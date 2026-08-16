import { z } from 'zod'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { listOwnerPublicSourceReviews } from '../../../../public-intelligence/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const sourceId = z.coerce.number().int().positive().parse(getRouterParam(event, 'id'))
  return listOwnerPublicSourceReviews({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), sourceId })
})
