import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createInternalDnsTlsBrokerHmacV1Adapter } from '../server/managed-sites/live-connectors/broker-adapters'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { executeManagedSiteDnsTls } from '../server/managed-sites/live-connectors/domain-connectors'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

const NOW = new Date('2030-01-01T00:00:00.000Z')
const HMAC_SECRET = 'dns-tls-broker-test-secret'
const API_TOKEN = 'cloudflare-readiness-test-token'
const configuration = { deploymentCredentialReference: 'envref:deployment-bearer-test', dnsTlsCredentialReference: 'envref:dns-tls-hmac-test', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cf-token-test', projectPrefix: 'ds' } }
const providerCore = { schemaVersion: 'managed-site-provider-authority-v1', capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'internal-dns-ownership:v1', readinessStatus: 'verified', executionMode: 'live', verifiedAt: NOW.toISOString() } as const
const authority = { ...providerCore, authorityFingerprint: stableFingerprint(providerCore) }
const identity = { ownerUserId: 1, projectId: 2, releaseId: 3, contentHash: 'd'.repeat(64), canonicalDomain: 'site.acme.taipei', providerAuthorityFingerprint: authority.authorityFingerprint }
const input = { ownerUserId: identity.ownerUserId, projectId: identity.projectId, releaseId: identity.releaseId, contentHash: identity.contentHash, canonicalDomain: identity.canonicalDomain, providerAuthority: authority, requestFingerprint: stableFingerprint(identity), idempotencyKey: 'dns-tls-ready-test', timeoutMs: 10_000 }
const zoneId = 'e'.repeat(32)
const activeDomain = { id: 'domain-test-123', name: input.canonicalDomain, status: 'active', validation_data: { status: 'active' }, verification_data: { status: 'active' }, zone_tag: zoneId }
const activeZone = { id: zoneId, name: 'acme.taipei', account: { id: configuration.cloudflare.accountId }, status: 'active' }
const envelope = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, result }), { status })
const credentialResolver = async (reference: string) => reference === configuration.dnsTlsCredentialReference ? { ok: true as const, value: HMAC_SECRET } : reference === configuration.cloudflare.apiTokenReference ? { ok: true as const, value: API_TOKEN } : { ok: false as const, reason: 'missing_reference' as const }

function setup(domain: unknown = activeDomain, zone: unknown = activeZone, domainStatus = 200) {
  const cloudflareFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${API_TOKEN}`)
    if (String(url) === `https://api.cloudflare.com/client/v4/accounts/${configuration.cloudflare.accountId}/pages/projects/ds-o1-p2/domains/${input.canonicalDomain}`) return envelope(domain, domainStatus)
    if (String(url) === `https://api.cloudflare.com/client/v4/zones/${zoneId}`) return envelope(zone)
    throw new Error('unexpected provider URL')
  })
  const broker = createManagedSiteInternalBrokerFetch({ configurationResolver: () => configuration, credentialResolver, clock: () => NOW, cloudflareFetch, dnsMutationAuthorityResolver: async () => null })
  const adapter = createInternalDnsTlsBrokerHmacV1Adapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: providerCore.providerKey, credentialReference: configuration.dnsTlsCredentialReference, resolveCredential: credentialResolver, fetchImpl: broker, providerAuthorityFingerprint: authority.authorityFingerprint, clock: () => NOW })
  return { adapter, cloudflareFetch, broker }
}

