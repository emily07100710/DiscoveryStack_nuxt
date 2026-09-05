import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createEvent, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import { createManagedSiteCheckoutSession } from '../server/managed-sites/live-connectors/checkout-session'
import { MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES, setManagedSitePaymentWebhookDependenciesForTests, setManagedSiteRouteDependencyFactoryForTests } from '../server/managed-sites/live-connectors/http'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { createStripeCheckoutSessionAdapter, createStripePaymentWebhookAdapter, STRIPE_WEBHOOK_TOLERANCE_SECONDS } from '../server/managed-sites/live-connectors/stripe-adapters'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

beforeAll(() => { (globalThis as any).defineEventHandler = defineEventHandler; (globalThis as any).createError = createError })

const savedProviderOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const savedCheckoutOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
const savedPrivateOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN

afterEach(() => {
  setManagedSitePaymentWebhookDependenciesForTests(null)
  setManagedSiteRouteDependencyFactoryForTests(null)
  if (savedProviderOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = savedProviderOrigins
  if (savedCheckoutOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = savedCheckoutOrigins
  if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
  else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin
})

async function serveRoutes(routes: { method: 'use'; path: string; handler: any }[]) {
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, (error as any).statusCode || 500, (error as any).statusMessage); await send(event, JSON.stringify({ statusCode: (error as any).statusCode || 500, statusMessage: (error as any).statusMessage || 'Request failed.' }), 'application/json') } })
  const router = createRouter(); for (const route of routes) router.use(route.path, route.handler); app.use(router)
  const request = toWebHandler(app)
  return {
    request: (path: string, init: RequestInit) => request(new Request(`https://route-test.invalid${path}`, init)),
    handleNodeRequest: async (nodeRequest: Readable & { method?: string; url?: string; headers?: Record<string, string> }) => {
      const response = new ServerResponse(nodeRequest as any)
      try { return await app.handler(createEvent(nodeRequest as any, response)) } finally { response.destroy() }
    },
    close: async () => {},
  }
}

const metadataKeys = ['ds_draft_order_id', 'ds_release_id', 'ds_owner_user_id', 'ds_configuration_fingerprint', 'ds_verification_receipt_fingerprint', 'ds_checkout_receipt_fingerprint', 'ds_snapshot_fingerprint'] as const

async function stripeLine(options: { ownerUserId?: number; canonicalDomain?: string } = {}) {
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
  const line = await createAuthoritativeManagedSiteReleaseFixture({ ownerUserId: options.ownerUserId, canonicalDomain: options.canonicalDomain, createCheckout: false })
  const returnOrigin = 'https://merchant.example.com'
  await configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'mock', transportConfiguration: { checkoutOrigin: 'https://checkout.stripe.com', returnOrigin }, idempotencyKey: `fixture-stripe-${line.ownerUserId}` }, line.live.repository, () => managedSiteFixedNow)
  const apiCredential = randomBytes(32).toString('hex'); const requestCapture: { body?: URLSearchParams } = {}
  const fetchImpl: typeof fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(_url)).toBe('https://api.stripe.com/v1/checkout/sessions'); expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiCredential}`); expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    requestCapture.body = new URLSearchParams(String(init?.body || ''))
    const metadata = Object.fromEntries(metadataKeys.map(key => [key, requestCapture.body!.get(`metadata[${key}]`)]))
    return new Response(JSON.stringify({ id: `cs_test_${line.ownerUserId}_001`, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/cs_test_${line.ownerUserId}_001#fidkdWxOYHwnPyd1blpxYHZxWjA0`, amount_total: line.quote.quote.totalMinor * 100, currency: line.quote.quote.currency.toLowerCase(), metadata, extra_provider_field: true }), { status: 200 })
  }
  const checkout = await createManagedSiteCheckoutSession(line.ownerUserId, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: `fixture-stripe-checkout-${line.ownerUserId}` }, createStripeCheckoutSessionAdapter({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin, credentialReference: 'vault:stripe-api-test', resolveCredential: async () => ({ ok: true, value: apiCredential }), fetchImpl }), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, clock: () => managedSiteFixedNow })
  const sentBody = requestCapture.body
  if (!sentBody) throw new Error('Stripe checkout request was not captured')
  const metadata = Object.fromEntries(metadataKeys.map(key => [key, sentBody.get(`metadata[${key}]`)])) as Record<typeof metadataKeys[number], string>
  return { ...line, checkout, sentBody, metadata, returnOrigin }
}

