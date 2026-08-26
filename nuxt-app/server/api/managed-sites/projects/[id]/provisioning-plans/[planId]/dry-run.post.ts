import { getRouterParam } from 'h3'
import { requireOwner } from '../../../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../../../audit/repository'
import { executeManagedSiteProvisioningPlan } from '../../../../../../managed-sites/provisioning-service'
import { parsePathId } from '../../../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const planId = parsePathId(getRouterParam(event, 'planId'), 'Managed site provisioning plan id')
  const result = await executeManagedSiteProvisioningPlan(ownerUserId, planId, 'dry_run')
  if (!result.plan || result.plan.projectId !== projectId) throw createError({ statusCode: 404, statusMessage: 'Managed site provisioning plan was not found.' })
  return result
})
