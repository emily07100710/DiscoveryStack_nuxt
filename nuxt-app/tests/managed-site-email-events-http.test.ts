import { createHmac } from 'node:crypto'
import { createServer, request as httpRequest, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { createApp, createEvent, defineEventHandler, toNodeListener, type H3Event } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decidePublicCors } from '../server/utils/publicCors'

const calls = vi.hoisted(() => ({ factory: vi.fn(), record: vi.fn(), fetch: vi.fn() }))
vi.mock('../server/managed-sites/email-events/repository', () => ({ createEmailProviderEventsRepository: calls.factory }))
const NOW = new Date('2026-10-07T12:30:00.000Z')
const KEY = Buffer.alloc(32, 0x48), SECRET = `whsec_${KEY.toString('base64')}`
const ENCRYPTION = 'synthetic-independent-email-event-http-key-32bytes'
const rawBody = Buffer.from(' { "type": "email.delivered", "created_at":"2026-10-07T12:29:59.123Z", "data":{"email_id":"12345678-90ab-cdef-1234-567890abcdef","ownerUserId":99,"to":["private@example.test"]} }\n')
const timestamp = String(NOW.getTime() / 1000), id = 'msg_http-raw-event'
const signedHeaders = (bytes = rawBody) => ({ 'content-type': 'application/json; charset=utf-8', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${createHmac('sha256', KEY).update(`${id}.${timestamp}.`).update(bytes).digest('base64')}` })
const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []
let handler: (event: H3Event) => Promise<any>
function fixture(bytes: unknown = rawBody, options: { action?: string; method?: string; headers?: Record<string, string> } = {}) {
  const req = Object.assign(new PassThrough(), { method: options.method || 'POST', url: '/api/managed-sites/email-outbox/resend-webhook', headers: options.headers || signedHeaders() })
  if (bytes !== undefined) Object.assign(req, { rawBody: bytes })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  const event = createEvent(req as never, res)
  event.context.params = { action: options.action || 'resend-webhook' }
  return { event, req, res }
}
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (value: unknown) => value)
  handler = (await import('../server/api/managed-sites/email-outbox/[...action]')).default as unknown as typeof handler
})
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', calls.fetch)
  for (const [name, value] of Object.entries({ NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED: 'true', NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET: SECRET, NUXT_MANAGED_SITE_EMAIL_API_KEY: 're_synthetic_http_key', NUXT_MANAGED_SITE_EMAIL_FROM: 'DS <notifications@example.test>', DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: 'https://api.resend.com', NUXT_MANAGED_SITE_EMAIL_ENDPOINT: 'https://api.resend.com/emails', NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS: '10000', NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY: ENCRYPTION, NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENABLED: 'false' })) vi.stubEnv(name, value)
  calls.factory.mockReturnValue({ record: calls.record })
  calls.record.mockResolvedValue('recorded')
})
afterEach(() => {
  expect(calls.fetch).not.toHaveBeenCalled()
  vi.useRealTimers(); vi.unstubAllEnvs()
  for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() }
})
afterAll(() => vi.unstubAllGlobals())

describe('Resend event signed server-to-server route', () => {
  it('persists signed untouched raw bytes without an owner session, CORS grant, or sending capability', async () => {
    const { event, res } = fixture()
    await expect(handler(event)).resolves.toMatchObject({ status: 'recorded', recorded: true, providerObservationOnly: true, inboxDeliveryVerified: false })
    expect(calls.factory).toHaveBeenCalledTimes(1)
    expect(calls.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'email.delivered', providerReceiptId: '12345678-90ab-cdef-1234-567890abcdef', occurredAt: new Date('2026-10-07T12:29:59.123Z') }))
    expect(JSON.stringify(calls.record.mock.calls)).not.toContain('private@example')
    expect(res.getHeader('cache-control')).toBe('private, no-store, max-age=0')
    expect(res.getHeader('access-control-allow-origin')).toBeUndefined()
    expect(res.getHeader('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })
  it.each(['GET', 'PUT', 'DELETE', 'OPTIONS'])('refuses %s before resolving storage or consuming bytes', async method => {
    const { event, req } = fixture({ forbidden: 'parsed-body' }, { method })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 405 })
    expect(calls.factory).not.toHaveBeenCalled(); expect(req.listenerCount('data')).toBe(0)
  })
  it('does not expose a catch-all administration action', async () => {
    await expect(handler(fixture(rawBody, { action: 'resend-webhook/other' }).event)).rejects.toMatchObject({ statusCode: 404 })
    expect(calls.factory).not.toHaveBeenCalled()
  })
  it.each(['disabled', 'unconfigured'])('refuses %s before even reading an oversized body', async mode => {
    if (mode === 'disabled') vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED', 'false')
    else vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_EVENTS_WEBHOOK_SECRET', '')
    await expect(handler(fixture(Buffer.alloc(65_537)).event)).rejects.toMatchObject({ statusCode: 503 })
    expect(calls.factory).not.toHaveBeenCalled()
  })
  it('requires JSON content type but never reconstructs a parsed adapter object', async () => {
    await expect(handler(fixture(rawBody, { headers: { ...signedHeaders(), 'content-type': 'text/plain' } }).event)).rejects.toMatchObject({ statusCode: 415 })
    await expect(handler(fixture(JSON.parse(rawBody.toString())).event)).rejects.toMatchObject({ statusCode: 400 })
    expect(calls.factory).not.toHaveBeenCalled()
  })
  it('rejects mismatched raw signatures and malformed supported events before storage', async () => {
    await expect(handler(fixture(Buffer.concat([rawBody, Buffer.from(' ')])).event)).rejects.toMatchObject({ statusCode: 401 })
    const broken = Buffer.from('{"type":"email.sent","data":{}}')
    await expect(handler(fixture(broken, { headers: signedHeaders(broken) }).event)).rejects.toMatchObject({ statusCode: 400 })
    expect(calls.factory).not.toHaveBeenCalled()
  })
  it('acknowledges signed tracking events without recording personal analytics', async () => {
    const ignored = Buffer.from('{"type":"email.clicked","data":{"to":"private@example.test"}}')
    await expect(handler(fixture(ignored, { headers: signedHeaders(ignored) }).event)).resolves.toMatchObject({ status: 'ignored', recorded: false })
    expect(calls.factory).not.toHaveBeenCalled()
  })
  it('enforces the actual cached-body byte cap and returns a retryable sanitized storage failure', async () => {
    await expect(handler(fixture(Buffer.alloc(65_537), { headers: { ...signedHeaders(), 'content-length': '1' } }).event)).rejects.toMatchObject({ statusCode: 413 })
    expect(calls.factory).not.toHaveBeenCalled()
    calls.record.mockRejectedValueOnce(new Error('private-mysql-url'))
    const error = await handler(fixture().event).catch(cause => cause)
    expect(error.statusCode).toBe(503)
    expect(JSON.stringify(error)).not.toContain('private-mysql-url')
  })
  it('keeps the exact webhook outside the global public-browser CORS policy', () => {
    for (const method of ['POST', 'OPTIONS']) {
      const decision = decidePublicCors({ path: '/api/managed-sites/email-outbox/resend-webhook', method, origin: 'https://public.example.test', configuredOrigin: 'https://public.example.test', accessRequestMethod: 'POST', nodeEnv: 'production' })
      expect(decision).toMatchObject({ reason: 'not-target', isPreflight: false, headers: {} })
    }
  })
  it('verifies actual chunked H3 wire bytes end-to-end, refuses tampering, and stops oversized streams', async () => {
    vi.useRealTimers()
    const app = createApp().use(defineEventHandler(event => { event.context.params = { action: 'resend-webhook' }; return handler(event) }))
    const server = createServer(toNodeListener(app))
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected isolated loopback listener.')
    const wire = (bytes: Buffer, signedBytes = bytes) => new Promise<{ status: number; body: string; cors: string | undefined }>((resolve, reject) => {
      const ts = String(Math.floor(Date.now() / 1000))
      const signature = createHmac('sha256', KEY).update(`${id}.${ts}.`).update(signedBytes).digest('base64')
      const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/managed-sites/email-outbox/resend-webhook', method: 'POST', headers: { ...signedHeaders(), 'svix-timestamp': ts, 'svix-signature': `v1,${signature}`, 'transfer-encoding': 'chunked', origin: 'https://public.example.test' } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8'), cors: response.headers['access-control-allow-origin'] as string | undefined }))
        response.once('error', reject)
      })
      request.once('error', reject)
      request.write(bytes.subarray(0, 9)); request.end(bytes.subarray(9))
    })
    try {
      const success = await wire(rawBody)
      expect(success.status).toBe(200); expect(JSON.parse(success.body)).toMatchObject({ status: 'recorded', recorded: true, inboxDeliveryVerified: false }); expect(success.cors).toBeUndefined()
      expect(calls.factory).toHaveBeenCalledTimes(1)
      const tampered = await wire(Buffer.concat([rawBody, Buffer.from(' ')]), rawBody)
      expect(tampered.status).toBe(401)
      const oversized = await wire(Buffer.alloc(65_537))
      expect(oversized.status).toBe(413)
      expect(calls.factory).toHaveBeenCalledTimes(1)
      for (const result of [success, tampered, oversized]) expect(result.body).not.toContain('private@example')
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
    }
  })
})
