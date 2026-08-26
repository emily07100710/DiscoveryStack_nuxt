import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getManagedSiteCustomerProjection } from '../../../managed-sites/service'

export default defineEventHandler(async (event) => {
  const access = await requireManagedSiteCustomer(event)
  return getManagedSiteCustomerProjection(access.token)
})
