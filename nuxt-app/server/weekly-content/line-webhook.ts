import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createError, getRequestHeader, type H3Event } from 'h3'
import type { Readable } from 'node:stream'
import { claimLineBindingInvite, claimWeeklyLineInteraction, reviewFromVerifiedLine, type WeeklyContentDependencies } from './service'
import { WEEKLY_LINE_REQUEST_ID, WEEKLY_LINE_USER_ID, isWeeklyLineToken, isWeeklyLineAccessToken } from './line-transport'
import {buildWeeklyLineWelcomeMessage,weeklyLineConnectUrl,sendWeeklyLineReply,weeklyLineInteractionForText,type WeeklyLineInteraction,type WeeklyLineReplyMessage} from './line-onboarding'

// Source: https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
// HMAC uses the untouched raw bytes. Signature/destination/event parsing precede dependency resolution.
export const WEEKLY_LINE_WEBHOOK_MAX_BYTES = 65_536
export const WEEKLY_LINE_WEBHOOK_MAX_EVENTS = 20
const RAW_BODY = Symbol.for('h3RawBody')
const BOUNDED_RAW = Symbol('weeklyLineBoundedRaw')
const EVENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u
const INVITATION = /^wli_[A-Za-z0-9_-]{32}$/u
const INVALID_BODY = 'Weekly LINE webhook is invalid.'
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function invalid(): never { throw createError({ statusCode: 400, statusMessage: INVALID_BODY }) }
function oversized(): never { throw createError({ statusCode: 413, statusMessage: 'Weekly LINE webhook is too large.' }) }

