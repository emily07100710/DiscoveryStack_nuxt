import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { requireAuditDatabase } from '../audit/repository'
import { publicIntelligenceArtifacts, publicIntelligenceDatasetBuilds, publicIntelligenceDatasetMembers, publicIntelligenceSourceReviews, publicIntelligenceSources } from '../database/schema'
import { SEO_GEO_LABEL_TAXONOMY_VERSION, seoGeoMultilabelSchema } from './seoGeoTaxonomy'
import { assertPermittedPublicUse, maximumPermittedUse, PublicUseViolation, type PublicUse } from './policy'
import { trainingMemberAdmissionError } from './training-admission'

export function sourceFingerprint(url: string) { return createHash('sha256').update(url.trim().toLowerCase()).digest('hex') }
export function artifactFingerprint(input: { sourceId: number, sourceUrl: string, sourceSpanHash?: string | null, artifactType: string, sourceLocator?: string | null, artifactText?: string | null, fieldData: object }) {
  return createHash('sha256').update(JSON.stringify({
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    sourceSpanHash: input.sourceSpanHash || '',
    artifactType: input.artifactType,
    sourceLocator: input.sourceLocator || '',
    artifactText: input.artifactText || '',
    fieldData: input.fieldData,
  })).digest('hex')
}

type SourcePolicyInput = { robotsStatus: 'unreviewed' | 'reviewed_allow' | 'reviewed_restrict' | 'unavailable' | 'not_applicable', robotsUrl: string | null, termsStatus: 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown', termsUrl: string | null, licenceReference: string | null, copyrightRisk: 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked', piiStatus: 'unreviewed' | 'none_detected' | 'possible' | 'restricted', retentionUntil: Date | null, policyEvidence: object, reviewNote: string | null }

function sourcePolicySnapshot(source: Pick<typeof publicIntelligenceSources.$inferSelect, 'robotsStatus' | 'robotsUrl' | 'termsStatus' | 'termsUrl' | 'licenceReference' | 'copyrightRisk' | 'piiStatus' | 'retentionUntil' | 'policyEvidence'>) {
  return { robotsStatus: source.robotsStatus, robotsUrl: source.robotsUrl, termsStatus: source.termsStatus, termsUrl: source.termsUrl, licenceReference: source.licenceReference, copyrightRisk: source.copyrightRisk, piiStatus: source.piiStatus, retentionUntil: source.retentionUntil?.toISOString() ?? null, policyEvidence: source.policyEvidence }
}

async function appendSourceReview(input: { sourceId: number, reviewerUserId: number, action: 'created' | 'reviewed' | 'approved' | 'use_changed' | 'removed' | 'restored', previousAllowedUse: PublicUse | null, nextAllowedUse: PublicUse, previousReviewStatus: 'pending' | 'approved' | 'needs_policy_review' | 'rejected' | 'removed' | null, nextReviewStatus: 'pending' | 'approved' | 'needs_policy_review' | 'rejected' | 'removed', policySnapshot: object, reviewNote: string | null }) {
  const database = requireAuditDatabase()
  await database.insert(publicIntelligenceSourceReviews).values(input)
}

export async function listOwnerPublicSources(ownerUserId: number, filters: { search?: string, reviewStatus?: 'pending' | 'approved' | 'needs_policy_review' | 'rejected' | 'removed', allowedUse?: PublicUse, includeRemoved?: boolean } = {}) {
  const database = requireAuditDatabase()
  const predicates = [eq(publicIntelligenceSources.ownerUserId, ownerUserId)]
  if (!filters.includeRemoved) predicates.push(isNull(publicIntelligenceSources.removedAt))
  if (filters.reviewStatus) predicates.push(eq(publicIntelligenceSources.reviewStatus, filters.reviewStatus))
  if (filters.allowedUse) predicates.push(eq(publicIntelligenceSources.allowedUse, filters.allowedUse))
  if (filters.search) predicates.push(or(like(publicIntelligenceSources.sourceName, `%${filters.search}%`), like(publicIntelligenceSources.domain, `%${filters.search}%`))!)
  return database.select({ id: publicIntelligenceSources.id, sourceName: publicIntelligenceSources.sourceName, sourceUrl: publicIntelligenceSources.sourceUrl, domain: publicIntelligenceSources.domain, sourceType: publicIntelligenceSources.sourceType, allowedUse: publicIntelligenceSources.allowedUse, reviewStatus: publicIntelligenceSources.reviewStatus, robotsStatus: publicIntelligenceSources.robotsStatus, termsStatus: publicIntelligenceSources.termsStatus, copyrightRisk: publicIntelligenceSources.copyrightRisk, piiStatus: publicIntelligenceSources.piiStatus, lastReviewedAt: publicIntelligenceSources.lastReviewedAt, retentionUntil: publicIntelligenceSources.retentionUntil, removedAt: publicIntelligenceSources.removedAt }).from(publicIntelligenceSources).where(and(...predicates)).orderBy(desc(publicIntelligenceSources.createdAt))
}

