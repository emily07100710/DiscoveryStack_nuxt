import { createServer } from 'node:http'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp, createError, createRouter, defineEventHandler, getHeader, toNodeListener } from 'h3'
import { createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { setManagedSiteRouteDependencyFactoryForTests } from '../server/managed-sites/live-connectors/http'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

beforeAll(() => { (globalThis as any).defineEventHandler = defineEventHandler; (globalThis as any).createError = createError })
afterEach(() => setManagedSiteRouteDependencyFactoryForTests(null))

async function serve(handler: any, path: string) {
  const app = createApp(); const router = createRouter(); router.post(path, handler); app.use(router)
  const server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return { origin, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

describe('managed-site actual fixed H3 route acceptance', () => {
  it('enforces owner session, exact path scope, strict fields, safe order, and redacted response at the checkout handler', async () => {
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
      const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-unauthorized' }) }); expect(unauthorized.status).toBe(401)
      const unknown = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1' }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-unknown', apiKey: 'forbidden-browser-value' }) }); expect(unknown.status).toBe(422)
      const wrongScope = await fetch(`${route.origin}/api/managed-sites/projects/999/releases/${line.release.release.id}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1' }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-wrong-project' }) }); expect(wrongScope.status).toBe(404)
      expect(line.live.state.receipts.some(row => row.receiptType === 'generation_candidate_admitted')).toBe(true)
      expect(line.live.state.receipts.some(row => row.receiptType === 'preview_build_verified')).toBe(true)
      expect(line.live.state.receipts.some(row => row.receiptType === 'owner_preview_approved')).toBe(true)
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1' }, body: JSON.stringify({ executionMode: 'mocked', idempotencyKey: 'route-checkout-success-001' }) }); expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('x-robots-tag')).toContain('noindex')
      const body = await response.text(); expect(body).toContain('checkout'); expect(body).not.toMatch(/credential|signature|secret|stack/iu)
      const ordered = line.live.state.receipts.map(row => row.receiptType); expect(ordered.indexOf('generation_candidate_admitted')).toBeLessThan(ordered.indexOf('preview_build_verified')); expect(ordered.indexOf('preview_build_verified')).toBeLessThan(ordered.indexOf('owner_preview_approved')); expect(ordered.indexOf('owner_preview_approved')).toBeLessThan(ordered.indexOf('checkout_session_created'))
    } finally { await route.close() }
  })

  it('reaches the actual fixed provider configuration and owner-triggered Qwen verification handlers with mocked fetch', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); let probeCalls = 0
    setManagedSiteRouteDependencyFactoryForTests(event => {
      if (getHeader(event, 'x-test-owner-session') !== 'owner-1') throw createError({ statusCode: 401, statusMessage: 'Owner session is required.' })
      return { ownerUserId: 1, repository: line.live.repository, credentialResolver: async reference => reference === 'vault:qwen-route-probe' ? { ok: true as const, value: 'runtime-only-route-qwen-key' } : { ok: false as const, reason: 'missing_reference' as const }, fetchImpl: (async (_url: string, init: RequestInit) => { probeCalls++; expect(init.redirect).toBe('error'); return new Response(JSON.stringify({ id: 'route-probe-request-001', object: 'chat.completion', created: 1787788800, model: 'qwen-plus', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }), { status: 200 }) }) as typeof fetch }
    })
    const configure = (await import('../server/api/managed-sites/live-connectors/provider-configurations.post')).default
    const verify = (await import('../server/api/managed-sites/live-connectors/providers/[capability]/verify.post')).default
    const app = createApp(); const router = createRouter(); router.post('/api/managed-sites/live-connectors/provider-configurations', configure); router.post('/api/managed-sites/live-connectors/providers/:capability/verify', verify); app.use(router)
    const server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    try {
      const headers = { 'content-type': 'application/json', 'x-test-owner-session': 'owner-1' }
      const configured = await fetch(`${origin}/api/managed-sites/live-connectors/provider-configurations`, { method: 'POST', headers, body: JSON.stringify({ capability: 'website_generator', providerKey: 'bailian-qwen', readinessStatus: 'configured', credentialReference: 'vault:qwen-route-probe', transportConfiguration: { endpointOrigin: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' }, idempotencyKey: 'route-qwen-configuration-001' }) }); expect(configured.status).toBe(200)
      const verified = await fetch(`${origin}/api/managed-sites/live-connectors/providers/website_generator/verify`, { method: 'POST', headers, body: '{}' }); expect(verified.status).toBe(200); expect(probeCalls).toBe(1)
      const response = await verified.text(); expect(response).not.toContain('runtime-only-route-qwen-key'); expect(response).not.toContain('OK'); expect((await line.live.repository.findProviderConfiguration(1, 'website_generator'))?.readinessStatus).toBe('verified')
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
