import { getRouterParam } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parsePathId } from '../../../../managed-sites/normalization'
import { prepareCustomerRuntime } from '../../../../managed-sites/customer-runtime'
import { assertSameOriginManagedSiteMutation, privateManagedSiteHeaders } from '../../../../managed-sites/live-connectors/http'
import { readBoundedRequestBody } from '../../../../utils/bounded-request-body'

export default defineEventHandler(async event => {
  privateManagedSiteHeaders(event)
  assertSameOriginManagedSiteMutation(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBoundedRequestBody(event, { maxBytes: 4096, oversizedMessage: '網站生成設定過大。', invalidMessage: '網站生成設定格式不正確。', invalidStatusCode: 422 })
  return prepareCustomerRuntime(ownerUserId, projectId, body)
})
