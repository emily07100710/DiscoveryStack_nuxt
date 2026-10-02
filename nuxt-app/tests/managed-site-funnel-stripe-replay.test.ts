import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFunnelCheckout, type ManagedSiteFunnelOrchestratorDependencies } from '../server/managed-sites/funnel/checkout-orchestrator'
import { createFunnelSession, MANAGED_SITE_FUNNEL_CONSENT_VERSION, recordFunnelConsent } from '../server/managed-sites/funnel/session-service'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const MODE_MESSAGE = '自助下單目前僅開放 Stripe 測試模式，請聯絡客服。'
const CREDENTIAL_REFERENCE = 'vault:stripe-funnel-replay'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function credential(mode: 'test' | 'live') {
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON', JSON.stringify({ [CREDENTIAL_REFERENCE]: `sk_${mode}_placeholder` }))
}

async function checkoutLine(mode: 'test' | 'live') {
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', 'https://api.stripe.com')
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS', 'https://checkout.stripe.com')
  vi.stubEnv('MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE', mode === 'live' ? 'true' : 'false')
  credential(mode)
  const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
  await configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference: CREDENTIAL_REFERENCE, transportConfiguration: { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com' }, idempotencyKey: 'funnel-stripe-replay-configuration' }, line.live.repository, () => managedSiteFixedNow)
  const configuration = (await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'))!
  Object.assign(configuration, { readinessStatus: 'verified', verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: `stripe-balance:${mode}`, verifiedAt: managedSiteFixedNow })
  const funnel = createFunnelSessionMemoryRepository()
  const created = await createFunnelSession(funnel.repository, () => managedSiteFixedNow)
  await recordFunnelConsent(created.sessionId, created.sessionToken, { policyVersion: MANAGED_SITE_FUNNEL_CONSENT_VERSION, scrolledToBottom: true }, funnel.repository, () => managedSiteFixedNow)
  const release = (await line.live.repository.findRelease(line.ownerUserId, line.release.release.id))!
  const preview = (await line.ordering.repository.findPreviewById(line.preview.preview.id))!
  await funnel.repository.updateSession(created.sessionId, { status: 'checkout_pending', releaseId: release.id, projectId: release.projectId, previewId: preview.id, previewAccessTokenHash: preview.accessTokenHash, draftOrderId: line.order.order.id, builtPreviewUrl: release.previewUrl })
  let now = new Date(managedSiteFixedNow)
  const dependencies: ManagedSiteFunnelOrchestratorDependencies = { funnelRepository: funnel.repository, orderingRepository: line.ordering.repository, connectorRepository: line.live.repository, managedRepository: line.managed.repository, executionMode: 'live', clock: () => now, resolveOwnerUserId: async () => line.ownerUserId }
  const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = new URLSearchParams(String(init?.body || ''))
    const requestMode = new Headers(init?.headers).get('authorization')?.includes('sk_live_') ? 'live' : 'test'
    const metadata = Object.fromEntries([...request].filter(([key]) => /^metadata\[/u.test(key)).map(([key, value]) => [key.slice(9, -1), value]))
    let total = 0
    for (let index = 0; request.has(`line_items[${index}][quantity]`); index += 1) total += Number(request.get(`line_items[${index}][quantity]`)) * Number(request.get(`line_items[${index}][price_data][unit_amount]`))
    const id = `cs_${requestMode}_funnel_replay_001`
    return new Response(JSON.stringify({ object: 'checkout.session', id, url: `https://checkout.stripe.com/c/pay/${id}`, amount_total: total, currency: request.get('currency'), livemode: requestMode === 'live', metadata }))
  })
  vi.stubGlobal('fetch', fetchSpy)
  return { ...line, funnel, created, configuration, dependencies, fetchSpy, checkout: () => runFunnelCheckout(created.sessionId, created.sessionToken, dependencies), advance: () => { now = new Date(now.getTime() + 31_000) } }
}

describe('funnel Stripe persisted checkout replay', () => {
  it.each([false, true])('blocks a cached live session after closing live mode (credential rotated: %s)', async rotateCredential => {
    const line = await checkoutLine('live')
    await expect(line.checkout()).resolves.toMatchObject({ checkoutUrl: expect.stringContaining('cs_live_') })
    vi.stubEnv('MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE', 'false')
    if (rotateCredential) credential('test')
    const before = structuredClone({ receipts: line.live.state.receipts, attempts: line.live.state.attempts, session: line.funnel.state.sessions[0] })
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503, statusMessage: MODE_MESSAGE })
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
    expect({ receipts: line.live.state.receipts, attempts: line.live.state.attempts, session: line.funnel.state.sessions[0] }).toEqual(before)
  })

  it('replays a test session without another provider call or checkout attempt', async () => {
    const line = await checkoutLine('test')
    const first = await line.checkout()
    const attempts = line.live.state.attempts.length
    await expect(line.checkout()).resolves.toEqual(first)
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
    expect(line.live.state.attempts).toHaveLength(attempts)
  })

  it('fails closed on a cached Stripe session whose mode cannot be established', async () => {
    const line = await checkoutLine('test')
    await line.checkout()
    const receipt = line.live.state.receipts.find(row => row.receiptType === 'checkout_session_created')!
    receipt.externalReference = 'cs_legacy_unknown_mode'
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503, statusMessage: MODE_MESSAGE })
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('withholds an in-flight live result if live mode closes before the URL handoff', async () => {
    const line = await checkoutLine('live')
    const provider = line.fetchSpy.getMockImplementation()!
    line.fetchSpy.mockImplementationOnce(async (...args) => {
      const response = await provider(...args)
      vi.stubEnv('MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE', 'false')
      return response
    })
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503, statusMessage: MODE_MESSAGE })
    expect(line.funnel.state.sessions[0]!.checkoutUrl).toBeNull()
    expect(line.live.state.receipts.filter(row => row.receiptType === 'checkout_session_created')).toHaveLength(1)
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503, statusMessage: MODE_MESSAGE })
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry a pending live request after closing live mode', async () => {
    const line = await checkoutLine('live')
    line.fetchSpy.mockRejectedValueOnce(new Error('provider response lost'))
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Stripe checkout transport failed.' })
    line.advance()
    vi.stubEnv('MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE', 'false')
    const before = structuredClone(line.live.state.attempts)
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503, statusMessage: MODE_MESSAGE })
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
    expect(line.live.state.attempts).toEqual(before)
  })

  it('blocks a pending live request from moving into the test namespace after credential rotation', async () => {
    const line = await checkoutLine('live')
    line.fetchSpy.mockRejectedValueOnce(new Error('provider response lost'))
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503 })
    line.advance()
    vi.stubEnv('MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE', 'false')
    credential('test')
    const before = structuredClone(line.live.state.attempts)
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Stripe credential mode no longer matches the verified payment configuration.' })
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
    expect(line.live.state.attempts).toEqual(before)
  })

  it('retries a permitted pending request with the same provider idempotency and receipt authority', async () => {
    const line = await checkoutLine('live')
    line.fetchSpy.mockRejectedValueOnce(new Error('provider response lost'))
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503 })
    line.advance()
    await expect(line.checkout()).resolves.toMatchObject({ checkoutUrl: expect.stringContaining('cs_live_') })
    expect(line.fetchSpy).toHaveBeenCalledTimes(2)
    const [first, second] = line.fetchSpy.mock.calls.map(call => call[1]!)
    expect(new Headers(first!.headers).get('idempotency-key')).toBe(new Headers(second!.headers).get('idempotency-key'))
    expect(first!.body).toEqual(second!.body)
    expect(line.live.state.attempts.filter(row => row.operation === 'checkout_session_create')).toMatchObject([{ status: 'succeeded', attemptNumber: 2 }])
  })

  it('does not silently restart a pending attempt after the provider is reverified in another mode', async () => {
    const line = await checkoutLine('live')
    line.fetchSpy.mockRejectedValueOnce(new Error('provider response lost'))
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 503 })
    line.advance()
    vi.stubEnv('MANAGED_SITE_FUNNEL_STRIPE_LIVE_MODE', 'false')
    credential('test')
    Object.assign(line.configuration, { verificationReceiptFingerprint: 'c'.repeat(64), capabilityIdentity: 'stripe-balance:test' })
    const before = structuredClone(line.live.state.attempts)
    await expect(line.checkout()).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Checkout session idempotency key collides with another commercial snapshot.' })
    expect(line.fetchSpy).toHaveBeenCalledTimes(1)
    expect(line.live.state.attempts).toEqual(before)
  })
})
