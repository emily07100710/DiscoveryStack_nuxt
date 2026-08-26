import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { exportManagedSiteCustomerData } from '../../../managed-sites/service'

export default defineEventHandler(async (event) => {
  const access = await requireManagedSiteCustomer(event)
  setHeader(event, 'Content-Disposition', 'attachment; filename="managed-site-customer-export.json"')
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  return exportManagedSiteCustomerData(access.token)
})
