import { getRouterParam } from 'h3'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { changeManagedSiteDesignCareState } from '../../../../managed-sites/design-care'
import { assertSameOriginManagedSiteMutation, privateManagedSiteHeaders } from '../../../../managed-sites/live-connectors/http'
import { parsePathId } from '../../../../managed-sites/normalization'
import { requireOwner } from '../../../../utils/auth'
import { readBoundedRequestBody } from '../../../../utils/bounded-request-body'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  assertSameOriginManagedSiteMutation(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBoundedRequestBody(event, {
    maxBytes: 4 * 1024,
    oversizedMessage: '設計調整狀態內容過大。',
    invalidMessage: '設計調整狀態格式不正確。',
    invalidStatusCode: 422,
  })
  return changeManagedSiteDesignCareState(ownerUserId, projectId, ownerUserId, body)
})
