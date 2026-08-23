import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createContentReview } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

const inputSchema = z.object({ jobId: z.number().int().positive(), draftId: z.number().int().positive(), decision: z.enum(['approved_for_preview', 'approved_for_delivery', 'changes_requested', 'rejected']), reviewNote: z.string().trim().max(4000).optional() })

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review decision is incomplete.', data: parsed.error.flatten().fieldErrors })
  return createContentReview({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), ...parsed.data })
})
