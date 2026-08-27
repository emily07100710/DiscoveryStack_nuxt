import { createError, getRouterParam, readBody, setResponseHeaders, type H3Event } from 'h3'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parsePathId } from '../normalization'
import { requireOwner } from '../../utils/auth'
import { getManagedSiteLiveConnectorRepository } from './repository'
import type { PreviewRepository } from '../ordering-types'
import type { ManagedSiteRepository } from '../types'
import type { ManagedSiteArtifactVault } from './generation-service'
import type { ManagedSiteDeploymentAdapter, ManagedSiteDomainAdapter, ManagedSiteDnsTlsAdapter, ManagedSiteExistingSiteOwnershipAdapter, ManagedSiteGenerationAdapter, ManagedSiteLiveConnectorRepository, ManagedSiteCheckoutSessionAdapter } from './types'
import type { ManagedSiteCredentialResolver } from './types'
import type { ManagedSiteProviderVerifierRegistry } from './provider-verifiers'

export type ManagedSiteRouteDependencies = {
  ownerUserId: number
  repository: ManagedSiteLiveConnectorRepository
  orderingRepository?: PreviewRepository
  managedRepository?: ManagedSiteRepository
  artifactVault?: ManagedSiteArtifactVault
  generationAdapter?: ManagedSiteGenerationAdapter
  checkoutAdapter?: ManagedSiteCheckoutSessionAdapter
  domainAdapter?: ManagedSiteDomainAdapter
  dnsTlsAdapter?: ManagedSiteDnsTlsAdapter
  deploymentAdapter?: ManagedSiteDeploymentAdapter
  ownershipAdapter?: ManagedSiteExistingSiteOwnershipAdapter
  credentialResolver?: ManagedSiteCredentialResolver
  verifierRegistry?: ManagedSiteProviderVerifierRegistry
  fetchImpl?: typeof fetch
}

let testDependencyFactory: ((event: H3Event) => Promise<ManagedSiteRouteDependencies> | ManagedSiteRouteDependencies) | null = null

/** Production-equivalent fixed-route seam. It is test-only and cannot replace server authority in production. */
export function setManagedSiteRouteDependencyFactoryForTests(factory: ((event: H3Event) => Promise<ManagedSiteRouteDependencies> | ManagedSiteRouteDependencies) | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site route dependency injection is test-only.' })
  testDependencyFactory = factory
}

export function privateManagedSiteHeaders(event: H3Event): void {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
}

export async function managedSiteOwnerContext(event: H3Event) {
  privateManagedSiteHeaders(event)
  if (testDependencyFactory) return testDependencyFactory(event)
  const owner = await requireOwner(event)
  return { ownerUserId: await getOwnerDatabaseUserId(owner.openId), repository: getManagedSiteLiveConnectorRepository() }
}

export async function strictManagedSiteBody(event: H3Event, allowedFields: readonly string[]): Promise<Record<string, unknown>> {
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowedFields.includes(key)) || Object.getPrototypeOf(body) !== Object.prototype) throw createError({ statusCode: 422, statusMessage: 'Managed-site request contains missing or unknown fields.' })
  return body as Record<string, unknown>
}

export function managedSitePathId(event: H3Event, key: string, label: string): number { return parsePathId(getRouterParam(event, key), label) }

export async function requireManagedSiteReleaseScope(ownerUserId: number, projectId: number, releaseId: number, repository = getManagedSiteLiveConnectorRepository()) {
  const release = await repository.findRelease(ownerUserId, releaseId)
  if (!release || release.projectId !== projectId) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped release was not found in this project.' })
  return release
}
