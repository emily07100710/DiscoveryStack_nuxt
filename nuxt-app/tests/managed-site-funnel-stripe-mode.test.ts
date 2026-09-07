import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFunnelStripeCredentialMode, guardedManagedSiteCredentialResolver, isStripeTestModeSecret, managedSiteFunnelStripeLiveModeEnabled } from '../server/managed-sites/funnel/stripe-mode-guard'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { managedSiteLiveCheckoutAdapter } from '../server/managed-sites/live-connectors/runtime-adapters'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const FUNNEL_ONLY_MESSAGE = '自助下單目前僅開放 Stripe 測試模式，請聯絡客服。'
const SAVED_ENV = {
  MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE: process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE,
  DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS,
  DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS: process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS,
  DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON: process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON,
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function checkoutInput() {
  return { ownerUserId: 1, projectId: 2, releaseId: 3, previewId: 4, approvalFingerprint: 'a'.repeat(64), draftOrderId: 5, quoteId: 6, amountMinor: 12_000, currency: 'TWD', planKey: 'site_geo', cadenceDays: 0, domainOption: 'none', lineSnapshot: [{ lineKey: 'build-one_page', quantity: 1, unitAmountMinor: 12_000, lineAmountMinor: 12_000 }], taxStatus: 'none', snapshotFingerprint: 'a'.repeat(64), checkoutReceiptFingerprint: 'b'.repeat(64), configurationFingerprint: 'c'.repeat(64), verificationReceiptFingerprint: 'd'.repeat(64), capabilityIdentity: 'stripe-balance:test', idempotencyKey: 'funnel-stripe-guard-001', timeoutMs: 5_000 }
}

/** Seeds a verified Stripe payment provider whose credential reference resolves through the env registry. */
async function verifiedStripeRepository(credentialValue: string) {
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
  process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'vault:stripe-funnel-guard': credentialValue })
  const live = createLiveConnectorMemoryRepository()
  await configureManagedSiteProvider(1, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference: 'vault:stripe-funnel-guard', transportConfiguration: { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com' }, idempotencyKey: 'stripe-funnel-guard-config-001' }, live.repository, () => managedSiteFixedNow)
  const configuration = await live.repository.findProviderConfiguration(1, 'payment')
  Object.assign(configuration!, { readinessStatus: 'verified', verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'stripe-balance:test', verifiedAt: managedSiteFixedNow })
  return live.repository
}

function networkSpy() {
  const spy = vi.fn(async () => { throw new Error('network must not be reached') })
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('managed-site funnel Stripe mode guard', () => {
  it('allows only Stripe test credentials unless live mode is explicitly enabled', () => {
    delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
    expect(isStripeTestModeSecret('sk_test_placeholder')).toBe(true)
    expect(isStripeTestModeSecret('rk_test_placeholder')).toBe(true)
    expect(() => assertFunnelStripeCredentialMode('sk_test_placeholder')).not.toThrow()
    expect(() => assertFunnelStripeCredentialMode('rk_test_placeholder')).not.toThrow()
    for (const secret of ['sk_live_private_value', '', 'whsec_private_value', 'SK_TEST_uppercase_is_not_test']) {
      let thrown: unknown = null
      try { assertFunnelStripeCredentialMode(secret) } catch (error) { thrown = error }
      expect(thrown, `expected ${JSON.stringify(secret)} to be rejected`).toMatchObject({ statusCode: 503, statusMessage: FUNNEL_ONLY_MESSAGE })
      if (secret) expect(JSON.stringify(thrown)).not.toContain(secret)
    }
    expect(() => assertFunnelStripeCredentialMode('sk_live_placeholder', true)).not.toThrow()
  })

  it('enables live mode only for the exact true string', () => {
    expect(managedSiteFunnelStripeLiveModeEnabled('true')).toBe(true)
    for (const value of ['TRUE', '1', 'yes', ' true', '', undefined]) expect(managedSiteFunnelStripeLiveModeEnabled(value)).toBe(false)
  })

  it('guards successful synchronous and asynchronous credential resolutions', async () => {
    delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
    const guarded = guardedManagedSiteCredentialResolver(async (_reference: string) => ({ ok: true as const, value: 'sk_live_placeholder' }), value => assertFunnelStripeCredentialMode(value))
    await expect(guarded('vault:stripe-test')).rejects.toMatchObject({ statusCode: 503, statusMessage: FUNNEL_ONLY_MESSAGE })
    const testGuarded = guardedManagedSiteCredentialResolver((_reference: string) => ({ ok: true as const, value: 'sk_test_placeholder' }), value => assertFunnelStripeCredentialMode(value))
    expect(testGuarded('vault:stripe-test')).toEqual({ ok: true, value: 'sk_test_placeholder' })
    const guardSpy = vi.fn()
    const unresolved = guardedManagedSiteCredentialResolver((_reference: string) => ({ ok: false as const, reason: 'missing' } as any), guardSpy)
    expect(unresolved('vault:missing')).toMatchObject({ ok: false })
    expect(guardSpy).not.toHaveBeenCalled()
  })

  it('rejects a live Stripe key through the real funnel adapter wiring before any network request', async () => {
    delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
    const repository = await verifiedStripeRepository('sk_live_placeholder')
    const spy = networkSpy()
    await expect(managedSiteLiveCheckoutAdapter(1, repository, { credentialGuard: assertFunnelStripeCredentialMode })).rejects.toMatchObject({ statusCode: 503, statusMessage: FUNNEL_ONLY_MESSAGE })
    expect(spy).not.toHaveBeenCalled()
  })

  it('re-checks the credential on every checkout call', async () => {
    delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
    const repository = await verifiedStripeRepository('sk_test_placeholder')
    const spy = networkSpy()
    const adapter = await managedSiteLiveCheckoutAdapter(1, repository, { credentialGuard: assertFunnelStripeCredentialMode })
    process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'vault:stripe-funnel-guard': 'sk_live_placeholder' })
    await expect(adapter.createSession(checkoutInput())).rejects.toMatchObject({ statusCode: 503, statusMessage: FUNNEL_ONLY_MESSAGE })
    expect(spy).not.toHaveBeenCalled()
  })

  it('requires re-verification when a resolved adapter credential changes between test and live mode', async () => {
    process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE = 'true'
    const repository = await verifiedStripeRepository('sk_test_placeholder')
    const spy = networkSpy()
    const adapter = await managedSiteLiveCheckoutAdapter(1, repository, { credentialGuard: assertFunnelStripeCredentialMode })
    process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ 'vault:stripe-funnel-guard': 'sk_live_placeholder' })
    await expect(adapter.createSession(checkoutInput())).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Stripe credential mode no longer matches the verified payment configuration.' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('leaves owner-side checkout resolution unguarded and lets test keys through the funnel wiring', async () => {
    delete process.env.MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE
    const liveRepository = await verifiedStripeRepository('sk_live_placeholder')
    const ownerSpy = networkSpy()
    const ownerAdapter = await managedSiteLiveCheckoutAdapter(1, liveRepository)
    await expect(ownerAdapter.createSession(checkoutInput())).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Stripe checkout transport failed.' })
    expect(ownerSpy).toHaveBeenCalledTimes(1)

    const testRepository = await verifiedStripeRepository('sk_test_placeholder')
    const funnelSpy = networkSpy()
    const funnelAdapter = await managedSiteLiveCheckoutAdapter(1, testRepository, { credentialGuard: assertFunnelStripeCredentialMode })
    await expect(funnelAdapter.createSession(checkoutInput())).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Stripe checkout transport failed.' })
    expect(funnelSpy).toHaveBeenCalledTimes(1)
  })
})
