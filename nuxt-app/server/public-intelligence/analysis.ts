import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { BGE_M3_MODEL_ID, BGE_M3_PILOT_MAX_CANDIDATES, BGE_M3_PILOT_MIN_CANDIDATES, buildBaselineReadiness } from '../audit/baselines'
import { classifyJourneyFriction } from '../audit/classifier'
import { cosineSimilarity, embedFeatureDocuments } from '../audit/huggingface'
import { CLASSIFIER_VERSION, type ClassifiableObservation } from '../audit/types'
import { publicIntelligenceArtifacts, publicIntelligenceInferences, publicIntelligenceIngestionJobs, publicIntelligenceSources } from '../database/schema'
import { assertPermittedPublicUse, PublicUseViolation } from './policy'
import { requireAuditDatabase } from '../audit/repository'

type StructuralFeatureData = { signals: { primaryCta: boolean, serviceRouting: boolean, expertContact: boolean, insights: boolean, trustSignals: boolean, priceOrEstimator: boolean, faqOrGuidedTopics: boolean }, primaryJourneyStage: string, navigationDepth: number, serviceRoutes: number }
type CompletedJob = { id: number, sourceId: number, sourceUrl: string, language: string | null, allowedUse: 'research_only' | 'evaluation_candidate' | 'training_candidate' | 'blocked', reviewStatus: 'pending' | 'approved' | 'needs_policy_review' | 'rejected' | 'removed', piiStatus: 'unreviewed' | 'none_detected' | 'possible' | 'restricted', artifactId: number, artifactHash: string, fieldData: unknown }

const structuralSchema = z.object({
  signals: z.object({ primaryCta: z.boolean(), serviceRouting: z.boolean(), expertContact: z.boolean(), insights: z.boolean(), trustSignals: z.boolean(), priceOrEstimator: z.boolean(), faqOrGuidedTopics: z.boolean() }),
  primaryJourneyStage: z.enum(['discovery', 'understanding', 'response', 'progression', 'conversion']),
  navigationDepth: z.number().int().min(0),
  serviceRoutes: z.number().int().min(0),
})

function fingerprint(value: object) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

function observationRows(job: CompletedJob, feature: StructuralFeatureData): ClassifiableObservation[] {
  const pairs: Array<[string, boolean]> = [
    ['content.service_language', feature.signals.serviceRouting],
    ['content.faq_present', feature.signals.faqOrGuidedTopics],
    ['journey.contact_route', feature.signals.expertContact],
    ['journey.booking_route', false],
    ['journey.cta_present', feature.signals.primaryCta],
  ]
  return pairs.map(([observationKey, value], index) => ({ id: job.artifactId * 100 + index, observationKey, valueText: String(value), evidenceQuote: null, sourceUrl: job.sourceUrl }))
}

