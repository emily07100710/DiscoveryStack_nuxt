import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../../seo-geo-core/repository'
import { managedSiteStableFingerprint } from '../canonical'
import { assertPublicHttpsUrl } from '../../../content-operations/normalization'
import { isOpaqueReference } from '../../../first-party-publishing/normalization'
import { createS3ManagedSiteArtifactVault } from '../s3-vault'
import { getManagedSiteLiveConnectorRepository } from '../repository'
import { resolveManagedSiteCredential } from '../provider-registry'
import type { ManagedSiteArtifactVault, ManagedSiteArtifactVaultBundle } from '../generation-service'
import type { ManagedSiteCredentialResolver, ManagedSiteDeploymentReceipt, ManagedSiteProviderAuthoritySnapshot } from '../types'
import { deployCloudflarePagesPreview, verifyCloudflarePagesAccess } from './cloudflare-pages'
import { parseManagedSiteInternalBrokerConfiguration, type ManagedSiteInternalBrokerConfiguration } from './config'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from './constants'
import { createManagedSiteHmacServer, type ManagedSiteHmacServerContext } from './hmac-server'
import { resolveManagedSiteOwnershipTxt, securelyFetchManagedSiteWellKnown, verifyManagedSiteWellKnown, type OwnershipAddressLookup, type OwnershipDnsTxtResolver, type OwnershipWellKnownFetcher } from './ownership-dns'
import { renderManagedSiteStaticAssets, STATIC_RENDERER_FINGERPRINT } from './static-renderer'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const MAX_BODY_BYTES = 128 * 1024
const FINGERPRINT = /^[a-f0-9]{64}$/u

type ChallengeIdentity = { ownerUserId: number; projectId: number; releaseId: number; canonicalDomain: string; verificationMethod: 'dns_txt' | 'well_known_file' | 'provider_account'; requestFingerprint: string }
export type ManagedSiteInternalBrokerDependencies = {
  clock?: () => Date
  nonceFactory?: () => string
  cloudflareFetch?: typeof fetch
  dnsTxtResolver?: OwnershipDnsTxtResolver
  addressLookup?: OwnershipAddressLookup
  wellKnownFileFetcher?: OwnershipWellKnownFetcher
  vaultFactory?: () => ManagedSiteArtifactVault
  credentialResolver?: ManagedSiteCredentialResolver
  configurationResolver?: () => ManagedSiteInternalBrokerConfiguration | null
  sleep?: (milliseconds: number) => Promise<void>
  ownershipIdentityResolver?: (input: { projectId: number; canonicalDomain: string; challengeReference: string }) => Promise<ChallengeIdentity | null>
}

