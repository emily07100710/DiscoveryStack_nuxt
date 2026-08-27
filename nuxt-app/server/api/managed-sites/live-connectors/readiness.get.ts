import { setResponseHeaders } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getManagedSiteProviderReadiness } from '../../../managed-sites/live-connectors/provider-registry'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  return getManagedSiteProviderReadiness(ownerUserId)
})
