import { getRouterParam } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { inviteAndDeliverManagedSiteMember } from '../../../../managed-sites/member-invitation-delivery'
import { parsePathId } from '../../../../managed-sites/normalization'
import { assertSameOriginManagedSiteMutation, privateManagedSiteHeaders } from '../../../../managed-sites/live-connectors/http'
import { readBoundedRequestBody } from '../../../../utils/bounded-request-body'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  assertSameOriginManagedSiteMutation(event)
  const body = await readBoundedRequestBody(event, { maxBytes: 12 * 1024, oversizedMessage: '成員邀請內容過大。', invalidMessage: '成員邀請內容格式不正確。', invalidStatusCode: 422 })
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  return inviteAndDeliverManagedSiteMember(ownerUserId, projectId, { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session', role: 'owner' }, body)
})
