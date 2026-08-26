import { getRouterParam, readBody } from 'h3'
import { requireOwner } from '../../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../../audit/repository'
import { updateManagedSiteMemberRole } from '../../../../../managed-sites/service'
import { parsePathId } from '../../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const membershipId = parsePathId(getRouterParam(event, 'membershipId'), 'Managed site membership id')
  return updateManagedSiteMemberRole(ownerUserId, projectId, membershipId, { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session', role: 'owner' }, await readBody(event))
})
