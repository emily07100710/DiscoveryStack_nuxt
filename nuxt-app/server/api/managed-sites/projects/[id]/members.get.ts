import { getRouterParam } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { listManagedSiteMembers } from '../../../../managed-sites/service'
import { parsePathId } from '../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  return { members: await listManagedSiteMembers(ownerUserId, projectId, { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session', role: 'owner' }) }
})
