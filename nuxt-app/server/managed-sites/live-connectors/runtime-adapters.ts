import { createError } from 'h3'
import { createAuthenticatedBearerManagedSiteDeploymentAdapter } from './deployment-transport'
import { createBailianQwenManagedSiteGenerationAdapter } from './adapters'
import { resolveManagedSiteCredential } from './provider-registry'
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

export function unsupportedManagedSiteVendorAdapter(capability: 'payment' | 'domain_registration' | 'dns_tls' | 'existing_site_ownership'): never {
  throw createError({ statusCode: 503, statusMessage: `unsupported_provider_adapter: ${capability} has no owner-selected live adapter.` })
}
