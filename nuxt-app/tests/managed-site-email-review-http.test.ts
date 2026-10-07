import { PassThrough } from 'node:stream'
import { ServerResponse } from 'node:http'
import { createEvent, type H3Event } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decidePublicCors } from '../server/utils/publicCors'
import type { EmailManualReviewRepository } from '../server/managed-sites/email-review/types'

const calls = vi.hoisted(() => ({ auth: vi.fn(), owner: vi.fn(), factory: vi.fn(), close: vi.fn(), fetch: vi.fn() }))
vi.mock('../server/utils/auth', () => ({ requireOwner: calls.auth }))
vi.mock('../server/audit/repository', () => ({ getOwnerDatabaseUserId: calls.owner }))
vi.mock('../server/managed-sites/email-review/repository', () => ({ createEmailManualReviewRepository: calls.factory }))
const ORIGIN = 'https://private.synthetic.example.test'
const command = { itemId: '12345678-90ab-cdef-1234-567890abcdef', expectedVersion: 'a'.repeat(64), requestId: 'abcdefab-cdef-abcd-efab-cdefabcdefab', reason: 'reviewed_no_resend', confirmNoResend: true }
const allocated: Array<{ req: PassThrough; res: ServerResponse }> = []
let handler: (event: H3Event) => Promise<unknown>

