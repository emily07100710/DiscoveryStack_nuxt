import { createError, getRequestHeader, getRequestURL, getRouterParam, readBody, readRawBody, setResponseHeaders, type H3Event } from 'h3'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parsePathId } from '../normalization'
import { requireOwner } from '../../utils/auth'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import type { ManagedSiteRepository } from '../types'
import type { ManagedSiteArtifactVault } from './generation-service'
import type { ManagedSiteDeploymentAdapter, ManagedSiteDomainAdapter, ManagedSiteDnsTlsAdapter, ManagedSiteExistingSiteOwnershipAdapter, ManagedSiteGenerationAdapter, ManagedSiteLiveConnectorRepository, ManagedSiteCheckoutSessionAdapter } from './types'
import type { ManagedSiteCredentialResolver } from './types'
import type { ManagedSiteProviderVerifierRegistry } from './provider-verifiers'
import type { ManagedSiteJointTransaction } from './payment-webhook'

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
  paymentWebhookAdapter?: import('./types').ManagedSitePaymentWebhookAdapter
  paymentWebhookCredentialReference?: string
  paymentWebhookExecutionMode?: 'mocked' | 'live'
  paymentWebhookJointTransaction?: ManagedSiteJointTransaction
  paymentWebhookClock?: () => Date
  geoActivator?: (...args: any[]) => Promise<any>
}

let testDependencyFactory: ((event: H3Event) => Promise<ManagedSiteRouteDependencies> | ManagedSiteRouteDependencies) | null = null
let testPaymentWebhookDependencies: ManagedSiteRouteDependencies | null = null
let testPublicOrderingRepository: PreviewRepository | null = null

/** Production-equivalent fixed-route seam. It is test-only and cannot replace server authority in production. */
export function setManagedSiteRouteDependencyFactoryForTests(factory: ((event: H3Event) => Promise<ManagedSiteRouteDependencies> | ManagedSiteRouteDependencies) | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site route dependency injection is test-only.' })
  testDependencyFactory = factory
}

export function setManagedSitePaymentWebhookDependenciesForTests(dependencies: ManagedSiteRouteDependencies | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site webhook dependency injection is test-only.' })
  testPaymentWebhookDependencies = dependencies
}

/** Public preview routes have no owner session, so their repository seam is separate and test-only. */
export function setManagedSitePublicOrderingRepositoryForTests(repository: PreviewRepository | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site public ordering dependency injection is test-only.' })
  testPublicOrderingRepository = repository
}

export function managedSitePublicOrderingRepository(): PreviewRepository {
  return process.env.NODE_ENV === 'test' && testPublicOrderingRepository ? testPublicOrderingRepository : getPreviewRepository()
}

export function privateManagedSiteHeaders(event: H3Event): void {
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
}

export async function managedSiteOwnerContext(event: H3Event, mutation = true) {
  privateManagedSiteHeaders(event)
  if (mutation) assertSameOriginManagedSiteMutation(event)
  if (testDependencyFactory) return testDependencyFactory(event)
  const owner = await requireOwner(event)
  return { ownerUserId: await getOwnerDatabaseUserId(owner.openId), repository: getManagedSiteLiveConnectorRepository() }
}

/** Browsers omit Origin on same-origin GET, so only mutations may demand it. Mirrors server/system-factory/http.ts. */
export function assertSameOriginManagedSiteMutation(event: H3Event): void {
  const origin = getRequestHeader(event, 'origin') || ''
  const configured = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN || ''
  const expected = configured ? (() => { try { return new URL(configured).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Private managed-site origin is not configured correctly.' }) } })() : getRequestURL(event).origin
  if (!origin || (() => { try { return new URL(origin).origin } catch { return '' } })() !== expected) throw createError({ statusCode: 403, statusMessage: 'Managed-site mutation requires an exact same-origin request.' })
  const fetchSite = getRequestHeader(event, 'sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') throw createError({ statusCode: 403, statusMessage: 'Cross-site managed-site mutation is not allowed.' })
}

/** Webhooks have no owner session. This seam exists only in NODE_ENV=test; production always resolves its server authority below the route. */
export function managedSitePaymentWebhookContextForTests(): ManagedSiteRouteDependencies | null {
  return process.env.NODE_ENV === 'test' ? testPaymentWebhookDependencies : null
}

export const MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES = 1_000_000
const H3_RAW_BODY = Symbol.for('h3RawBody')

function oversizedManagedSitePaymentWebhook(): never {
  throw createError({ statusCode: 413, statusMessage: 'Stripe webhook request body is too large.' })
}

export async function readBoundedManagedSitePaymentWebhookBody(event: H3Event, maxBytes = MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES): Promise<Buffer | undefined> {
  const lengthHeader = getRequestHeader(event, 'content-length')
  const normalizedLength = lengthHeader?.trim() || ''
  if (/^\d+$/u.test(normalizedLength)) {
    const declaredLength = Number(normalizedLength)
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) oversizedManagedSitePaymentWebhook()
  }

  const request = event.node.req as typeof event.node.req & { [H3_RAW_BODY]?: unknown; rawBody?: unknown; body?: unknown }
  // Keep this precedence identical to h3's readRawBody so an already materialized/cached body is never read from the consumed Node stream again.
  const materializedBody = event._requestBody || event.web?.request?.body || request[H3_RAW_BODY] || request.rawBody || request.body
  if (materializedBody) {
    const raw = await readRawBody(event, false)
    if (raw && raw.byteLength > maxBytes) oversizedManagedSitePaymentWebhook()
    return raw
  }

  const declaredLength = /^\d+$/u.test(normalizedLength) ? Number(normalizedLength) : 0
  const chunked = /\bchunked\b/iu.test(String(request.headers['transfer-encoding'] ?? ''))
  if (!declaredLength && !chunked) return readRawBody(event, false)

  const rawBody = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let accumulatedBytes = 0

    const cleanup = () => {
      request.off('error', onError)
      request.off('data', onData)
      request.off('end', onEnd)
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onData = (chunk: Uint8Array | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (accumulatedBytes + bytes.byteLength > maxBytes) {
        cleanup()
        request.pause()
        const destroyRequest = () => { if (!request.destroyed) request.destroy() }
        event.node.res.once('finish', destroyRequest)
        event.node.res.once('close', destroyRequest)
        try { oversizedManagedSitePaymentWebhook() } catch (error) { reject(error) }
        return
      }
      accumulatedBytes += bytes.byteLength
      chunks.push(bytes)
    }
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, accumulatedBytes)) }

    request.on('error', onError).on('data', onData).on('end', onEnd)
  })
  request[H3_RAW_BODY] = rawBody
  return rawBody
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
