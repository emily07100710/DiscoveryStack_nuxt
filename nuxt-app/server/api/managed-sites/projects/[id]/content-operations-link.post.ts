import { getRouterParam, readBody } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { linkManagedSiteContentOperations } from '../../../../managed-sites/modules-service'
import { parsePathId } from '../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  return linkManagedSiteContentOperations(ownerUserId, projectId, await readBody(event), undefined, undefined)
})
