import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPorkbunDomainAdapter, parsePorkbunRegistrantContact, quotePorkbunRegistration, updatePorkbunDomainNameservers, type PorkbunAdapterOptions } from '../server/managed-sites/live-connectors/porkbun-adapters'
import type { ManagedSiteDomainAdapter, ManagedSiteDomainReceipt } from '../server/managed-sites/live-connectors/types'

const origin = 'https://api.porkbun.com'
const now = new Date('2026-09-06T00:00:00Z')
const authority = { schemaVersion: 'managed-site-provider-authority-v1' as const, capability: 'domain_registration' as const, providerKey: 'porkbun', configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'porkbun:production', readinessStatus: 'verified' as const, executionMode: 'live' as const, verifiedAt: now.toISOString(), authorityFingerprint: 'c'.repeat(64) }
const registrant = { firstName: 'Customer', lastName: 'Example', organization: '', address1: '1 Test Street', city: 'Taipei', state: '', postalCode: '100', country: 'TW', phoneCountryCode: '886', phone: '912345678', email: 'customer@example.com' }
const quote = { providerKey: 'porkbun', quoteId: 'porkbun-quote:test', canonicalDomain: 'example.com', amountMinor: 1299, currency: 'USD', expiresAt: '2026-09-06T00:05:00Z', providerAuthorityFingerprint: authority.authorityFingerprint, exactResponseIdentity: 'porkbun-domain-check:test' }
const created = { status: 'SUCCESS', domain: 'example.com', cost: 1299, orderId: 123456 }
const owned = { status: 'SUCCESS', domain: { domain: 'example.com', status: 'ACTIVE', notLocal: 0, apiAccess: 1 } }
const success = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
function options(fetchImpl: typeof fetch): PorkbunAdapterOptions {
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', origin)
  return { endpointOrigin: origin, providerKey: 'porkbun', credentialReference: 'vault:porkbun', resolveCredential: async () => ({ ok: true, value: JSON.stringify({ apiKey: 'pk1_noncredential_test', secretApiKey: 'noncredential_secret' }) }), providerAuthorityFingerprint: authority.authorityFingerprint, fetchImpl, clock: () => now }
}
function input(): Parameters<ManagedSiteDomainAdapter['createPurchaseIntent']>[0] {
  return { ownerUserId: 1, projectId: 2, releaseId: 3, draftOrderId: 4, commerceSnapshotFingerprint: 'd'.repeat(64), quote, providerAuthority: authority, ownerConfirmationFingerprint: '', paymentReceiptFingerprint: 'e'.repeat(64), idempotencyKey: 'delegated-registration-001', timeoutMs: 5_000, purchaseAuthority: { kind: 'customer_domain_delegation_v1', fingerprint: 'f'.repeat(64), registrant }, beforeMutation: vi.fn(async () => {}), onRegistrationCreated: vi.fn(async () => {}) }
}
const staged: ManagedSiteDomainReceipt = { providerKey: 'porkbun', providerEventId: '123456', providerReference: '123456', canonicalDomain: 'example.com', status: 'purchase_intent_created', providerAuthorityFingerprint: authority.authorityFingerprint, exactResponseIdentity: 'porkbun-domain-create:actual-response-hash' }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('Porkbun customer registration delegation', () => {
  it('stages actual order identity before contact mutation and requires exact customer readback', async () => {
    const calls: string[] = []; let changed = false
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname; calls.push(path)
      if (path.includes('/create/')) { expect(JSON.parse(String(init.body))).toEqual({ apikey: 'pk1_noncredential_test', secretapikey: 'noncredential_secret', cost: 1299, agreeToTerms: 'yes', whoisPrivacy: 'yes' }); expect(new Headers(init.headers).get('Idempotency-Key')).toBe('delegated-registration-001'); return success(created) }
      if (path.includes('/updateContacts/')) { expect(calls).toContain('persist-order'); expect(JSON.parse(String(init.body)).contacts.registrant).toEqual(registrant); changed = true; return success({ status: 'SUCCESS' }) }
      return success({ status: 'SUCCESS', contacts: { registrant: changed ? registrant : { ...registrant, email: 'platform@example.com' } } })
    })
    const request = input()
    // The exact response identity is hashed rather than a fixture label.
    request.onRegistrationCreated = async receipt => { expect(receipt).toMatchObject({ ...staged, exactResponseIdentity: expect.stringMatching(/^porkbun-domain-create:/u) }); calls.push('persist-order') }
    const receipt = await createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)
    expect(receipt).toMatchObject({ status: 'registered', providerReference: '123456' })
    expect(request.beforeMutation).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['/api/json/v3/domain/create/example.com', 'persist-order', '/api/json/v3/domain/getContacts/example.com', '/api/json/v3/domain/updateContacts/example.com', '/api/json/v3/domain/getContacts/example.com'])
    expect(JSON.stringify(receipt)).not.toContain(registrant.email)
    expect(JSON.stringify(receipt)).not.toContain('noncredential_secret')
  })

  it('does not change contacts when durable order staging fails', async () => {
    const fetchImpl = vi.fn(async () => success(created)); const request = input()
    request.onRegistrationCreated = async () => { throw new Error('durable stage unavailable') }
    await expect(createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)).rejects.toThrow('durable stage unavailable')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('repairs a staged registration after restart without calling create again', async () => {
    let changed = false
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/domain/get/')) { expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); expect(new Headers(init.headers).get('X-API-Key')).toBe('pk1_noncredential_test'); return success(owned) }
      if (url.includes('/updateContacts/')) { changed = true; return success({ status: 'SUCCESS' }) }
      expect(url).toContain('/getContacts/')
      return success({ status: 'SUCCESS', contacts: { registrant: changed ? registrant : { ...registrant, email: 'platform@example.com' } } })
    })
    const request = { ...input(), reconcileOnly: true, registrationReceipt: staged, quote: { ...quote, expiresAt: '2025-01-01T00:00:00Z' } }
    await expect(createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)).resolves.toMatchObject({ status: 'registered', providerReference: '123456' })
    expect(request.onRegistrationCreated).not.toHaveBeenCalled()
    expect(request.beforeMutation).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('/create/'))).toBe(false)
  })

  it.each([false, true])('never re-registers an outcome-unknown retry; exact existing contacts=%s', async matches => {
    const fetchImpl = vi.fn(async (url: string) => success(url.includes('/domain/get/') ? owned : { status: 'SUCCESS', contacts: { registrant: { ...registrant, email: matches ? registrant.email : 'unrelated@example.com' } } }))
    const request = { ...input(), reconcileOnly: true }; const promise = createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)
    if (matches) await expect(promise).resolves.toMatchObject({ status: 'registered', providerReference: 'domain:example.com' })
    else await expect(promise).rejects.toMatchObject({ statusCode: 409 })
    expect(request.beforeMutation).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/json/v3/domain/get/example.com', '/api/json/v3/domain/getContacts/example.com'])
  })

  it('fails closed when registrant write succeeds but readback still differs', async () => {
    const fetchImpl = vi.fn(async (url: string) => success(url.includes('/create/') ? created : url.includes('/updateContacts/') ? { status: 'SUCCESS' } : { status: 'SUCCESS', contacts: { registrant: { ...registrant, email: 'platform@example.com' } } }))
    await expect(createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(input())).rejects.toMatchObject({ statusCode: 409 })
  })

  it.each([{ domain: 'other.com' }, { cost: 1300 }, { orderId: undefined }, { dryRun: true }])('rejects mismatched or simulated registration confirmation %j', async patch => {
    const request = input(); const fetchImpl = vi.fn(async () => success({ ...created, ...patch }))
    await expect(createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)).rejects.toMatchObject({ statusCode: 409 })
    expect(request.onRegistrationCreated).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('refuses a sandbox registrar credential before any delegated purchase network call', async () => {
    const fetchImpl = vi.fn(); const setup = options(fetchImpl as typeof fetch)
    setup.resolveCredential = async () => ({ ok: true, value: JSON.stringify({ apiKey: 'pk1_sb_noncredential', secretApiKey: 'noncredential_secret' }) })
    await expect(createPorkbunDomainAdapter(setup).createPurchaseIntent(input())).rejects.toMatchObject({ statusCode: 409 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rechecks current payment authority immediately before every purchase mutation', async () => {
    const fetchImpl = vi.fn(); const request = input(); request.beforeMutation = async () => { throw new Error('payment refunded') }
    await expect(createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)).rejects.toThrow('payment refunded')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops after the cumulative provider budget before another mutation, retaining staged purchase identity', async () => {
    let elapsed = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now.getTime() + elapsed)
    const request = input(); const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/create/')) { elapsed += 3_000; return success(created) }
      expect(url).toContain('/getContacts/'); elapsed += 2_001
      return success({ status: 'SUCCESS', contacts: { registrant: { ...registrant, email: 'platform@example.com' } } })
    })
    await expect(createPorkbunDomainAdapter(options(fetchImpl as typeof fetch)).createPurchaseIntent(request)).rejects.toMatchObject({ statusCode: 503 })
    expect(request.onRegistrationCreated).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('/updateContacts/'))).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([{ ...registrant, country: 'Taiwan' }, { ...registrant, email: 'bad' }, { ...registrant, organization: 123 }, { ...registrant, unexpected: 'x' }])('rejects malformed customer contacts', contact => {
    expect(() => parsePorkbunRegistrantContact(contact)).toThrow()
  })
})

