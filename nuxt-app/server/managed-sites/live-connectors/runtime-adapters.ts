import { createError } from 'h3'
import { createAuthenticatedBearerManagedSiteDeploymentAdapter } from './deployment-transport'
import { createBailianQwenManagedSiteGenerationAdapter } from './adapters'
import { resolveManagedSiteCredential } from './provider-registry'
import { createInternalDnsTlsBrokerHmacV1Adapter, createInternalDomainBrokerHmacV1Adapter, createInternalHmacV1CheckoutAdapter, createInternalOwnershipBrokerHmacV1Adapter } from './broker-adapters'
import type { ManagedSiteLiveConnectorRepository } from './types'

export async function managedSiteLiveDeploymentAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'deployment')
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration || configuration.readinessStatus !== 'verified' || configuration.providerKey !== 'internal-deployment-bearer-v1' || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: 'Verified internal-deployment-bearer-v1 transport is not configured.' })
  return createAuthenticatedBearerManagedSiteDeploymentAdapter({ endpointOrigin: transport.endpointOrigin, providerKey: configuration.providerKey, credentialReference: configuration.credentialReference, resolveCredential: resolveManagedSiteCredential })
}

export async function managedSiteLiveGenerationAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'website_generator')
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration || configuration.readinessStatus !== 'verified' || configuration.providerKey !== 'bailian-qwen' || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: 'Verified exact bailian-qwen generation adapter is not configured.' })
  return createBailianQwenManagedSiteGenerationAdapter({ endpoint: transport.endpointOrigin, model: typeof transport.model === 'string' ? transport.model : undefined, providerKey: configuration.providerKey })
}

async function verifiedBroker(ownerUserId: number, capability: 'payment' | 'domain_registration' | 'dns_tls', providerKey: string, repository: ManagedSiteLiveConnectorRepository) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, capability)
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration || configuration.readinessStatus !== 'verified' || configuration.providerKey !== providerKey || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: `Verified ${providerKey} transport is not configured.` })
  return { endpointOrigin: transport.endpointOrigin, ...(capability === 'payment' && typeof transport.checkoutOrigin === 'string' ? { checkoutOrigin: transport.checkoutOrigin } : {}), providerKey, credentialReference: configuration.credentialReference, resolveCredential: resolveManagedSiteCredential }
}

export async function managedSiteLiveCheckoutAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) { return createInternalHmacV1CheckoutAdapter(await verifiedBroker(ownerUserId, 'payment', 'internal_hmac_v1', repository)) }
export async function managedSiteLiveDomainAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) { return createInternalDomainBrokerHmacV1Adapter(await verifiedBroker(ownerUserId, 'domain_registration', 'internal-domain-broker-hmac-v1', repository)) }
export async function managedSiteLiveDnsTlsAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) { return createInternalDnsTlsBrokerHmacV1Adapter(await verifiedBroker(ownerUserId, 'dns_tls', 'internal-dns-tls-broker-hmac-v1', repository)) }
export async function managedSiteLiveOwnershipAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) { return createInternalOwnershipBrokerHmacV1Adapter(await verifiedBroker(ownerUserId, 'dns_tls', 'internal-dns-tls-broker-hmac-v1', repository)) }