export async function createOwnerPublicSource(input: { ownerUserId: number, sourceType: 'website' | 'api' | 'dataset' | 'publication' | 'document', sourceUrl: string, canonicalUrl: string | null, sourceName: string, domain: string | null, language: string | null, region: string | null, discoveryMethod: 'owner_research' | 'public_search' | 'api_catalogue' | 'licensed_import', robotsStatus: 'unreviewed' | 'reviewed_allow' | 'reviewed_restrict' | 'unavailable' | 'not_applicable', robotsUrl: string | null, termsStatus: 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown', termsUrl: string | null, licenceReference: string | null, copyrightRisk: 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked', piiStatus: 'unreviewed' | 'none_detected' | 'possible' | 'restricted', retentionUntil: Date | null, policyEvidence: object, reviewNote: string | null }) {
  const database = requireAuditDatabase()
  const fingerprint = sourceFingerprint(input.canonicalUrl || input.sourceUrl)
  const [previous] = await database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), eq(publicIntelligenceSources.sourceFingerprint, fingerprint))).limit(1)
  const maximumUse = maximumPermittedUse({ termsStatus: input.termsStatus, copyrightRisk: input.copyrightRisk, piiStatus: input.piiStatus, reviewStatus: 'pending' })
  const nextReviewStatus = maximumUse === 'blocked' ? 'needs_policy_review' : 'pending' as const
  await database.insert(publicIntelligenceSources).values({ ...input, sourceFingerprint: fingerprint, allowedUse: maximumUse, reviewStatus: nextReviewStatus, firstObservedAt: new Date(), sourceCardVersion: 'public-source-card-v1' }).onDuplicateKeyUpdate({ set: { sourceName: input.sourceName, canonicalUrl: input.canonicalUrl, domain: input.domain, language: input.language, region: input.region, robotsStatus: input.robotsStatus, robotsUrl: input.robotsUrl, termsStatus: input.termsStatus, termsUrl: input.termsUrl, licenceReference: input.licenceReference, copyrightRisk: input.copyrightRisk, piiStatus: input.piiStatus, retentionUntil: input.retentionUntil, policyEvidence: input.policyEvidence, reviewNote: input.reviewNote, allowedUse: maximumUse, reviewStatus: nextReviewStatus, removedAt: null, lastReviewedAt: new Date() } })
  const [source] = await database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), eq(publicIntelligenceSources.sourceFingerprint, fingerprint))).limit(1)
  if (!source) throw createError({ statusCode: 500, statusMessage: 'The Source Card could not be recorded.' })
  await appendSourceReview({ sourceId: source.id, reviewerUserId: input.ownerUserId, action: previous ? 'reviewed' : 'created', previousAllowedUse: previous?.allowedUse ?? null, nextAllowedUse: source.allowedUse, previousReviewStatus: previous?.reviewStatus ?? null, nextReviewStatus: source.reviewStatus, policySnapshot: sourcePolicySnapshot(source), reviewNote: input.reviewNote })
  return { id: source.id, allowedUse: source.allowedUse, reviewStatus: source.reviewStatus }
}

