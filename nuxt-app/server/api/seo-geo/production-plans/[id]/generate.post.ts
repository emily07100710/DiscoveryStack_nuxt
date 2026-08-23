import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { runOwnerProductionPlan } from '../../../../seo-geo-core/service'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const planId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(planId) || planId <= 0) throw createError({ statusCode: 422, statusMessage: 'Invalid Production Plan ID.' })
  return runOwnerProductionPlan({ ownerUserId: await getOwnerDatabaseUserId(owner.openId), planId })
})
