import { getRouterParam, getQuery } from 'h3'
import { requireOwner } from '../../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../../audit/repository'
import { revokeManagedSiteMember } from '../../../../../managed-sites/service'
import { parsePathId } from '../../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const membershipId = parsePathId(getRouterParam(event, 'membershipId'), 'Managed site membership id')
  const query = getQuery(event)
  const idempotencyKey = typeof query.idempotencyKey === 'string' ? query.idempotencyKey : `revoke:${projectId}:${membershipId}`
  return revokeManagedSiteMember(ownerUserId, projectId, membershipId, { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session', role: 'owner' }, idempotencyKey)
})