function json(status: number, statusMessage: string): Response { return new Response(JSON.stringify({ statusCode: status, statusMessage }), { status, headers: { 'content-type': 'application/json' } }) }
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) }
function fail(statusCode: number, statusMessage: string): never { throw createError({ statusCode, statusMessage }) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function method(value: unknown): value is ChallengeIdentity['verificationMethod'] { return ['dns_txt', 'well_known_file', 'provider_account'].includes(String(value)) }

function sameSecret(supplied: string, expected: string): boolean {
  const left = createHash('sha256').update(supplied).digest(); const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

async function resolveSecret(resolver: ManagedSiteCredentialResolver, reference: string): Promise<string> {
  const result = await resolver(reference)
  if (!result.ok) fail(503, 'Internal managed-site broker credential reference is unavailable.')
  return result.value
}

function challengeReference(credential: string, identity: ChallengeIdentity): string {
  const canonical = ['ownership-challenge', identity.ownerUserId, identity.projectId, identity.releaseId, identity.canonicalDomain, identity.verificationMethod, identity.requestFingerprint].join('\n')
  return `dsv1-${createHmac('sha256', credential).update(canonical).digest('hex').slice(0, 40)}`
}

function authority(value: unknown): ManagedSiteProviderAuthoritySnapshot {
  if (!plain(value) || typeof value.authorityFingerprint !== 'string' || !FINGERPRINT.test(value.authorityFingerprint)) fail(422, 'Internal broker provider authority is invalid.')
  return value as ManagedSiteProviderAuthoritySnapshot
}

function validateBundle(value: unknown, expected: { ownerUserId: number; projectId: number; requestFingerprint: string; contentHash: string }): ManagedSiteArtifactVaultBundle {
  if (!plain(value)) fail(409, 'Managed-site vault bundle is malformed.')
  const keys = ['schemaVersion', 'ownerUserId', 'projectId', 'requestFingerprint', 'providerOutput', 'blueprint', 'blueprintHash', 'compilerFingerprint', 'manifest', 'files']
  if (!exact(value, keys) || value.schemaVersion !== 'managed-site-owner-vault-bundle-v2' || value.ownerUserId !== expected.ownerUserId || value.projectId !== expected.projectId || value.requestFingerprint !== expected.requestFingerprint || !plain(value.manifest) || value.manifest.contentHash !== expected.contentHash || !plain(value.blueprint) || !Array.isArray(value.files) || typeof value.blueprintHash !== 'string' || !FINGERPRINT.test(value.blueprintHash) || managedSiteStableFingerprint(value.blueprint) !== value.blueprintHash || value.files.some(file => !plain(file) || typeof file.path !== 'string' || typeof file.content !== 'string' || typeof file.sha256 !== 'string' || sha256(file.content) !== file.sha256)) fail(409, 'Managed-site vault bundle identity is mismatched.')
  return value as unknown as ManagedSiteArtifactVaultBundle
}

function parseVaultReference(value: unknown): { ownerUserId: number; projectId: number; requestFingerprint: string } {
  if (typeof value !== 'string') fail(422, 'Managed-site vault reference is invalid.')
  const matched = /^vault:s3:([1-9]\d{0,14}):([1-9]\d{0,14}):([a-f0-9]{64})$/u.exec(value)
  if (!matched) fail(422, 'Managed-site vault reference is invalid.')
  const ownerUserId = Number(matched[1]); const projectId = Number(matched[2])
  if (!positive(ownerUserId) || !positive(projectId)) fail(422, 'Managed-site vault reference is invalid.')
  return { ownerUserId, projectId, requestFingerprint: matched[3]! }
}

function canonicalOwnershipDomain(value: unknown): string {
  if (typeof value !== 'string') fail(422, 'Internal ownership domain is invalid.')
  const hostname = new URL(assertPublicHttpsUrl(`https://${value}`, 'Managed-site ownership domain')).hostname
  if (hostname !== value) fail(422, 'Internal ownership domain is not canonical.')
  return hostname
}

function receipt(input: Omit<ManagedSiteDeploymentReceipt, 'payloadHash' | 'exactResponseIdentity'>, exactResponseIdentity: string): ManagedSiteDeploymentReceipt {
  return { ...input, payloadHash: stableFingerprint(input), exactResponseIdentity }
}

function errorResponse(error: unknown): Response {
  const candidate = error as { statusCode?: unknown; statusMessage?: unknown; message?: unknown }
  const status = Number.isInteger(candidate?.statusCode) ? Math.min(Math.max(Number(candidate.statusCode), 400), 599) : 503
  const statusMessage = typeof candidate?.statusMessage === 'string' ? candidate.statusMessage : 'Internal managed-site broker operation failed closed.'
  return json(status, statusMessage)
}

export function createManagedSiteInternalBrokerFetch(dependencies: ManagedSiteInternalBrokerDependencies = {}): typeof fetch {
  const clock = dependencies.clock || (() => new Date()); const nonceFactory = dependencies.nonceFactory || (() => randomBytes(18).toString('hex'))
  const credentialResolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const configurationResolver = dependencies.configurationResolver || parseManagedSiteInternalBrokerConfiguration
  const vaultFactory = dependencies.vaultFactory || createS3ManagedSiteArtifactVault
  const ownershipIdentityResolver = dependencies.ownershipIdentityResolver || (process.env.NODE_ENV === 'test' ? async () => null : async input => {
    const receipt = await getManagedSiteLiveConnectorRepository().findOwnershipChallengeByReference(input.projectId, input.canonicalDomain, input.challengeReference)
    const verificationMethod = plain(receipt?.metadata) ? receipt.metadata.verificationMethod : null
    if (!receipt || !positive(receipt.ownerUserId) || !positive(receipt.projectId) || !positive(receipt.releaseId) || !method(verificationMethod) || !FINGERPRINT.test(receipt.requestFingerprint)) return null
    return { ownerUserId: receipt.ownerUserId, projectId: receipt.projectId, releaseId: receipt.releaseId, canonicalDomain: input.canonicalDomain, verificationMethod, requestFingerprint: receipt.requestFingerprint }
  })
  const challenges = new Map<string, ChallengeIdentity>()
  let hmacServer: ReturnType<typeof createManagedSiteHmacServer> | null = null
  let hmacCredentialHash = ''
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request: Request; try { request = new Request(input, init) } catch { throw new Error('Internal broker received an invalid request URL.') }
    if (request.url === '' || new URL(request.url).origin !== MANAGED_SITE_INTERNAL_BROKER_ORIGIN) throw new Error('Internal managed-site broker fetch cannot access network origins.')
    if (request.method !== 'POST') return json(405, 'Internal managed-site broker accepts POST only.')
    const pathname = new URL(request.url).pathname; const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json(413, 'Internal managed-site broker request is oversized.')
    const configuration = configurationResolver()
    if (!configuration) return json(503, 'Internal managed-site broker configuration is unavailable.')
    if (request.headers.has('authorization')) {
      try {
        if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') || '')) fail(415, 'Internal deployment broker requires JSON content.')
        const credential = await resolveSecret(credentialResolver, configuration.deploymentCredentialReference)
        const authorization = request.headers.get('authorization') || ''
        if (!authorization.startsWith('Bearer ') || !sameSecret(authorization.slice(7), credential)) fail(401, 'Internal deployment broker bearer credential is invalid.')
        let body: unknown
        try { body = JSON.parse(raw) } catch { fail(422, 'Internal deployment broker body is malformed.') }
        if (!plain(body)) fail(422, 'Internal deployment broker body is malformed.')
        if (pathname === '/v1/managed-sites/production' || pathname === '/v1/managed-sites/rollback') return json(503, 'Internal broker segment 1 does not execute production/rollback; payment and domain chains are not yet live.')
        const cloudflareToken = await resolveSecret(credentialResolver, configuration.cloudflare.apiTokenReference)
        if (pathname === '/v1/managed-sites/verify') {
          const keys = ['schemaVersion', 'challenge', 'configurationFingerprint']
          if (!exact(body, keys) || body.schemaVersion !== 'managed-site-provider-verification-v1' || typeof body.challenge !== 'string' || body.challenge.length < 32 || typeof body.configurationFingerprint !== 'string' || !FINGERPRINT.test(body.configurationFingerprint)) fail(422, 'Internal deployment verification challenge is invalid.')
          try { await verifyCloudflarePagesAccess({ fetchImpl: dependencies.cloudflareFetch || fetch, accountId: configuration.cloudflare.accountId, apiToken: cloudflareToken }) } catch { fail(424, 'Cloudflare Pages capability probe failed.') }
          const challengeHash = sha256(body.challenge); const providerEventId = `cf-probe-${nonceFactory()}`.slice(0, 160); const observedAt = clock().toISOString(); const capabilityIdentity = `cloudflare-pages:${sha256(configuration.cloudflare.accountId).slice(0, 16)}`
          const payloadHash = stableFingerprint({ challengeHash, capabilityIdentity, providerEventId, observedAt, configurationFingerprint: body.configurationFingerprint })
          return new Response(JSON.stringify({ schemaVersion: 'managed-site-provider-verification-v1', challengeHash, capabilityIdentity, providerEventId, observedAt, payloadHash, exactResponseIdentity: `cf-pages-probe:${stableFingerprint({ providerEventId, payloadHash })}` }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (pathname !== '/v1/managed-sites/preview') fail(404, 'Internal deployment broker path is not implemented.')
        const previewKeys = ['schemaVersion', 'providerKey', 'operation', 'projectId', 'versionId', 'releaseId', 'vaultReference', 'contentHash', 'canonicalDomain', 'providerAuthority', 'requestFingerprint', 'timeoutMs']
        if (!exact(body, previewKeys) || body.schemaVersion !== 'discoverystack-managed-deployment-command-v1' || body.providerKey !== 'internal-deployment-bearer-v1' || body.operation !== 'preview' || !positive(body.projectId) || !positive(body.versionId) || !positive(body.releaseId) || typeof body.contentHash !== 'string' || !FINGERPRINT.test(body.contentHash) || typeof body.requestFingerprint !== 'string' || !FINGERPRINT.test(body.requestFingerprint) || typeof body.canonicalDomain !== 'string' || !positive(body.timeoutMs)) fail(422, 'Internal preview deployment command is invalid.')
        const canonicalDomain = new URL(assertPublicHttpsUrl(`https://${body.canonicalDomain}`, 'Managed-site canonical domain')).hostname
        if (canonicalDomain !== body.canonicalDomain) fail(422, 'Internal preview canonical domain is not canonical.')
        const vaultIdentity = parseVaultReference(body.vaultReference)
        if (vaultIdentity.projectId !== body.projectId) fail(409, 'Internal preview vault project identity is mismatched.')
        const stored = await vaultFactory().lookupImmutableCandidate(vaultIdentity)
        if (!stored || stored.vaultReference !== body.vaultReference) fail(409, 'Internal preview vault candidate was not found.')
        const bundle = validateBundle(stored.bundle, { ...vaultIdentity, contentHash: body.contentHash })
        const assets = renderManagedSiteStaticAssets(bundle.blueprint, bundle.files)
        const deployed = await deployCloudflarePagesPreview({ ownerUserId: vaultIdentity.ownerUserId, projectId: body.projectId, releaseId: body.releaseId, assets, timeoutMs: body.timeoutMs }, { fetchImpl: dependencies.cloudflareFetch || fetch, accountId: configuration.cloudflare.accountId, apiToken: cloudflareToken, projectPrefix: configuration.cloudflare.projectPrefix, now: () => clock().getTime(), sleep: dependencies.sleep })
        const providerAuthority = authority(body.providerAuthority); const providerEventId = `cf-preview-${nonceFactory()}`.slice(0, 160); const observedAt = clock().toISOString()
        const core = { providerKey: String(body.providerKey), providerEventId, providerDeploymentId: deployed.deploymentId, projectId: body.projectId, versionId: body.versionId, contentHash: body.contentHash, canonicalDomain: body.canonicalDomain, deploymentUrl: deployed.deploymentUrl, status: 'preview_ready' as const, observedAt, providerAuthorityFingerprint: providerAuthority.authorityFingerprint }
        return new Response(JSON.stringify(receipt(core, `cf-pages:${stableFingerprint({ deploymentId: deployed.deploymentId, rendererFingerprint: STATIC_RENDERER_FINGERPRINT, blueprintHash: bundle.blueprintHash })}`)), { status: 200, headers: { 'content-type': 'application/json' } })
      } catch (error) { return errorResponse(error) }
    }
    let dnsCredential: string
    try { dnsCredential = await resolveSecret(credentialResolver, configuration.dnsTlsCredentialReference) } catch (error) { return errorResponse(error) }
    const credentialHash = sha256(dnsCredential)
    if (!hmacServer || credentialHash !== hmacCredentialHash) { hmacServer = createManagedSiteHmacServer({ credential: dnsCredential, clock, nonceFactory }); hmacCredentialHash = credentialHash }
    return hmacServer.handle(pathname, request.headers, raw, async context => handleHmac(context, dnsCredential))
  }

  const handleHmac = async (context: ManagedSiteHmacServerContext, credential: string): Promise<Record<string, unknown>> => {
    const body = context.body
    if (context.path === '/v1/managed-sites/verify') {
      const keys = ['schemaVersion', 'capability', 'providerKey', 'configurationFingerprint', 'challengeHash']
      if (!exact(body, keys) || body.schemaVersion !== 'managed-site-broker-verification-v1' || body.capability !== 'dns_tls' || body.providerKey !== 'internal-dns-tls-broker-hmac-v1' || typeof body.configurationFingerprint !== 'string' || !FINGERPRINT.test(body.configurationFingerprint) || typeof body.challengeHash !== 'string' || !FINGERPRINT.test(body.challengeHash)) fail(422, 'Internal ownership capability challenge is invalid.')
      return { schemaVersion: body.schemaVersion, capability: body.capability, providerKey: body.providerKey, configurationFingerprint: body.configurationFingerprint, challengeHash: body.challengeHash, capabilityIdentity: 'internal-dns-ownership:v1', providerEventId: context.providerEventId, observedAt: context.observedAt }
    }
    if (context.path === '/v1/managed-sites/ownership/challenge') {
      const keys = ['schemaVersion', 'providerKey', 'ownerUserId', 'projectId', 'releaseId', 'canonicalDomain', 'verificationMethod', 'providerAuthority', 'requestFingerprint', 'idempotencyKey', 'timeoutMs']
      if (!exact(body, keys) || body.schemaVersion !== 'managed-site-ownership-challenge-request-v1' || body.providerKey !== 'internal-dns-tls-broker-hmac-v1' || !positive(body.ownerUserId) || !positive(body.projectId) || !positive(body.releaseId) || typeof body.canonicalDomain !== 'string' || !method(body.verificationMethod) || typeof body.requestFingerprint !== 'string' || !FINGERPRINT.test(body.requestFingerprint) || !isOpaqueReference(body.idempotencyKey, 128) || !positive(body.timeoutMs)) fail(422, 'Internal ownership challenge command is invalid.')
      const providerAuthority = authority(body.providerAuthority); const canonicalDomain = canonicalOwnershipDomain(body.canonicalDomain); const identity: ChallengeIdentity = { ownerUserId: body.ownerUserId, projectId: body.projectId, releaseId: body.releaseId, canonicalDomain, verificationMethod: body.verificationMethod, requestFingerprint: body.requestFingerprint }
      const reference = challengeReference(credential, identity); challenges.set(reference, identity); while (challenges.size > 2_048) challenges.delete(challenges.keys().next().value as string)
      return { schemaVersion: 'managed-site-ownership-challenge-response-v1', providerKey: body.providerKey, providerEventId: context.providerEventId, ownerUserId: body.ownerUserId, projectId: body.projectId, releaseId: body.releaseId, canonicalDomain: body.canonicalDomain, verificationMethod: body.verificationMethod, requestFingerprint: body.requestFingerprint, challengeReference: reference, providerAuthorityFingerprint: providerAuthority.authorityFingerprint }
    }
    const keys = ['schemaVersion', 'providerKey', 'projectId', 'canonicalDomain', 'challengeReference', 'providerAuthority', 'requestFingerprint', 'timeoutMs']
    if (!exact(body, keys) || body.schemaVersion !== 'managed-site-ownership-verify-request-v1' || body.providerKey !== 'internal-dns-tls-broker-hmac-v1' || !positive(body.projectId) || typeof body.canonicalDomain !== 'string' || typeof body.challengeReference !== 'string' || !isOpaqueReference(body.challengeReference, 160) || typeof body.requestFingerprint !== 'string' || !FINGERPRINT.test(body.requestFingerprint) || !positive(body.timeoutMs)) fail(422, 'Internal ownership verification command is invalid.')
    const providerAuthority = authority(body.providerAuthority); const canonicalDomain = canonicalOwnershipDomain(body.canonicalDomain); const identity = challenges.get(body.challengeReference) || await ownershipIdentityResolver({ projectId: body.projectId, canonicalDomain, challengeReference: body.challengeReference }).catch(() => null)
    let status: 'verified' | 'pending' | 'failed' = 'failed'; let matched: string | null = null; const verificationMethod = identity?.verificationMethod || 'provider_account'
    const identityMatches = Boolean(identity && identity.projectId === body.projectId && identity.canonicalDomain === canonicalDomain && sameSecret(body.challengeReference, challengeReference(credential, identity)))
    if (identityMatches && verificationMethod === 'dns_txt') { const result = await resolveManagedSiteOwnershipTxt(body.canonicalDomain, body.challengeReference, dependencies.dnsTxtResolver); status = result.verified ? 'verified' : 'pending'; matched = result.matched }
    else if (identityMatches && verificationMethod === 'well_known_file') { const fetcher = dependencies.wellKnownFileFetcher || (domain => securelyFetchManagedSiteWellKnown(domain, { lookup: dependencies.addressLookup })); const result = await verifyManagedSiteWellKnown(body.canonicalDomain, body.challengeReference, fetcher); status = result.verified ? 'verified' : 'pending'; matched = result.matched }
    const evidenceHash = stableFingerprint({ canonicalDomain: body.canonicalDomain, verificationMethod, challengeReference: body.challengeReference, matched })
    return { schemaVersion: 'managed-site-ownership-verify-response-v1', providerKey: body.providerKey, providerEventId: context.providerEventId, providerReference: `ownership-${stableFingerprint({ projectId: body.projectId, canonicalDomain: body.canonicalDomain, challengeReference: body.challengeReference }).slice(0, 40)}`, projectId: body.projectId, canonicalDomain: body.canonicalDomain, challengeReference: body.challengeReference, requestFingerprint: body.requestFingerprint, verificationMethod, evidenceHash, status, providerAuthorityFingerprint: providerAuthority.authorityFingerprint }
  }
  return fetchImpl as typeof fetch
}

const DEFAULT_INTERNAL_BROKER_FETCH = createManagedSiteInternalBrokerFetch()

export function resolveManagedSiteBrokerFetchImpl(endpointOrigin: string): typeof fetch | undefined {
  let origin: string
  try { origin = new URL(endpointOrigin).origin } catch { return undefined }
  return origin === MANAGED_SITE_INTERNAL_BROKER_ORIGIN ? DEFAULT_INTERNAL_BROKER_FETCH : undefined
}