describe('Porkbun read-only automatic eligibility', () => {
  it.each([
    [{ apiRegisterable: false }, null, 'DOMAIN_UNSUPPORTED'],
    [{ requiresValidatedAddress: true }, null, 'DOMAIN_UNSUPPORTED'],
    [{ registryRequirements: { required: ['nationalId'] } }, null, 'DOMAIN_UNSUPPORTED'],
    [{}, { avail: 'no' }, 'DOMAIN_UNAVAILABLE'],
    [{}, { premium: 'yes' }, 'DOMAIN_PREMIUM'],
    [{}, { minDuration: 2 }, 'DOMAIN_UNSUPPORTED'],
  ])('rejects unsupported registry requirements or availability without a purchase', async (requirements, availability, code) => {
    const fetchImpl = vi.fn(async (url: string) => success(url.includes('/getRegistrationRequirements/') ? { status: 'SUCCESS', tld: 'com', apiRegisterable: true, requiresValidatedAddress: false, registryRequirements: null, registrationDurationYears: 1, ...requirements } : { status: 'SUCCESS', response: { avail: 'yes', price: '12.99', premium: 'no', minDuration: 1, ...availability } }))
    await expect(quotePorkbunRegistration(options(fetchImpl as typeof fetch), { canonicalDomain: 'example.com', providerAuthority: authority, requestFingerprint: 'f'.repeat(64), timeoutMs: 5_000, requireAutomaticEligibility: true })).rejects.toMatchObject({ data: { code } })
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('/create/'))).toBe(false)
  })
})

