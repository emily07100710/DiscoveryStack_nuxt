import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { approveOwnerPublicSource } from '../../../../public-intelligence/repository'
import { requireOwner } from '../../../../utils/auth'

const inputSchema = z.object({ requestedUse: z.enum(['research_only', 'evaluation_candidate', 'training_candidate']), reviewNote: z.string().trim().max(3000).nullable().optional().default(null) })
export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const sourceId = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  const parsed = inputSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Review the source approval fields.' })
  return approveOwnerPublicSource({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), sourceId, ...parsed.data })
})