export async function approveOwnerPublicSource(input: { ownerUserId: number, sourceId: number, requestedUse: PublicUse, reviewNote: string | null }) {
  const database = requireAuditDatabase()
  const [source] = await database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.id, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Public source was not found.' })
  const maximumUse = maximumPermittedUse({ termsStatus: source.termsStatus, copyrightRisk: source.copyrightRisk, piiStatus: source.piiStatus, reviewStatus: 'approved' })
  try { assertPermittedPublicUse({ requestedUse: input.requestedUse, maximumUse }) } catch (error) { if (error instanceof PublicUseViolation) throw createError({ statusCode: 422, statusMessage: error.message }); throw error }
  await database.update(publicIntelligenceSources).set({ allowedUse: input.requestedUse, reviewStatus: 'approved', reviewNote: input.reviewNote, lastReviewedAt: new Date() }).where(eq(publicIntelligenceSources.id, source.id))
  await appendSourceReview({ sourceId: source.id, reviewerUserId: input.ownerUserId, action: source.reviewStatus === 'approved' ? 'use_changed' : 'approved', previousAllowedUse: source.allowedUse, nextAllowedUse: input.requestedUse, previousReviewStatus: source.reviewStatus, nextReviewStatus: 'approved', policySnapshot: sourcePolicySnapshot(source), reviewNote: input.reviewNote })
  return { sourceId: source.id, allowedUse: input.requestedUse, maximumUse }
}

export async function rereviewOwnerPublicSource(input: { ownerUserId: number, sourceId: number, requestedUse: PublicUse, policy: SourcePolicyInput }) {
  const database = requireAuditDatabase()
  const [source] = await database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.id, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Public source was not found.' })
  const maximumUse = maximumPermittedUse({ termsStatus: input.policy.termsStatus, copyrightRisk: input.policy.copyrightRisk, piiStatus: input.policy.piiStatus, reviewStatus: 'approved' })
  try { assertPermittedPublicUse({ requestedUse: input.requestedUse, maximumUse }) } catch (error) { if (error instanceof PublicUseViolation) throw createError({ statusCode: 422, statusMessage: error.message }); throw error }
  const nextReviewStatus = input.requestedUse === 'blocked' ? 'needs_policy_review' : 'approved' as const
  await database.update(publicIntelligenceSources).set({ ...input.policy, allowedUse: input.requestedUse, reviewStatus: nextReviewStatus, lastReviewedAt: new Date() }).where(eq(publicIntelligenceSources.id, source.id))
  const [updated] = await database.select().from(publicIntelligenceSources).where(eq(publicIntelligenceSources.id, source.id)).limit(1)
  if (!updated) throw createError({ statusCode: 500, statusMessage: 'The Source Card could not be re-reviewed.' })
  await appendSourceReview({ sourceId: source.id, reviewerUserId: input.ownerUserId, action: 'reviewed', previousAllowedUse: source.allowedUse, nextAllowedUse: updated.allowedUse, previousReviewStatus: source.reviewStatus, nextReviewStatus: updated.reviewStatus, policySnapshot: sourcePolicySnapshot(updated), reviewNote: input.policy.reviewNote })
  return { sourceId: source.id, allowedUse: updated.allowedUse, reviewStatus: updated.reviewStatus }
}

export async function removeOwnerPublicSource(input: { ownerUserId: number, sourceId: number, reviewNote: string | null }) {
  const database = requireAuditDatabase()
  const [source] = await database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.id, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Public source was not found.' })
  const removedAt = new Date()
  const artifacts = await database.select({ id: publicIntelligenceArtifacts.id }).from(publicIntelligenceArtifacts).where(eq(publicIntelligenceArtifacts.sourceId, source.id))
  const artifactIds = artifacts.map(artifact => artifact.id)
  await database.update(publicIntelligenceSources).set({ allowedUse: 'blocked', reviewStatus: 'removed', removedAt, removalRequestedAt: removedAt, reviewNote: input.reviewNote }).where(eq(publicIntelligenceSources.id, source.id))
  await database.update(publicIntelligenceArtifacts).set({ removedAt }).where(eq(publicIntelligenceArtifacts.sourceId, source.id))
  if (artifactIds.length) await database.update(publicIntelligenceDatasetMembers).set({ memberStatus: 'revoked', revokedAt: removedAt }).where(inArray(publicIntelligenceDatasetMembers.artifactId, artifactIds))
  await appendSourceReview({ sourceId: source.id, reviewerUserId: input.ownerUserId, action: 'removed', previousAllowedUse: source.allowedUse, nextAllowedUse: 'blocked', previousReviewStatus: source.reviewStatus, nextReviewStatus: 'removed', policySnapshot: sourcePolicySnapshot(source), reviewNote: input.reviewNote })
  return { sourceId: source.id, removedAt }
}

