import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { removeOwnerPublicSource } from '../../../../public-intelligence/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const sourceId = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  const body = z.object({ reviewNote: z.string().trim().max(3000).nullable().optional().default(null) }).parse(await readBody(event))
  return removeOwnerPublicSource({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), sourceId, reviewNote: body.reviewNote })
})
