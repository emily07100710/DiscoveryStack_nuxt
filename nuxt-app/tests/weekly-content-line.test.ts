import { createHash, createHmac } from 'node:crypto'
import { ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { createEvent } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWeeklyLineReviewMessage, buildWeeklyLineRetryKey, encodeWeeklyLinePostback, normalizeWeeklyLinePublicOrigin, sendWeeklyLinePush } from '../server/weekly-content/line-transport'
import { handleWeeklyLineWebhook, parseWeeklyLinePostback, processWeeklyLineWebhook, readBoundedWeeklyLineWebhookBody, verifyWeeklyLineSignature, WEEKLY_LINE_WEBHOOK_MAX_BYTES } from '../server/weekly-content/line-webhook'
import { runWeeklyLineOutbox, type WeeklyLineOutboxDependencies } from '../server/weekly-content/line-outbox'
import { WeeklyFixture } from './fixtures/weekly-content/repository'
import type { WeeklyContentRepository } from '../server/weekly-content/repository'
import type { WeeklyConfig, PrivateLineBinding, WeeklyReviewRequest, WeeklyDraft, WeeklyOutbox } from '../server/weekly-content/types'
const calls = vi.hoisted(() => ({ bind: vi.fn(), review: vi.fn() }))
vi.mock('../server/weekly-content/service', async importOriginal => ({ ...await importOriginal<typeof import('../server/weekly-content/service')>(), claimLineBindingInvite: calls.bind, reviewFromVerifiedLine: calls.review }))
const NOW = new Date('2026-10-04T00:00:00.000Z')
const USER = `U${'1'.repeat(32)}`, BOT = `U${'2'.repeat(32)}`
const RID = `wcr_${'r'.repeat(32)}`, INVITE = `wli_${'i'.repeat(32)}`
const KEY = 'synthetic-local-only-token-key-32-bytes'
const SECRET = '0'.repeat(32), ACCESS = 'synthetic-line-access-token-only'
const token = (purpose: string) => createHmac('sha256', KEY).update(`${purpose}:${RID}`).digest('base64url')
const READ = token('weekly-read-v1'), ACTION = token('weekly-action-v1')
const sha = (v: string) => createHash('sha256').update(v).digest('hex')
const messageInput = { requestId: RID, readToken: READ, actionToken: ACTION, title: '這週的示範文章', expiresAt: new Date(NOW.getTime() + 86400000), publicOrigin: 'https://preview.example.com' }
const identity = { id: 11, ownerUserId: 7, clientId: 8, requestId: RID, bindingId: 9 }
const eventId = '01FZ74A0TDDPYRVKNK77XKC3ZR'
function lineEvent(patch: Record<string, unknown> = {}) { return { type: 'postback', mode: 'active', timestamp: NOW.getTime(), source: { type: 'user', userId: USER }, webhookEventId: eventId, deliveryContext: { isRedelivery: false }, postback: { data: encodeWeeklyLinePostback(RID, ACTION, 'approved') }, ...patch } }
function signed(events: unknown[], destination = BOT) { const rawBody = Buffer.from(JSON.stringify({ destination, events })); return { rawBody, signature: createHmac('sha256', SECRET).update(rawBody).digest('base64') } }
function context() { const getDependencies = vi.fn(async () => ({ repository: {} as WeeklyContentRepository, featureEnabled: true, tokenKey: KEY, now: NOW })); return { featureEnabled: true, channelSecret: SECRET, botUserId: BOT, getDependencies } }
const requests: Array<{ req: PassThrough; res: ServerResponse }> = []
function request(headers: Record<string, string> = {}) { const req = Object.assign(new PassThrough(), { method: 'POST', url: '/api/weekly-content/line/webhook', headers }); const res = new ServerResponse(req as never); requests.push({ req, res }); return { req, res, event: createEvent(req as never, res) } }
beforeEach(() => { vi.clearAllMocks(); calls.bind.mockResolvedValue({ bound: true }); calls.review.mockResolvedValue({ queued: true }) })
afterEach(() => { vi.useRealTimers(); for (const { req, res } of requests.splice(0)) { res.destroy(); req.destroy() } })