export async function listOwnerPublicSourceReviews(input: { ownerUserId: number, sourceId: number }) {
  const database = requireAuditDatabase()
  return database.select({ id: publicIntelligenceSourceReviews.id, action: publicIntelligenceSourceReviews.action, previousAllowedUse: publicIntelligenceSourceReviews.previousAllowedUse, nextAllowedUse: publicIntelligenceSourceReviews.nextAllowedUse, previousReviewStatus: publicIntelligenceSourceReviews.previousReviewStatus, nextReviewStatus: publicIntelligenceSourceReviews.nextReviewStatus, policySnapshot: publicIntelligenceSourceReviews.policySnapshot, reviewNote: publicIntelligenceSourceReviews.reviewNote, createdAt: publicIntelligenceSourceReviews.createdAt }).from(publicIntelligenceSourceReviews).innerJoin(publicIntelligenceSources, eq(publicIntelligenceSourceReviews.sourceId, publicIntelligenceSources.id)).where(and(eq(publicIntelligenceSourceReviews.sourceId, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId))).orderBy(desc(publicIntelligenceSourceReviews.createdAt))
}

function useForIntendedDataset(intendedUse: 'research' | 'evaluation' | 'training'): PublicUse {
  return intendedUse === 'research' ? 'research_only' : intendedUse === 'evaluation' ? 'evaluation_candidate' : 'training_candidate'
}

export async function listOwnerPublicDatasetBuilds(ownerUserId: number) {
  const database = requireAuditDatabase()
  return database.select({ id: publicIntelligenceDatasetBuilds.id, datasetName: publicIntelligenceDatasetBuilds.datasetName, datasetVersion: publicIntelligenceDatasetBuilds.datasetVersion, intendedUse: publicIntelligenceDatasetBuilds.intendedUse, status: publicIntelligenceDatasetBuilds.status, featureContractVersion: publicIntelligenceDatasetBuilds.featureContractVersion, labelTaxonomyVersion: publicIntelligenceDatasetBuilds.labelTaxonomyVersion, splitVersion: publicIntelligenceDatasetBuilds.splitVersion, manifestHash: publicIntelligenceDatasetBuilds.manifestHash, createdAt: publicIntelligenceDatasetBuilds.createdAt, approvedAt: publicIntelligenceDatasetBuilds.approvedAt, artifactCount: sql<number>`count(${publicIntelligenceDatasetMembers.id})` }).from(publicIntelligenceDatasetBuilds).leftJoin(publicIntelligenceDatasetMembers, eq(publicIntelligenceDatasetMembers.datasetBuildId, publicIntelligenceDatasetBuilds.id)).where(eq(publicIntelligenceDatasetBuilds.ownerUserId, ownerUserId)).groupBy(publicIntelligenceDatasetBuilds.id).orderBy(desc(publicIntelligenceDatasetBuilds.createdAt))
}

/** Counts only active public human annotations that satisfy the immutable training-manifest admission policy. */
export async function getOwnerPublicManifestCandidateReadiness(ownerUserId: number) {
  const database = requireAuditDatabase()
  const rows = await database.select({ sourceUrl: publicIntelligenceArtifacts.sourceUrl, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, fieldData: publicIntelligenceArtifacts.fieldData })
    .from(publicIntelligenceArtifacts)
    .innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id))
    .where(and(
      eq(publicIntelligenceSources.ownerUserId, ownerUserId),
      eq(publicIntelligenceSources.reviewStatus, 'approved'),
      eq(publicIntelligenceSources.allowedUse, 'training_candidate'),
      eq(publicIntelligenceSources.piiStatus, 'none_detected'),
      isNull(publicIntelligenceSources.removedAt),
      eq(publicIntelligenceArtifacts.artifactType, 'human_annotation'),
      eq(publicIntelligenceArtifacts.extractionMethod, 'human_annotation'),
      eq(publicIntelligenceArtifacts.useSnapshot, 'training_candidate'),
      eq(publicIntelligenceArtifacts.qualityStatus, 'passed'),
      eq(publicIntelligenceArtifacts.piiStatus, 'none_detected'),
      isNull(publicIntelligenceArtifacts.removedAt),
    ))
  const uniqueUrls = new Set<string>()
  const uniqueSpans = new Set<string>()
  const stageCounts: Record<string, number> = {}
  for (const row of rows) {
    const labels = seoGeoMultilabelSchema.safeParse(row.fieldData)
    if (!labels.success || !row.sourceSpanHash || uniqueUrls.has(row.sourceUrl) || uniqueSpans.has(row.sourceSpanHash)) continue
    uniqueUrls.add(row.sourceUrl)
    uniqueSpans.add(row.sourceSpanHash)
    stageCounts[labels.data.primaryJourneyStage] = (stageCounts[labels.data.primaryJourneyStage] || 0) + 1
  }
  return { approvedHumanAnnotations: uniqueUrls.size, stageCounts }
}