export function verifyWeeklyLineSignature(rawBody: Uint8Array, signature: unknown, channelSecret: unknown): boolean {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength === 0 || rawBody.byteLength > WEEKLY_LINE_WEBHOOK_MAX_BYTES || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(signature) || typeof channelSecret !== 'string' || channelSecret.length < 16 || channelSecret.length > 256 || /[\r\n\x00]/u.test(channelSecret)) return false
  const received = Buffer.from(signature, 'base64')
  if (received.length !== 32 || received.toString('base64') !== signature) return false
  return timingSafeEqual(createHmac('sha256', channelSecret).update(rawBody).digest(), received)
}
export function parseWeeklyLinePostback(value: unknown): { requestId: string; actionToken: string; decision: 'approved' | 'changes_requested' } | null {
  if (typeof value !== 'string' || value.length > 300) return null
  const fields = value.split('|')
  if (fields.length !== 4 || fields[0] !== 'wca' || !WEEKLY_LINE_REQUEST_ID.test(fields[1] || '') || !isWeeklyLineToken(fields[2]) || !['approved', 'changes_requested'].includes(fields[3] || '')) return null
  return { requestId: fields[1]!, actionToken: fields[2]!, decision: fields[3] as 'approved' | 'changes_requested' }
}
type Action = { lineUserId: string; webhookEventId: string; semanticFingerprint: string; replyToken?: string } & ({kind:'interaction';interaction:WeeklyLineInteraction} | { kind: 'binding'; invitationToken: string } | { kind: 'review'; requestId: string; actionToken: string; decision: 'approved' | 'changes_requested' })
function parseVerifiedActions(rawBody: Uint8Array, expectedDestination: string, onboarding = false, requireLiffBindingConfirmation = false): { actions: Action[]; ignored: number } {
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) } catch { invalid() }
  if (!record(payload) || payload.destination !== expectedDestination || !Array.isArray(payload.events) || payload.events.length > WEEKLY_LINE_WEBHOOK_MAX_EVENTS) invalid()
  const actions: Action[] = []
  let ignored = 0
  for (const event of payload.events) {
    if (!record(event) || event.mode !== 'active' || !record(event.source) || event.source.type !== 'user' || !WEEKLY_LINE_USER_ID.test(String(event.source.userId || '')) || event.source.groupId || event.source.roomId) { ignored++; continue }
    const lineUserId = event.source.userId as string
    if (typeof event.webhookEventId !== 'string' || !EVENT_ID.test(event.webhookEventId) || !Number.isSafeInteger(event.timestamp) || (event.timestamp as number) < 0) { ignored++; continue }
    const identity = { destination: expectedDestination, webhookEventId: event.webhookEventId, type: event.type, timestamp: event.timestamp, lineUserId }
    const replyToken = typeof event.replyToken === 'string' && /^[A-Za-z0-9_-]{16,256}$/u.test(event.replyToken) ? event.replyToken : undefined
    const interaction = onboarding && event.type === 'follow' ? 'welcome' : onboarding && event.type === 'message' && record(event.message) && event.message.type === 'text' && typeof event.message.text === 'string' && event.message.text.length <= 256 ? weeklyLineInteractionForText(event.message.text) : null
    if (interaction) {
      if (!replyToken) {ignored++;continue}
      actions.push({kind:'interaction',interaction,lineUserId,webhookEventId:event.webhookEventId,replyToken,semanticFingerprint:hash(JSON.stringify({...identity,interaction}))});continue
    }
    if (event.type === 'message' && record(event.message) && event.message.type === 'text' && typeof event.message.text === 'string' && event.message.text.length <= 256 && INVITATION.test(event.message.text.trim())) {
      const invitationToken = event.message.text.trim()
      if(requireLiffBindingConfirmation){
        // A pasted invite is a navigation request, never a substitute for the LIFF company confirmation.
        if(!onboarding || !replyToken){ignored++;continue}
        actions.push({kind:'interaction',interaction:'connect',replyToken,lineUserId,webhookEventId:event.webhookEventId,semanticFingerprint:hash(JSON.stringify({...identity,interaction:'connect',invitationTokenHash:hash(invitationToken)}))})
      }else actions.push({ kind: 'binding', replyToken, lineUserId, webhookEventId: event.webhookEventId, invitationToken, semanticFingerprint: hash(JSON.stringify({ ...identity, invitationTokenHash: hash(invitationToken) })) })
    } else if (event.type === 'postback' && record(event.postback)) {
      const postback = parseWeeklyLinePostback(event.postback.data)
      if (postback) actions.push({ kind: 'review', replyToken, lineUserId, webhookEventId: event.webhookEventId, ...postback, semanticFingerprint: hash(JSON.stringify({ ...identity, requestId: postback.requestId, actionTokenHash: hash(postback.actionToken), decision: postback.decision })) })
      else ignored++
    } else ignored++
  }
  return { actions, ignored }
}
export type WeeklyLineWebhookOptions = { featureEnabled: boolean; channelSecret: string; botUserId: string; getDependencies: () => WeeklyContentDependencies | Promise<WeeklyContentDependencies>; requireLiffBindingConfirmation?:boolean; onboarding?: {publicOrigin:string;liffId?:string;liffEnabled?:boolean;channelAccessToken:string;fetchImpl?:typeof fetch} }
export async function processWeeklyLineWebhook(input: WeeklyLineWebhookOptions & { rawBody: Uint8Array; signature: unknown }): Promise<{ status: 'disabled' | 'accepted'; processed: number; ignored: number }> {
  if (!input.featureEnabled) return { status: 'disabled', processed: 0, ignored: 0 }
  if (!WEEKLY_LINE_USER_ID.test(input.botUserId) || typeof input.channelSecret !== 'string' || input.channelSecret.length < 16 || input.channelSecret.length > 256) throw createError({ statusCode: 503, statusMessage: 'Weekly LINE webhook is not configured.' })
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength > WEEKLY_LINE_WEBHOOK_MAX_BYTES) oversized()
  if (!verifyWeeklyLineSignature(input.rawBody, input.signature, input.channelSecret)) throw createError({ statusCode: 401, statusMessage: 'Weekly LINE webhook signature is invalid.' })
  if(input.onboarding){weeklyLineConnectUrl(input.onboarding);if(!isWeeklyLineAccessToken(input.onboarding.channelAccessToken))throw createError({statusCode:503,statusMessage:'Weekly LINE interaction is not configured.'})}
  const parsed = parseVerifiedActions(input.rawBody, input.botUserId, Boolean(input.onboarding), input.requireLiffBindingConfirmation === true || input.onboarding?.liffEnabled === true)
  if (!parsed.actions.length) return { status: 'accepted', processed: 0, ignored: parsed.ignored }
  let dependencies: WeeklyContentDependencies
  try { dependencies = await input.getDependencies() } catch { throw createError({ statusCode: 503, statusMessage: 'Weekly LINE event processing is temporarily unavailable.' }) }
  let processed = 0, ignored = parsed.ignored
  for (const action of parsed.actions) {
    try {
      const result = action.kind === 'interaction' ? await claimWeeklyLineInteraction(action,dependencies)
        : action.kind === 'binding' ? await claimLineBindingInvite({ invitationToken: action.invitationToken, lineUserId: action.lineUserId, webhookEventId: action.webhookEventId, semanticFingerprint: action.semanticFingerprint }, dependencies)
        : await reviewFromVerifiedLine({ requestId: action.requestId, actionToken: action.actionToken, lineUserId: action.lineUserId, webhookEventId: action.webhookEventId, semanticFingerprint: action.semanticFingerprint, decision: action.decision }, dependencies)
      processed++
      // Business writes are already committed. A reply failure must not revoke or repeat a decision.
      // A changed replyToken on redelivery is never a new business event or a new reply attempt.
      if(input.onboarding && action.replyToken && result?.status!=='replayed') {
        let message:WeeklyLineReplyMessage
        if(action.kind==='interaction')message=buildWeeklyLineWelcomeMessage({...input.onboarding,interaction:action.interaction})
        else message={type:'text',text:action.kind==='binding'?'綁定已完成。請點「我的公司」查看公司與網站。':action.decision==='approved'?'已收到這篇文章的發佈同意。系統會再次檢查內容與授權，再進入發文流程。':'已收到修改要求，這篇文章會保留待修。服務窗口將協助調整後重新送審。'}
        await sendWeeklyLineReply({replyToken:action.replyToken,message},input.onboarding)
      }
    } catch (error) {
      const code = (error as { statusCode?: unknown } | null)?.statusCode
      if (typeof code === 'number' && [400, 401, 403, 404, 409, 410, 422].includes(code)) { ignored++; continue }
      // LINE may redeliver after a transient DB failure; the durable inbox prevents repeated business writes.
      throw createError({ statusCode: 503, statusMessage: 'Weekly LINE event processing is temporarily unavailable.' })
    }
  }
  return { status: 'accepted', processed, ignored }
}