describe('weekly LINE Flex and stable push transport', () => {
  it('uses the requested brand, a view-only read URL and distinct consent postbacks', () => {
    const message = buildWeeklyLineReviewMessage(messageInput)
    const text = JSON.stringify(message)
    expect(text).toContain('DS搜尋王')
    expect(text).toContain('#171A32')
    expect(text).toContain(`/weekly-content/review/${RID}?token=${READ}`)
    expect(text).toContain(`wca|${RID}|${ACTION}|approved`)
    expect(text).toContain(`wca|${RID}|${ACTION}|changes_requested`)
    expect(text).not.toContain(`?token=${ACTION}`)
    expect(text).not.toContain(USER)
    expect(text).toContain('閱讀完整文章')
  })
  it.each(['http://preview.example.com', 'https://preview.example.com/a', 'https://preview.example.com/?next=evil', 'https://user:pass@preview.example.com', 'https://127.0.0.1', 'https://localhost', 'https://preview.example.com:8443'])('rejects unsafe configured preview origin %s', value => expect(() => normalizeWeeklyLinePublicOrigin(value)).toThrow())
  it('keeps one standard UUID across retry attempts but isolates request/client/binding', () => {
    const key = buildWeeklyLineRetryKey(identity)
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(buildWeeklyLineRetryKey({ ...identity })).toBe(key)
    for (const change of [{ id: 12 }, { clientId: 10 }, { bindingId: 10 }, { ownerUserId: 10 }, { requestId: `wcr_${'s'.repeat(32)}` }]) expect(buildWeeklyLineRetryKey({ ...identity, ...change })).not.toBe(key)
  })
  it('posts only to the official endpoint with the first stable retry key and no redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'x-line-request-id': 'request-accepted-1' } }))
    const result = await sendWeeklyLinePush({ lineUserId: USER, message: buildWeeklyLineReviewMessage(messageInput), retryKey: buildWeeklyLineRetryKey(identity) }, { channelAccessToken: ACCESS, fetchImpl })
    expect(result).toEqual({ accepted: true, duplicate: false, providerMessageId: 'request-accepted-1' })
    const [endpoint, options] = fetchImpl.mock.calls[0]!
    expect(endpoint).toBe('https://api.line.me/v2/bot/message/push')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'X-Line-Retry-Key': buildWeeklyLineRetryKey(identity), authorization: `Bearer ${ACCESS}` } })
    expect(JSON.parse(options!.body as string)).toMatchObject({ to: USER, messages: [{ type: 'flex' }] })
  })
  it('accepts a precise 409 replay receipt and never returns quote tokens/provider prose', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"quoteToken":"do-not-return","message":"private-provider-prose"}', { status: 409, headers: { 'x-line-accepted-request-id': 'original-request-1', 'x-line-request-id': 'retry-request-2' } }))
    expect(await sendWeeklyLinePush({ lineUserId: USER, message: buildWeeklyLineReviewMessage(messageInput), retryKey: buildWeeklyLineRetryKey(identity) }, { channelAccessToken: ACCESS, fetchImpl })).toEqual({ accepted: true, duplicate: true, providerMessageId: 'original-request-1' })
  })
  it.each([200, 409])('keeps acceptance unknown without the required receipt header at %s', async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }))
    expect(await sendWeeklyLinePush({ lineUserId: USER, message: buildWeeklyLineReviewMessage(messageInput), retryKey: buildWeeklyLineRetryKey(identity) }, { channelAccessToken: ACCESS, fetchImpl })).toEqual({ accepted: false, retryable: true, errorCode: 'line_delivery_outcome_unknown' })
  })
  it.each([{ status: 400, retry: false }, { status: 401, retry: false }, { status: 429, retry: false }, { status: 500, retry: true }])('bounds retry for status $status', async ({ status, retry }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private prose', { status }))
    const result = await sendWeeklyLinePush({ lineUserId: USER, message: buildWeeklyLineReviewMessage(messageInput), retryKey: buildWeeklyLineRetryKey(identity) }, { channelAccessToken: ACCESS, fetchImpl })
    expect(result).toMatchObject({ accepted: false, retryable: retry }); expect(JSON.stringify(result)).not.toContain('private prose')
  })
  it('sanitizes uncertain network errors and rejects group/credential/header injection before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${ACCESS} ${USER}`))
    const payload = { lineUserId: USER, message: buildWeeklyLineReviewMessage(messageInput), retryKey: buildWeeklyLineRetryKey(identity) }
    expect(await sendWeeklyLinePush(payload, { channelAccessToken: ACCESS, fetchImpl })).toEqual({ accepted: false, retryable: true, errorCode: 'line_delivery_outcome_unknown' })
    fetchImpl.mockClear()
    for (const change of [{ lineUserId: `C${'1'.repeat(32)}` }, { retryKey: 'bad\r\nheader' }]) await sendWeeklyLinePush({ ...payload, ...change }, { channelAccessToken: ACCESS, fetchImpl })
    await sendWeeklyLinePush(payload, { channelAccessToken: 'bad\r\nsecret', fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('raw signed weekly LINE webhook and verified sender boundary', () => {
  it('validates exact raw UTF-8 bytes before any dependency resolution', async () => {
    const options = context(), body = signed([lineEvent()])
    expect(verifyWeeklyLineSignature(body.rawBody, body.signature, SECRET)).toBe(true)
    expect(await processWeeklyLineWebhook({ ...options, ...body })).toEqual({ status: 'accepted', processed: 1, ignored: 0 })
    expect(options.getDependencies).toHaveBeenCalledTimes(1)
    expect(calls.review).toHaveBeenCalledWith(expect.objectContaining({ requestId: RID, actionToken: ACTION, lineUserId: USER, decision: 'approved', webhookEventId: eventId, semanticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }), expect.any(Object))
  })
  it.each([undefined, '', 'invalid', Buffer.alloc(32).toString('base64')])('does zero DB/dependency work for a missing or invalid signature %s', async signature => {
    const options = context()
    await expect(processWeeklyLineWebhook({ ...options, ...signed([lineEvent()]), signature })).rejects.toMatchObject({ statusCode: 401 })
    expect(options.getDependencies).not.toHaveBeenCalled(); expect(calls.review).not.toHaveBeenCalled()
  })
  it('rejects body normalization/tampering and a valid signature from another bot without DB', async () => {
    const options = context(), body = signed([lineEvent()])
    await expect(processWeeklyLineWebhook({ ...options, ...body, rawBody: Buffer.from(JSON.stringify(JSON.parse(body.rawBody.toString()), null, 2)) })).rejects.toMatchObject({ statusCode: 401 })
    await expect(processWeeklyLineWebhook({ ...options, ...signed([lineEvent()], USER) })).rejects.toMatchObject({ statusCode: 400 })
    expect(options.getDependencies).not.toHaveBeenCalled()
  })
  it('does zero DB/body/provider work when disabled or events are only URL verification', async () => {
    const options = context()
    expect(await processWeeklyLineWebhook({ ...options, featureEnabled: false, rawBody: Buffer.alloc(0), signature: undefined })).toEqual({ status: 'disabled', processed: 0, ignored: 0 })
    expect(await processWeeklyLineWebhook({ ...options, ...signed([]) })).toEqual({ status: 'accepted', processed: 0, ignored: 0 })
    expect(options.getDependencies).not.toHaveBeenCalled()
  })
  it.each([{ source: { type: 'group', userId: USER, groupId: 'group' } }, { source: { type: 'room', userId: USER } }, { source: { type: 'user' } }, { mode: 'standby' }, { webhookEventId: 'missing-ulid' }])('ignores non-1:1, standby or malformed events before storage', async patch => {
    const options = context()
    expect(await processWeeklyLineWebhook({ ...options, ...signed([lineEvent(patch)]) })).toEqual({ status: 'accepted', processed: 0, ignored: 1 })
    expect(options.getDependencies).not.toHaveBeenCalled()
  })
  it('passes only the signed sender, never external owner/client/userId fields', async () => {
    const options = context(), body = signed([lineEvent({ ownerUserId: 999, clientId: 999, lineUserId: BOT })])
    await processWeeklyLineWebhook({ ...options, ...body })
    const input = calls.review.mock.calls[0]![0]
    expect(input.lineUserId).toBe(USER); expect(input).not.toHaveProperty('ownerUserId'); expect(input).not.toHaveProperty('clientId')
  })
  it('binds from a signed 1:1 invitation and fingerprints redelivery semantics without replyToken', async () => {
    const options = context(), event = lineEvent({ type: 'message', message: { type: 'text', text: INVITE } })
    await processWeeklyLineWebhook({ ...options, ...signed([event]) })
    await processWeeklyLineWebhook({ ...options, ...signed([{ ...event, replyToken: 'changed-reply-token', deliveryContext: { isRedelivery: true } }]) })
    expect(calls.bind.mock.calls[0]![0].semanticFingerprint).toBe(calls.bind.mock.calls[1]![0].semanticFingerprint)
    expect(calls.bind.mock.calls[0]![0]).toMatchObject({ lineUserId: USER, invitationToken: INVITE })
  })
  it('routes a valid forwarded postback to core with its actual sender and returns no actor/token data', async () => {
    calls.review.mockRejectedValueOnce({ statusCode: 404, message: 'synthetic-private-binding' })
    const result = await processWeeklyLineWebhook({ ...context(), ...signed([lineEvent({ source: { type: 'user', userId: BOT } })]) })
    expect(calls.review.mock.calls[0]![0].lineUserId).toBe(BOT)
    expect(result).toEqual({ status: 'accepted', processed: 0, ignored: 1 }); expect(JSON.stringify(result)).not.toContain(ACTION)
  })
  it('sanitizes transient storage errors for durable redelivery', async () => {
    calls.review.mockRejectedValueOnce(new Error(`${USER} ${ACTION} raw query`))
    await expect(processWeeklyLineWebhook({ ...context(), ...signed([lineEvent()]) })).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Weekly LINE event processing is temporarily unavailable.' })
  })
  it('sanitizes dependency initialization failures after signature verification', async () => {
    const options = context(); options.getDependencies.mockRejectedValueOnce(new Error(`${SECRET} private database configuration`))
    await expect(processWeeklyLineWebhook({ ...options, ...signed([lineEvent()]) })).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Weekly LINE event processing is temporarily unavailable.' })
    expect(calls.review).not.toHaveBeenCalled()
  })
  it('rejects signed invalid UTF8 and excessive batches before dependencies', async () => {
    const options = context(), rawBody = Buffer.from([0xff, 0xfe])
    await expect(processWeeklyLineWebhook({ ...options, rawBody, signature: createHmac('sha256', SECRET).update(rawBody).digest('base64') })).rejects.toMatchObject({ statusCode: 400 })
    await expect(processWeeklyLineWebhook({ ...options, ...signed(Array.from({ length: 21 }, () => lineEvent())) })).rejects.toMatchObject({ statusCode: 400 })
    expect(options.getDependencies).not.toHaveBeenCalled()
  })
  it.each([`wca|${RID}|${READ}|unknown`, `wca|${RID}|${ACTION}|approved|extra`, 'requestId=1&decision=approved', 'x'.repeat(301), `wca|not-opaque|${ACTION}|approved`])('rejects malformed opaque postback syntax without processing it', data => expect(parseWeeklyLinePostback(data)).toBeNull())
  it('caps materialized raw bytes and rejects parsed objects', async () => {
    const a = request(); Object.assign(a.req, { rawBody: Buffer.alloc(WEEKLY_LINE_WEBHOOK_MAX_BYTES + 1) })
    await expect(readBoundedWeeklyLineWebhookBody(a.event)).rejects.toMatchObject({ statusCode: 413 })
    const b = request(); Object.assign(b.req, { rawBody: { destination: BOT, events: [] } })
    await expect(readBoundedWeeklyLineWebhookBody(b.event)).rejects.toMatchObject({ statusCode: 400 })
  })
  it('rejects unended oversized Node streams immediately and closes after the response', async () => {
    const { req, res, event } = request({ 'transfer-encoding': 'chunked' })
    const rejected = expect(readBoundedWeeklyLineWebhookBody(event)).rejects.toMatchObject({ statusCode: 413 })
    req.write(Buffer.alloc(WEEKLY_LINE_WEBHOOK_MAX_BYTES)); req.write('x')
    await rejected; expect(req.isPaused()).toBe(true); expect(req.writableEnded).toBe(false)
    expect(() => req.emit('error', new Error('synthetic peer reset'))).not.toThrow()
    res.emit('finish'); expect(req.destroyed).toBe(true)
  })
  it('stops an unended Node stream at the absolute body deadline', async () => {
    vi.useFakeTimers()
    const { req, res, event } = request({ 'transfer-encoding': 'chunked' })
    const rejected = expect(readBoundedWeeklyLineWebhookBody(event)).rejects.toMatchObject({ statusCode: 400 })
    await Promise.resolve(); req.write('slow body')
    await vi.advanceTimersByTimeAsync(10_000); await rejected
    expect(req.isPaused()).toBe(true); expect(req.listenerCount('data')).toBe(0)
    expect(() => req.emit('error', new Error('synthetic peer reset'))).not.toThrow()
    res.emit('finish'); expect(req.destroyed).toBe(true)
  })
  it('bounds Web streams without reserializing bytes and cancels an oversized stream', async () => {
    let cancelled = false
    const { event } = request()
    event._requestBody = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(WEEKLY_LINE_WEBHOOK_MAX_BYTES + 1)) }, cancel() { cancelled = true } }) as never
    await expect(readBoundedWeeklyLineWebhookBody(event)).rejects.toMatchObject({ statusCode: 413 }); expect(cancelled).toBe(true)
  })
  it('runs the HTTP seam with the raw cached body and no public response tokens', async () => {
    const body = signed([lineEvent()]), options = context()
    const { req, event } = request({ 'content-type': 'application/json; charset=utf-8', 'x-line-signature': body.signature }); Object.assign(req, { rawBody: body.rawBody })
    expect(await handleWeeklyLineWebhook(event, options)).toEqual({ status: 'accepted', processed: 1, ignored: 0 })
  })
})

