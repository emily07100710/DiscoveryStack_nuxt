import { setHeader } from 'h3'
import { requireManagedSiteCustomer } from '../../../managed-sites/auth'
import { getManagedSiteCustomerProjection } from '../../../managed-sites/service'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  const access = await requireManagedSiteCustomer(event)
  return getManagedSiteCustomerProjection(access.token)
})
