import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { createManagedSiteCheckoutSession } from '../server/managed-sites/live-connectors/checkout-session'
import { setManagedSiteRouteDependencyFactoryForTests } from '../server/managed-sites/live-connectors/http'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { managedSiteLiveCheckoutAdapter } from '../server/managed-sites/live-connectors/runtime-adapters'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const CREDENTIAL_REFERENCE = 'vault:stripe-return-origin'
const RETURN_ORIGIN = 'https://ops.example.com'
const clock = () => managedSiteFixedNow
type Line = Awaited<ReturnType<typeof createAuthoritativeManagedSiteReleaseFixture>>

beforeAll(() => { (globalThis as any).defineEventHandler = defineEventHandler; (globalThis as any).createError = createError })
afterEach(() => { setManagedSiteRouteDependencyFactoryForTests(null); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

function stripeEnvironment() {
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', 'https://api.stripe.com')
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS', 'https://checkout.stripe.com')
  vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON', JSON.stringify({ [CREDENTIAL_REFERENCE]: 'sk_test_placeholder' }))
}

const stripeInput = (transportConfiguration: Record<string, unknown>, idempotencyKey: string) => ({ capability: 'payment' as const, providerKey: 'stripe', readinessStatus: 'configured' as const, credentialReference: CREDENTIAL_REFERENCE, transportConfiguration: transportConfiguration as any, idempotencyKey })
const savedTransport = async (line: Line) => (await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'))?.transportConfiguration

async function markVerified(line: Line) {
  const configuration = (await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'))!
  Object.assign(configuration, { readinessStatus: 'verified', verificationReceiptFingerprint: 'c'.repeat(64), capabilityIdentity: 'stripe-balance:test', verifiedAt: managedSiteFixedNow })
}

function stubStripeFetch() {
  const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = new URLSearchParams(String(init?.body || ''))
    const metadata = Object.fromEntries([...request].filter(([key]) => /^metadata\[/u.test(key)).map(([key, value]) => [key.slice(9, -1), value]))
    let total = 0
    for (let index = 0; request.has(`line_items[${index}][quantity]`); index += 1) total += Number(request.get(`line_items[${index}][quantity]`)) * Number(request.get(`line_items[${index}][price_data][unit_amount]`))
    return new Response(JSON.stringify({ object: 'checkout.session', id: 'cs_test_return_origin_001', url: 'https://checkout.stripe.com/c/pay/cs_test_return_origin_001', amount_total: total, currency: request.get('currency'), livemode: false, metadata }))
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

async function saveThroughRoute(line: Line, transportConfiguration: Record<string, string>, idempotencyKey: string) {
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', 'https://ops.test')
  setManagedSiteRouteDependencyFactoryForTests(() => ({ ownerUserId: line.ownerUserId, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository }))
  const handler = (await import('../server/api/managed-sites/live-connectors/provider-configurations.post')).default
  const app = createApp({ debug: false }); const router = createRouter(); router.post('/api/managed-sites/live-connectors/provider-configurations', handler); app.use(router)
  return toWebHandler(app)(new Request('https://ops.test/api/managed-sites/live-connectors/provider-configurations', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://ops.test' }, body: JSON.stringify({ capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference: CREDENTIAL_REFERENCE, transportConfiguration, idempotencyKey }) }))
}

describe('managed-site Stripe return origin configuration', () => {
  it('persists the exact return origin together with the endpoint and checkout origins', async () => {
    stripeEnvironment(); const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    const saved = await configureManagedSiteProvider(line.ownerUserId, stripeInput({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: `${RETURN_ORIGIN}/` }, 'return-origin-save-001'), line.live.repository, clock)
    expect(saved.replayed).toBe(false)
    expect(await savedTransport(line)).toEqual({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: RETURN_ORIGIN })
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['plain http', 'http://ops.example.com'],
    ['with a path', 'https://ops.example.com/managed-sites'],
    ['with a query', 'https://ops.example.com?next=1'],
    ['with a fragment', 'https://ops.example.com#paid'],
    ['with userinfo', 'https://owner@ops.example.com'],
    ['not a URL', 'ops.example.com'],
    ['not a string', 42],
  ])('rejects a configured Stripe payment row whose return origin is %s', async (_label, returnOrigin) => {
    stripeEnvironment(); const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    const transport: Record<string, unknown> = { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com' }
    if (returnOrigin !== undefined) transport.returnOrigin = returnOrigin
    const before = structuredClone(await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'))
    await expect(configureManagedSiteProvider(line.ownerUserId, stripeInput(transport, 'return-origin-invalid-001'), line.live.repository, clock)).rejects.toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('Stripe return origin') })
    expect(await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment')).toEqual(before)
  })

  it('keeps the saved return origin when a re-save without one is refused', async () => {
    stripeEnvironment(); const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    await configureManagedSiteProvider(line.ownerUserId, stripeInput({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: RETURN_ORIGIN }, 'return-origin-first-001'), line.live.repository, clock)
    await markVerified(line); const before = structuredClone(await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'))
    await expect(configureManagedSiteProvider(line.ownerUserId, stripeInput({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com' }, 'return-origin-resave-001'), line.live.repository, clock)).rejects.toMatchObject({ statusCode: 422 })
    expect(await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment')).toEqual(before)
  })

  it('leaves non-Stripe payment, mock and disabled rows on their existing rules', async () => {
    stripeEnvironment(); const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    await expect(configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'mock', transportConfiguration: {}, idempotencyKey: 'return-origin-mock-001' }, line.live.repository, clock)).resolves.toMatchObject({ replayed: false })
    await expect(configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'disabled', transportConfiguration: {}, idempotencyKey: 'return-origin-disabled-001' }, line.live.repository, clock)).resolves.toMatchObject({ replayed: false })
    await expect(configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'internal_hmac_v1', readinessStatus: 'configured', credentialReference: CREDENTIAL_REFERENCE, transportConfiguration: { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: RETURN_ORIGIN } as any, idempotencyKey: 'return-origin-hmac-001' }, line.live.repository, clock)).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Transport configuration is not allowlisted for this exact provider and capability.' })
  })

  it('saves the payload the owner form sends and can still create a checkout that returns to that origin', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(managedSiteFixedNow)
    stripeEnvironment(); const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    const response = await saveThroughRoute(line, { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: RETURN_ORIGIN }, 'return-origin-route-001')
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ capability: 'payment', providerKey: 'stripe', status: 'configured', replayed: false })
    expect(await savedTransport(line)).toEqual({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: RETURN_ORIGIN })
    await markVerified(line); const fetchSpy = stubStripeFetch()
    const adapter = await managedSiteLiveCheckoutAdapter(line.ownerUserId, line.live.repository)
    const created = await createManagedSiteCheckoutSession(line.ownerUserId, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'live', idempotencyKey: 'return-origin-checkout-001' }, adapter, { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, clock })
    expect(created).toMatchObject({ replayed: false, checkout: { url: 'https://checkout.stripe.com/c/pay/cs_test_return_origin_001' } })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const sent = new URLSearchParams(String(fetchSpy.mock.calls[0]![1]?.body || ''))
    expect(sent.get('success_url')).toBe(`${RETURN_ORIGIN}/managed-sites/checkout/success`); expect(sent.get('cancel_url')).toBe(`${RETURN_ORIGIN}/managed-sites/checkout/cancel`)
  })

  it('refuses the old form payload at the route instead of saving a row that cannot create a checkout', async () => {
    stripeEnvironment(); const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    const before = structuredClone(await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'))
    const response = await saveThroughRoute(line, { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com' }, 'return-origin-route-missing-001')
    expect(response.status).toBe(422); expect(await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment')).toEqual(before)
  })

  it('keeps one shared exact-origin rule and an owner form that sends the return origin', () => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    const page = read('pages/audit-lab/managed-sites.vue')
    expect(page).toContain('v-model="form.returnOrigin"')
    expect(page).toContain('if (form.returnOrigin.trim()) transportConfiguration.returnOrigin = form.returnOrigin.trim()')
    expect(page).toContain('if (form.endpointOrigin.trim()) transportConfiguration.endpointOrigin = form.endpointOrigin.trim()')
    expect(page).toContain('if (form.checkoutOrigin.trim()) transportConfiguration.checkoutOrigin = form.checkoutOrigin.trim()')
    expect(read('server/managed-sites/live-connectors/stripe-adapters.ts')).toContain('exactManagedSiteReturnOrigin(value)')
    expect(read('server/managed-sites/live-connectors/provider-registry.ts')).toContain('exactManagedSiteReturnOrigin(transportConfiguration.returnOrigin)')
  })
})
