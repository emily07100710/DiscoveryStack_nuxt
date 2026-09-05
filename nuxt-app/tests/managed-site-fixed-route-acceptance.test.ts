import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, getHeader, send, setResponseStatus, toNodeListener } from 'h3'
import { createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { setManagedSitePaymentWebhookDependenciesForTests, setManagedSitePublicOrderingRepositoryForTests, setManagedSiteRouteDependencyFactoryForTests } from '../server/managed-sites/live-connectors/http'
import { createBailianQwenManagedSiteGenerationAdapter, createDeterministicManagedSiteBlueprint, createMemoryManagedSiteArtifactVault, createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { buildManagedSiteGenerationRequest } from '../server/managed-sites/live-connectors/generation-service'
import { createMockManagedSiteDeploymentAdapter, createMockExistingSiteOwnershipAdapter } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter } from '../server/managed-sites/live-connectors/domain-connectors'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const savedPrivateOrigin = process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
beforeAll(() => { (globalThis as any).defineEventHandler = defineEventHandler; (globalThis as any).createError = createError })
afterEach(() => { vi.useRealTimers(); setManagedSiteRouteDependencyFactoryForTests(null); setManagedSitePaymentWebhookDependenciesForTests(null); setManagedSitePublicOrderingRepositoryForTests(null); if (savedPrivateOrigin === undefined) delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN; else process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN = savedPrivateOrigin })

async function serve(handler: any, path: string) {
  const app = createApp(); const router = createRouter(); router.post(path, handler); app.use(router)
  const server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return { origin, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function serveRoutes(routes: { method: 'get' | 'post' | 'use'; path: string; handler: any }[]) {
  const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, error.statusCode || 500, error.statusMessage); await send(event, JSON.stringify({ statusCode: error.statusCode || 500, statusMessage: error.statusMessage || 'Request failed.' }), 'application/json') } }); const router = createRouter()
  for (const route of routes) {
    if (route.method === 'use') router.use(route.path, route.handler)
    else router[route.method](route.path, route.handler)
  }
  app.use(router); const server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); return { origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function createRouteState() {
  const managed = createManagedSiteMemoryRepository(); const ordering = createOrderingMemoryRepository(); const live = createLiveConnectorMemoryRepository(); const now = new Date('2026-08-27T00:00:00.000Z')
  let queue = Promise.resolve()
  const jointTransaction = async <T>(work: (repositories: { connector: typeof live.repository; ordering: typeof ordering.repository; managed: typeof managed.repository }) => Promise<T>) => {
    const prior = queue; let release!: () => void; queue = new Promise(resolve => { release = resolve }); await prior
    const snapshots = { live: structuredClone(live.state), ordering: structuredClone(ordering.state), managed: structuredClone(managed.state) }
    try { return await work({ connector: live.repository, ordering: ordering.repository, managed: managed.repository }) } catch (error) { Object.assign(live.state, snapshots.live); Object.assign(ordering.state, snapshots.ordering); Object.assign(managed.state, snapshots.managed); throw error } finally { release() }
  }
  return { managed, ordering, live, now, jointTransaction }
}

describe('managed-site actual fixed H3 route acceptance', () => {
  it('executes the complete generated-site and existing-site journeys through fixed H3 handlers only', async () => {
    delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
    const line = await createRouteState(); const vault = createMemoryManagedSiteArtifactVault(); const paymentCredential = 'runtime-only-route-payment-key'; let qwenBlueprint: any = null; let probeCalls = 0; let generationCalls = 0
    const qwenFetch = (async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)); expect(init.redirect).toBe('error')
      if (request.max_tokens === 4) { probeCalls++; return new Response(JSON.stringify({ id: 'route-probe-request-001', object: 'chat.completion', created: 1787788800, model: 'qwen-plus', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }), { status: 200, headers: { 'x-request-id': 'route-probe-request-001' } }) }
      generationCalls++; expect(qwenBlueprint).not.toBeNull(); const id = 'route-generation-request-001'
      return new Response(JSON.stringify({ id, model: 'qwen-plus', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ schemaVersion: 'managed-site-preview-copy-v1', navigation: [], pages: [], sections: [], faq: [], summaryAnswer: qwenBlueprint.seoGeo.summaryAnswer }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 80, total_tokens: 120 } }), { status: 200, headers: { 'x-request-id': id } })
    }) as typeof fetch
    const generationAdapter = createBailianQwenManagedSiteGenerationAdapter({ endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', fetchImpl: qwenFetch })
    let domainPurchaseCalls = 0; const domainBase = createMockManagedSiteDomainAdapter({ now: () => new Date() }); const domainAdapter = { ...domainBase, createPurchaseIntent: async (input: any) => { domainPurchaseCalls++; return domainBase.createPurchaseIntent(input) } }
    const dependencies = { ownerUserId: 1, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, artifactVault: vault, generationAdapter, checkoutAdapter: createMockManagedSiteCheckoutSessionAdapter(), domainAdapter, dnsTlsAdapter: createMockManagedSiteDnsTlsAdapter(), deploymentAdapter: createMockManagedSiteDeploymentAdapter(), ownershipAdapter: createMockExistingSiteOwnershipAdapter(), credentialResolver: async (reference: string) => reference === 'vault:qwen-route-full' ? { ok: true as const, value: 'runtime-only-qwen-route-key' } : reference === 'vault:route-payment-webhook' ? { ok: true as const, value: paymentCredential } : { ok: false as const, reason: 'missing_reference' as const }, fetchImpl: qwenFetch, paymentWebhookAdapter: createMockRawBodyPaymentWebhookAdapter('mock-payment'), paymentWebhookCredentialReference: 'vault:route-payment-webhook', paymentWebhookExecutionMode: 'mocked' as const, paymentWebhookJointTransaction: line.jointTransaction, geoActivator: async (ownerUserId: number, projectId: number, _input: unknown, repository: any) => ({ project: await repository.updateProject(ownerUserId, projectId, { contentOperationClientId: 901 }), client: { id: 901 }, linked: true }) }
    setManagedSitePaymentWebhookDependenciesForTests(dependencies)
    setManagedSitePublicOrderingRepositoryForTests(line.ordering.repository)
    setManagedSiteRouteDependencyFactoryForTests(event => {
      const session = getHeader(event, 'x-test-owner-session'); if (!session) throw createError({ statusCode: 401, statusMessage: 'Owner session is required.' })
      if (session === 'owner-2') return { ...dependencies, ownerUserId: 2 }
      if (session !== 'owner-1') throw createError({ statusCode: 403, statusMessage: 'Owner session is forbidden.' })
      return dependencies
    })
    const routeSpecs = [
      ['get', '/api/managed-sites/price-catalog', '../server/api/managed-sites/price-catalog.get'],
      ['post', '/api/managed-sites/previews', '../server/api/managed-sites/previews.post'],
      ['get', '/api/managed-sites/previews/:id', '../server/api/managed-sites/previews/[id].get'],
      ['post', '/api/managed-sites/previews/:id', '../server/api/managed-sites/previews/[id].post'],
      ['post', '/api/managed-sites/previews/:id/quote', '../server/api/managed-sites/previews/[id]/quote.post'],
      ['post', '/api/managed-sites/previews/:id/lead', '../server/api/managed-sites/previews/[id]/lead.post'],
      ['post', '/api/managed-sites/previews/:id/order', '../server/api/managed-sites/previews/[id]/order.post'],
      ['post', '/api/managed-sites/checkout-claim', '../server/api/managed-sites/checkout-claim.post'],
      ['post', '/api/managed-sites/projects/prepurchase', '../server/api/managed-sites/projects/prepurchase.post'],
      ['post', '/api/managed-sites/live-connectors/provider-configurations', '../server/api/managed-sites/live-connectors/provider-configurations.post'],
      ['post', '/api/managed-sites/live-connectors/providers/:capability/verify', '../server/api/managed-sites/live-connectors/providers/[capability]/verify.post'],
      ['post', '/api/managed-sites/projects/:id/live-generation', '../server/api/managed-sites/projects/[id]/live-generation.post'],
      ['post', '/api/managed-sites/projects/:id/releases/generated', '../server/api/managed-sites/projects/[id]/releases/generated.post'],
      ['post', '/api/managed-sites/projects/:id/releases/existing', '../server/api/managed-sites/projects/[id]/releases/existing.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/preview-build', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/preview-build.post'],
      ['get', '/api/managed-sites/projects/:id/releases/:releaseId/gates', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/gates.get'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/approve', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/approve.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/checkout', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/checkout.post'],
      ['post', '/api/managed-sites/live-connectors/payment-webhook', '../server/api/managed-sites/live-connectors/payment-webhook.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/domain-quote', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/domain-quote.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/domain-purchase', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/domain-purchase.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/dns-tls', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/dns-tls.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/deploy', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/deploy.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/ownership-challenge', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/ownership-challenge.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/ownership-verify', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/ownership-verify.post'],
      ['post', '/api/managed-sites/projects/:id/releases/:releaseId/geo-activate', '../server/api/managed-sites/projects/[id]/releases/[releaseId]/geo-activate.post'],
    ] as const
    const routes: { method: 'get' | 'post' | 'use'; path: string; handler: any }[] = await Promise.all(routeSpecs.map(async ([method, path, module]) => ({ method, path, handler: (await import(module)).default })))
    routes.push({ method: 'use', path: '/api/managed-sites/payments/**', handler: (await import('../server/api/managed-sites/payments/[...path]')).default })
    const server = await serveRoutes(routes as any); const ownerHeaders = { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1' }
    const request = async (path: string, body: unknown, headers: Record<string, string> = ownerHeaders) => {
      const response = await fetch(`${server.origin}${path}`, { method: 'POST', headers: { origin: server.origin, ...headers }, body: JSON.stringify(body) }); const text = await response.text()
      expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('x-robots-tag')).toContain('noindex'); expect(text).not.toContain('runtime-only-'); expect(text).not.toMatch(/x-discoverystack-provider-signature|authorization|rawBody|"stack"/iu)
      return { response, body: text ? JSON.parse(text) : null, text }
    }
    const getRequest = async (path: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${server.origin}${path}`, { headers }); const text = await response.text()
      expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('x-robots-tag')).toContain('noindex'); expect(text).not.toMatch(/credential|signature|secret|rawBody|"stack"/iu)
      return { response, body: text ? JSON.parse(text) : null, text }
    }
    const createOrderingJourney = async (canonicalDomain: string, prefix: string) => {
      const visitorHeaders = { 'content-type': 'application/json' }
      const preview = await request('/api/managed-sites/previews', { draftIdentity: `${prefix}-draft`, brandName: 'Route Managed Site', audience: 'Reviewed buyers', brief: 'A governed route-level managed website with evidence limitations.', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [] }, visitorHeaders)
      expect(preview.response.status, preview.text).toBe(200)
      const previewId = Number(preview.body.previewId); const previewAccessToken = String(preview.body.previewAccessToken)
      expect((await getRequest(`/api/managed-sites/previews/${previewId}`)).response.status).toBe(405)
      expect((await request(`/api/managed-sites/previews/${previewId}`, { accessToken: previewAccessToken }, visitorHeaders)).response.status).toBe(200)
      expect((await request(`/api/managed-sites/previews/${previewId}/quote`, { previewAccessToken, planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', idempotencyKey: `${prefix}-quote`, apiKey: 'forbidden-browser-secret' }, visitorHeaders)).response.status).toBe(422)
      const quote = await request(`/api/managed-sites/previews/${previewId}/quote`, { previewAccessToken, planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', idempotencyKey: `${prefix}-quote` }, visitorHeaders); expect(quote.response.status, quote.text).toBe(200)
      const quoteId = Number(quote.body.quote.quoteId)
      const lead = await request(`/api/managed-sites/previews/${previewId}/lead`, { previewAccessToken, quoteId, name: 'Route Owner', email: 'not-authority@example.invalid', company: 'Route Managed Site', website: `https://${canonicalDomain}`, privacyConsent: true, recontactConsent: false, idempotencyKey: `${prefix}-lead` }, visitorHeaders); expect(lead.response.status, lead.text).toBe(200)
      const leadIntentId = Number(lead.body.leadIntent.id)
      const order = await request(`/api/managed-sites/previews/${previewId}/order`, { previewAccessToken, quoteId, leadIntentId, idempotencyKey: `${prefix}-order` }, visitorHeaders); expect(order.response.status, order.text).toBe(200)
      const draftOrderId = Number(order.body.order.id)
      const claimBody = { previewId, previewAccessToken, quoteId, leadIntentId, draftOrderId }
      expect((await request('/api/managed-sites/checkout-claim', claimBody, visitorHeaders)).response.status).toBe(401)
      const claim = await request('/api/managed-sites/checkout-claim', claimBody); expect(claim.response.status, claim.text).toBe(200); expect(claim.body).toMatchObject({ previewId, quoteId, leadIntentId, draftOrderId, externalCalls: false })
      return { previewId, previewAccessToken, quoteId, leadIntentId, draftOrderId, quote: quote.body.quote }
    }
    try {
      const csrfRejectionHeaders: Record<string, string>[] = [
        { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1' },
        { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1', origin: 'https://foreign.example.invalid' },
        { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1', origin: server.origin, 'sec-fetch-site': 'cross-site' },
      ]
      for (const headers of csrfRejectionHeaders) {
        const rejected = await fetch(`${server.origin}/api/managed-sites/live-connectors/provider-configurations`, { method: 'POST', headers, body: '{}' })
        expect(rejected.status).toBe(403)
      }
      const catalog = await getRequest('/api/managed-sites/price-catalog'); expect(catalog.response.status).toBe(200); expect(catalog.body.version).toBe('managed-site-pricing-twd-v6')
      const orderingLine = await createOrderingJourney('route-generated.acme.taipei', 'route-full')
      const prepurchaseBody = { previewId: orderingLine.previewId, quoteId: orderingLine.quoteId, leadIntentId: orderingLine.leadIntentId, draftOrderId: orderingLine.draftOrderId, idempotencyKey: 'route-full-prepurchase' }
      expect((await request('/api/managed-sites/projects/prepurchase', prepurchaseBody, { 'content-type': 'application/json' })).response.status).toBe(401)
      const prepurchase = await request('/api/managed-sites/projects/prepurchase', prepurchaseBody); expect(prepurchase.response.status).toBe(200); expect(prepurchase.body).toMatchObject({ subscriptionActivated: false, paymentVerified: false, projectStatus: 'payment_pending', versionStatus: 'draft' })
      const projectId = Number(prepurchase.body.projectId); const sourceVersionId = Number(prepurchase.body.sourceVersionId)
      expect((await request('/api/managed-sites/projects/prepurchase', { ...prepurchaseBody, apiKey: 'browser-secret-is-forbidden' })).response.status).toBe(422)
      for (const configuration of [
        { capability: 'website_generator', providerKey: 'bailian-qwen', readinessStatus: 'configured', credentialReference: 'vault:qwen-route-full', transportConfiguration: { endpointOrigin: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' }, idempotencyKey: 'route-full-qwen-config' },
        { capability: 'payment', providerKey: 'mock-payment', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'route-full-payment-config' },
        { capability: 'domain_registration', providerKey: 'mock-domain', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'route-full-domain-config' },
        { capability: 'dns_tls', providerKey: 'mock-dns-tls', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'route-full-dns-config' },
        { capability: 'deployment', providerKey: 'mock-deployment', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'route-full-deployment-config' },
      ]) expect((await request('/api/managed-sites/live-connectors/provider-configurations', configuration)).response.status).toBe(200)
      const verified = await request('/api/managed-sites/live-connectors/providers/website_generator/verify', {}); expect(verified.response.status).toBe(200); expect(probeCalls).toBe(1)
      const version = await line.managed.repository.findVersion(1, sourceVersionId); qwenBlueprint = createDeterministicManagedSiteBlueprint(buildManagedSiteGenerationRequest(1, projectId, sourceVersionId, version!.versionFingerprint, version!.siteSpecSnapshot, 'astro', 'route-full-generation'))
      const generation = await request(`/api/managed-sites/projects/${projectId}/live-generation`, { sourceVersionId, executionMode: 'live', idempotencyKey: 'route-full-generation' }); expect(generation.response.status).toBe(200); expect(generationCalls).toBe(1)
      const generated = await request(`/api/managed-sites/projects/${projectId}/releases/generated`, { generationCandidateId: generation.body.candidate.id, canonicalDomain: 'route-generated.acme.taipei', targetKey: 'production-primary', idempotencyKey: 'route-full-release' }); expect(generated.response.status).toBe(200); const releaseId = Number(generated.body.release.id)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/checkout`, { executionMode: 'mocked', idempotencyKey: 'route-too-early-checkout' })).response.status).toBe(409)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/preview-build`, { executionMode: 'mocked', idempotencyKey: 'route-full-preview' })).response.status).toBe(200)
      const gatesResponse = await fetch(`${server.origin}/api/managed-sites/projects/${projectId}/releases/${releaseId}/gates`, { headers: { 'x-test-owner-session': 'owner-1', 'sec-fetch-site': 'same-origin' } }); expect(gatesResponse.status).toBe(200); expect(gatesResponse.headers.get('cache-control')).toContain('no-store'); const gates = await gatesResponse.json() as any; expect(gates.allAutomatedRequiredPassed).toBe(true); expect(gates.required).toHaveLength(5); expect(gates.humanReview).toMatchObject({ result: 'required', contentHashMatches: true })
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/approve`, { idempotencyKey: 'route-full-approve' })).response.status).toBe(200)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/checkout`, { executionMode: 'mocked', idempotencyKey: 'route-full-checkout' }, { 'content-type': 'application/json', 'x-test-owner-session': 'owner-2' })).response.status).toBe(404)
      const checkout = await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/checkout`, { executionMode: 'mocked', idempotencyKey: 'route-full-checkout' }); expect(checkout.response.status).toBe(200)
      expect((await request(`/api/managed-sites/payments/projects/${projectId}/releases/${releaseId}/reconcile`, { idempotencyKey: 'route-full-reconcile' })).response.status).toBe(503)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/domain-quote`, { requestedDomain: 'route-generated.acme.taipei', executionMode: 'mocked', idempotencyKey: 'route-domain-before-payment' })).response.status).toBe(404)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/deploy`, { executionMode: 'mocked', idempotencyKey: 'route-wrong-content', contentHash: 'f'.repeat(64) })).response.status).toBe(422)
      const paymentConfiguration = await line.live.repository.findProviderConfiguration(1, 'payment'); const checkoutReceipt = line.live.state.receipts.find(row => row.receiptType === 'checkout_session_created' && row.releaseId === releaseId)!
      const paymentPayload = { providerKey: 'mock-payment', providerEventId: 'route-payment-success-001', providerReference: 'route-payment-ref-001', eventType: 'checkout_succeeded', draftOrderId: orderingLine.draftOrderId, amountMinor: orderingLine.quote.totalMinor, currency: orderingLine.quote.currency, configurationFingerprint: paymentConfiguration!.configurationFingerprint, verificationReceiptFingerprint: paymentConfiguration!.verificationReceiptFingerprint, checkoutReceiptFingerprint: checkoutReceipt.receiptFingerprint, occurredAt: line.now.toISOString(), exactResponseIdentity: 'route-payment-response-001' }
      const wrongPayment = JSON.stringify({ ...paymentPayload, checkoutReceiptFingerprint: 'f'.repeat(64), providerEventId: 'route-payment-wrong-receipt' }); const wrongPaymentSignature = createHmac('sha256', paymentCredential).update(wrongPayment).digest('hex')
      const rejectedPayment = await fetch(`${server.origin}/api/managed-sites/live-connectors/payment-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-discoverystack-provider-signature': wrongPaymentSignature }, body: wrongPayment }); expect(rejectedPayment.status).toBe(409); expect(line.live.state.receipts.some(row => row.providerEventId === 'route-payment-wrong-receipt')).toBe(false)
      const rawPayment = JSON.stringify(paymentPayload); const paymentSignature = createHmac('sha256', paymentCredential).update(rawPayment).digest('hex')
      const webhook = await fetch(`${server.origin}/api/managed-sites/live-connectors/payment-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-discoverystack-provider-signature': paymentSignature }, body: rawPayment }); expect(webhook.status).toBe(200); expect(webhook.headers.get('cache-control')).toContain('no-store'); expect(await webhook.json()).toMatchObject({ accepted: true, effective: true })
      const duplicateWebhook = await fetch(`${server.origin}/api/managed-sites/live-connectors/payment-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-discoverystack-provider-signature': paymentSignature }, body: rawPayment }); expect(duplicateWebhook.status).toBe(200); expect(await duplicateWebhook.json()).toMatchObject({ accepted: true, replayed: true })
      const collisionRaw = JSON.stringify({ ...paymentPayload, providerReference: 'route-payment-collision-ref' }); const collisionSignature = createHmac('sha256', paymentCredential).update(collisionRaw).digest('hex')
      const collisionWebhook = await fetch(`${server.origin}/api/managed-sites/live-connectors/payment-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-discoverystack-provider-signature': collisionSignature }, body: collisionRaw }); expect(collisionWebhook.status).toBe(409)
      const domainQuote = await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/domain-quote`, { requestedDomain: 'route-generated.acme.taipei', executionMode: 'mocked', idempotencyKey: 'route-full-domain-quote' }); expect(domainQuote.response.status, domainQuote.text).toBe(200)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/domain-purchase`, { explicitConfirmation: true, executionMode: 'mocked', idempotencyKey: 'route-wrong-receipt', quoteReceiptFingerprint: 'f'.repeat(64) })).response.status).toBe(422)
      await request('/api/managed-sites/live-connectors/provider-configurations', { capability: 'domain_registration', providerKey: 'mock-domain', readinessStatus: 'mock', credentialReference: 'vault:route-rotated-domain-account', transportConfiguration: {}, idempotencyKey: 'route-domain-rotate' })
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/domain-purchase`, { explicitConfirmation: true, executionMode: 'mocked', idempotencyKey: 'route-stale-domain-purchase' })).response.status).toBe(409); expect(domainPurchaseCalls).toBe(0)
      await request('/api/managed-sites/live-connectors/provider-configurations', { capability: 'domain_registration', providerKey: 'mock-domain', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'route-domain-restore' })
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/domain-purchase`, { explicitConfirmation: true, executionMode: 'mocked', idempotencyKey: 'route-full-domain-purchase' })).response.status).toBe(200); expect(domainPurchaseCalls).toBe(1)
      expect((await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/dns-tls`, { executionMode: 'mocked', idempotencyKey: 'route-full-dns' })).response.status).toBe(200)
      const deployed = await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/deploy`, { executionMode: 'mocked', idempotencyKey: 'route-full-deploy' }); expect(deployed.response.status, deployed.text).toBe(200)
      const geo = await request(`/api/managed-sites/projects/${projectId}/releases/${releaseId}/geo-activate`, { timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 12, idempotencyKey: 'route-full-geo' }); expect(geo.response.status).toBe(200); expect(geo.body.release.status).toBe('geo_active')
      const ordered = line.live.state.receipts.map(row => row.receiptType); for (const [before, after] of [['generation_candidate_admitted', 'preview_build_verified'], ['preview_build_verified', 'owner_preview_approved'], ['owner_preview_approved', 'checkout_session_created'], ['checkout_session_created', 'checkout_succeeded'], ['checkout_succeeded', 'domain_registered'], ['domain_registered', 'dns_tls_verified'], ['dns_tls_verified', 'production_deployment_verified'], ['production_deployment_verified', 'geo_subscription_activated']] as const) expect(ordered.indexOf(before), `${before} -> ${after}: ${ordered.join(',')}`).toBeLessThan(ordered.indexOf(after))

      const existingLine = await createRouteState()
      Object.assign(dependencies, { repository: existingLine.live.repository, orderingRepository: existingLine.ordering.repository, managedRepository: existingLine.managed.repository, paymentWebhookJointTransaction: existingLine.jointTransaction, geoActivator: async (ownerUserId: number, existingProjectId: number, _input: unknown, repository: any) => ({ project: await repository.updateProject(ownerUserId, existingProjectId, { contentOperationClientId: 902 }), client: { id: 902 } }) })
      setManagedSitePublicOrderingRepositoryForTests(existingLine.ordering.repository)
      const existingOrdering = await createOrderingJourney('route-existing.acme.taipei', 'route-existing')
      await request('/api/managed-sites/projects/prepurchase', { previewId: existingOrdering.previewId, quoteId: existingOrdering.quoteId, leadIntentId: existingOrdering.leadIntentId, draftOrderId: existingOrdering.draftOrderId, idempotencyKey: 'route-existing-prepurchase' })
      await request('/api/managed-sites/live-connectors/provider-configurations', { capability: 'dns_tls', providerKey: 'mock-dns-tls', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'route-existing-dns-config' })
      const existingProjectId = existingLine.managed.state.projects[0]!.id
      const existingRelease = await request(`/api/managed-sites/projects/${existingProjectId}/releases/existing`, { canonicalDomain: 'route-existing.acme.taipei', targetKey: 'existing-primary', idempotencyKey: 'route-existing-release' }); expect(existingRelease.response.status, existingRelease.text).toBe(200); const existingReleaseId = existingRelease.body.release.id
      expect((await request(`/api/managed-sites/projects/${existingProjectId}/releases/${existingReleaseId}/ownership-challenge`, { executionMode: 'mocked', idempotencyKey: 'route-existing-challenge' })).response.status).toBe(200)
      expect((await request(`/api/managed-sites/projects/${existingProjectId}/releases/${existingReleaseId}/ownership-verify`, { executionMode: 'mocked', idempotencyKey: 'route-existing-verify' })).response.status).toBe(200)
      const existingGeo = await request(`/api/managed-sites/projects/${existingProjectId}/releases/${existingReleaseId}/geo-activate`, { timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 6, idempotencyKey: 'route-existing-geo' }); expect(existingGeo.body.release.status).toBe('geo_active')
    } finally { await server.close() }
  })

  it('enforces owner session, exact path scope, strict fields, safe order, and redacted response at the checkout handler', async () => {
    delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(managedSiteFixedNow)
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    setManagedSiteRouteDependencyFactoryForTests(event => {
      const session = getHeader(event, 'x-test-owner-session')
      if (session !== 'owner-1') throw createError({ statusCode: 401, statusMessage: 'Owner session is required.' })
      return { ownerUserId: 1, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, checkoutAdapter: createMockManagedSiteCheckoutSessionAdapter() }
    })
    const handler = (await import('../server/api/managed-sites/projects/[id]/releases/[releaseId]/checkout.post')).default
    const route = await serve(handler, '/api/managed-sites/projects/:id/releases/:releaseId/checkout')
    try {
      const url = `${route.origin}/api/managed-sites/projects/${line.prePurchase.project.id}/releases/${line.release.release.id}/checkout`
      const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: route.origin }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-unauthorized' }) }); expect(unauthorized.status).toBe(401)
      const unknown = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1', origin: route.origin }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-unknown', apiKey: 'forbidden-browser-value' }) }); expect(unknown.status).toBe(422)
      const wrongScope = await fetch(`${route.origin}/api/managed-sites/projects/999/releases/${line.release.release.id}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1', origin: route.origin }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-wrong-project' }) }); expect(wrongScope.status).toBe(404)
      expect(line.live.state.receipts.some(row => row.receiptType === 'generation_candidate_admitted')).toBe(true)
      expect(line.live.state.receipts.some(row => row.receiptType === 'preview_build_verified')).toBe(true)
      expect(line.live.state.receipts.some(row => row.receiptType === 'owner_preview_approved')).toBe(true)
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1', origin: route.origin }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-success-001' }) }); expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('x-robots-tag')).toContain('noindex')
      const body = await response.text(); expect(body).toContain('checkout'); expect(body).not.toMatch(/credential|signature|secret|stack/iu)
      const ordered = line.live.state.receipts.map(row => row.receiptType); expect(ordered.indexOf('generation_candidate_admitted')).toBeLessThan(ordered.indexOf('preview_build_verified')); expect(ordered.indexOf('preview_build_verified')).toBeLessThan(ordered.indexOf('owner_preview_approved')); expect(ordered.indexOf('owner_preview_approved')).toBeLessThan(ordered.indexOf('checkout_session_created'))
    } finally { await route.close() }
  })

  it('reaches the actual fixed provider configuration and owner-triggered Qwen verification handlers with mocked fetch', async () => {
    delete process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN
    const line = await createAuthoritativeManagedSiteReleaseFixture(); let probeCalls = 0
    setManagedSiteRouteDependencyFactoryForTests(event => {
      if (getHeader(event, 'x-test-owner-session') !== 'owner-1') throw createError({ statusCode: 401, statusMessage: 'Owner session is required.' })
      return { ownerUserId: 1, repository: line.live.repository, credentialResolver: async reference => reference === 'vault:qwen-route-probe' ? { ok: true as const, value: 'runtime-only-route-qwen-key' } : { ok: false as const, reason: 'missing_reference' as const }, fetchImpl: (async (_url: string, init: RequestInit) => { probeCalls++; expect(init.redirect).toBe('error'); return new Response(JSON.stringify({ id: 'route-probe-request-001', object: 'chat.completion', created: 1787788800, model: 'qwen-plus', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }), { status: 200, headers: { 'x-request-id': 'route-probe-request-001' } }) }) as typeof fetch }
    })
    const configure = (await import('../server/api/managed-sites/live-connectors/provider-configurations.post')).default
    const verify = (await import('../server/api/managed-sites/live-connectors/providers/[capability]/verify.post')).default
    const app = createApp(); const router = createRouter(); router.post('/api/managed-sites/live-connectors/provider-configurations', configure); router.post('/api/managed-sites/live-connectors/providers/:capability/verify', verify); app.use(router)
    const server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    try {
      const headers = { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1', origin }
      const configured = await fetch(`${origin}/api/managed-sites/live-connectors/provider-configurations`, { method: 'POST', headers, body: JSON.stringify({ capability: 'website_generator', providerKey: 'bailian-qwen', readinessStatus: 'configured', credentialReference: 'vault:qwen-route-probe', transportConfiguration: { endpointOrigin: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' }, idempotencyKey: 'route-qwen-configuration-001' }) }); expect(configured.status).toBe(200)
      const verified = await fetch(`${origin}/api/managed-sites/live-connectors/providers/website_generator/verify`, { method: 'POST', headers, body: '{}' }); expect(verified.status).toBe(200); expect(probeCalls).toBe(1)
      const response = await verified.text(); expect(response).not.toContain('runtime-only-route-qwen-key'); expect(response).not.toContain('OK'); expect((await line.live.repository.findProviderConfiguration(1, 'website_generator'))?.readinessStatus).toBe('verified')
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
