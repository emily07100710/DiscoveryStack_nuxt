import { createHash } from 'node:crypto'
import { and, asc, desc, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { getOwnerPublicManifestCandidateReadiness, approveOwnerPublicSource, createOwnerPublicArtifact, createOwnerPublicDatasetBuild, createOwnerPublicSource, reviewOwnerPublicArtifact, removeOwnerPublicSource } from '../public-intelligence/repository'
import { JOURNEY_STAGES, SEO_GEO_LABEL_TAXONOMY_VERSION, seoGeoMultilabelSchema, type SeoGeoMultilabel } from '../public-intelligence/seoGeoTaxonomy'
import { runSupervisedTraining } from '../public-intelligence/training'
import { requireAuditDatabase } from '../audit/repository'
import { leads, modelImprovementCandidates, modelImprovementCollectionRuns, publicIntelligenceArtifacts, publicIntelligenceDatasetBuilds, publicIntelligenceSources, publicIntelligenceTrainingRuns } from '../database/schema'
import { analysePublicHomepage, PUBLIC_SITE_ANALYSIS_VERSION, reviewRobotsForHomepage, type PublicSiteAnalysisResult } from '../utils/publicSiteAnalysis'

const COLLECTION_BATCH_SIZE = 20
const PRODUCTION_MINIMUM = 150
const PRODUCTION_MINIMUM_PER_STAGE = 20
const TRAINING_FEATURE_CONTRACT = 'consented-homepage-structural-v1'
const TRAINING_SPLIT_VERSION = 'deterministic-id-v1'

function publicErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('private') || message.includes('local')) return 'unsafe_target'
  if (message.includes('response_too_large')) return 'response_too_large'
  if (message.includes('timeout')) return 'fetch_timeout'
  return 'public_homepage_unavailable'
}

export function suggestLabelsFromStructuralAnalysis(result: PublicSiteAnalysisResult): SeoGeoMultilabel {
  const checks = result.checks
  const primaryJourneyStage = !checks.titlePresent || !checks.h1Present
    ? 'discovery'
    : !checks.serviceRouting
      ? 'understanding'
      : !checks.primaryCta
        ? 'response'
        : !checks.expertContact
          ? 'progression'
          : 'conversion'
  const technicalSeoSignals: SeoGeoMultilabel['technicalSeoSignals'] = ['performance_not_observed']
  if (checks.titlePresent) technicalSeoSignals.push('title_present')
  if (checks.h1Present) technicalSeoSignals.push('h1_present')
  if (checks.canonicalPresent) technicalSeoSignals.push('canonical_present')
  if (checks.indexability === 'indexable') technicalSeoSignals.push('indexable')
  if (checks.schemaPresent) technicalSeoSignals.push('structured_data')
  if (checks.serviceRouting) technicalSeoSignals.push('internal_routing')
  const frictionSignals: SeoGeoMultilabel['frictionSignals'] = []
  if (!checks.titlePresent || !checks.h1Present) frictionSignals.push('unclear_value')
  if (!checks.primaryCta) frictionSignals.push('weak_cta')
  if (!checks.expertContact) frictionSignals.push('missing_contact_route')
  if (!checks.trustSignals) frictionSignals.push('missing_trust_signal')
  if (!checks.serviceRouting) frictionSignals.push('missing_next_step')
  if (!frictionSignals.length) frictionSignals.push('no_material_friction_observed')
  const citationReadiness: SeoGeoMultilabel['citationReadiness'] = []
  if (checks.trustSignals) citationReadiness.push('first_party_expertise')
  if (checks.schemaPresent) citationReadiness.push('structured_data')
  if (checks.expertContact) citationReadiness.push('contact_or_location')
  if (!citationReadiness.length) citationReadiness.push('insufficient_evidence')
  return seoGeoMultilabelSchema.parse({
    annotationKind: 'seo_geo_multilabel',
    annotationVersion: SEO_GEO_LABEL_TAXONOMY_VERSION,
    primaryJourneyStage,
    journeyStages: [primaryJourneyStage],
    searchIntents: checks.serviceRouting ? ['commercial'] : ['informational'],
    contentTypes: ['home'],
    audienceRoles: ['buyer'],
    topicClusters: ['public homepage structure'],
    entitySignals: [{ name: result.hostname, type: 'organisation', relationship: 'Public website reviewed from consented structural signals.' }],
    geoSignals: ['not_applicable'],
    citationReadiness,
    technicalSeoSignals,
    frictionSignals,
    actionPriority: result.scores.overall < 35 ? 'critical' : result.scores.overall < 55 ? 'high' : result.scores.overall < 75 ? 'medium' : 'low',
    annotationRationale: 'Automated structural suggestion only. The owner must inspect and correct every label before training admission.',
    reviewerConfidence: 1,
  })
}