beforeEach(() => vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', MANAGED_SITE_INTERNAL_BROKER_ORIGIN))
afterEach(() => vi.unstubAllEnvs())

describe('internal DNS/TLS broker readiness', () => {
  it('returns a signed verified receipt only for the exact existing Pages domain and owned active zone', async () => {
    const { adapter, cloudflareFetch } = setup()
    await expect(adapter.configureAndVerify(input)).resolves.toMatchObject({ canonicalDomain: input.canonicalDomain, dnsStatus: 'verified', tlsStatus: 'verified', providerAuthorityFingerprint: authority.authorityFingerprint })
    expect(cloudflareFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps missing custom-domain setup pending without creating a domain, record, or nameserver change', async () => {
    const { adapter, cloudflareFetch } = setup(null, activeZone, 404)
    await expect(adapter.configureAndVerify(input)).resolves.toMatchObject({ dnsStatus: 'propagation_pending', tlsStatus: 'pending' })
    expect(cloudflareFetch).toHaveBeenCalledTimes(1)
  })

  it('allows provider-verified external DNS without inventing a Cloudflare zone', async () => {
    const { adapter, cloudflareFetch } = setup({ ...activeDomain, zone_tag: '' })
    await expect(adapter.configureAndVerify(input)).resolves.toMatchObject({ dnsStatus: 'verified', tlsStatus: 'verified' })
    expect(cloudflareFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...activeDomain, name: 'other.acme.taipei' },
    { ...activeDomain, status: 'unexpected_provider_status' },
    { ...activeDomain, verification_data: undefined },
    { ...activeDomain, zone_tag: '../unrelated-zone' },
  ])('rejects mismatched or malformed provider domain evidence', async domain => {
    const { adapter, cloudflareFetch } = setup(domain)
    await expect(adapter.configureAndVerify(input)).rejects.toBeDefined()
    expect(cloudflareFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { ...activeZone, account: { id: 'f'.repeat(32) } },
    { ...activeZone, name: 'evilacme.taipei' },
    { ...activeZone, id: 'f'.repeat(32) },
  ])('rejects cross-account, unrelated, or mismatched zones', async zone => {
    const { adapter } = setup(activeDomain, zone)
    await expect(adapter.configureAndVerify(input)).rejects.toBeDefined()
  })

  it.each([
    { ...activeDomain, status: 'pending' },
    { ...activeDomain, validation_data: { status: 'pending' } },
    { ...activeDomain, verification_data: { status: 'pending' } },
  ])('does not promote partial Pages readiness into DNS and TLS verification', async domain => {
    const { adapter } = setup(domain)
    const result = await adapter.configureAndVerify(input)
    expect(result.dnsStatus === 'verified' && result.tlsStatus === 'verified').toBe(false)
  })

  it('reports a provider failure without claiming verification', async () => {
    const { adapter } = setup({ ...activeDomain, status: 'blocked' })
    await expect(adapter.configureAndVerify(input)).resolves.toMatchObject({ dnsStatus: 'partial_failure', tlsStatus: 'failed' })
  })

  it('validates request lineage before any provider lookup', async () => {
    const { adapter, cloudflareFetch } = setup()
    await expect(adapter.configureAndVerify({ ...input, ownerUserId: 7 })).rejects.toBeDefined()
    await expect(adapter.configureAndVerify({ ...input, providerAuthority: { ...authority, capability: 'deployment' } })).rejects.toBeDefined()
    expect(cloudflareFetch).not.toHaveBeenCalled()
  })

  it('does not turn an inaccessible provider into ready or expose provider response secrets', async () => {
    const { adapter, cloudflareFetch } = setup()
    cloudflareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, errors: [{ message: API_TOKEN }] }), { status: 403 }))
    let failure: unknown
    try { await adapter.configureAndVerify(input) } catch (error) { failure = error }
    expect(failure).toBeDefined()
    expect(JSON.stringify(failure)).not.toContain(API_TOKEN)
  })

  it('cancels oversized streamed provider responses before parsing or returning readiness', async () => {
    const { adapter, cloudflareFetch } = setup()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65 * 1024)) }, cancel })
    cloudflareFetch.mockResolvedValueOnce(new Response(stream))
    await expect(adapter.configureAndVerify(input)).rejects.toBeDefined()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cloudflareFetch).toHaveBeenCalledTimes(1)
  })

  it('runs the governed DNS service only after its exact domain claim and commits the signed broker receipt', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: input.canonicalDomain, createCheckout: false })
    const { cloudflareFetch, broker } = setup()
    cloudflareFetch.mockImplementation(async (url, init) => {
      expect(init?.method).toBe('GET')
      if (String(url) === `https://api.cloudflare.com/client/v4/accounts/${configuration.cloudflare.accountId}/pages/projects/ds-o1-p${line.prePurchase.project.id}/domains/${input.canonicalDomain}`) return envelope(activeDomain)
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}`)
      return envelope(activeZone)
    })
    await configureManagedSiteProvider(1, { capability: 'dns_tls', providerKey: providerCore.providerKey, readinessStatus: 'configured', credentialReference: configuration.dnsTlsCredentialReference, transportConfiguration: { endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN }, idempotencyKey: 'dns-service-provider-config' }, line.live.repository, () => NOW)
    await verifyManagedSiteProviderConfiguration(1, 'dns_tls', line.live.repository, credentialResolver, () => NOW, undefined, broker)
    const adapter = createInternalDnsTlsBrokerHmacV1Adapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: providerCore.providerKey, credentialReference: configuration.dnsTlsCredentialReference, resolveCredential: credentialResolver, fetchImpl: broker, clock: () => NOW })
    const command = { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'live' as const, idempotencyKey: 'dns-service-readiness' }
    const dependencies = { repository: line.live.repository, credentialResolver, clock: () => NOW }
    await expect(executeManagedSiteDnsTls(1, command, adapter, dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(cloudflareFetch).not.toHaveBeenCalled()
    // Synthetic pre-existing ownership authority; the broker never creates it.
    const fingerprint = stableFingerprint({ test: 'existing-exact-domain-authority' })
    await line.live.repository.insertReceipt({ ownerUserId: 1, projectId: command.projectId, releaseId: command.releaseId, draftOrderId: null, attemptId: null, capability: 'dns_tls', providerKey: 'synthetic-ownership', providerEventId: 'synthetic-owned-domain', receiptType: 'existing_site_ownership_verified', receiptStatus: 'verified', externalReference: 'synthetic-owned-domain', exactResponseIdentity: 'synthetic-owned-domain-response', requestFingerprint: fingerprint, contentHash: line.release.release.contentHash, canonicalDomain: input.canonicalDomain, metadata: {}, receiptFingerprint: fingerprint, verifiedAt: NOW } as any)
    await line.live.repository.insertDomainClaim({ ownerUserId: 1, projectId: command.projectId, releaseId: command.releaseId, canonicalDomain: input.canonicalDomain, status: 'verified', authorityReceiptFingerprint: fingerprint, requestFingerprint: fingerprint, projectionFingerprint: fingerprint, idempotencyKey: 'synthetic-dns-claim' } as any)
    const verified = await executeManagedSiteDnsTls(1, command, adapter, dependencies)
    expect(verified.ready).toBe(true)
    expect(verified.receipt).toMatchObject({ receiptType: 'dns_tls_verified', receiptStatus: 'verified', projectId: command.projectId, releaseId: command.releaseId })
    expect(cloudflareFetch).toHaveBeenCalledTimes(2)
    await expect(executeManagedSiteDnsTls(1, command, adapter, dependencies)).resolves.toMatchObject({ ready: true, replayed: true })
    expect(cloudflareFetch).toHaveBeenCalledTimes(2)
  })
})