export async function approveOwnerPublicDatasetBuild(input: { ownerUserId: number, datasetBuildId: number, reviewNote: string | null }) {
  const database = requireAuditDatabase()
  const [build] = await database.select().from(publicIntelligenceDatasetBuilds).where(and(eq(publicIntelligenceDatasetBuilds.id, input.datasetBuildId), eq(publicIntelligenceDatasetBuilds.ownerUserId, input.ownerUserId))).limit(1)
  if (!build) throw createError({ statusCode: 404, statusMessage: 'The public dataset manifest was not found.' })
  if (build.intendedUse !== 'training') throw createError({ statusCode: 422, statusMessage: 'Only a training-intended manifest can be approved for a training run.' })
  if (build.status !== 'ready_for_review') throw createError({ statusCode: 422, statusMessage: 'Only a ready-for-review manifest can be approved.' })
  if (build.labelTaxonomyVersion !== SEO_GEO_LABEL_TAXONOMY_VERSION) throw createError({ statusCode: 422, statusMessage: 'The manifest must use the active SEO/GEO label taxonomy version.' })
  const members = await database.select({ artifactId: publicIntelligenceArtifacts.id, sourceUrl: publicIntelligenceArtifacts.sourceUrl, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, fieldData: publicIntelligenceArtifacts.fieldData, artifactType: publicIntelligenceArtifacts.artifactType, qualityStatus: publicIntelligenceArtifacts.qualityStatus, piiStatus: publicIntelligenceArtifacts.piiStatus, memberStatus: publicIntelligenceDatasetMembers.memberStatus, sourceUse: publicIntelligenceSources.allowedUse, sourceReviewStatus: publicIntelligenceSources.reviewStatus, sourceRemovedAt: publicIntelligenceSources.removedAt, artifactRemovedAt: publicIntelligenceArtifacts.removedAt }).from(publicIntelligenceDatasetMembers).innerJoin(publicIntelligenceArtifacts, eq(publicIntelligenceDatasetMembers.artifactId, publicIntelligenceArtifacts.id)).innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id)).where(eq(publicIntelligenceDatasetMembers.datasetBuildId, build.id))
  const active = members.filter(member => member.memberStatus === 'included')
  if (active.length < 100) throw createError({ statusCode: 422, statusMessage: `A real public training manifest needs at least 100 included examples; found ${active.length}.` })
  if (new Set(active.map(member => member.sourceUrl)).size !== active.length || new Set(active.map(member => member.sourceSpanHash)).size !== active.length) throw createError({ statusCode: 422, statusMessage: 'The manifest contains duplicate source URLs or source-span fingerprints and cannot be approved.' })
  const labels: string[] = []
  for (const member of active) {
    if (trainingMemberAdmissionError(member)) throw createError({ statusCode: 422, statusMessage: 'Every training member must be an active, quality-passed, PII-cleared human annotation from an approved training source.' })
    const parsed = seoGeoMultilabelSchema.safeParse(member.fieldData)
    if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Every training member must use the active multi-dimensional SEO/GEO human-label contract.' })
    labels.push(parsed.data.primaryJourneyStage)
  }
  const missingStages = ['discovery', 'understanding', 'response', 'progression', 'conversion'].filter(stage => labels.filter(label => label === stage).length < 10)
  if (missingStages.length) throw createError({ statusCode: 422, statusMessage: `The 100-example public manifest needs at least 10 human-reviewed examples for each journey stage; insufficient: ${missingStages.join(', ')}.` })
  await database.update(publicIntelligenceDatasetBuilds).set({ status: 'approved', reviewerUserId: input.ownerUserId, reviewNote: input.reviewNote, approvedAt: new Date() }).where(eq(publicIntelligenceDatasetBuilds.id, build.id))
  return { datasetBuildId: build.id, status: 'approved' as const, artifactCount: active.length, labelCounts: Object.fromEntries(['discovery', 'understanding', 'response', 'progression', 'conversion'].map(stage => [stage, labels.filter(label => label === stage).length])) }
}

