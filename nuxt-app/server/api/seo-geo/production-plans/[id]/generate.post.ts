import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { getProductionPlanDetail } from '../../../../seo-geo-core/repository'
import { runOwnerProductionPlan } from '../../../../seo-geo-core/service'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const planId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(planId) || planId <= 0) throw createError({ statusCode: 422, statusMessage: 'Invalid Production Plan ID.' })
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const generated = await runOwnerProductionPlan({ ownerUserId, planId })
  setHeader(event, 'cache-control', 'no-store')
  return { ...generated, detail: await getProductionPlanDetail(ownerUserId, planId) }
})
