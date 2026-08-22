import { desc } from 'drizzle-orm'
import { getDatabase } from '../../database'
import { growthExperiments, growthResearchIntakes } from '../../database/schema'
import { autoGeoProviderStatus } from '../../growth/ledger'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  await requireOwner(event)
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const [intakes, experiments] = await Promise.all([
    database.select({ id: growthResearchIntakes.id, canonicalWebsiteUrl: growthResearchIntakes.canonicalWebsiteUrl, domain: growthResearchIntakes.domain, locale: growthResearchIntakes.locale, status: growthResearchIntakes.status, ownerReviewNote: growthResearchIntakes.ownerReviewNote, reviewedAt: growthResearchIntakes.reviewedAt, consentRevokedAt: growthResearchIntakes.consentRevokedAt, createdAt: growthResearchIntakes.createdAt }).from(growthResearchIntakes).orderBy(desc(growthResearchIntakes.createdAt)).limit(100),
    database.select({ id: growthExperiments.id, intakeId: growthExperiments.intakeId, sourceUrl: growthExperiments.sourceUrl, sourceContentHash: growthExperiments.sourceContentHash, locale: growthExperiments.locale, targetEngine: growthExperiments.targetEngine, queryFingerprint: growthExperiments.queryFingerprint, rewriteMode: growthExperiments.rewriteMode, modelId: growthExperiments.modelId, modelRevision: growthExperiments.modelRevision, ruleRevision: growthExperiments.ruleRevision, datasetRevision: growthExperiments.datasetRevision, status: growthExperiments.status, autoPublish: growthExperiments.autoPublish, createdAt: growthExperiments.createdAt }).from(growthExperiments).orderBy(desc(growthExperiments.createdAt)).limit(100),
  ])
  return { intakes, experiments, provider: autoGeoProviderStatus }
})
