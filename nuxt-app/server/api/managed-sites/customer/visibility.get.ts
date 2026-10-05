import { requireManagedSiteCustomer, requireManagedSiteCustomerPermission } from '../../../managed-sites/auth'
import { getManagedSiteCustomerVisibilityDashboard } from '../../../managed-sites/customer-visibility-service'

export default defineEventHandler(async event => {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  const access = requireManagedSiteCustomerPermission(await requireManagedSiteCustomer(event), 'content:read')
  return getManagedSiteCustomerVisibilityDashboard(access.project.ownerUserId, access.project.id)
})