async function realCoreFixture() {
  const actual = await vi.importActual<typeof import('../server/weekly-content/service')>('../server/weekly-content/service')
  const fixture = new WeeklyFixture(), deps = fixture.deps()
  await actual.activateWeeklyReviewConfig({ ownerUserId: 1, clientId: 1, publicationTargetId: 3, policyId: 'policy-1', idempotencyKey: 'synthetic-weekly-line-core' }, deps)
  const invite = await actual.issueLineBindingInvite({ ownerUserId: 1, clientId: 1 }, deps)
  const options = { featureEnabled: true, channelSecret: SECRET, botUserId: BOT, getDependencies: vi.fn(async () => deps) }
  calls.bind.mockImplementation(actual.claimLineBindingInvite); calls.review.mockImplementation(actual.reviewFromVerifiedLine)
  await processWeeklyLineWebhook({ ...options, ...signed([lineEvent({ type: 'message', message: { type: 'text', text: invite.invitationToken } })]) })
  await actual.createReviewRequest({ ownerUserId: 1, clientId: 1, entryId: fixture.state.draft.entryId }, deps)
  const review = fixture.state.requests[0]!, tokens = actual.deriveReviewTokens(review, deps.tokenKey)
  const approval = lineEvent({ webhookEventId: '01FZ74A0TDDPYRVKNK77XKC3ZS', postback: { data: encodeWeeklyLinePostback(review.requestId, tokens.actionToken, 'approved') } })
  return { actual, fixture, deps, options, review, tokens, approval }
}
describe('signed LINE seam with the actual core and a synthetic transaction repository', () => {
  it('binds the signed recipient, keeps reading view-only, and records one approval across redelivery', async () => {
    const f = await realCoreFixture()
    expect(f.fixture.state.binding?.lineUserId).toBe(USER)
    await f.actual.getReviewByReadToken({ requestId: f.review.requestId, readToken: f.tokens.readToken }, f.deps)
    expect(f.fixture.state.consents).toHaveLength(0); expect(f.fixture.state.queued).toBe(0)
    await processWeeklyLineWebhook({ ...f.options, ...signed([f.approval]) })
    await processWeeklyLineWebhook({ ...f.options, ...signed([{ ...f.approval, replyToken: 'changed-synthetic-reply', deliveryContext: { isRedelivery: true } }]) })
    expect(f.fixture.state.consents).toHaveLength(1); expect(f.fixture.state.queued).toBe(1)
    expect(f.fixture.state.requests[0]?.status).toBe('approved'); expect(f.fixture.state.inbox).toHaveLength(2)
  })
  it('rejects a forwarded action token by the actual signed sender without writing consent', async () => {
    const f = await realCoreFixture()
    expect(await processWeeklyLineWebhook({ ...f.options, ...signed([{ ...f.approval, source: { type: 'user', userId: BOT } }]) })).toEqual({ status: 'accepted', processed: 0, ignored: 1 })
    expect(f.fixture.state.consents).toHaveLength(0); expect(f.fixture.state.queued).toBe(0)
    expect(f.fixture.state.requests[0]?.status).toBe('pending'); expect(f.fixture.state.inbox).toHaveLength(1)
  })
  it('does not reinterpret a previously processed event ID as another decision', async () => {
    const f = await realCoreFixture()
    await processWeeklyLineWebhook({ ...f.options, ...signed([f.approval]) })
    const changed = { ...f.approval, postback: { data: encodeWeeklyLinePostback(f.review.requestId, f.tokens.actionToken, 'changes_requested') } }
    expect(await processWeeklyLineWebhook({ ...f.options, ...signed([changed]) })).toEqual({ status: 'accepted', processed: 0, ignored: 1 })
    expect(f.fixture.state.consents).toHaveLength(1); expect(f.fixture.state.queued).toBe(1); expect(f.fixture.state.requests[0]?.status).toBe('approved')
  })
})

