import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processWeeklyLineWebhook, parseWeeklyLineReviewTestPostback } from '../server/weekly-content/line-webhook'
import { renderReviewTestPage } from '../server/weekly-content/review-test-page'
import type { WeeklyContentRepository } from '../server/weekly-content/repository'
const formal = vi.hoisted(() => ({ review: vi.fn(), binding: vi.fn() }))
vi.mock('../server/weekly-content/service', async original => ({ ...await original<typeof import('../server/weekly-content/service')>(), reviewFromVerifiedLine: formal.review, claimLineBindingInvite: formal.binding }))
const SECRET = 'synthetic-secret-32-characters-only'
const BOT = `U${'1'.repeat(32)}`, USER = `U${'2'.repeat(32)}`
const ID = `wct_${'x'.repeat(32)}`, TOKEN = Buffer.alloc(32, 1).toString('base64url')
const postback = `wct|${ID}|${TOKEN}|approved`
function setup() {
  const reviewTest = vi.fn().mockResolvedValue({ status: 'approved' })
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  return { featureEnabled: true, channelSecret: SECRET, botUserId: BOT, reviewTest, getDependencies: vi.fn(async () => ({ repository: {} as WeeklyContentRepository, featureEnabled: true, tokenKey: 'synthetic-token-key-over-32-characters' })), onboarding: { publicOrigin: 'https://review.example.com', channelAccessToken: 'synthetic-access-token-only', fetchImpl } }
}
function signed(data = postback, sender = USER) {
  const rawBody = Buffer.from(JSON.stringify({ destination: BOT, events: [{ type: 'postback', mode: 'active', timestamp: 1, source: { type: 'user', userId: sender }, webhookEventId: '01FZ74A0TDDPYRVKNK77XKC3ZR', replyToken: 'synthetic_reply_token_32_characters', postback: { data } }] }))
  return { rawBody, signature: createHmac('sha256', SECRET).update(rawBody).digest('base64') }
}
beforeEach(() => vi.clearAllMocks())
describe('isolated LINE sample review webhook', () => {
  it('routes only signed sample events to the test service and explicitly confirms no publication', async () => {
    const options = setup()
    expect(await processWeeklyLineWebhook({ ...options, ...signed() })).toEqual({ status: 'accepted', processed: 1, ignored: 0 })
    expect(options.reviewTest).toHaveBeenCalledWith(expect.objectContaining({ requestId: ID, lineUserId: USER, actionToken: TOKEN, decision: 'approved' }))
    expect(formal.review).not.toHaveBeenCalled(); expect(formal.binding).not.toHaveBeenCalled()
    expect(JSON.stringify(options.onboarding.fetchImpl.mock.calls)).toContain('不會發布文章')
    expect(JSON.stringify(options.onboarding.fetchImpl.mock.calls)).not.toContain('進入發文流程')
  })
  it('rejects altered signatures before any test or storage resolution', async () => {
    const options = setup()
    await expect(processWeeklyLineWebhook({ ...options, ...signed(), signature: Buffer.alloc(32).toString('base64') })).rejects.toMatchObject({ statusCode: 401 })
    expect(options.reviewTest).not.toHaveBeenCalled(); expect(options.getDependencies).not.toHaveBeenCalled()
  })
  it('uses the actual signed sender for forwarded cards and reveals no private result', async () => {
    const options = setup(); options.reviewTest.mockRejectedValue({ statusCode: 409 })
    expect(await processWeeklyLineWebhook({ ...options, ...signed(postback, BOT) })).toMatchObject({ processed: 0, ignored: 1 })
    expect(options.reviewTest).toHaveBeenCalledWith(expect.objectContaining({ lineUserId: BOT }))
    expect(options.onboarding.fetchImpl).not.toHaveBeenCalled(); expect(formal.review).not.toHaveBeenCalled()
  })
  it('does not send a second reply for a durable replay', async () => {
    const options = setup(); options.reviewTest.mockResolvedValue({ status: 'replayed' })
    expect(await processWeeklyLineWebhook({ ...options, ...signed() })).toMatchObject({ processed: 1 })
    expect(options.onboarding.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([postback.replace('wct|', 'wca|'), postback.replace(ID, `wcr_${'x'.repeat(32)}`), `${postback}|extra`, postback.replace('approved', 'publish'), postback.replace(TOKEN, 'bad')])('rejects mixed or invalid test namespaces', value => expect(parseWeeklyLineReviewTestPostback(value)).toBeNull())
  it('escapes the private sample and presents no web approval or publishing action', () => {
    const html = renderReviewTestPage({ title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>', status: 'pending', expiresAt: '2026-10-11T00:00:00Z', canRespond: true })
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img')
    expect(html).toContain('不會發布到網站'); expect(html).toContain('同意測試稿')
    expect(html).not.toMatch(/<script|<form|<img|actionToken|token=/iu)
  })
})