/** Strict raw-byte reader: never serializes parsed objects or buffers an unbounded stream. */
export async function readBoundedWeeklyLineWebhookBody(event: H3Event): Promise<Buffer> {
  const request = event.node.req as H3Event['node']['req'] & { [RAW_BODY]?: unknown; [BOUNDED_RAW]?: Promise<Buffer>; rawBody?: unknown; body?: unknown }
  const header = getRequestHeader(event, 'content-length')
  if (header && (!/^\d+$/u.test(header) || !Number.isSafeInteger(Number(header)))) invalid()
  if (header && Number(header) > WEEKLY_LINE_WEBHOOK_MAX_BYTES) oversized()
  if (request[BOUNDED_RAW]) return request[BOUNDED_RAW]!
  const bound = (value: Buffer) => { if (value.byteLength > WEEKLY_LINE_WEBHOOK_MAX_BYTES) oversized(); return value }
  const source = event._requestBody ?? event.web?.request?.body ?? request[RAW_BODY] ?? request.rawBody ?? request.body ?? request
  async function read(value: unknown): Promise<Buffer> {
    value = await value
    if (Buffer.isBuffer(value)) return bound(value)
    if (value instanceof Uint8Array) return bound(Buffer.from(value))
    if (typeof value === 'string') { if (Buffer.byteLength(value) > WEEKLY_LINE_WEBHOOK_MAX_BYTES) oversized(); return Buffer.from(value) }
    if (value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function') {
      const reader = (value as ReadableStream<Uint8Array>).getReader()
      const chunks: Buffer[] = []; let total = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(createError({ statusCode: 400, statusMessage: INVALID_BODY })), 10_000); timer.unref?.() })
      try {
        while (true) {
          const next = await Promise.race([reader.read(), timeout])
          if (next.done) return Buffer.concat(chunks, total)
          total += next.value.byteLength
          if (total > WEEKLY_LINE_WEBHOOK_MAX_BYTES) oversized()
          chunks.push(Buffer.from(next.value))
        }
      } catch (error) { void reader.cancel().catch(() => undefined); throw error }
      finally { if (timer) clearTimeout(timer); reader.releaseLock() }
    }
    if (value && typeof (value as Readable).on === 'function' && typeof (value as Readable).pipe === 'function') {
      const stream = value as Readable & { aborted?: boolean }
      if (stream.aborted || stream.destroyed || stream.readableEnded) invalid()
      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []; let total = 0; let settled = false
        const cleanup = () => { clearTimeout(timer); stream.off('data', data); stream.off('end', end); stream.off('error', failed); stream.off('aborted', failed); stream.off('close', failed) }
        const stop = () => {
          stream.pause()
          const ignore = () => undefined; stream.on('error', ignore); stream.once('close', () => stream.off('error', ignore))
          const destroy = () => { if (!stream.destroyed) stream.destroy() }
          if (stream !== request || event.node.res.writableFinished || event.node.res.destroyed) destroy()
          else event.node.res.once('finish', destroy).once('close', destroy)
        }
        const failed = () => { if (settled) return; settled = true; cleanup(); chunks.length = 0; stop(); reject(createError({ statusCode: 400, statusMessage: INVALID_BODY })) }
        const data = (chunk: Uint8Array | string) => {
          const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          if (total + size > WEEKLY_LINE_WEBHOOK_MAX_BYTES) {
            settled = true; cleanup(); chunks.length = 0; stop()
            reject(createError({ statusCode: 413, statusMessage: 'Weekly LINE webhook is too large.' })); return
          }
          total += size; chunks.push(Buffer.from(chunk))
        }
        const end = () => { if (settled) return; settled = true; cleanup(); resolve(Buffer.concat(chunks, total)) }
        const timer = setTimeout(failed, 10_000); timer.unref?.()
        stream.on('data', data).once('end', end).once('error', failed).once('aborted', failed).once('close', failed)
      })
    }
    invalid()
  }
  request[BOUNDED_RAW] = read(source)
  const raw = await request[BOUNDED_RAW]!
  request[RAW_BODY] = raw
  return raw
}
export async function handleWeeklyLineWebhook(event: H3Event, options: WeeklyLineWebhookOptions) {
  if (!options.featureEnabled) return { status: 'disabled' as const, processed: 0, ignored: 0 }
  const contentType = getRequestHeader(event, 'content-type') || ''
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) throw createError({ statusCode: 415, statusMessage: INVALID_BODY })
  const signature = getRequestHeader(event, 'x-line-signature')
  const rawBody = await readBoundedWeeklyLineWebhookBody(event)
  return processWeeklyLineWebhook({ ...options, signature, rawBody })
}
