import { requireManagedSiteCustomer, requireManagedSiteCustomerPermission } from '../../../managed-sites/auth'
import { requestManagedSiteDesignCare } from '../../../managed-sites/design-care'
import { assertSameOriginManagedSiteMutation, privateManagedSiteHeaders } from '../../../managed-sites/live-connectors/http'
import { readBoundedRequestBody } from '../../../utils/bounded-request-body'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  assertSameOriginManagedSiteMutation(event)
  const access = requireManagedSiteCustomerPermission(await requireManagedSiteCustomer(event), 'content:write')
  const body = await readBoundedRequestBody(event, {
    maxBytes: 8 * 1024,
    oversizedMessage: '設計調整需求內容過大。',
    invalidMessage: '設計調整需求格式不正確。',
    invalidStatusCode: 422,
  })
  return requestManagedSiteDesignCare(access.project.ownerUserId, access.project.id, access.membership.id, body)
})
