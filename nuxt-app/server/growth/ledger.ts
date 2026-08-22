import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../database'
import { growthExperimentReviews, growthExperimentVariants, growthExperiments, growthMeasurements, growthResearchConsents, growthResearchIntakes, leads } from '../database/schema'

export const GROWTH_RESEARCH_SCOPE = 'governed_seo_geo_growth_research'
export const GROWTH_RESEARCH_COPY_VERSION = 'growth-research-consent-v1'

export type PairedTrainingEligibilityReason =
  | 'CONSENT_MISSING'
  | 'CONSENT_REVOKED'
  | 'INTAKE_NOT_APPROVED'
  | 'EXPERIMENT_NOT_APPROVED'
  | 'VARIANT_MISSING'
  | 'MEASUREMENT_MISSING'
  | 'FACTUALITY_NOT_PASSED'
  | 'QUALITY_NOT_PASSED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'LINEAGE_INCOMPLETE'
  | 'AUTO_PUBLISH_ENABLED'

export function canonicalGrowthWebsite(rawWebsite: string) {
  const url = new URL(rawWebsite)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw createError({ statusCode: 422, statusMessage: 'A valid public http(s) website is required for research consent.' })
  url.hash = ''
  return { canonicalWebsiteUrl: url.toString(), domain: url.hostname.toLowerCase() }
}

export async function appendGrantedGrowthConsent(input: { leadId: number, website?: string, locale: 'en' | 'zh-hant', requestFingerprintHash: string }) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research consent is temporarily unavailable.' })
  const consent = await database.insert(growthResearchConsents).values({ leadId: input.leadId, action: 'granted', scope: GROWTH_RESEARCH_SCOPE, copyVersion: GROWTH_RESEARCH_COPY_VERSION, locale: input.locale, requestFingerprintHash: input.requestFingerprintHash })
  const consentId = Number(consent[0].insertId)
  if (!input.website) return { consentId, intakeId: null }
  const website = canonicalGrowthWebsite(input.website)
  const intake = await database.insert(growthResearchIntakes).values({ leadId: input.leadId, ...website, locale: input.locale, consentId })
  return { consentId, intakeId: Number(intake[0].insertId) }
}

export async function revokeGrowthResearchConsent(input: { ownerUserId: number, leadId: number, requestFingerprintHash: string }) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research consent is temporarily unavailable.' })
  const [lead] = await database.select({ id: leads.id, language: leads.language }).from(leads).where(eq(leads.id, input.leadId)).limit(1)
  if (!lead) throw createError({ statusCode: 404, statusMessage: 'Lead was not found.' })
  const now = new Date()
  await database.insert(growthResearchConsents).values({ leadId: lead.id, action: 'revoked', scope: GROWTH_RESEARCH_SCOPE, copyVersion: GROWTH_RESEARCH_COPY_VERSION, locale: lead.language, requestFingerprintHash: input.requestFingerprintHash })
  await database.update(growthResearchIntakes).set({ status: 'revoked', consentRevokedAt: now }).where(eq(growthResearchIntakes.leadId, lead.id))
  const intakes = await database.select({ id: growthResearchIntakes.id }).from(growthResearchIntakes).where(eq(growthResearchIntakes.leadId, lead.id))
  if (intakes.length) await database.update(growthExperiments).set({ status: 'revoked' }).where(inArray(growthExperiments.intakeId, intakes.map(intake => intake.id)))
  return { revokedAt: now }
}

export function pairedTrainingEligibility(input: {
  hasGrantedConsent: boolean
  consentRevoked: boolean
  intakeStatus: 'pending_review' | 'approved' | 'rejected' | 'revoked'
  experimentStatus: 'draft' | 'ready_for_review' | 'approved' | 'rejected' | 'revoked'
  hasControlVariant: boolean
  hasCandidateVariant: boolean
  controlFactualityPassed: boolean
  candidateFactualityPassed: boolean
  controlQualityPassed: boolean
  candidateQualityPassed: boolean
  hasRealMeasurement: boolean
  hasCompleteLineage: boolean
  autoPublish: boolean
  review?: { decision: 'approved' | 'needs_revision' | 'rejected', factualityDecision: 'passed' | 'failed', brandQualityDecision: 'passed' | 'failed', approvedForDataset: boolean } | null
}) {
  const reasons: PairedTrainingEligibilityReason[] = []
  if (!input.hasGrantedConsent) reasons.push('CONSENT_MISSING')
  if (input.consentRevoked || input.intakeStatus === 'revoked' || input.experimentStatus === 'revoked') reasons.push('CONSENT_REVOKED')
  if (input.intakeStatus !== 'approved') reasons.push('INTAKE_NOT_APPROVED')
  if (input.experimentStatus !== 'approved') reasons.push('EXPERIMENT_NOT_APPROVED')
  if (!input.hasControlVariant || !input.hasCandidateVariant) reasons.push('VARIANT_MISSING')
  if (!input.hasRealMeasurement) reasons.push('MEASUREMENT_MISSING')
  if (!input.controlFactualityPassed || !input.candidateFactualityPassed || input.review?.factualityDecision !== 'passed') reasons.push('FACTUALITY_NOT_PASSED')
  if (!input.controlQualityPassed || !input.candidateQualityPassed || input.review?.brandQualityDecision !== 'passed') reasons.push('QUALITY_NOT_PASSED')
  if (input.review?.decision !== 'approved' || !input.review.approvedForDataset) reasons.push('HUMAN_REVIEW_REQUIRED')
  if (!input.hasCompleteLineage) reasons.push('LINEAGE_INCOMPLETE')
  if (input.autoPublish) reasons.push('AUTO_PUBLISH_ENABLED')
  return { eligible: reasons.length === 0, reasons }
}