function stripeEvent(line: Awaited<ReturnType<typeof stripeLine>>, input: { id: string; type: string; object?: Record<string, unknown> }) {
  const base = input.type === 'checkout.session.completed'
    ? { id: `cs_event_${input.id}`, object: 'checkout.session', payment_status: 'paid', amount_total: line.quote.quote.totalMinor * 100, currency: line.quote.quote.currency.toLowerCase(), payment_intent: `pi_event_${input.id}`, invoice: `in_event_${input.id}`, subscription: `sub_event_${input.id}`, metadata: line.metadata }
    : input.type === 'payment_intent.succeeded'
      ? { id: `pi_event_${input.id}`, object: 'payment_intent', amount_received: line.quote.quote.totalMinor * 100, currency: line.quote.quote.currency.toLowerCase(), latest_charge: `ch_event_${input.id}`, invoice: `in_event_${input.id}`, metadata: line.metadata }
      : input.type === 'charge.refunded'
        ? { id: `ch_event_${input.id}`, object: 'charge', payment_intent: `pi_event_${input.id}`, amount_refunded: line.quote.quote.totalMinor * 100, currency: line.quote.quote.currency.toLowerCase(), metadata: line.metadata }
        : { id: `dp_event_${input.id}`, object: 'dispute', charge: `ch_event_${input.id}`, payment_intent: `pi_event_${input.id}`, amount: line.quote.quote.totalMinor * 100, currency: line.quote.quote.currency.toLowerCase(), metadata: line.metadata }
  return { id: `evt_${input.id}`, object: 'event', type: input.type, created: Math.floor(managedSiteFixedNow.getTime() / 1000), data: { object: { ...base, ...input.object } } }
}

function signed(raw: string, credential: string, timestamp = Math.floor(managedSiteFixedNow.getTime() / 1000)): string {
  const signature = createHmac('sha256', credential).update(`${timestamp}.${raw}`).digest('hex')
  return `t=${timestamp},v0=${randomBytes(32).toString('hex')},v1=${signature}`
}

async function routeFor(line: Awaited<ReturnType<typeof stripeLine>>, webhookCredential: string) {
  setManagedSitePaymentWebhookDependenciesForTests({ ownerUserId: line.ownerUserId, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, paymentWebhookAdapter: createStripePaymentWebhookAdapter({ clock: () => managedSiteFixedNow }), paymentWebhookCredentialReference: 'vault:stripe-webhook-test', paymentWebhookExecutionMode: 'mocked', paymentWebhookJointTransaction: line.jointTransaction, paymentWebhookClock: () => managedSiteFixedNow, credentialResolver: async reference => reference === 'vault:stripe-webhook-test' ? { ok: true, value: webhookCredential } : { ok: false, reason: 'missing_reference' } })
  const handler = (await import('../server/api/managed-sites/payments/[...path]')).default
  return serveRoutes([{ method: 'use', path: '/api/managed-sites/payments/**', handler }])
}

async function deliver(server: Awaited<ReturnType<typeof routeFor>>, payload: unknown, credential: string, timestamp?: number, overrideSignature?: string) {
  const raw = JSON.stringify(payload)
  const response = await server.request('/api/managed-sites/payments/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': overrideSignature || signed(raw, credential, timestamp) }, body: raw })
  return { response, body: await response.json() as any }
}

