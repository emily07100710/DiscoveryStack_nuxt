import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFunnelDomainReadyForCheckout, checkFunnelDomainAvailability, publicFunnelDomainAvailability } from '../server/managed-sites/funnel/domain-registration'
import { createFunnelDomainRegistrationDelegation } from '../server/managed-sites/funnel/domain-purchase-authority'
import type { FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

const now = new Date('2026-09-06T00:00:00Z')
const origin = 'https://api.porkbun.com'
async function setup(response: Record<string, unknown> = {}, options: { identity?: string; budget?: number } = {}) {
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', origin)
  const live = createLiveConnectorMemoryRepository()
  await configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'porkbun', readinessStatus: 'configured', credentialReference: 'vault:porkbun', transportConfiguration: { endpointOrigin: origin }, idempotencyKey: 'availability-provider-001' }, live.repository)
  const config = await live.repository.findProviderConfiguration(1, 'domain_registration')
  Object.assign(config!, { readinessStatus: 'verified', verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: options.identity || 'porkbun:production', verifiedAt: now })
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes('/getRegistrationRequirements/')) return new Response(JSON.stringify({ status: 'SUCCESS', tld: 'com', apiRegisterable: true, requiresValidatedAddress: false, registryRequirements: null, registrationDurationYears: 1 }))
    expect(url).toContain('/checkDomain/example.com')
    return new Response(JSON.stringify({ status: 'SUCCESS', response: { avail: 'yes', price: '12.99', premium: 'no', minDuration: 1, ...response } }))
  })
  const dependencies = { repository: live.repository, credentialResolver: async () => ({ ok: true as const, value: JSON.stringify({ apiKey: 'pk1_noncredential', secretApiKey: 'noncredential_secret' }) }), fetchImpl: fetchImpl as typeof fetch, clock: () => now, procurementPolicyJson: JSON.stringify({ com: { currency: 'USD', maxAmountMinor: options.budget ?? 1500 } }) }
  vi.stubEnv('MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON', dependencies.procurementPolicyJson)
  return { ...live, fetchImpl, dependencies }
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('funnel domain availability before payment', () => {
  it('gets real provider eligibility and availability but returns only catalog retail price to the browser', async () => {
    const context = await setup()
    const result = await checkFunnelDomainAvailability(1, 5, 'Example.COM', context.dependencies)
    expect(result).toMatchObject({ schemaVersion: 'funnel-domain-availability-v1', canonicalDomain: 'example.com', available: true, quote: { amountMinor: 1299, currency: 'USD' }, customerPrice: { amountMinor: 600, currency: 'TWD' } })
    const visible = publicFunnelDomainAvailability(result)
    expect(visible).toEqual({ canonicalDomain: 'example.com', available: true, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), expiresAt: '2026-09-06T00:05:00.000Z', customerPrice: { amountMinor: 600, currency: 'TWD' } })
    expect(JSON.stringify(visible)).not.toContain('porkbun')
    expect(context.fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/json/v3/domain/getRegistrationRequirements/com', '/api/json/v3/domain/checkDomain/example.com'])
  })
  it('binds the same supplier response and catalog price to the exact funnel session', async () => {
    const context = await setup()
    const first = await checkFunnelDomainAvailability(1, 5, 'example.com', context.dependencies)
    const second = await checkFunnelDomainAvailability(1, 6, 'example.com', context.dependencies)
    expect(first.available && second.available && first.quoteFingerprint !== second.quoteFingerprint).toBe(true)
  })
  it.each([
    [{ avail: 'no' }, 'unavailable'],
    [{ premium: 'yes' }, 'premium'],
    [{ minDuration: 2 }, 'unsupported'],
  ])('offers no delegation when the selected domain cannot be automatically registered', async (availability, reason) => {
    const context = await setup(availability)
    const result = await checkFunnelDomainAvailability(1, 5, 'example.com', context.dependencies)
    expect(result).toMatchObject({ canonicalDomain: 'example.com', available: false, reason })
    expect(result).not.toHaveProperty('quote'); expect(result).not.toHaveProperty('quoteFingerprint')
  })
  it('does not offer a supplier price above the configured procurement ceiling', async () => {
    const context = await setup({}, { budget: 1200 })
    await expect(checkFunnelDomainAvailability(1, 5, 'example.com', context.dependencies)).resolves.toMatchObject({ available: false, reason: 'unsupported' })
  })
  it.each(['sub.example.com', 'example.invalidtld'])('rejects an unsupported name without a provider request', async domain => {
    const context = await setup()
    try { const result = await checkFunnelDomainAvailability(1, 5, domain, context.dependencies); expect(result.available).toBe(false) } catch (error) { expect(error).toMatchObject({ statusCode: 422 }) }
    expect(context.fetchImpl).not.toHaveBeenCalled()
  })
  it('does not present sandbox registrar observations as genuine availability', async () => {
    const context = await setup({}, { identity: 'porkbun:sandbox' })
    await expect(checkFunnelDomainAvailability(1, 5, 'example.com', context.dependencies)).rejects.toMatchObject({ statusCode: 503 })
    expect(context.fetchImpl).not.toHaveBeenCalled()
  })
  it('keeps provider authority owner-scoped', async () => {
    const context = await setup()
    await expect(checkFunnelDomainAvailability(2, 5, 'example.com', context.dependencies)).rejects.toMatchObject({ statusCode: 503 })
    expect(context.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('checkout availability within accepted customer delegation', () => {
  async function delegatedSession() {
    const context = await setup()
    const availability = await checkFunnelDomainAvailability(1, 5, 'example.com', context.dependencies)
    if (!availability.available) throw new Error('fixture unavailable')
    const answers: FunnelAnswers = { existingSite: { hasSite: false }, company: { brandName: 'Example', whatWeDo: '品牌服務', feelings: ['專業'], mainOffer: '顧問', conversionGoals: ['increase_inquiries'] }, contact: { contactName: 'Example', email: 'customer@example.com' }, siteType: 'one_page', modules: [], style: { referenceUrls: [], designTier: 'template' }, domain: { option: 'new', name: 'example', tld: 'com' }, plan: { planKey: 'site_only' } }
    const delegation = createFunnelDomainRegistrationDelegation({ sessionId: 5, canonicalDomain: 'example.com', registrant: { firstName: 'Customer', lastName: '', organization: '', address1: '1 Test Street', city: 'Taipei', state: '', postalCode: '100', country: 'TW', phoneCountryCode: '886', phone: '912345678', email: 'customer@example.com' }, quote: availability.quote, customerPrice: availability.customerPrice, acceptedAt: now.toISOString() })
    context.fetchImpl.mockClear()
    return { ...context, session: { id: 5, answers, consentSnapshot: { scrolledToBottom: true, domainRegistration: delegation } }, delegation }
  }
  it('refreshes an expired supplier quote after plan selection and generation without changing original consent', async () => {
    const context = await delegatedSession(); const original = JSON.stringify(context.session)
    const refreshed = await assertFunnelDomainReadyForCheckout(1, context.session, { ...context.dependencies, clock: () => new Date(now.getTime() + 3_600_000) })
    expect(refreshed).toMatchObject({ available: true, canonicalDomain: 'example.com', expiresAt: '2026-09-06T01:05:00.000Z' })
    expect(JSON.stringify(context.session)).toBe(original)
    expect(context.fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('refuses a new supplier price above the accepted quote even when still under platform budget', async () => {
    const context = await delegatedSession()
    context.fetchImpl.mockImplementation(async url => new Response(JSON.stringify(url.includes('/getRegistrationRequirements/') ? { status: 'SUCCESS', tld: 'com', apiRegisterable: true, requiresValidatedAddress: false, registryRequirements: null, registrationDurationYears: 1 } : { status: 'SUCCESS', response: { avail: 'yes', price: '13.00', premium: 'no', minDuration: 1 } })))
    await expect(assertFunnelDomainReadyForCheckout(1, context.session, context.dependencies)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('refuses the now-unavailable selected domain before any checkout can be issued', async () => {
    const context = await delegatedSession()
    context.fetchImpl.mockImplementation(async url => new Response(JSON.stringify(url.includes('/getRegistrationRequirements/') ? { status: 'SUCCESS', tld: 'com', apiRegisterable: true, requiresValidatedAddress: false, registryRequirements: null, registrationDurationYears: 1 } : { status: 'SUCCESS', response: { avail: 'no' } })))
    await expect(assertFunnelDomainReadyForCheckout(1, context.session, context.dependencies)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('does not silently accept changed provider authority', async () => {
    const context = await delegatedSession()
    const config = await context.repository.findProviderConfiguration(1, 'domain_registration')
    config!.verificationReceiptFingerprint = 'd'.repeat(64)
    await expect(assertFunnelDomainReadyForCheckout(1, context.session, context.dependencies)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('does not silently accept a changed domain or tampered customer price', async () => {
    const context = await delegatedSession()
    context.session.answers.domain!.name = 'other'
    await expect(assertFunnelDomainReadyForCheckout(1, context.session, context.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    context.session.answers.domain!.name = 'example'; context.delegation.customerPrice.amountMinor = 1
    await expect(assertFunnelDomainReadyForCheckout(1, context.session, context.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(context.fetchImpl).not.toHaveBeenCalled()
  })
})