/** A PII-free feature string sent to BGE-M3. Never include raw text, source name, URL, owner or performance outcomes. */
export function serialisePublicStructuralFeature(feature: StructuralFeatureData) {
  return [
    'contract=public-intelligence-structural-v1',
    `primary_journey_stage=${feature.primaryJourneyStage}`,
    `navigation_depth=${feature.navigationDepth}`,
    `service_routes=${feature.serviceRoutes}`,
    ...Object.entries(feature.signals).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`),
  ].join('\n')
}

async function completedJobsForOwner(ownerUserId: number, jobIds: number[]) {
  const database = requireAuditDatabase()
  const uniqueIds = [...new Set(jobIds)]
  const rows = await database.select({
    id: publicIntelligenceIngestionJobs.id,
    sourceId: publicIntelligenceIngestionJobs.sourceId,
    sourceUrl: publicIntelligenceIngestionJobs.requestedUrl,
    language: publicIntelligenceSources.language,
    allowedUse: publicIntelligenceSources.allowedUse,
    reviewStatus: publicIntelligenceSources.reviewStatus,
    piiStatus: publicIntelligenceSources.piiStatus,
    artifactId: publicIntelligenceArtifacts.id,
    artifactHash: publicIntelligenceArtifacts.artifactHash,
    fieldData: publicIntelligenceArtifacts.fieldData,
  }).from(publicIntelligenceIngestionJobs)
    .innerJoin(publicIntelligenceSources, eq(publicIntelligenceIngestionJobs.sourceId, publicIntelligenceSources.id))
    .innerJoin(publicIntelligenceArtifacts, eq(publicIntelligenceIngestionJobs.primaryArtifactId, publicIntelligenceArtifacts.id))
    .where(and(inArray(publicIntelligenceIngestionJobs.id, uniqueIds), eq(publicIntelligenceIngestionJobs.ownerUserId, ownerUserId), eq(publicIntelligenceIngestionJobs.status, 'completed'), eq(publicIntelligenceSources.reviewStatus, 'approved'), eq(publicIntelligenceSources.piiStatus, 'none_detected'), isNull(publicIntelligenceSources.removedAt), isNull(publicIntelligenceArtifacts.removedAt)))
  if (rows.length !== uniqueIds.length) throw createError({ statusCode: 422, statusMessage: 'Every analysis job must be completed, owned, source-approved, PII-clear and have an active derived artifact.' })
  return rows as CompletedJob[]
}

async function persistInference(input: { ownerUserId: number, job: CompletedJob, analysisKind: 'journey_friction_baseline' | 'bge_m3_similarity', modelFamily: 'rule_baseline' | 'bge_m3', modelVersion: string, artifactIds: number[], output: object, status: 'completed' | 'needs_human_review' | 'blocked' | 'failed' }) {
  const database = requireAuditDatabase()
  const inputFingerprint = fingerprint({ analysisKind: input.analysisKind, modelVersion: input.modelVersion, artifactIds: [...input.artifactIds].sort(), output: input.output })
  const result = await database.insert(publicIntelligenceInferences).values({ ownerUserId: input.ownerUserId, sourceId: input.job.sourceId, ingestionJobId: input.job.id, artifactIds: input.artifactIds, analysisKind: input.analysisKind, modelFamily: input.modelFamily, modelVersion: input.modelVersion, inputFingerprint, output: input.output, status: input.status, requiresHumanReview: true })
  return Number(result[0].insertId)
}

export async function listOwnerPublicInferences(ownerUserId: number) {
  const database = requireAuditDatabase()
  return database.select({ id: publicIntelligenceInferences.id, sourceId: publicIntelligenceInferences.sourceId, sourceName: publicIntelligenceSources.sourceName, ingestionJobId: publicIntelligenceInferences.ingestionJobId, analysisKind: publicIntelligenceInferences.analysisKind, modelFamily: publicIntelligenceInferences.modelFamily, modelVersion: publicIntelligenceInferences.modelVersion, status: publicIntelligenceInferences.status, requiresHumanReview: publicIntelligenceInferences.requiresHumanReview, createdAt: publicIntelligenceInferences.createdAt }).from(publicIntelligenceInferences)
    .innerJoin(publicIntelligenceSources, eq(publicIntelligenceInferences.sourceId, publicIntelligenceSources.id))
    .where(eq(publicIntelligenceInferences.ownerUserId, ownerUserId)).orderBy(desc(publicIntelligenceInferences.createdAt))
}

export async function runPublicFrictionBaseline(input: { ownerUserId: number, ingestionJobId: number }) {
  const [job] = await completedJobsForOwner(input.ownerUserId, [input.ingestionJobId])
  if (!job) throw createError({ statusCode: 422, statusMessage: 'No completed feature record is available for this analysis.' })
  const parsed = structuralSchema.safeParse(job.fieldData)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'The selected derived artifact does not match the structural feature contract.' })
  const language = job.language === 'en' ? 'en' : 'zh-hant'
  const assessments = classifyJourneyFriction(observationRows(job, parsed.data), language)
  const output = { analysisBoundary: 'Public structural evidence only. It is not a conversion prediction or business-performance claim.', assessments: assessments.map(item => ({ journeyStage: item.journeyStage, priorityRank: item.priorityRank, score: item.score, assessmentStatus: item.assessmentStatus, summary: item.summary, evidenceKeys: item.evidence.map(evidence => evidence.observationKey) })) }
  const inferenceId = await persistInference({ ownerUserId: input.ownerUserId, job, analysisKind: 'journey_friction_baseline', modelFamily: 'rule_baseline', modelVersion: CLASSIFIER_VERSION, artifactIds: [job.artifactId], output, status: 'needs_human_review' })
  return { inferenceId, status: 'needs_human_review' as const, output }
}

export async function runPublicBgeSimilarity(input: { ownerUserId: number, ingestionJobIds: number[] }) {
  const uniqueJobIds = [...new Set(input.ingestionJobIds)]
  if (uniqueJobIds.length < BGE_M3_PILOT_MIN_CANDIDATES || uniqueJobIds.length > BGE_M3_PILOT_MAX_CANDIDATES) throw createError({ statusCode: 422, statusMessage: `Select ${BGE_M3_PILOT_MIN_CANDIDATES}–${BGE_M3_PILOT_MAX_CANDIDATES} completed documents for BGE-M3 similarity.` })
  const jobs = await completedJobsForOwner(input.ownerUserId, uniqueJobIds)
  for (const job of jobs) {
    try { assertPermittedPublicUse({ requestedUse: 'evaluation_candidate', maximumUse: job.allowedUse }) } catch (error) { if (error instanceof PublicUseViolation) throw createError({ statusCode: 422, statusMessage: 'BGE-M3 analysis needs a Source Card approved for evaluation or training, not research-only use.' }); throw error }
  }
  const features = jobs.map(job => {
    const parsed = structuralSchema.safeParse(job.fieldData)
    if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Every BGE-M3 input must be a valid derived structural feature artifact.' })
    return parsed.data
  })
  const embeddings = await embedFeatureDocuments(features.map(serialisePublicStructuralFeature))
  const anchor = jobs[0]!
  const similarities = jobs.slice(1).map((job, index) => ({ ingestionJobId: job.id, artifactId: job.artifactId, similarity: Number(cosineSimilarity(embeddings[0]!, embeddings[index + 1]!).toFixed(4)) })).sort((left, right) => right.similarity - left.similarity)
  const output = { analysisBoundary: 'BGE-M3 compares de-identified derived structural features only. Similarity is not quality, conversion likelihood or a decision.', anchorIngestionJobId: anchor.id, similarities }
  const inferenceId = await persistInference({ ownerUserId: input.ownerUserId, job: anchor, analysisKind: 'bge_m3_similarity', modelFamily: 'bge_m3', modelVersion: BGE_M3_MODEL_ID, artifactIds: jobs.map(job => job.artifactId), output, status: 'needs_human_review' })
  return { inferenceId, status: 'needs_human_review' as const, output }
}

/** This is deliberately a live API contract, not a fabricated trained model. */
export async function requestSupervisedPrediction(input: { ownerUserId: number }) {
  const database = requireAuditDatabase()
  const rows = await database.select({ sourceId: publicIntelligenceSources.id }).from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.ownerUserId, input.ownerUserId), eq(publicIntelligenceSources.reviewStatus, 'approved'), isNull(publicIntelligenceSources.removedAt)))
  const readiness = buildBaselineReadiness({ consentedCandidates: 0, stageCounts: {}, huggingFaceConfigured: Boolean(process.env.HUGGINGFACE_API_TOKEN) })
  return { status: 'training_not_ready' as const, eligibleSourceCards: rows.length, readiness: readiness.supervisedLearning, message: 'No supervised Journey Intelligence model is deployed. A prediction cannot be returned until explicit first-party consent, human-approved labels, versioned dataset splits and holdout evaluation meet the training gate.' }
}
