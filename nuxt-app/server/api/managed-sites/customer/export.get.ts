import { requireManagedSiteCustomer, requireManagedSiteCustomerPermission } from '../../../managed-sites/auth'
import { exportManagedSiteCustomerData } from '../../../managed-sites/service'

export default defineEventHandler(async (event) => {
  const access = requireManagedSiteCustomerPermission(await requireManagedSiteCustomer(event), 'data:export')
  setHeader(event, 'Content-Disposition', 'attachment; filename="managed-site-customer-export.json"')
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  return exportManagedSiteCustomerData(access.token)
})
