import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { requireManagedSiteCustomerPermission } from '../../../managed-sites/auth'
import { getManagedSiteContentAdminWorkspace } from '../../../managed-sites/content-admin-service'

export default defineEventHandler(async (event) => {
  const access = requireManagedSiteCustomerPermission(await requireManagedSiteCustomer(event), 'content:read')
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  return getManagedSiteContentAdminWorkspace(access.project.ownerUserId, access.project.id, access.membership.role)
})
