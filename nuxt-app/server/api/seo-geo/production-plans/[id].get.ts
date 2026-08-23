import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getProductionPlanDetail } from '../../../seo-geo-core/repository'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const planId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(planId) || planId < 1) throw createError({ statusCode: 422, statusMessage: 'Production Plan ID is invalid.' })
  setHeader(event, 'cache-control', 'no-store')
  return getProductionPlanDetail(await getOwnerDatabaseUserId(owner.openId), planId)
})