export async function listOwnerPublicArtifacts(ownerUserId: number) {
  const database = requireAuditDatabase()
  return database.select({ id: publicIntelligenceArtifacts.id, sourceId: publicIntelligenceArtifacts.sourceId, sourceName: publicIntelligenceSources.sourceName, sourceUrl: publicIntelligenceArtifacts.sourceUrl, artifactType: publicIntelligenceArtifacts.artifactType, useSnapshot: publicIntelligenceArtifacts.useSnapshot, qualityStatus: publicIntelligenceArtifacts.qualityStatus, sourceLocator: publicIntelligenceArtifacts.sourceLocator, sourceSpanHash: publicIntelligenceArtifacts.sourceSpanHash, capturedAt: publicIntelligenceArtifacts.capturedAt }).from(publicIntelligenceArtifacts).innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id)).where(and(eq(publicIntelligenceSources.ownerUserId, ownerUserId), isNull(publicIntelligenceSources.removedAt), isNull(publicIntelligenceArtifacts.removedAt))).orderBy(desc(publicIntelligenceArtifacts.createdAt))
}

export async function reviewOwnerPublicArtifact(input: { ownerUserId: number, artifactId: number, qualityStatus: 'passed' | 'needs_revision' | 'rejected', qualityNote: string | null }) {
  const database = requireAuditDatabase()
  const [artifact] = await database.select({ id: publicIntelligenceArtifacts.id }).from(publicIntelligenceArtifacts).innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id)).where(and(eq(publicIntelligenceArtifacts.id, input.artifactId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceArtifacts.removedAt), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!artifact) throw createError({ statusCode: 404, statusMessage: 'Public artifact was not found.' })
  await database.update(publicIntelligenceArtifacts).set({ qualityStatus: input.qualityStatus }).where(eq(publicIntelligenceArtifacts.id, artifact.id))
  return { artifactId: artifact.id, qualityStatus: input.qualityStatus, qualityNote: input.qualityNote }
}

