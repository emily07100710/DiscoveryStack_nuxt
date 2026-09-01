import { setResponseHeaders } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getManagedSiteLiveConnectorWorkspace } from '../../../managed-sites/live-connectors/workspace'
import { managedSiteOnRequestProvisionAdvancer } from '../../../managed-sites/live-connectors/provision-advancer'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const response = await getManagedSiteLiveConnectorWorkspace(ownerUserId)
  const advancer = managedSiteOnRequestProvisionAdvancer()
  if (advancer) {
    const advancement = advancer({ ownerUserId, limit: 3 }).catch(() => ({ scanned: 0, advanced: 0, failed: 0 }))
    const waitUntil = (event as typeof event & { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil
    if (typeof waitUntil === 'function') waitUntil.call(event, advancement)
    else void advancement
  }
  return response
})