export async function getPairedTrainingEligibility(experimentId: number) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const [experiment] = await database.select({ id: growthExperiments.id, status: growthExperiments.status, intakeStatus: growthResearchIntakes.status, consentRevokedAt: growthResearchIntakes.consentRevokedAt, leadId: growthResearchIntakes.leadId, modelId: growthExperiments.modelId, modelRevision: growthExperiments.modelRevision, ruleRevision: growthExperiments.ruleRevision, datasetRevision: growthExperiments.datasetRevision, autoPublish: growthExperiments.autoPublish }).from(growthExperiments).innerJoin(growthResearchIntakes, eq(growthExperiments.intakeId, growthResearchIntakes.id)).where(eq(growthExperiments.id, experimentId)).limit(1)
  if (!experiment) throw createError({ statusCode: 404, statusMessage: 'Growth experiment was not found.' })
  const [latestConsent] = await database.select({ action: growthResearchConsents.action }).from(growthResearchConsents).where(eq(growthResearchConsents.leadId, experiment.leadId)).orderBy(desc(growthResearchConsents.occurredAt), desc(growthResearchConsents.id)).limit(1)
  const variants = await database.select({ variantType: growthExperimentVariants.variantType, contentHash: growthExperimentVariants.contentHash, factualityStatus: growthExperimentVariants.factualityStatus, qualityStatus: growthExperimentVariants.qualityStatus }).from(growthExperimentVariants).where(eq(growthExperimentVariants.experimentId, experiment.id))
  const [review] = await database.select({ decision: growthExperimentReviews.decision, factualityDecision: growthExperimentReviews.factualityDecision, brandQualityDecision: growthExperimentReviews.brandQualityDecision, approvedForDataset: growthExperimentReviews.approvedForDataset }).from(growthExperimentReviews).where(eq(growthExperimentReviews.experimentId, experiment.id)).orderBy(desc(growthExperimentReviews.reviewedAt), desc(growthExperimentReviews.id)).limit(1)
  const measurements = await database.select({ provenance: growthMeasurements.provenance }).from(growthMeasurements).where(eq(growthMeasurements.experimentId, experiment.id))
  const control = variants.find(variant => variant.variantType === 'control' && Boolean(variant.contentHash.trim()))
  const candidate = variants.find(variant => variant.variantType === 'candidate' && Boolean(variant.contentHash.trim()))
  return pairedTrainingEligibility({
    hasGrantedConsent: latestConsent?.action === 'granted',
    consentRevoked: Boolean(experiment.consentRevokedAt),
    intakeStatus: experiment.intakeStatus,
    experimentStatus: experiment.status,
    hasControlVariant: Boolean(control),
    hasCandidateVariant: Boolean(candidate),
    controlFactualityPassed: control?.factualityStatus === 'passed',
    candidateFactualityPassed: candidate?.factualityStatus === 'passed',
    controlQualityPassed: control?.qualityStatus === 'passed',
    candidateQualityPassed: candidate?.qualityStatus === 'passed',
    hasRealMeasurement: measurements.some(measurement => measurement.provenance === 'observed' || measurement.provenance === 'human_confirmed'),
    hasCompleteLineage: Boolean(experiment.modelId?.trim() && experiment.modelRevision?.trim() && experiment.ruleRevision?.trim() && experiment.datasetRevision?.trim()),
    autoPublish: experiment.autoPublish,
    review,
  })
}

export const autoGeoProviderStatus = Object.freeze({ foundationAvailable: true, providerConfigured: false, modelLoaded: false, liveApiApproved: false, autoPublishEnabled: false, status: 'blocked' as const, reason: 'AutoGEO foundation is available, but no provider/model is configured or approved for live requests.' })
