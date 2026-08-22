import { eq } from 'drizzle-orm'
import { getDatabase } from '../../../../database'
import { growthExperimentReviews, growthExperiments, users } from '../../../../database/schema'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const experimentId = Number(event.context.params?.id)
  const body = await readBody<{ decision?: 'approved' | 'needs_revision' | 'rejected', factualityDecision?: 'passed' | 'failed', brandQualityDecision?: 'passed' | 'failed', approvedForDataset?: boolean, reviewNote?: string }>(event)
  if (!Number.isInteger(experimentId) || !['approved', 'needs_revision', 'rejected'].includes(body?.decision || '') || !['passed', 'failed'].includes(body?.factualityDecision || '') || !['passed', 'failed'].includes(body?.brandQualityDecision || '')) throw createError({ statusCode: 422, statusMessage: 'A complete human review is required.' })
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Growth research ledger is temporarily unavailable.' })
  const [reviewer] = await database.select({ id: users.id }).from(users).where(eq(users.openId, owner.openId)).limit(1)
  if (!reviewer) throw createError({ statusCode: 403, statusMessage: 'Owner record is unavailable.' })
  await database.insert(growthExperimentReviews).values({ experimentId, reviewerUserId: reviewer.id, decision: body.decision!, factualityDecision: body.factualityDecision!, brandQualityDecision: body.brandQualityDecision!, approvedForDataset: body.approvedForDataset === true, reviewNote: body.reviewNote?.slice(0, 4000) || null })
  await database.update(growthExperiments).set({ status: body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : 'ready_for_review', completedAt: new Date(), autoPublish: false }).where(eq(growthExperiments.id, experimentId))
  return { ok: true, autoPublish: false }
})
