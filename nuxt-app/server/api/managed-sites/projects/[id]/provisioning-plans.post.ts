import { getRouterParam, readBody } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { createManagedSiteProvisioningPlan } from '../../../../managed-sites/provisioning-service'
import { parsePathId } from '../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  return createManagedSiteProvisioningPlan(ownerUserId, { ...(await readBody(event) || {}), projectId })
})
