import { createHash } from 'node:crypto'
import { createError } from 'h3'

// Official source: https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
// One stable UUID must accompany the first push and every unchanged retry. Acceptance is not delivery proof.
export const WEEKLY_LINE_USER_ID = /^U[a-f0-9]{32}$/u
export const WEEKLY_LINE_REQUEST_ID = /^wcr_[A-Za-z0-9_-]{32}$/u
export const WEEKLY_LINE_TOKEN = /^[A-Za-z0-9_-]{43}$/u
const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push'
const MAX_PUSH_BYTES = 16_384
const RETRY_NAMESPACE = Buffer.from('ab9eab4829e14caa96ab703f8b802a7d', 'hex')
export type WeeklyLineReviewMessage = { type: 'flex'; altText: string; contents: Record<string, unknown> }
export type WeeklyLinePushResult = { accepted: true; duplicate: boolean; providerMessageId: string } | { accepted: false; retryable: boolean; errorCode: string }

export function normalizeWeeklyLinePublicOrigin(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw createError({ statusCode: 503, statusMessage: 'Weekly article preview origin is not configured.' }) }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/' || !/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(host) || /(^|\.)(localhost|local|internal|test|invalid|example)$/u.test(host) || /^\d+(?:\.\d+){3}$/u.test(host)) throw createError({ statusCode: 503, statusMessage: 'Weekly article preview origin is not configured.' })
  return parsed.origin
}
export function isWeeklyLineToken(value: unknown): value is string {
  return typeof value === 'string' && WEEKLY_LINE_TOKEN.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value
}
export function isWeeklyLineAccessToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 2048 && /^[A-Za-z0-9+/_=.\-]+$/u.test(value)
}
export function encodeWeeklyLinePostback(requestId: string, actionToken: string, decision: 'approved' | 'changes_requested'): string {
  if (!WEEKLY_LINE_REQUEST_ID.test(requestId) || !isWeeklyLineToken(actionToken) || !['approved', 'changes_requested'].includes(decision)) throw createError({ statusCode: 422, statusMessage: 'Weekly article action is invalid.' })
  return `wca|${requestId}|${actionToken}|${decision}`
}
export function buildWeeklyLineReviewMessage(input: { requestId: string; readToken: string; actionToken: string; title: string; expiresAt: Date | string; publicOrigin: string; brand?: string }): WeeklyLineReviewMessage {
  if (!WEEKLY_LINE_REQUEST_ID.test(input.requestId) || !isWeeklyLineToken(input.readToken) || !isWeeklyLineToken(input.actionToken) || typeof input.title !== 'string' || !input.title.trim()) throw createError({ statusCode: 422, statusMessage: 'Weekly article notification is invalid.' })
  const origin = normalizeWeeklyLinePublicOrigin(input.publicOrigin)
  const expiry = new Date(input.expiresAt)
  if (!Number.isFinite(expiry.getTime())) throw createError({ statusCode: 422, statusMessage: 'Weekly article notification is invalid.' })
  const brand = typeof input.brand === 'string' && input.brand.trim() ? Array.from(input.brand.trim()).slice(0, 60).join('') : 'DS搜尋王'
  const title = Array.from(input.title.trim()).slice(0, 120).join('')
  const preview = new URL(`/weekly-content/review/${input.requestId}`, origin)
  preview.searchParams.set('token', input.readToken)
  return {
    type: 'flex', altText: `${brand}：本週文章已備妥，請閱讀後確認。`,
    contents: { type: 'bubble', styles: { body: { backgroundColor: '#EEE9DF' }, footer: { backgroundColor: '#101326' } }, body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: brand, weight: 'bold', size: 'sm', color: '#B9A477' },
      { type: 'text', text: '本週文章，請你確認', weight: 'bold', size: 'lg', color: '#171A32', wrap: true },
      { type: 'text', text: title, size: 'md', color: '#171A32', wrap: true },
      { type: 'text', text: '先閱讀全文。點選同意後，文章才會進入公開部落格的發布佇列；要求修改則保留待修。', size: 'sm', wrap: true, color: '#101326' },
      { type: 'text', text: `回覆期限：${expiry.toISOString()}`, size: 'xs', wrap: true, color: '#101326' },
    ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'button', color: '#B9A477', action: { type: 'uri', label: '閱讀完整文章', uri: preview.toString() } },
      { type: 'button', style: 'primary', color: '#171A32', action: { type: 'postback', label: '同意發佈', data: encodeWeeklyLinePostback(input.requestId, input.actionToken, 'approved'), displayText: '我已閱讀，同意發佈這篇文章' } },
      { type: 'button', color: '#B9A477', action: { type: 'postback', label: '要求修改', data: encodeWeeklyLinePostback(input.requestId, input.actionToken, 'changes_requested'), displayText: '這篇文章需要修改' } },
    ] } },
  }
}
export function buildWeeklyLineRetryKey(input: { id: number; ownerUserId: number; clientId: number; requestId: string; bindingId: number }): string {
  if ([input.id, input.ownerUserId, input.clientId, input.bindingId].some(id => !Number.isSafeInteger(id) || id < 1) || !WEEKLY_LINE_REQUEST_ID.test(input.requestId)) throw createError({ statusCode: 422, statusMessage: 'Weekly notification identity is invalid.' })
  const name = JSON.stringify(['weekly-line-push-v1', input.id, input.ownerUserId, input.clientId, input.requestId, input.bindingId])
  const bytes = createHash('sha1').update(RETRY_NAMESPACE).update(name).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export async function sendWeeklyLinePush(input: { lineUserId: string; message: WeeklyLineReviewMessage; retryKey: string }, dependencies: { channelAccessToken: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<WeeklyLinePushResult> {
  if (!WEEKLY_LINE_USER_ID.test(input.lineUserId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(input.retryKey) || !isWeeklyLineAccessToken(dependencies.channelAccessToken)) return { accepted: false, retryable: false, errorCode: 'line_push_not_configured' }
  let body: string
  try {
    if (input.message?.type !== 'flex' || typeof input.message.altText !== 'string' || !input.message.altText || Array.from(input.message.altText).length > 400 || !input.message.contents || typeof input.message.contents !== 'object') throw new Error('invalid')
    body = JSON.stringify({ to: input.lineUserId, messages: [input.message] })
    if (Buffer.byteLength(body) > MAX_PUSH_BYTES) throw new Error('oversized')
  } catch { return { accepted: false, retryable: false, errorCode: 'line_push_payload_invalid' } }
  const controller = new AbortController()
  const timeout = Number.isSafeInteger(dependencies.timeoutMs) ? Math.max(100, Math.min(dependencies.timeoutMs!, 10_000)) : 5000
  const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.()
  try {
    const response = await (dependencies.fetchImpl || fetch)(PUSH_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${dependencies.channelAccessToken}`, 'X-Line-Retry-Key': input.retryKey }, body, redirect: 'error', signal: controller.signal })
    const id = response.headers.get(response.status === 409 ? 'x-line-accepted-request-id' : 'x-line-request-id') || ''
    // No error body, quoteToken, header dump or raw provider prose is persisted or returned.
    if (response.body) void response.body.cancel().catch(() => undefined)
    if ((response.status >= 200 && response.status < 300 || response.status === 409) && /^[A-Za-z0-9_-]{1,128}$/u.test(id)) return { accepted: true, duplicate: response.status === 409, providerMessageId: id }
    if (response.status >= 200 && response.status < 300 || response.status === 409) return { accepted: false, retryable: true, errorCode: 'line_delivery_outcome_unknown' }
    return { accepted: false, retryable: response.status >= 500, errorCode: response.status === 429 ? 'line_rate_or_quota_limited' : response.status >= 500 ? 'line_provider_unavailable' : 'line_push_rejected' }
  } catch { return { accepted: false, retryable: true, errorCode: 'line_delivery_outcome_unknown' } }
  finally { clearTimeout(timer) }
}
