import { createError } from 'h3'
import { createAuthenticatedBearerManagedSiteDeploymentAdapter } from './deployment-transport'
import { createBailianQwenManagedSiteGenerationAdapter } from './adapters'
import { resolveManagedSiteCredential, resolveManagedSiteProviderAuthority } from './provider-registry'
import { createInternalDnsTlsBrokerHmacV1Adapter, createInternalDomainBrokerHmacV1Adapter, createInternalHmacV1CheckoutAdapter, createInternalOwnershipBrokerHmacV1Adapter } from './broker-adapters'
import { createStripeCheckoutSessionAdapter } from './stripe-adapters'
import { createPorkbunDomainAdapter } from './porkbun-adapters'
import type { ManagedSiteCheckoutSessionAdapter, ManagedSiteDomainAdapter, ManagedSiteLiveConnectorRepository } from './types'
import { resolveManagedSiteBrokerFetchImpl } from './internal-broker/broker-fetch'

export async function managedSiteLiveDeploymentAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) {
  const authority = await resolveManagedSiteProviderAuthority(ownerUserId, 'deployment', 'live', repository, resolveManagedSiteCredential)
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'deployment')
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration || configuration.readinessStatus !== 'verified' || configuration.providerKey !== 'internal-deployment-bearer-v1' || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: 'Verified internal-deployment-bearer-v1 transport is not configured.' })
  if (configuration.configurationFingerprint !== authority.configurationFingerprint) throw createError({ statusCode: 409, statusMessage: 'Deployment provider configuration changed during adapter resolution.' })
  return createAuthenticatedBearerManagedSiteDeploymentAdapter({ endpointOrigin: transport.endpointOrigin, providerKey: configuration.providerKey, credentialReference: configuration.credentialReference, resolveCredential: resolveManagedSiteCredential, providerAuthorityFingerprint: authority.authorityFingerprint, fetchImpl: resolveManagedSiteBrokerFetchImpl(transport.endpointOrigin) })
}

export async function managedSiteLiveGenerationAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'website_generator')
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration || configuration.readinessStatus !== 'verified' || configuration.providerKey !== 'bailian-qwen' || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: 'Verified exact bailian-qwen generation adapter is not configured.' })
  return createBailianQwenManagedSiteGenerationAdapter({ endpoint: transport.endpointOrigin, model: typeof transport.model === 'string' ? transport.model : undefined, providerKey: configuration.providerKey })
}

async function verifiedBroker(ownerUserId: number, capability: 'payment' | 'domain_registration' | 'dns_tls', providerKey: string, repository: ManagedSiteLiveConnectorRepository) {
  const authority = await resolveManagedSiteProviderAuthority(ownerUserId, capability, 'live', repository, resolveManagedSiteCredential)
  const configuration = await repository.findProviderConfiguration(ownerUserId, capability)
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration || configuration.readinessStatus !== 'verified' || configuration.providerKey !== providerKey || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: `Verified ${providerKey} transport is not configured.` })
  if (configuration.configurationFingerprint !== authority.configurationFingerprint || configuration.providerKey !== authority.providerKey) throw createError({ statusCode: 409, statusMessage: `Provider ${capability} configuration changed during adapter resolution.` })
  return { endpointOrigin: transport.endpointOrigin, ...(capability === 'payment' && typeof transport.checkoutOrigin === 'string' ? { checkoutOrigin: transport.checkoutOrigin } : {}), ...(capability === 'payment' && typeof transport.returnOrigin === 'string' ? { returnOrigin: transport.returnOrigin } : {}), providerKey, credentialReference: configuration.credentialReference, resolveCredential: resolveManagedSiteCredential, providerAuthorityFingerprint: authority.authorityFingerprint, fetchImpl: resolveManagedSiteBrokerFetchImpl(transport.endpointOrigin) }
}

type PaymentCheckoutAdapterFactory = (options: Awaited<ReturnType<typeof verifiedBroker>>) => ManagedSiteCheckoutSessionAdapter
const PAYMENT_CHECKOUT_ADAPTERS: ReadonlyMap<string, PaymentCheckoutAdapterFactory> = new Map([
  ['internal_hmac_v1', options => createInternalHmacV1CheckoutAdapter(options)],
  ['stripe', options => {
    if (typeof options.checkoutOrigin !== 'string' || typeof options.returnOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: 'Verified Stripe checkout and return origins are not configured.' })
    return createStripeCheckoutSessionAdapter({ ...options, checkoutOrigin: options.checkoutOrigin, returnOrigin: options.returnOrigin })
  }],
])

export async function managedSiteLiveCheckoutAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'payment')
  const factory = configuration ? PAYMENT_CHECKOUT_ADAPTERS.get(configuration.providerKey) : null
  if (!configuration || !factory) throw createError({ statusCode: 503, statusMessage: 'Verified payment provider adapter is not registered.' })
  return factory(await verifiedBroker(ownerUserId, 'payment', configuration.providerKey, repository))
}
type DomainAdapterFactory = (options: Awaited<ReturnType<typeof verifiedBroker>>) => ManagedSiteDomainAdapter
const DOMAIN_ADAPTERS: ReadonlyMap<string, DomainAdapterFactory> = new Map([
  ['internal-domain-broker-hmac-v1', options => createInternalDomainBrokerHmacV1Adapter(options)],
  ['porkbun', options => createPorkbunDomainAdapter(options)],
])

export async function managedSiteLiveDomainAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) {
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'domain_registration')
  const factory = configuration ? DOMAIN_ADAPTERS.get(configuration.providerKey) : null
  if (!configuration || !factory) throw createError({ statusCode: 503, statusMessage: 'Verified domain_registration provider adapter is not registered.' })
  return factory(await verifiedBroker(ownerUserId, 'domain_registration', configuration.providerKey, repository))
}
export async function managedSiteLiveDnsTlsAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) { return createInternalDnsTlsBrokerHmacV1Adapter(await verifiedBroker(ownerUserId, 'dns_tls', 'internal-dns-tls-broker-hmac-v1', repository)) }
export async function managedSiteLiveOwnershipAdapter(ownerUserId: number, repository: ManagedSiteLiveConnectorRepository) { return createInternalOwnershipBrokerHmacV1Adapter(await verifiedBroker(ownerUserId, 'dns_tls', 'internal-dns-tls-broker-hmac-v1', repository)) }
