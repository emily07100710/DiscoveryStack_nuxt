import { z } from 'zod'
import { journeyStages } from '../../audit/types'
import { recordAuditReview } from '../../audit/review'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { requireOwner } from '../../utils/auth'

const reviewInput = z.object({
  auditRunId: z.number().int().positive(),
  decision: z.enum(['confirmed', 'amended', 'rejected']),
  correctedPrimaryStage: z.enum(journeyStages).nullable(),
  reviewNote: z.string().trim().max(3_000).nullable(),
  qualityCheckStatus: z.enum(['pending', 'passed', 'needs_revision', 'rejected']),
  approvedForTraining: z.boolean(),
}).superRefine((input, context) => {
  if ((input.decision === 'confirmed' || input.decision === 'amended') && (!input.correctedPrimaryStage || !input.reviewNote)) context.addIssue({ code: 'custom', message: 'A confirmed or amended label requires a primary stage and rationale.' })
  if (input.approvedForTraining && (input.decision === 'rejected' || input.qualityCheckStatus !== 'passed')) context.addIssue({ code: 'custom', message: 'Training approval requires a non-rejected review that has passed quality checks.' })
})

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const parsed = reviewInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review decision is incomplete.', data: parsed.error.flatten().fieldErrors })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return recordAuditReview({ ownerUserId, auditRunId: parsed.data.auditRunId, review: parsed.data })
})