function outboxFixture() {
  const h = (x: string) => x.repeat(64)
  const cfg = { ownerUserId: 7, clientId: 8, status: 'active', cadenceDays: 7, publicationTargetId: 14, policyId: 'policy-1', configurationFingerprint: h('c'), policyConfigurationFingerprint: h('a') } as WeeklyConfig
  const binding = { id: 9, ownerUserId: 7, clientId: 8, status: 'active', bindingFingerprint: h('d'), lineUserId: USER } as PrivateLineBinding
  const review = { id: 12, requestId: RID, ownerUserId: 7, clientId: 8, entryId: 10, jobId: 11, draftId: 13, draftVersion: 2, contentType: 'article', language: 'zh-hant', contentHash: h('e'), evidenceSnapshotHash: h('f'), publicationTargetId: 14, targetConfigurationFingerprint: h('b'), policyId: 'policy-1', policyConfigurationFingerprint: h('a'), configurationFingerprint: h('c'), bindingId: 9, bindingFingerprint: h('d'), readTokenHash: sha(READ), actionTokenHash: sha(ACTION), status: 'pending', expiresAt: new Date(NOW.getTime() + 86400000) } as WeeklyReviewRequest
  const draft = { client: { id: 8, ownerUserId: 7, status: 'active', requireCustomerApproval: true }, entryId: 10, entryStatus: 'ready_to_publish', jobId: 11, draftId: 13, draftVersion: 2, contentType: 'article', language: 'zh-hant', title: '這週的示範文章', body: 'synthetic body', contentHash: h('e'), evidenceSnapshotHash: h('f'), riskGateStatus: 'passed', machineAuthorizationValid: true, target: { id: 14, ownerUserId: 7, clientId: 8, status: 'active', executionEnabled: true, configurationFingerprint: h('b') }, policy: { ownerUserId: 7, clientId: 8, publicationTargetId: 14, status: 'enabled', policyVersion: 'governed-autopilot-policy-v4', authorizedByOwnerUserId: 7, cadenceDays: 7, policyId: 'policy-1', configurationFingerprint: h('a'), expiresAt: new Date(NOW.getTime() + 86400000), revokedAt: null } } as WeeklyDraft
  const row = { id: 15, ownerUserId: 7, clientId: 8, requestRowId: 12, bindingId: 9, status: 'processing', attemptNumber: 1, leaseToken: null, leaseExpiresAt: null, retryEligibleAt: null, sentAt: null, providerMessageId: null, errorCode: null, payloadFingerprint: null, firstAttemptAt: null, createdAt: new Date(NOW.getTime() - 60_000), updatedAt: NOW } as WeeklyOutbox
  const repo = { claimOutbox: vi.fn(async (_owner: number, _max: number, leaseToken: string) => [{ ...row, leaseToken, leaseExpiresAt: new Date(NOW.getTime() + 120000) }]), getRequestByRowId: vi.fn(async () => review), getConfig: vi.fn(async () => cfg), getBinding: vi.fn(async () => binding), getDraft: vi.fn(async () => draft), reserveOutboxPayload: vi.fn(async () => true), finishOutbox: vi.fn(async () => true) }
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'x-line-request-id': 'accepted-1' } }))
  const deps: WeeklyLineOutboxDependencies = { repository: repo as unknown as WeeklyContentRepository, featureEnabled: true, tokenKey: KEY, botUserId: BOT, publicOrigin: messageInput.publicOrigin, channelAccessToken: ACCESS, fetchImpl, now: NOW }
  return { row, review, cfg, binding, draft, repo, fetchImpl, deps }
}
describe('weekly LINE durable outbox runner', () => {
  it('performs zero repository/provider calls while disabled or unconfigured', async () => {
    const f = outboxFixture()
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, { ...f.deps, featureEnabled: false })).toMatchObject({ status: 'disabled', claimed: 0 })
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, { ...f.deps, channelAccessToken: '' })).toMatchObject({ status: 'not_configured', claimed: 0 })
    expect(f.repo.claimOutbox).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('bounds claims, rechecks lineage, persists payload fingerprint then sends under an exact lease', async () => {
    const f = outboxFixture(), result = await runWeeklyLineOutbox({ ownerUserId: 7, maxMessages: 999 }, f.deps)
    expect(result).toMatchObject({ claimed: 1, sent: 1, deduplicated: 0 })
    expect(f.repo.claimOutbox).toHaveBeenCalledWith(7, 10, expect.any(String), NOW)
    expect(f.repo.reserveOutboxPayload).toHaveBeenCalledWith(15, expect.any(String), expect.stringMatching(/^[a-f0-9]{64}$/), NOW)
    expect(f.repo.reserveOutboxPayload.mock.invocationCallOrder[0]).toBeLessThan(f.fetchImpl.mock.invocationCallOrder[0]!)
    expect(f.repo.finishOutbox).toHaveBeenCalledWith(15, expect.any(String), NOW, { status: 'sent', providerMessageId: 'accepted-1' })
    expect(JSON.stringify(result)).not.toContain(USER); expect(JSON.stringify(result)).not.toContain(ACTION)
  })
  it.each(['request', 'binding', 'draft', 'target', 'policy', 'config', 'machine'] as const)('cancels a changed %s without calling LINE', async kind => {
    const f = outboxFixture()
    if (kind === 'request') f.review.status = 'approved'
    if (kind === 'binding') f.binding.bindingFingerprint = '0'.repeat(64)
    if (kind === 'draft') f.draft.draftVersion++
    if (kind === 'target') f.draft.target.executionEnabled = false
    if (kind === 'policy') f.draft.policy!.status = 'revoked'
    if (kind === 'config') f.cfg.status = 'paused'
    if (kind === 'machine') f.draft.machineAuthorizationValid = false
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ cancelled: 1, sent: 0 }); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('fails closed on a stored token/key mismatch or changed payload fingerprint', async () => {
    const f = outboxFixture(); f.review.actionTokenHash = '0'.repeat(64)
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ failed: 1 }); expect(f.fetchImpl).not.toHaveBeenCalled()
    const g = outboxFixture(); g.repo.reserveOutboxPayload.mockResolvedValue(false)
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, g.deps)).toMatchObject({ cancelled: 1 }); expect(g.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([{ age: 86400000, attempt: 1 }, { age: 1000, attempt: 7 }, { age: 86395000, attempt: 1 }])('never sends after the retry window/attempt deadline $age $attempt', async ({ age, attempt }) => {
    const f = outboxFixture(); f.row.createdAt = new Date(NOW.getTime() - age); f.row.attemptNumber = attempt
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ failed: 1 }); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('keeps the same key and payload after a timeout and recognizes the original acceptance', async () => {
    const f = outboxFixture(); f.fetchImpl.mockRejectedValueOnce(new Error('synthetic timeout')).mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'accepted-original' } }))
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ retryWaiting: 1 })
    f.row.attemptNumber = 2
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ sent: 1, deduplicated: 1 })
    const first = f.fetchImpl.mock.calls[0]![1]!, second = f.fetchImpl.mock.calls[1]![1]!
    expect((first.headers as Record<string,string>)['X-Line-Retry-Key']).toBe((second.headers as Record<string,string>)['X-Line-Retry-Key']); expect(first.body).toBe(second.body)
  })
  it('does not mark an acceptance completed when the lease CAS loses', async () => {
    const f = outboxFixture(); f.repo.finishOutbox.mockResolvedValue(false)
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ sent: 0, leaseLost: 1 })
  })
  it('ignores foreign claims and sanitizes repository exceptions', async () => {
    const f = outboxFixture(); f.row.ownerUserId = 999
    expect(await runWeeklyLineOutbox({ ownerUserId: 7 }, f.deps)).toMatchObject({ leaseLost: 1 }); expect(f.repo.getRequestByRowId).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
    const g = outboxFixture(); g.repo.getBinding.mockRejectedValueOnce(new Error(`${USER} raw sql ${ACTION}`))
    await expect(runWeeklyLineOutbox({ ownerUserId: 7 }, g.deps)).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Weekly notification processing is temporarily unavailable.' })
  })
})
