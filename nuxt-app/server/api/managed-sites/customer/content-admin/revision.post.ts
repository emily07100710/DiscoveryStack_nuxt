import { requireManagedSiteCustomer } from '../../../../managed-sites/auth'
import { requireManagedSiteCustomerPermission } from '../../../../managed-sites/auth'
import { parsePathId } from '../../../../managed-sites/normalization'
import { requestManagedContentRevision } from '../../../../managed-sites/content-admin-service'

export default defineEventHandler(async (event) => {
  const access = requireManagedSiteCustomerPermission(await requireManagedSiteCustomer(event), 'content:write')
  const entryId = parsePathId(getRouterParam(event, 'entryId'), 'Content operation entry id')
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  return requestManagedContentRevision(access.project.ownerUserId, access.project.id, entryId, access.membership.role, await readBody(event) || {})
})
