import { setResponseHeaders } from 'h3'
import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getCustomerSystemStatus } from '../../../system-factory/service'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  const access = await requireManagedSiteCustomer(event)
  return getCustomerSystemStatus(access.project.ownerUserId, access.project.id)
})