function fixture(body: unknown = Buffer.from(JSON.stringify(command)), options: { action?: string; method?: string; headers?: Record<string, string> } = {}) {
  const req = Object.assign(new PassThrough(), { method: options.method || 'POST', url: '/api/managed-sites/email-outbox/manual-resolution', headers: options.headers || { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', host: 'private.synthetic.example.test' }, rawBody: body })
  const res = new ServerResponse(req as never)
  allocated.push({ req, res })
  const event = createEvent(req as never, res)
  event.context.params = { action: options.action || 'manual-resolution' }
  return { event, req, res }
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (value: unknown) => value)
  handler = (await import('../server/api/managed-sites/email-outbox/[...action]')).default as unknown as typeof handler
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', calls.fetch)
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', ORIGIN)
  vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_REVIEW_ENABLED', 'true')
  vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_EVENTS_ENABLED', 'false')
  calls.auth.mockResolvedValue({ openId: 'synthetic-owner' })
  calls.owner.mockResolvedValue(7)
  calls.factory.mockReturnValue({ close: calls.close })
  calls.close.mockImplementation(async ({ ownerUserId, command, closedAt }: Parameters<EmailManualReviewRepository['close']>[0]) => ({ status: 'recorded', record: { outboxId: command.itemId, ownerUserId, requestId: command.requestId, outboxVersion: command.expectedVersion, reason: command.reason, closedAt } }))
})
afterEach(() => {
  expect(calls.fetch).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
  for (const { req, res } of allocated.splice(0)) { res.destroy(); req.destroy() }
})
afterAll(() => vi.unstubAllGlobals())

describe('owner manual investigation route, never email delivery', () => {
  it('uses exact authenticated owner scope, appends only a review, and retains private headers', async () => {
    const { event, res } = fixture()
    await expect(handler(event)).resolves.toMatchObject({ itemId: command.itemId, status: 'closed_no_resend', resendAuthorized: false, outboxStatusUnchanged: true, inboxDeliveryVerified: false })
    expect(calls.owner).toHaveBeenCalledExactlyOnceWith('synthetic-owner')
    expect(calls.close).toHaveBeenCalledExactlyOnceWith({ ownerUserId: 7, command, closedAt: expect.any(Date) })
    expect(calls.auth.mock.invocationCallOrder[0]).toBeLessThan(calls.owner.mock.invocationCallOrder[0]!)
    expect(res.getHeader('cache-control')).toBe('private, no-store, max-age=0')
    expect(res.getHeader('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(res.getHeader('referrer-policy')).toBe('no-referrer')
    expect(res.getHeader('access-control-allow-origin')).toBeUndefined()
  })
  it.each(['GET', 'OPTIONS', 'PUT', 'DELETE'])('refuses %s before authentication, body or database work', async method => {
    await expect(handler(fixture(Buffer.alloc(3000), { method }).event)).rejects.toMatchObject({ statusCode: 405 })
    for (const call of [calls.auth, calls.owner, calls.factory, calls.close]) expect(call).not.toHaveBeenCalled()
  })
  it.each(['', 'https://public.synthetic.example.test', `${ORIGIN}/path`, `${ORIGIN}/`, `${ORIGIN}?q=1`, 'null'])('rejects a missing/cross-origin/noncanonical Origin %s before identity or storage', async origin => {
    await expect(handler(fixture(undefined, { headers: { origin, 'content-type': 'application/json' } }).event)).rejects.toMatchObject({ statusCode: 403 })
    for (const call of [calls.auth, calls.owner, calls.factory, calls.close]) expect(call).not.toHaveBeenCalled()
  })
  it.each(['cross-site', 'same-site', 'none'])('refuses Sec-Fetch-Site %s even with a matching Origin', async site => {
    await expect(handler(fixture(undefined, { headers: { origin: ORIGIN, 'sec-fetch-site': site, 'content-type': 'application/json' } }).event)).rejects.toMatchObject({ statusCode: 403 })
    expect(calls.auth).not.toHaveBeenCalled()
  })
  it.each(['', 'http://private.synthetic.example.test', `${ORIGIN}/path`, `https://user:pass@private.synthetic.example.test`, `${ORIGIN}?query=1`, `${ORIGIN}#hash`])('fails closed for invalid production private-origin configuration %s', async configured => {
    vi.stubEnv('NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN', configured)
    await expect(handler(fixture().event)).rejects.toMatchObject({ statusCode: 503 })
    expect(calls.auth).not.toHaveBeenCalled()
  })
  it('does not read oversized bodies or resolve a database identity when default off', async () => {
    vi.stubEnv('NUXT_MANAGED_SITE_EMAIL_REVIEW_ENABLED', 'false')
    const { event, req } = fixture(Buffer.alloc(3000))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案功能尚未開通。' })
    expect(calls.auth).toHaveBeenCalledTimes(1)
    expect(req.listenerCount('data')).toBe(0)
    for (const call of [calls.owner, calls.factory, calls.close]) expect(call).not.toHaveBeenCalled()
  })
  it('refuses an expired owner before resolving identity, parsing input or storing a closure', async () => {
    calls.auth.mockRejectedValueOnce(Object.assign(new Error('Owner required'), { statusCode: 401 }))
    await expect(handler(fixture(Buffer.alloc(3000)).event)).rejects.toMatchObject({ statusCode: 401 })
    for (const call of [calls.owner, calls.factory, calls.close]) expect(call).not.toHaveBeenCalled()
  })
  it('bounds actual bytes, requires JSON, and rejects caller scope/privacy hints before database work', async () => {
    await expect(handler(fixture(Buffer.alloc(2049), { headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '1' } }).event)).rejects.toMatchObject({ statusCode: 413 })
    await expect(handler(fixture(undefined, { headers: { origin: ORIGIN, 'content-type': 'text/plain' } }).event)).rejects.toMatchObject({ statusCode: 415 })
    for (const extra of [{ ownerUserId: 8 }, { projectId: 99 }, { status: 'accepted' }, { recipient: 'private@example.test' }, { note: 'private-body' }, { retry: true }]) {
      await expect(handler(fixture(Buffer.from(JSON.stringify({ ...command, ...extra }))).event)).rejects.toMatchObject({ statusCode: 422 })
    }
    for (const call of [calls.owner, calls.factory, calls.close]) expect(call).not.toHaveBeenCalled()
  })
  it('returns generic storage failures and preserves domain not-found/conflict without secret echoes', async () => {
    calls.close.mockRejectedValueOnce(new Error('mysql://synthetic-private-secret@host/db'))
    const failure = await handler(fixture().event).catch(error => error)
    expect(failure).toMatchObject({ statusCode: 503, statusMessage: '郵件人工結案暫時無法儲存，請稍後重試。' })
    expect(JSON.stringify(failure)).not.toContain('synthetic-private-secret')
    for (const [status, code] of [['not_found', 404], ['not_eligible', 409], ['conflict', 409]] as const) {
      calls.close.mockResolvedValueOnce({ status })
      await expect(handler(fixture().event)).rejects.toMatchObject({ statusCode: code })
    }
  })
  it('rejects unknown nested actions and keeps the new path outside public-browser CORS', async () => {
    await expect(handler(fixture(undefined, { action: 'manual-resolution/other' }).event)).rejects.toMatchObject({ statusCode: 404 })
    expect(calls.auth).not.toHaveBeenCalled()
    for (const method of ['POST', 'OPTIONS']) expect(decidePublicCors({ path: '/api/managed-sites/email-outbox/manual-resolution', method, origin: 'https://public.synthetic.example.test', configuredOrigin: 'https://public.synthetic.example.test', accessRequestMethod: 'POST', nodeEnv: 'production' })).toMatchObject({ reason: 'not-target', headers: {} })
  })
})