function deidentifiedTrainingText(result: PublicSiteAnalysisResult) {
  const facts = Object.entries(result.checks).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${String(value)}`)
  return [`[contract=${TRAINING_FEATURE_CONTRACT}]`, `[scope=${result.scope}]`, ...facts].join('\n')
}

async function markRevokedCandidates(ownerUserId: number) {
  const database = requireAuditDatabase()
  const rows = await database.select({ id: modelImprovementCandidates.id, status: modelImprovementCandidates.status, publicSourceId: modelImprovementCandidates.publicSourceId, leadId: leads.id })
    .from(modelImprovementCandidates)
    .innerJoin(leads, eq(modelImprovementCandidates.leadId, leads.id))
    .where(and(
      eq(modelImprovementCandidates.ownerUserId, ownerUserId),
      or(eq(leads.modelImprovementConsent, false), isNotNull(leads.modelImprovementConsentRevokedAt)),
    ))
  let revoked = 0
  for (const row of rows) {
    if (row.status === 'revoked') continue
    const revokedAt = new Date()
    if (row.publicSourceId) await removeOwnerPublicSource({ ownerUserId, sourceId: row.publicSourceId, reviewNote: 'Model-improvement consent was withdrawn.' })
    await database.update(modelImprovementCandidates).set({ status: 'revoked', consentRevokedAt: revokedAt, reviewedAt: revokedAt }).where(eq(modelImprovementCandidates.id, row.id))
    revoked += 1
  }
  return revoked
}

export async function collectModelImprovementCandidates(input: { ownerUserId: number, trigger: 'scheduled' | 'owner_manual' }) {
  const database = requireAuditDatabase()
  const inserted = await database.insert(modelImprovementCollectionRuns).values({ ownerUserId: input.ownerUserId, trigger: input.trigger, status: 'running', errorSummary: {} })
  const runId = Number(inserted[0].insertId)
  const summary = { leadsExamined: 0, eligibleLeads: 0, collectedCandidates: 0, duplicateCandidates: 0, skippedCandidates: 0, revokedCandidates: 0, failedCandidates: 0 }
  const errors: Record<string, number> = {}
  try {
    summary.revokedCandidates = await markRevokedCandidates(input.ownerUserId)
    const leadSelection = {
      id: leads.id,
      website: leads.website,
      language: leads.language,
      consentVersion: leads.modelImprovementConsentVersion,
      consentedAt: leads.modelImprovementConsentAt,
    }
    const activeConsent = and(eq(leads.modelImprovementConsent, true), isNull(leads.modelImprovementConsentRevokedAt))
    const unseen = await database.select(leadSelection).from(leads)
      .leftJoin(modelImprovementCandidates, and(eq(modelImprovementCandidates.ownerUserId, input.ownerUserId), eq(modelImprovementCandidates.leadId, leads.id)))
      .where(and(activeConsent, isNull(modelImprovementCandidates.id)))
      .orderBy(desc(leads.createdAt))
      .limit(COLLECTION_BATCH_SIZE)
    const remaining = COLLECTION_BATCH_SIZE - unseen.length
    const retries = remaining > 0
      ? await database.select(leadSelection).from(leads)
          .innerJoin(modelImprovementCandidates, and(eq(modelImprovementCandidates.ownerUserId, input.ownerUserId), eq(modelImprovementCandidates.leadId, leads.id)))
          .where(and(activeConsent, or(eq(modelImprovementCandidates.status, 'collection_failed'), eq(modelImprovementCandidates.status, 'ready_for_review'))))
          .orderBy(asc(modelImprovementCandidates.updatedAt))
          .limit(remaining)
      : []
    const eligible = [...unseen, ...retries]
    summary.leadsExamined = eligible.length
    for (const lead of eligible) {
      if (!lead.website || !lead.consentVersion || !lead.consentedAt) {
        summary.skippedCandidates += 1
        continue
      }
      summary.eligibleLeads += 1
      const [existing] = await database.select().from(modelImprovementCandidates).where(and(eq(modelImprovementCandidates.ownerUserId, input.ownerUserId), eq(modelImprovementCandidates.leadId, lead.id))).limit(1)
      if (existing?.status === 'approved' || existing?.status === 'revoked') {
        summary.skippedCandidates += 1
        continue
      }
      const checkedAt = new Date()
      try {
        const robots = await reviewRobotsForHomepage(lead.website)
        if (!robots.allowed) {
          const errorCode = robots.status === 'disallowed' ? 'robots_disallow' : 'robots_check_failed'
          errors[errorCode] = (errors[errorCode] || 0) + 1
          summary.failedCandidates += 1
          const values = { collectionRunId: runId, sourceUrl: lead.website, finalUrl: null, hostname: new URL(lead.website).hostname, consentVersion: lead.consentVersion, consentedAt: lead.consentedAt, status: 'collection_failed' as const, robotsStatus: robots.status, robotsCheckedAt: checkedAt, analysisVersion: PUBLIC_SITE_ANALYSIS_VERSION, featureData: {}, suggestedLabelData: {}, collectionErrorCode: errorCode, collectedAt: null }
          if (existing) await database.update(modelImprovementCandidates).set(values).where(eq(modelImprovementCandidates.id, existing.id))
          else await database.insert(modelImprovementCandidates).values({ ownerUserId: input.ownerUserId, leadId: lead.id, ...values })
          continue
        }
        const analysis = await analysePublicHomepage(lead.website)
        const labels = suggestLabelsFromStructuralAnalysis(analysis)
        if (existing?.snapshotFingerprint === analysis.snapshotFingerprint && existing.status === 'ready_for_review') {
          await database.update(modelImprovementCandidates).set({ collectionRunId: runId, robotsStatus: robots.status, robotsCheckedAt: checkedAt, collectedAt: new Date() }).where(eq(modelImprovementCandidates.id, existing.id))
          summary.duplicateCandidates += 1
          continue
        }
        const values = {
          collectionRunId: runId,
          sourceUrl: lead.website,
          finalUrl: analysis.finalUrl,
          hostname: analysis.hostname,
          consentVersion: lead.consentVersion,
          consentedAt: lead.consentedAt,
          status: 'ready_for_review' as const,
          robotsStatus: robots.status,
          robotsCheckedAt: checkedAt,
          snapshotFingerprint: analysis.snapshotFingerprint,
          analysisVersion: analysis.analysisVersion,
          featureData: { scope: analysis.scope, scores: analysis.scores, checks: analysis.checks, recommendationKeys: analysis.recommendationKeys, trainingText: deidentifiedTrainingText(analysis), rawHtmlStored: false, contactPiiStored: false },
          suggestedLabelData: labels,
          approvedLabelData: null,
          collectionErrorCode: null,
          collectedAt: new Date(),
        }
        if (existing) await database.update(modelImprovementCandidates).set(values).where(eq(modelImprovementCandidates.id, existing.id))
        else await database.insert(modelImprovementCandidates).values({ ownerUserId: input.ownerUserId, leadId: lead.id, ...values })
        summary.collectedCandidates += 1
      } catch (error) {
        const errorCode = publicErrorCode(error)
        errors[errorCode] = (errors[errorCode] || 0) + 1
        summary.failedCandidates += 1
        const fallbackHost = (() => { try { return new URL(lead.website!).hostname } catch { return 'invalid' } })()
        const values = { collectionRunId: runId, sourceUrl: lead.website, finalUrl: null, hostname: fallbackHost, consentVersion: lead.consentVersion, consentedAt: lead.consentedAt, status: 'collection_failed' as const, robotsStatus: 'error' as const, robotsCheckedAt: checkedAt, analysisVersion: PUBLIC_SITE_ANALYSIS_VERSION, featureData: {}, suggestedLabelData: {}, collectionErrorCode: errorCode, collectedAt: null }
        if (existing) await database.update(modelImprovementCandidates).set(values).where(eq(modelImprovementCandidates.id, existing.id))
        else await database.insert(modelImprovementCandidates).values({ ownerUserId: input.ownerUserId, leadId: lead.id, ...values })
      }
    }
    await database.update(modelImprovementCollectionRuns).set({ ...summary, status: 'completed', errorSummary: errors, completedAt: new Date() }).where(eq(modelImprovementCollectionRuns.id, runId))
    return { runId, status: 'completed' as const, ...summary, errors }
  } catch (error) {
    const code = publicErrorCode(error)
    errors[code] = (errors[code] || 0) + 1
    await database.update(modelImprovementCollectionRuns).set({ ...summary, status: 'failed', errorSummary: errors, completedAt: new Date() }).where(eq(modelImprovementCollectionRuns.id, runId))
    throw error
  }
}

export async function listModelImprovementPipeline(ownerUserId: number) {
  const database = requireAuditDatabase()
  const candidates = await database.select({
    id: modelImprovementCandidates.id,
    leadId: modelImprovementCandidates.leadId,
    company: leads.company,
    website: leads.website,
    language: leads.language,
    status: modelImprovementCandidates.status,
    robotsStatus: modelImprovementCandidates.robotsStatus,
    snapshotFingerprint: modelImprovementCandidates.snapshotFingerprint,
    featureData: modelImprovementCandidates.featureData,
    suggestedLabelData: modelImprovementCandidates.suggestedLabelData,
    approvedLabelData: modelImprovementCandidates.approvedLabelData,
    consentVersion: modelImprovementCandidates.consentVersion,
    consentedAt: modelImprovementCandidates.consentedAt,
    collectionErrorCode: modelImprovementCandidates.collectionErrorCode,
    publicArtifactId: modelImprovementCandidates.publicArtifactId,
    collectedAt: modelImprovementCandidates.collectedAt,
    reviewedAt: modelImprovementCandidates.reviewedAt,
  }).from(modelImprovementCandidates).innerJoin(leads, eq(modelImprovementCandidates.leadId, leads.id)).where(eq(modelImprovementCandidates.ownerUserId, ownerUserId)).orderBy(desc(modelImprovementCandidates.createdAt)).limit(100)
  const runs = await database.select().from(modelImprovementCollectionRuns).where(eq(modelImprovementCollectionRuns.ownerUserId, ownerUserId)).orderBy(desc(modelImprovementCollectionRuns.startedAt)).limit(20)
  const readiness = await getOwnerPublicManifestCandidateReadiness(ownerUserId)
  const stageCounts = Object.fromEntries(JOURNEY_STAGES.map(stage => [stage, readiness.stageCounts[stage] || 0]))
  return {
    candidates,
    runs,
    readiness: {
      approvedHumanAnnotations: readiness.approvedHumanAnnotations,
      stageCounts,
      productionMinimum: PRODUCTION_MINIMUM,
      productionMinimumPerStage: PRODUCTION_MINIMUM_PER_STAGE,
      productionReady: readiness.approvedHumanAnnotations >= PRODUCTION_MINIMUM && JOURNEY_STAGES.every(stage => (stageCounts[stage] || 0) >= PRODUCTION_MINIMUM_PER_STAGE),
    },
  }
}

async function eligibleArtifactIds(ownerUserId: number) {
  const database = requireAuditDatabase()
  const rows = await database.select({ id: publicIntelligenceArtifacts.id }).from(publicIntelligenceArtifacts)
    .innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id))
    .where(and(
      eq(publicIntelligenceSources.ownerUserId, ownerUserId),
      eq(publicIntelligenceSources.reviewStatus, 'approved'),
      eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
      eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
      eq(publicIntelligenceArtifacts.qualityStatus, 'passed'),
      eq(publicIntelligenceArtifacts.piiStatus, 'none_detected'),
      isNull(publicIntelligenceSources.removedAt),
      isNull(publicIntelligenceArtifacts.removedAt),
    ))
  return rows.map(row => row.id).sort((left, right) => left - right)
}

export async function prepareRetrainingManifestIfReady(ownerUserId: number) {
  const database = requireAuditDatabase()
  const state = await listModelImprovementPipeline(ownerUserId)
  if (!state.readiness.productionReady) return { status: 'gate_blocked' as const, readiness: state.readiness }
  const artifactIds = await eligibleArtifactIds(ownerUserId)
  const identity = createHash('sha256').update(JSON.stringify(artifactIds)).digest('hex')
  const datasetVersion = `consented-${artifactIds.length}-${identity.slice(0, 12)}`
  const [existing] = await database.select({ id: publicIntelligenceDatasetBuilds.id, status: publicIntelligenceDatasetBuilds.status, datasetVersion: publicIntelligenceDatasetBuilds.datasetVersion }).from(publicIntelligenceDatasetBuilds)
    .where(and(eq(publicIntelligenceDatasetBuilds.ownerUserId, ownerUserId), eq(publicIntelligenceDatasetBuilds.datasetName, 'consented-website-structural-v1')))
    .orderBy(desc(publicIntelligenceDatasetBuilds.createdAt)).limit(1)
  if (existing?.datasetVersion === datasetVersion) return { status: 'unchanged' as const, datasetBuildId: existing.id, datasetStatus: existing.status, readiness: state.readiness }
  const created = await createOwnerPublicDatasetBuild({ ownerUserId, datasetName: 'consented-website-structural-v1', datasetVersion, intendedUse: 'training', featureContractVersion: TRAINING_FEATURE_CONTRACT, labelTaxonomyVersion: SEO_GEO_LABEL_TAXONOMY_VERSION, splitVersion: TRAINING_SPLIT_VERSION, artifactIds, reviewNote: 'Automatically prepared from owner-approved, consented, de-identified structural candidates. Owner approval is still required.' })
  return { ...created, preparationStatus: 'ready_for_owner_review' as const, readiness: state.readiness }
}

export async function maybeStartApprovedAutomaticTraining(ownerUserId: number) {
  const enabled = String(useRuntimeConfig().modelImprovementAutoTrain || process.env.NUXT_MODEL_IMPROVEMENT_AUTO_TRAIN || '').toLowerCase() === 'true'
  if (!enabled) return { status: 'disabled' as const }
  const database = requireAuditDatabase()
  const [dataset] = await database.select({ id: publicIntelligenceDatasetBuilds.id, status: publicIntelligenceDatasetBuilds.status }).from(publicIntelligenceDatasetBuilds)
    .where(and(eq(publicIntelligenceDatasetBuilds.ownerUserId, ownerUserId), eq(publicIntelligenceDatasetBuilds.intendedUse, 'training')))
    .orderBy(desc(publicIntelligenceDatasetBuilds.createdAt)).limit(1)
  if (!dataset) return { status: 'no_manifest' as const }
  if (dataset.status !== 'approved') return { status: 'awaiting_manifest_approval' as const, datasetBuildId: dataset.id, datasetStatus: dataset.status }
  const [existingRun] = await database.select({ id: publicIntelligenceTrainingRuns.id, status: publicIntelligenceTrainingRuns.status }).from(publicIntelligenceTrainingRuns)
    .where(and(eq(publicIntelligenceTrainingRuns.ownerUserId, ownerUserId), eq(publicIntelligenceTrainingRuns.datasetBuildId, dataset.id), eq(publicIntelligenceTrainingRuns.mode, 'production')))
    .orderBy(desc(publicIntelligenceTrainingRuns.createdAt)).limit(1)
  if (existingRun) return { status: 'already_recorded' as const, runId: existingRun.id, runStatus: existingRun.status }
  return runSupervisedTraining({ ownerUserId, mode: 'production', datasetBuildId: dataset.id })
}

export async function reviewModelImprovementCandidate(input: { ownerUserId: number, candidateId: number, decision: 'approved' | 'rejected', reviewNote: string, rightsConfirmed: boolean, labels?: unknown }) {
  const database = requireAuditDatabase()
  const [candidate] = await database.select({
    id: modelImprovementCandidates.id,
    leadId: modelImprovementCandidates.leadId,
    sourceUrl: modelImprovementCandidates.sourceUrl,
    finalUrl: modelImprovementCandidates.finalUrl,
    hostname: modelImprovementCandidates.hostname,
    status: modelImprovementCandidates.status,
    robotsStatus: modelImprovementCandidates.robotsStatus,
    robotsCheckedAt: modelImprovementCandidates.robotsCheckedAt,
    snapshotFingerprint: modelImprovementCandidates.snapshotFingerprint,
    featureData: modelImprovementCandidates.featureData,
    consentVersion: modelImprovementCandidates.consentVersion,
    consentedAt: modelImprovementCandidates.consentedAt,
    language: leads.language,
    consentActive: leads.modelImprovementConsent,
    consentRevokedAt: leads.modelImprovementConsentRevokedAt,
  }).from(modelImprovementCandidates).innerJoin(leads, eq(modelImprovementCandidates.leadId, leads.id)).where(and(eq(modelImprovementCandidates.id, input.candidateId), eq(modelImprovementCandidates.ownerUserId, input.ownerUserId))).limit(1)
  if (!candidate) throw createError({ statusCode: 404, statusMessage: 'Model-improvement candidate was not found.' })
  if (!candidate.consentActive || candidate.consentRevokedAt || candidate.status === 'revoked') throw createError({ statusCode: 409, statusMessage: 'Consent is no longer active for this candidate.' })
  if (candidate.status !== 'ready_for_review') throw createError({ statusCode: 409, statusMessage: 'Only a ready-for-review candidate can be decided.' })
  if (input.decision === 'rejected') {
    await database.update(modelImprovementCandidates).set({ status: 'rejected', reviewerUserId: input.ownerUserId, reviewNote: input.reviewNote, reviewedAt: new Date() }).where(eq(modelImprovementCandidates.id, candidate.id))
    return { candidateId: candidate.id, status: 'rejected' as const }
  }
  if (!input.rightsConfirmed) throw createError({ statusCode: 422, statusMessage: 'Owner confirmation of the consent and public-site rights is required.' })
  if (!candidate.snapshotFingerprint || !candidate.finalUrl || !['allowed', 'unavailable'].includes(candidate.robotsStatus)) throw createError({ statusCode: 422, statusMessage: 'This candidate has not passed the public collection gate.' })
  const labels = seoGeoMultilabelSchema.safeParse(input.labels)
  if (!labels.success) throw createError({ statusCode: 422, statusMessage: 'Review every multi-task label before approval.', data: labels.error.flatten().fieldErrors })
  const source = await createOwnerPublicSource({
    ownerUserId: input.ownerUserId,
    sourceType: 'website',
    sourceUrl: candidate.finalUrl,
    canonicalUrl: candidate.finalUrl,
    sourceName: `Consented website: ${candidate.hostname}`,
    domain: candidate.hostname,
    language: candidate.language,
    region: null,
    discoveryMethod: 'customer_consent',
    robotsStatus: candidate.robotsStatus === 'allowed' ? 'reviewed_allow' : 'unavailable',
    robotsUrl: new URL('/robots.txt', candidate.finalUrl).toString(),
    termsStatus: 'allows_training',
    termsUrl: null,
    licenceReference: `customer-consent:${candidate.consentVersion}`,
    copyrightRisk: 'low',
    piiStatus: 'none_detected',
    retentionUntil: null,
    policyEvidence: { candidateId: candidate.id, consentVersion: candidate.consentVersion, consentedAt: candidate.consentedAt.toISOString(), ownerRightsConfirmed: true, robotsStatus: candidate.robotsStatus, robotsCheckedAt: candidate.robotsCheckedAt.toISOString(), rawHtmlStored: false, contactPiiStored: false },
    reviewNote: input.reviewNote,
  })
  await approveOwnerPublicSource({ ownerUserId: input.ownerUserId, sourceId: source.id, requestedUse: 'training_candidate', reviewNote: input.reviewNote })
  const [existingArtifact] = await database.select({ id: publicIntelligenceArtifacts.id }).from(publicIntelligenceArtifacts).where(and(eq(publicIntelligenceArtifacts.sourceId, source.id), eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'), isNull(publicIntelligenceArtifacts.removedAt))).limit(1)
  let artifactId = existingArtifact?.id
  if (!artifactId) {
    const featureData = candidate.featureData as { trainingText?: string }
    const artifact = await createOwnerPublicArtifact({ ownerUserId: input.ownerUserId, sourceId: source.id, sourceUrl: candidate.finalUrl, canonicalUrl: candidate.finalUrl, artifactType: 'human_annotation', artifactText: featureData.trainingText || `[contract=${TRAINING_FEATURE_CONTRACT}]`, sourceLocator: `consented-structural-candidate:${candidate.id}`, sourceSpanHash: candidate.snapshotFingerprint, fieldData: labels.data, language: candidate.language, extractionMethod: 'human_annotation', requestedUse: 'training_candidate', retentionUntil: null })
    artifactId = artifact.id
  }
  if (!artifactId) throw createError({ statusCode: 500, statusMessage: 'Approved candidate artifact was not created.' })
  await reviewOwnerPublicArtifact({ ownerUserId: input.ownerUserId, artifactId, qualityStatus: 'passed', qualityNote: input.reviewNote })
  await database.update(modelImprovementCandidates).set({ status: 'approved', approvedLabelData: labels.data, reviewerUserId: input.ownerUserId, reviewNote: input.reviewNote, publicSourceId: source.id, publicArtifactId: artifactId, reviewedAt: new Date() }).where(eq(modelImprovementCandidates.id, candidate.id))
  const manifest = await prepareRetrainingManifestIfReady(input.ownerUserId)
  return { candidateId: candidate.id, status: 'approved' as const, publicSourceId: source.id, publicArtifactId: artifactId, manifest }
}

export async function revokeLeadModelImprovementConsent(input: { ownerUserId: number, leadId: number }) {
  const database = requireAuditDatabase()
  const [lead] = await database.select({ id: leads.id }).from(leads).where(eq(leads.id, input.leadId)).limit(1)
  if (!lead) throw createError({ statusCode: 404, statusMessage: 'Lead was not found.' })
  const [candidate] = await database.select({ id: modelImprovementCandidates.id, publicSourceId: modelImprovementCandidates.publicSourceId }).from(modelImprovementCandidates).where(and(eq(modelImprovementCandidates.ownerUserId, input.ownerUserId), eq(modelImprovementCandidates.leadId, input.leadId))).limit(1)
  const revokedAt = new Date()
  await database.update(leads).set({ modelImprovementConsent: false, modelImprovementConsentRevokedAt: revokedAt }).where(eq(leads.id, input.leadId))
  if (candidate?.publicSourceId) await removeOwnerPublicSource({ ownerUserId: input.ownerUserId, sourceId: candidate.publicSourceId, reviewNote: 'Model-improvement consent was withdrawn by request.' })
  if (candidate) await database.update(modelImprovementCandidates).set({ status: 'revoked', consentRevokedAt: revokedAt, reviewedAt: revokedAt }).where(eq(modelImprovementCandidates.id, candidate.id))
  return { leadId: input.leadId, revokedAt }
}
