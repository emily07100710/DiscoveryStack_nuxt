import { getRouterParam } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getOwnerManagedSite } from '../../../managed-sites/service'
import { parsePathId } from '../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  return { project: await getOwnerManagedSite(ownerUserId, projectId) }
})