export async function createOwnerPublicDatasetBuild(input: { ownerUserId: number, datasetName: string, datasetVersion: string, intendedUse: 'research' | 'evaluation' | 'training', featureContractVersion: string, labelTaxonomyVersion: string | null, splitVersion: string | null, artifactIds: number[], reviewNote: string | null }) {
  const database = requireAuditDatabase()
  const uniqueArtifactIds = [...new Set(input.artifactIds)]
  if (!uniqueArtifactIds.length) throw createError({ statusCode: 422, statusMessage: 'A dataset manifest needs at least one reviewed artifact.' })
  const requiredUse = useForIntendedDataset(input.intendedUse)
  const artifacts = await database.select({ id: publicIntelligenceArtifacts.id, artifactHash: publicIntelligenceArtifacts.artifactHash, sourceId: publicIntelligenceSources.id, sourceAllowedUse: publicIntelligenceSources.allowedUse, artifactUse: publicIntelligenceArtifacts.useSnapshot, qualityStatus: publicIntelligenceArtifacts.qualityStatus }).from(publicIntelligenceArtifacts).innerJoin(publicIntelligenceSources, eq(publicIntelligenceArtifacts.sourceId, publicIntelligenceSources.id)).where(and(inArray(publicIntelligenceArtifacts.id, uniqueArtifactIds), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), eq(publicIntelligenceSources.reviewStatus, 'approved'), isNull(publicIntelligenceSources.removedAt), isNull(publicIntelligenceArtifacts.removedAt)))
  if (artifacts.length !== uniqueArtifactIds.length) throw createError({ statusCode: 422, statusMessage: 'Every dataset artifact must be owned, active and attached to an approved Source Card.' })
  for (const artifact of artifacts) {
    if (artifact.qualityStatus !== 'passed') throw createError({ statusCode: 422, statusMessage: 'Every dataset artifact must pass human quality review.' })
    try { assertPermittedPublicUse({ requestedUse: requiredUse, maximumUse: artifact.sourceAllowedUse }); assertPermittedPublicUse({ requestedUse: requiredUse, maximumUse: artifact.artifactUse }) } catch (error) { if (error instanceof PublicUseViolation) throw createError({ statusCode: 422, statusMessage: error.message }); throw error }
  }
  const manifest = artifacts.map(artifact => ({ id: artifact.id, sourceId: artifact.sourceId, artifactHash: artifact.artifactHash })).sort((a, b) => a.id - b.id)
  const manifestHash = createHash('sha256').update(JSON.stringify({ intendedUse: input.intendedUse, featureContractVersion: input.featureContractVersion, labelTaxonomyVersion: input.labelTaxonomyVersion, splitVersion: input.splitVersion, artifacts: manifest })).digest('hex')
  const policyFilter = { requiredUse, qualityStatus: 'passed', sourceReviewStatus: 'approved', sourceStatus: 'active' }
  const result = await database.insert(publicIntelligenceDatasetBuilds).values({ ownerUserId: input.ownerUserId, datasetName: input.datasetName, datasetVersion: input.datasetVersion, intendedUse: input.intendedUse, policyFilter, featureContractVersion: input.featureContractVersion, labelTaxonomyVersion: input.labelTaxonomyVersion, splitVersion: input.splitVersion, manifestHash, status: 'ready_for_review', reviewerUserId: input.ownerUserId, reviewNote: input.reviewNote })
  const datasetBuildId = Number(result[0].insertId)
  await database.insert(publicIntelligenceDatasetMembers).values(artifacts.map(artifact => ({ datasetBuildId, artifactId: artifact.id, reviewerUserId: input.ownerUserId, inclusionReason: `Matched ${requiredUse}, approved Source Card and passed quality review.`, memberStatus: 'included' as const })))
  return { datasetBuildId, manifestHash, artifactCount: artifacts.length, status: 'ready_for_review' as const }
}

export async function createOwnerPublicArtifact(input: { ownerUserId: number, sourceId: number, sourceUrl: string, canonicalUrl: string | null, artifactType: 'page_manifest' | 'structural_features' | 'topic_map' | 'entity_map' | 'semantic_features' | 'technical_seo' | 'derived_excerpt' | 'human_annotation', artifactText: string | null, sourceLocator: string | null, sourceSpanHash: string | null, fieldData: object, language: string | null, extractionMethod: 'manual' | 'public_api' | 'policy_approved_fetch' | 'human_annotation', requestedUse: PublicUse, retentionUntil: Date | null }) {
  const database = requireAuditDatabase()
  const [source] = await database.select({ id: publicIntelligenceSources.id, allowedUse: publicIntelligenceSources.allowedUse, reviewStatus: publicIntelligenceSources.reviewStatus, piiStatus: publicIntelligenceSources.piiStatus }).from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.id, input.sourceId), eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), isNull(publicIntelligenceSources.removedAt))).limit(1)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'Public source was not found.' })
  if (source.reviewStatus !== 'approved') throw createError({ statusCode: 422, statusMessage: 'Approve the Source Card before adding artifacts.' })
  try { assertPermittedPublicUse({ requestedUse: input.requestedUse, maximumUse: source.allowedUse }) } catch (error) { if (error instanceof PublicUseViolation) throw createError({ statusCode: 422, statusMessage: error.message }); throw error }
  const artifactHash = artifactFingerprint({ sourceId: source.id, sourceUrl: input.sourceUrl, sourceSpanHash: input.sourceSpanHash, artifactType: input.artifactType, sourceLocator: input.sourceLocator, artifactText: input.artifactText, fieldData: input.fieldData })
  const result = await database.insert(publicIntelligenceArtifacts).values({ ...input, artifactHash, useSnapshot: input.requestedUse, extractionVersion: 'public-intelligence-v1', qualityStatus: 'pending', piiStatus: source.piiStatus === 'none_detected' ? 'none_detected' : 'unreviewed', capturedAt: new Date() })
  return { id: Number(result[0].insertId), artifactHash, useSnapshot: input.requestedUse }
}
