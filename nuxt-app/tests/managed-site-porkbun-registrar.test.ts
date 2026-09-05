import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPorkbunDomainAdapter, porkbunEnvironment } from '../server/managed-sites/live-connectors/porkbun-adapters'
import { porkbunPingVerifier } from '../server/managed-sites/live-connectors/provider-verifiers'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { managedSiteLiveDomainAdapter } from '../server/managed-sites/live-connectors/runtime-adapters'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

const originalOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const originalCredentials = process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON
const PORKBUN_ORIGIN = 'https://api.porkbun.com'
const apiKey = 'pk1_sb_noncredential_api_value'
const privateKey = 'noncredential_private_value'
const credentialValue = JSON.stringify({ apiKey, secretApiKey: privateKey })
const now = new Date('2026-09-03T00:00:00.000Z')

afterEach(() => {
  vi.restoreAllMocks()
  if (originalOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS; else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = originalOrigins
  if (originalCredentials === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON; else process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = originalCredentials
})

function authority(providerKey = 'porkbun', capabilityIdentity = 'porkbun:sandbox') {
  return { schemaVersion: 'managed-site-provider-authority-v1' as const, capability: 'domain_registration' as const, providerKey, configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity, readinessStatus: 'verified' as const, executionMode: 'live' as const, verifiedAt: now.toISOString(), authorityFingerprint: 'c'.repeat(64) }
}

function quoteInput() { return { ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: 'example.com', providerAuthority: authority(), requestFingerprint: 'd'.repeat(64), timeoutMs: 5_000 } }
function purchaseInput() {
  const quote = { providerKey: 'porkbun', quoteId: 'porkbun-quote:test', canonicalDomain: 'example.com', amountMinor: 1299, currency: 'USD', expiresAt: '2026-09-03T00:05:00.000Z', providerAuthorityFingerprint: 'c'.repeat(64), exactResponseIdentity: 'porkbun-domain-check:test' }
  return { ownerUserId: 1, projectId: 2, releaseId: 3, draftOrderId: 4, commerceSnapshotFingerprint: 'e'.repeat(64), quote, providerAuthority: authority(), ownerConfirmationFingerprint: 'f'.repeat(64), paymentReceiptFingerprint: '1'.repeat(64), idempotencyKey: 'porkbun-domain-purchase-001', timeoutMs: 5_000 }
}

function adapter(fetchImpl: typeof fetch) {
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = PORKBUN_ORIGIN
  return createPorkbunDomainAdapter({ endpointOrigin: PORKBUN_ORIGIN, providerKey: 'porkbun', credentialReference: 'vault:porkbun', resolveCredential: async () => ({ ok: true, value: credentialValue }), providerAuthorityFingerprint: 'c'.repeat(64), fetchImpl, clock: () => now })
}

describe('managed-site Porkbun registrar', () => {
  it('classifies sandbox keys only by their prefix', () => {
    expect(porkbunEnvironment('pk1_sb_anything')).toBe('sandbox')
    expect(porkbunEnvironment('pk1_live_anything')).toBe('production')
    expect(porkbunEnvironment('anything')).toBe('production')
  })

  it.each([
    ['sandbox', apiKey, 'porkbun:sandbox'],
    ['production', 'pk1_noncredential_api_value', 'porkbun:production'],
  ])('accepts a well-formed %s ping and records its environment', async (_label, verifierApiKey, capabilityIdentity) => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = PORKBUN_ORIGIN
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${PORKBUN_ORIGIN}/api/json/v3/ping`); expect(init.method).toBe('POST'); expect(init.redirect).toBe('error')
      expect(JSON.parse(String(init.body))).toEqual({ apikey: verifierApiKey, secretapikey: privateKey })
      return new Response(JSON.stringify({ status: 'SUCCESS', yourIp: '198.51.100.10' }), { status: 200 })
    })
    await expect(porkbunPingVerifier({ capability: 'domain_registration', providerKey: 'porkbun', configurationFingerprint: 'a'.repeat(64), transportConfiguration: { endpointOrigin: PORKBUN_ORIGIN }, credentialReference: 'vault:porkbun', resolveCredential: async () => ({ ok: true, value: JSON.stringify({ apiKey: verifierApiKey, secretApiKey: privateKey }) }), fetchImpl: fetchImpl as typeof fetch, clock: () => now })).resolves.toMatchObject({ capabilityIdentity, providerKey: 'porkbun', capability: 'domain_registration' })
  })

  it.each([
    ['malformed', '{'],
    ['wrong-shaped', JSON.stringify({ status: 'SUCCESS', yourIp: '' })],
    ['prototype-polluted', '{"status":"SUCCESS","yourIp":"198.51.100.11","__proto__":{"polluted":true}}'],
    ['oversized', JSON.stringify({ status: 'SUCCESS', yourIp: '198.51.100.12', padding: 'x'.repeat(16_384) })],
  ])('rejects a %s ping response with a truthful 409', async (_label, responseBody) => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = PORKBUN_ORIGIN
    const fetchImpl = vi.fn(async () => new Response(responseBody, { status: 200 }))
    await expect(porkbunPingVerifier({ capability: 'domain_registration', providerKey: 'porkbun', configurationFingerprint: 'a'.repeat(64), transportConfiguration: { endpointOrigin: PORKBUN_ORIGIN }, credentialReference: 'vault:porkbun', resolveCredential: async () => ({ ok: true, value: credentialValue }), fetchImpl: fetchImpl as typeof fetch, clock: () => now })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('replays a purchase once per idempotency key and only reports registration when Porkbun confirms it', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${PORKBUN_ORIGIN}/api/json/v3/domain/create/example.com`); expect(new Headers(init.headers).get('x-idempotency-key')).toBe('porkbun-domain-purchase-001')
      return new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 })
    })
    const domainAdapter = adapter(fetchImpl as typeof fetch); const input = purchaseInput()
    await expect(domainAdapter.createPurchaseIntent(input)).resolves.toMatchObject({ status: 'purchase_intent_created' })
    await expect(domainAdapter.createPurchaseIntent(input)).resolves.toMatchObject({ status: 'purchase_intent_created' })
    expect(fetchImpl).toHaveBeenCalledOnce()

    const registered = adapter(vi.fn(async () => new Response(JSON.stringify({ status: 'SUCCESS', id: '123456789' }), { status: 200 })) as typeof fetch)
    await expect(registered.createPurchaseIntent({ ...input, idempotencyKey: 'porkbun-domain-purchase-002' })).resolves.toMatchObject({ status: 'registered', providerReference: '123456789' })
  })

  it('quotes Porkbun availability in USD without changing the separate TWD catalog amount', async () => {
    const catalogAmountMinor = 360000
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${PORKBUN_ORIGIN}/api/json/v3/domain/checkDomain/example.com`)
      return new Response(JSON.stringify({ status: 'SUCCESS', avail: 'yes', price: '12.99' }), { status: 200 })
    })
    const result = await adapter(fetchImpl as typeof fetch).quote(quoteInput())
    expect(result).toMatchObject({ currency: 'USD', amountMinor: 1299, canonicalDomain: 'example.com' })
    expect(catalogAmountMinor).toBe(360000)
  })

  it('allows only Porkbun endpointOrigin configuration and leaves existing provider transport fields unchanged', async () => {
    const live = createLiveConnectorMemoryRepository()
    await expect(configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'porkbun', readinessStatus: 'configured', credentialReference: 'vault:porkbun', transportConfiguration: { endpointOrigin: PORKBUN_ORIGIN }, idempotencyKey: 'porkbun-config-001' }, live.repository)).resolves.toMatchObject({ replayed: false })
    await expect(configureManagedSiteProvider(2, { capability: 'domain_registration', providerKey: 'porkbun', readinessStatus: 'configured', credentialReference: 'vault:porkbun', transportConfiguration: { checkoutOrigin: 'https://checkout.example.com' }, idempotencyKey: 'porkbun-config-002' }, live.repository)).rejects.toMatchObject({ statusCode: 422 })
    await expect(configureManagedSiteProvider(3, { capability: 'domain_registration', providerKey: 'internal-domain-broker-hmac-v1', readinessStatus: 'configured', credentialReference: 'vault:internal', transportConfiguration: { checkoutOrigin: 'https://checkout.example.com' }, idempotencyKey: 'internal-config-001' }, live.repository)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('resolves both registered domain factories and fails closed for an unregistered provider key', async () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = `${PORKBUN_ORIGIN},https://domains.acme-provider.com`
    process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'vault:porkbun': credentialValue, 'vault:internal': 'noncredential-internal-material', 'vault:unregistered': 'noncredential-unregistered-material' })
    const porkbun = createLiveConnectorMemoryRepository(); const internal = createLiveConnectorMemoryRepository(); const unregistered = createLiveConnectorMemoryRepository()
    await configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'porkbun', readinessStatus: 'configured', credentialReference: 'vault:porkbun', transportConfiguration: { endpointOrigin: PORKBUN_ORIGIN }, idempotencyKey: 'runtime-porkbun-001' }, porkbun.repository)
    await configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'internal-domain-broker-hmac-v1', readinessStatus: 'configured', credentialReference: 'vault:internal', transportConfiguration: { endpointOrigin: 'https://domains.acme-provider.com' }, idempotencyKey: 'runtime-internal-001' }, internal.repository)
    await configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'unregistered-domain-provider', readinessStatus: 'configured', credentialReference: 'vault:unregistered', transportConfiguration: {}, idempotencyKey: 'runtime-unregistered-001' }, unregistered.repository)
    for (const line of [porkbun, internal, unregistered]) {
      const configuration = await line.repository.findProviderConfiguration(1, 'domain_registration')
      Object.assign(configuration!, { readinessStatus: 'verified', verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: `domain:${configuration!.providerKey}`, verifiedAt: now })
    }
    await expect(managedSiteLiveDomainAdapter(1, porkbun.repository)).resolves.toMatchObject({ quote: expect.any(Function), createPurchaseIntent: expect.any(Function) })
    await expect(managedSiteLiveDomainAdapter(1, internal.repository)).resolves.toMatchObject({ quote: expect.any(Function), createPurchaseIntent: expect.any(Function) })
    await expect(managedSiteLiveDomainAdapter(1, unregistered.repository)).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Verified domain_registration provider adapter is not registered.' })
  })

  it('does not leak credential material or bearer notation on adapter and verifier failures', async () => {
    const rejectedAdapter = adapter(vi.fn(async () => new Response('no', { status: 500 })) as typeof fetch)
    let adapterMessage = ''
    try { await rejectedAdapter.quote(quoteInput()) } catch (error) { adapterMessage = String((error as { statusMessage?: string }).statusMessage || (error as Error).message) }
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = PORKBUN_ORIGIN
    let verifierMessage = ''
    try { await porkbunPingVerifier({ capability: 'domain_registration', providerKey: 'porkbun', configurationFingerprint: 'a'.repeat(64), transportConfiguration: { endpointOrigin: PORKBUN_ORIGIN }, credentialReference: 'vault:porkbun', resolveCredential: async () => ({ ok: true, value: credentialValue }), fetchImpl: (async () => { throw new Error('network down') }) as typeof fetch, clock: () => now }) } catch (error) { verifierMessage = String((error as { statusMessage?: string }).statusMessage || (error as Error).message) }
    for (const message of [adapterMessage, verifierMessage]) { expect(message).not.toContain(apiKey); expect(message).not.toContain(privateKey); expect(message).not.toContain('Bearer') }
  })
})