describe('Porkbun registry nameserver delegation', () => {
  const desired = ['amy.ns.cloudflare.com', 'bob.ns.cloudflare.com']
  const request = { canonicalDomain: 'example.com', nameservers: desired, idempotencyKey: 'nameservers-001', timeoutMs: 5_000 }
  it('reads, authorizes, updates only default Porkbun nameservers and verifies the exact Cloudflare pair', async () => {
    const calls: string[] = []; let changed = false
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url.includes('/updateNs/') ? 'write' : 'read')
      if (url.includes('/updateNs/')) { expect(JSON.parse(String(init.body)).ns).toEqual(desired); changed = true; return success({ status: 'SUCCESS' }) }
      return success({ status: 'SUCCESS', ns: changed ? desired : ['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com'] })
    })
    await expect(updatePorkbunDomainNameservers(request, { ...options(fetchImpl as typeof fetch), beforeMutation: async () => { calls.push('authorize') } })).resolves.toMatchObject({ verified: true })
    expect(calls).toEqual(['read', 'authorize', 'write', 'read'])
  })
  it.each([{ nameservers: desired }, { nameservers: ['unrelated.example.net', 'other.example.net'] }])('does not write when nameservers are already exact or unrelated', async ({ nameservers }) => {
    const fetchImpl = vi.fn(async () => success({ status: 'SUCCESS', ns: nameservers })); const beforeMutation = vi.fn(async () => {})
    const promise = updatePorkbunDomainNameservers(request, { ...options(fetchImpl as typeof fetch), beforeMutation })
    if (nameservers === desired) await expect(promise).resolves.toMatchObject({ verified: true })
    else await expect(promise).rejects.toMatchObject({ statusCode: 409 })
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(beforeMutation).not.toHaveBeenCalled()
  })
})