describe('managed-site Stripe payment provider', () => {
  it('dispatches only exact payment paths and methods without mutating rejected requests', async () => {
    process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://route-test.invalid'
    const line = await stripeLine({ canonicalDomain: 'stripe-router-rejections.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    setManagedSiteRouteDependencyFactoryForTests(() => ({ ownerUserId: line.ownerUserId, repository: line.live.repository, orderingRepository: line.ordering.repository }))
    const state = () => structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
    try {
      for (const request of [
        { path: '/api/managed-sites/payments/nope', method: 'POST', expected: 404 },
        { path: '/api/managed-sites/payments/stripe/webhook', method: 'GET', expected: 405 },
        { path: '/api/managed-sites/payments/orders', method: 'POST', expected: 405 },
        // A loose prefix match would route these into the mutating reconcile handler, so pin exact segment shape.
        { path: '/api/managed-sites/payments/projects/1', method: 'POST', expected: 404 },
        { path: '/api/managed-sites/payments/projects/1/campaigns/1/reconcile', method: 'POST', expected: 404 },
        { path: '/api/managed-sites/payments/projects/1/releases/1/reconcile/extra', method: 'POST', expected: 404 },
        { path: '/api/managed-sites/payments/stripe/webhook/extra', method: 'POST', expected: 404 },
        { path: '/api/managed-sites/payments/orders/extra', method: 'GET', expected: 404 },
      ]) {
        const before = state()
        const response = await server.request(request.path, { method: request.method })
        expect(response.status).toBe(request.expected)
        expect(response.headers.get('cache-control')).toContain('no-store')
        expect(response.headers.get('x-robots-tag')).toContain('noindex')
        expect(state()).toEqual(before)
      }

      const beforeInvalidId = state()
      const invalidId = await server.request('/api/managed-sites/payments/projects/abc/releases/1/reconcile', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://route-test.invalid' }, body: JSON.stringify({ idempotencyKey: 'invalid-router-id' }) })
      expect(invalidId.status).toBe(422)
      expect(state()).toEqual(beforeInvalidId)
    } finally { await server.close() }
  })

  it('accepts a signed Stripe webhook without Origin while rejecting cross-origin reconciliation in the same handler', async () => {
    process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = 'https://route-test.invalid'
    const line = await stripeLine({ canonicalDomain: 'stripe-router-origin.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    setManagedSiteRouteDependencyFactoryForTests(() => ({ ownerUserId: line.ownerUserId, repository: line.live.repository, orderingRepository: line.ordering.repository }))
    try {
      const accepted = await deliver(server, stripeEvent(line, { id: 'no_origin_success_001', type: 'checkout.session.completed' }), credential)
      expect(accepted.response.status, JSON.stringify(accepted.body)).toBe(200)
      expect(accepted.body).toMatchObject({ accepted: true, replayed: false, effective: true })

      const afterWebhook = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const rejected = await server.request(`/api/managed-sites/payments/projects/${line.prePurchase.project.id}/releases/${line.release.release.id}/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://foreign.example.invalid' }, body: JSON.stringify({ idempotencyKey: 'cross-origin-reconcile' }) })
      expect(rejected.status).toBe(403)
      expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(afterWebhook)
    } finally { await server.close() }
  })

  it('rejects a declared oversized Stripe webhook before reading it and preserves byte-identical repository state', async () => {
    const line = await stripeLine({ canonicalDomain: 'declared-oversized-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    const stateBytes = () => Buffer.from(JSON.stringify({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }))
    const before = stateBytes()
    try {
      const response = await server.request('/api/managed-sites/payments/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES + 1) }, body: '{}' })
      expect(response.status).toBe(413)
      expect(stateBytes()).toEqual(before)
    } finally { await server.close() }
  })

  it('stops buffering a chunked Stripe webhook at the cap, returns 413, and preserves byte-identical repository state', async () => {
    const line = await stripeLine({ canonicalDomain: 'streamed-oversized-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    const stateBytes = () => Buffer.from(JSON.stringify({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }))
    const before = stateBytes(); const chunkBytes = 64_000; const totalBytes = MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES + 512_000
    let producedBytes = 0; let pausedAtLimit = false; let chunkScheduled = false
    const request = new Readable({
      read() {
        if (chunkScheduled) return
        chunkScheduled = true
        setImmediate(() => {
          chunkScheduled = false
          if (pausedAtLimit || request.destroyed) return
          if (producedBytes >= totalBytes) return this.push(null)
          const size = Math.min(chunkBytes, totalBytes - producedBytes)
          producedBytes += size
          this.push(Buffer.alloc(size, 0x78))
        })
      },
    }) as Readable & { method?: string; url?: string; headers?: Record<string, string> }
    const pause = request.pause.bind(request)
    request.pause = () => { pausedAtLimit = true; return pause() }
    request.method = 'POST'; request.url = '/api/managed-sites/payments/stripe/webhook'; request.headers = { host: 'route-test.invalid', 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
    try {
      await expect(server.handleNodeRequest(request)).rejects.toMatchObject({ statusCode: 413 })
      expect(pausedAtLimit).toBe(true)
      expect(producedBytes).toBeLessThan(totalBytes)
      expect(producedBytes).toBeLessThanOrEqual(MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES + chunkBytes)
      expect(stateBytes()).toEqual(before)
    } finally { request.destroy(); await server.close() }
  })

  it('accepts an exactly signed small webhook without content-length and still performs the paid transition once', async () => {
    const line = await stripeLine({ canonicalDomain: 'chunked-small-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    try {
      const raw = JSON.stringify(stripeEvent(line, { id: 'small_without_length_001', type: 'checkout.session.completed' }))
      const headers = new Headers({ 'content-type': 'application/json', 'stripe-signature': signed(raw, credential) })
      expect(headers.get('content-length')).toBeNull()
      const response = await server.request('/api/managed-sites/payments/stripe/webhook', { method: 'POST', headers, body: raw })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      expect(await response.json()).toMatchObject({ accepted: true, replayed: false, effective: true })
      expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)).toMatchObject({ status: 'payment_verified', paymentIntentReference: 'cs_event_small_without_length_001' })
      expect(line.live.state.releases.find(row => row.id === line.release.release.id)?.status).toBe('payment_verified')
      expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)

      // Keep this acceptance regression red if the bounded route guard is removed altogether.
      const afterAccepted = Buffer.from(JSON.stringify({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }))
      const oversized = await server.request('/api/managed-sites/payments/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(MANAGED_SITE_PAYMENT_WEBHOOK_MAX_BYTES + 1) }, body: '{}' })
      expect(oversized.status).toBe(413)
      expect(Buffer.from(JSON.stringify({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }))).toEqual(afterAccepted)
    } finally { await server.close() }
  })

  it('accepts an exactly signed small webhook through the Node stream path with and without content-length', async () => {
    // Production (Render/Node) always takes the bounded streaming branch; prove its resolve path returns the bytes intact across chunks.
    for (const shape of [
      { canonicalDomain: 'node-length-stripe.acme.taipei', eventId: 'node_with_length_001', headers: (raw: string) => ({ 'content-length': String(Buffer.byteLength(raw)) }) },
      { canonicalDomain: 'node-chunked-stripe.acme.taipei', eventId: 'node_chunked_001', headers: () => ({ 'transfer-encoding': 'chunked' }) },
    ]) {
      const line = await stripeLine({ canonicalDomain: shape.canonicalDomain }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
      try {
        const raw = JSON.stringify(stripeEvent(line, { id: shape.eventId, type: 'checkout.session.completed' }))
        const request = Readable.from([Buffer.from(raw.slice(0, 7)), Buffer.from(raw.slice(7))]) as Readable & { method?: string; url?: string; headers?: Record<string, string> }
        request.method = 'POST'; request.url = '/api/managed-sites/payments/stripe/webhook'; request.headers = { host: 'route-test.invalid', 'content-type': 'application/json', 'stripe-signature': signed(raw, credential), ...shape.headers(raw) }
        await server.handleNodeRequest(request)
        expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)).toMatchObject({ status: 'payment_verified', paymentIntentReference: `cs_event_${shape.eventId}` })
        expect(line.live.state.releases.find(row => row.id === line.release.release.id)?.status).toBe('payment_verified')
        expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)
      } finally { await server.close() }
    }
  })

  it('fails closed unless Stripe checkout and merchant return origins are exact and separate', () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
    const base = { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com', credentialReference: 'vault:stripe-api-test', resolveCredential: async () => ({ ok: true as const, value: 'unused-test-credential' }) }
    for (const options of [
      { ...base, returnOrigin: undefined },
      { ...base, returnOrigin: 'http://merchant.example.com' },
      { ...base, returnOrigin: 'https://merchant.example.com/path' },
      { ...base, checkoutOrigin: 'https://merchant.example.com' },
    ]) {
      try { createStripeCheckoutSessionAdapter(options as any); throw new Error('expected exact Stripe origin validation to reject') } catch (error) {
        expect((error as any).statusCode).toBe(503)
        expect(String((error as any).statusMessage)).not.toContain('unused-test-credential')
      }
    }
  })

  it('verifies Stripe with one read-only balance request', async () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
    const live = createLiveConnectorMemoryRepository(); const credential = randomBytes(32).toString('hex')
    await configureManagedSiteProvider(1, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference: 'vault:stripe-balance-test', transportConfiguration: { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin: 'https://merchant.example.com' }, idempotencyKey: 'stripe-balance-config-001' }, live.repository, () => managedSiteFixedNow)
    let calls = 0
    const fetchImpl: typeof fetch = async (input, init) => {
      calls++; expect(String(input)).toBe('https://api.stripe.com/v1/balance'); expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined(); expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${credential}`)
      return new Response(JSON.stringify({ object: 'balance', available: [{ amount: 100, currency: 'usd' }], pending: [], livemode: false, extra_provider_field: true }), { status: 200, headers: { 'request-id': 'req_balance_read_only_001' } })
    }
    const result = await verifyManagedSiteProviderConfiguration(1, 'payment', live.repository, async () => ({ ok: true, value: credential }), () => managedSiteFixedNow, undefined, fetchImpl)
    expect(calls).toBe(1); expect(result.configuration).toMatchObject({ providerKey: 'stripe', readinessStatus: 'verified', capabilityIdentity: 'stripe-balance:test' })
  })

  it('creates a server-derived subscription checkout and applies one signed success exactly once with one provisioning arm', async () => {
    const line = await stripeLine(); const webhookCredential = randomBytes(32).toString('hex'); const server = await routeFor(line, webhookCredential)
    try {
      expect(line.sentBody.get('mode')).toBe('subscription'); expect(line.sentBody.get('currency')).toBe(line.quote.quote.currency.toLowerCase())
      expect(line.sentBody.get('success_url')).toBe(`${line.returnOrigin}/managed-sites/checkout/success`); expect(line.sentBody.get('cancel_url')).toBe(`${line.returnOrigin}/managed-sites/checkout/cancel`)
      expect(line.sentBody.get('success_url')).not.toContain('checkout.stripe.com'); expect(line.checkout.checkout.url).toContain('#fidkdWxOYHwnPyd1blpx')
      expect(line.sentBody.get('line_items[0][price_data][recurring][interval]')).toBeNull(); expect(line.sentBody.get('line_items[2][price_data][recurring][interval]')).toBe('month'); expect(line.sentBody.get('line_items[2][price_data][recurring][interval_count]')).toBe('1')
      expect(metadataKeys.every(key => line.sentBody.get(`subscription_data[metadata][${key}]`) === line.metadata[key])).toBe(true)
      expect(line.live.state.receipts.find(row => row.receiptType === 'checkout_session_created')?.receiptFingerprint).toBe(line.metadata.ds_checkout_receipt_fingerprint)
      const payload = stripeEvent(line, { id: 'checkout_success_001', type: 'checkout.session.completed' })
      const first = await deliver(server, payload, webhookCredential); expect(first.response.status, JSON.stringify(first.body)).toBe(200); expect(first.body).toMatchObject({ accepted: true, replayed: false, effective: true })
      expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)).toMatchObject({ status: 'payment_verified', paymentIntentReference: 'cs_event_checkout_success_001' })
      expect(line.live.state.releases.find(row => row.id === line.release.release.id)?.status).toBe('payment_verified')
      expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)
      expect(line.live.state.receipts.find(row => row.receiptType === 'checkout_succeeded')?.metadata).toMatchObject({ stripePaymentIntentId: 'pi_event_checkout_success_001', stripeInvoiceId: 'in_event_checkout_success_001', stripeSubscriptionId: 'sub_event_checkout_success_001' })
      const second = await deliver(server, payload, webhookCredential); expect(second.response.status).toBe(200); expect(second.body).toMatchObject({ accepted: true, replayed: true, effective: true })
      expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)
      const lateIntent = await deliver(server, stripeEvent(line, { id: 'intent_late_001', type: 'payment_intent.succeeded' }), webhookCredential)
      expect(lateIntent.response.status).toBe(200); expect(lateIntent.body.effective).toBe(false)
      expect(line.live.state.receipts.filter(row => row.receiptType === 'checkout_succeeded')).toHaveLength(2)
      expect(line.live.state.receipts.find(row => row.providerEventId === 'evt_intent_late_001')?.metadata).toMatchObject({ stripeChargeId: 'ch_event_intent_late_001' })
      expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)
    } finally { await server.close() }
  })

  it('acknowledges unpaid Checkout completion without mutation and later arms from PaymentIntent success', async () => {
    const line = await stripeLine({ canonicalDomain: 'unpaid-checkout-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    try {
      const before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const unpaid = await deliver(server, stripeEvent(line, { id: 'checkout_unpaid_001', type: 'checkout.session.completed', object: { payment_status: 'unpaid' } }), credential)
      expect(unpaid.response.status).toBe(200); expect(unpaid.body).toEqual({ accepted: true, ignored: 'checkout_session_not_paid' })
      expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
      const paid = await deliver(server, stripeEvent(line, { id: 'intent_after_unpaid_001', type: 'payment_intent.succeeded' }), credential)
      expect(paid.response.status).toBe(200); expect(paid.body).toMatchObject({ accepted: true, replayed: false, effective: true })
      expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)?.status).toBe('payment_verified')
      expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)
    } finally { await server.close() }
  })

  it('acknowledges foreign handled events but rejects present malformed managed-site metadata', async () => {
    const line = await stripeLine({ canonicalDomain: 'foreign-stripe-events.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    try {
      for (const payload of [
        stripeEvent(line, { id: 'foreign_checkout', type: 'checkout.session.completed', object: { id: 'cs_foreign_checkout_001', payment_intent: 'pi_foreign_checkout_001', metadata: {} } }),
        stripeEvent(line, { id: 'foreign_intent', type: 'payment_intent.succeeded', object: { id: 'pi_foreign_intent_001', latest_charge: 'ch_foreign_intent_001', metadata: {} } }),
        stripeEvent(line, { id: 'incomplete_metadata', type: 'checkout.session.completed', object: { id: 'cs_incomplete_metadata_001', metadata: { ds_draft_order_id: '999' } } }),
      ]) {
        const before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
        const ignored = await deliver(server, payload, credential)
        expect(ignored.response.status).toBe(200); expect(ignored.body).toEqual({ accepted: true, ignored: 'unbindable_provider_reference' })
        expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
      }
      const before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const malformed = await deliver(server, stripeEvent(line, { id: 'malformed_metadata', type: 'checkout.session.completed', object: { metadata: { ds_draft_order_id: 999 } } }), credential)
      expect(malformed.response.status).toBe(400)
      expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
    } finally { await server.close() }
  })

  it('rejects a bad signature and a stale timestamp with byte-identical repository state', async () => {
    for (const stale of [false, true]) {
      const line = await stripeLine({ canonicalDomain: stale ? 'stale-stripe.acme.taipei' : 'bad-signature-stripe.acme.taipei' }); const webhookCredential = randomBytes(32).toString('hex'); const server = await routeFor(line, webhookCredential)
      const before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      try {
        const payload = stripeEvent(line, { id: stale ? 'stale_001' : 'bad_signature_001', type: 'checkout.session.completed' })
        const timestamp = Math.floor(managedSiteFixedNow.getTime() / 1000) - STRIPE_WEBHOOK_TOLERANCE_SECONDS - 1
        const result = stale ? await deliver(server, payload, webhookCredential, timestamp) : await deliver(server, payload, webhookCredential, undefined, `t=${Math.floor(managedSiteFixedNow.getTime() / 1000)},v1=${randomBytes(32).toString('hex')}`)
        expect(result.response.status).toBe(400)
        expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
      } finally { await server.close() }
    }
  })

  it('applies partial refunds and disputes as distinct terminal order and release authority', async () => {
    for (const lifecycle of [
      { type: 'charge.refunded', expectedOrder: 'refunded', reason: 'PAYMENT_REFUNDED', receipt: 'payment_refunded' },
      { type: 'charge.dispute.created', expectedOrder: 'disputed', reason: 'PAYMENT_DISPUTED', receipt: 'payment_disputed' },
    ]) {
      const line = await stripeLine({ canonicalDomain: lifecycle.type === 'charge.refunded' ? 'refund-stripe.acme.taipei' : 'dispute-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
      try {
        expect((await deliver(server, stripeEvent(line, { id: `${lifecycle.receipt}_success`, type: 'checkout.session.completed' }), credential)).response.status).toBe(200)
        const amount = Math.max(1, Math.floor(line.quote.quote.totalMinor / 2))
        const result = await deliver(server, stripeEvent(line, { id: `${lifecycle.receipt}_event`, type: lifecycle.type, object: lifecycle.type === 'charge.refunded' ? { amount_refunded: amount * 100 } : { amount: amount * 100 } }), credential)
        expect(result.response.status).toBe(200); expect(result.body.effective).toBe(true)
        expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)?.status).toBe(lifecycle.expectedOrder)
        expect(line.live.state.releases.find(row => row.id === line.release.release.id)).toMatchObject({ status: 'blocked', blockedReasonCode: lifecycle.reason })
        expect(line.managed.state.projects.find(row => row.id === line.prePurchase.project.id)?.status).toBe('suspended')
        expect(line.managed.state.subscriptions.find(row => row.projectId === line.prePurchase.project.id)?.status).toBe('suspended')
        expect(line.live.state.receipts.filter(row => row.receiptType === lifecycle.receipt)).toHaveLength(1)
        expect(line.live.state.receipts.find(row => row.receiptType === lifecycle.receipt)?.metadata).toMatchObject({ amountMinor: amount, fullAmount: false })
      } finally { await server.close() }
    }
  })

  it('settles partial refunds and disputes that arrive before checkout success without arming provisioning', async () => {
    for (const lifecycle of [
      { type: 'charge.refunded', expectedOrder: 'refunded', reason: 'PAYMENT_REFUNDED', receipt: 'payment_refunded' },
      { type: 'charge.dispute.created', expectedOrder: 'disputed', reason: 'PAYMENT_DISPUTED', receipt: 'payment_disputed' },
    ]) {
      const line = await stripeLine({ canonicalDomain: lifecycle.type === 'charge.refunded' ? 'early-refund-stripe.acme.taipei' : 'early-dispute-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
      try {
        const amount = Math.max(1, Math.floor(line.quote.quote.totalMinor / 2))
        const earlyId = `${lifecycle.receipt}_early_001`
        const early = await deliver(server, stripeEvent(line, { id: earlyId, type: lifecycle.type, object: lifecycle.type === 'charge.refunded' ? { amount_refunded: amount * 100 } : { amount: amount * 100 } }), credential)
        expect(early.response.status).toBe(200); expect(early.body).toMatchObject({ accepted: true, effective: false })
        const paid = await deliver(server, stripeEvent(line, { id: `${lifecycle.receipt}_paid_001`, type: 'checkout.session.completed' }), credential)
        expect(paid.response.status).toBe(200); expect(paid.body).toMatchObject({ accepted: true, effective: true })
        expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)?.status).toBe(lifecycle.expectedOrder)
        expect(line.live.state.releases.find(row => row.id === line.release.release.id)).toMatchObject({ status: 'blocked', blockedReasonCode: lifecycle.reason })
        expect(line.managed.state.projects.find(row => row.id === line.prePurchase.project.id)?.status).toBe('suspended')
        expect(line.managed.state.subscriptions.find(row => row.projectId === line.prePurchase.project.id)?.status).toBe('suspended')
        expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(0)
        expect(line.live.state.receipts.filter(row => row.receiptType === 'release_payment_bound')).toHaveLength(0)
        const settled = line.live.state.receipts.filter(row => row.receiptType === lifecycle.receipt && row.receiptStatus === 'verified' && (row.metadata as any)?.effective === true)
        expect(settled).toHaveLength(1); expect(settled[0]?.metadata).toMatchObject({ fullAmount: false, amountMinor: amount, settledFromProviderEventId: `evt_${earlyId}` })
      } finally { await server.close() }
    }
  })

  it('returns 404 for a signed unknown draft order before attempting an inbox write', async () => {
    const line = await stripeLine({ canonicalDomain: 'unknown-order-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    const inboxInsert = vi.spyOn(line.live.repository, 'insertPaymentWebhookInbox')
    try {
      const before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const unknownOrderId = Math.max(...line.ordering.state.orders.map(row => row.id)) + 10_000
      const payload = stripeEvent(line, { id: 'unknown_order_001', type: 'checkout.session.completed', object: { metadata: { ...line.metadata, ds_draft_order_id: String(unknownOrderId) } } })
      const result = await deliver(server, payload, credential)
      expect(result.response.status).toBe(404)
      expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
      expect(inboxInsert).not.toHaveBeenCalled()
    } finally { inboxInsert.mockRestore(); await server.close() }
  })

  it('rejects an unknown signed event and another owner order identity without mutation', async () => {
    const line = await stripeLine({ ownerUserId: 1, canonicalDomain: 'owner-one-stripe.acme.taipei' }); const other = await createAuthoritativeManagedSiteReleaseFixture({ ownerUserId: 2, canonicalDomain: 'owner-two-stripe.acme.taipei' })
    const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    try {
      let before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const unknown = await deliver(server, stripeEvent(line, { id: 'unknown_001', type: 'customer.created' }), credential)
      expect(unknown.response.status).toBe(200); expect(unknown.body).toEqual({ accepted: true, ignored: 'unsupported_event_type' }); expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)

      const anotherOwnerOrder = { ...structuredClone(other.order.order), id: Math.max(...line.ordering.state.orders.map(row => row.id)) + 100, projectId: line.prePurchase.project.id }
      line.ordering.state.orders.push(anotherOwnerOrder)
      const payload = stripeEvent(line, { id: 'wrong_owner_001', type: 'checkout.session.completed', object: { metadata: { ...line.metadata, ds_draft_order_id: String(anotherOwnerOrder.id) } } })
      before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const rejected = await deliver(server, payload, credential); expect(rejected.response.status).toBe(409)
      expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
    } finally { await server.close() }
  })

  it('binds a real-shaped metadata-free dispute through persisted Stripe object ids and rejects an excessive refund amount', async () => {
    const line = await stripeLine({ canonicalDomain: 'unbindable-stripe.acme.taipei' }); const credential = randomBytes(32).toString('hex'); const server = await routeFor(line, credential)
    try {
      expect((await deliver(server, stripeEvent(line, { id: 'paid_before_dispute', type: 'checkout.session.completed' }), credential)).body.effective).toBe(true)
      const paymentIntentId = 'pi_event_paid_before_dispute'; const chargeId = 'ch_bound_real_dispute_001'
      const intent = await deliver(server, stripeEvent(line, { id: 'bind_charge_id', type: 'payment_intent.succeeded', object: { id: paymentIntentId, latest_charge: chargeId, metadata: {} } }), credential)
      expect(intent.response.status).toBe(200); expect(intent.body).toMatchObject({ accepted: true, effective: false })
      expect(line.live.state.receipts.find(row => row.providerEventId === 'evt_bind_charge_id')?.metadata).toMatchObject({ stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId })
      const amount = Math.max(1, Math.floor(line.quote.quote.totalMinor / 2))
      const dispute = await deliver(server, stripeEvent(line, { id: 'real_dispute_empty_metadata', type: 'charge.dispute.created', object: { charge: chargeId, payment_intent: paymentIntentId, amount: amount * 100, metadata: {} } }), credential)
      expect(dispute.response.status).toBe(200); expect(dispute.body).toMatchObject({ accepted: true, effective: true })
      expect(line.ordering.state.orders.find(row => row.id === line.order.order.id)?.status).toBe('disputed')
      expect(line.live.state.releases.find(row => row.id === line.release.release.id)).toMatchObject({ status: 'blocked', blockedReasonCode: 'PAYMENT_DISPUTED' })
      expect(line.managed.state.projects.find(row => row.id === line.prePurchase.project.id)?.status).toBe('suspended')
      expect(line.managed.state.subscriptions.find(row => row.projectId === line.prePurchase.project.id)?.status).toBe('suspended')

      const before = structuredClone({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state })
      const excessive = await deliver(server, stripeEvent(line, { id: 'refund_excessive', type: 'charge.refunded', object: { amount_refunded: (line.quote.quote.totalMinor + 1) * 100 } }), credential)
      expect(excessive.response.status).toBe(409)
      expect({ live: line.live.state, ordering: line.ordering.state, managed: line.managed.state }).toEqual(before)
    } finally { await server.close() }
  })
})

/**
 * Stripe's Checkout Session resource reports `"object": "checkout.session"` — dotted, unlike
 * `payment_intent` / `charge` / `dispute`, which use underscores. Every fixture in this repo is
 * written by us, so a wrong constant here would stay green in CI and only fail against the real
 * API. Pin the literal so a "consistency" cleanup cannot silently reintroduce `checkout_session`.
 */
describe('stripe object-name constants match the real Stripe API', () => {
  const adapterSource = readFileSync(new URL('../server/managed-sites/live-connectors/stripe-adapters.ts', import.meta.url), 'utf8')
  const reconciliationSource = readFileSync(new URL('../server/managed-sites/live-connectors/payment-reconciliation.ts', import.meta.url), 'utf8')

  it('asserts the dotted checkout.session object name everywhere it is compared', () => {
    for (const source of [adapterSource, reconciliationSource]) {
      expect(source).toContain("'checkout.session'")
      expect(source).not.toMatch(/'checkout_session'/u)
    }
  })

  it('keeps the underscored names that Stripe really does use', () => {
    expect(adapterSource).toContain("'payment_intent'")
    expect(adapterSource).toContain("'charge'")
    expect(adapterSource).toContain("'dispute'")
  })
})
