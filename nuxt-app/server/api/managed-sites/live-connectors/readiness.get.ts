import { setResponseHeaders } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getManagedSiteProviderReadiness } from '../../../managed-sites/live-connectors/provider-registry'
import { evaluateManagedSiteLaunchReadiness } from '../../../managed-sites/live-connectors/launch-readiness'
import { getManagedSiteLiveConnectorRepository } from '../../../managed-sites/live-connectors/repository'
import { getDiscoveryStackSetupReadiness } from '../../../managed-sites/setup-readiness'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  const repository = getManagedSiteLiveConnectorRepository()
  const [providerReadiness, launchReadiness] = await Promise.all([
    getManagedSiteProviderReadiness(ownerUserId, repository),
    evaluateManagedSiteLaunchReadiness(ownerUserId, repository),
  ])
  const setupReadiness = getDiscoveryStackSetupReadiness({ providers: providerReadiness, runtimeConfig: useRuntimeConfig(event) as Record<string, unknown> })
  return { ...providerReadiness, launchReadiness, setupReadiness }
})
