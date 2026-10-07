import { createHmac, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'

export const RESEND_EVENTS_MAX_BYTES = 65_536
export const RESEND_EVENT_TYPES = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.suppressed',
] as const
export type ResendEventType = (typeof RESEND_EVENT_TYPES)[number]

const MAX_SIGNATURE_HEADER_BYTES = 2048
const MAX_SIGNATURES = 8
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MSG_ID = /^msg_[A-Za-z0-9_-]{1,124}$/u
const UTC_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u

function canonicalBase64(value: string): Buffer | null {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : null
}

export function isResendWebhookSecret(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 178 || !value.startsWith('whsec_')) return false
  const decoded = canonicalBase64(value.slice('whsec_'.length))
  return decoded !== null && decoded.byteLength >= 16 && decoded.byteLength <= 128
}

function validMessageId(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 128 && MSG_ID.test(value)
}

function validTimestampHeader(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,11})$/u.test(value) && Number.isSafeInteger(Number(value))
}

function signatureCandidates(value: unknown): Buffer[] | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SIGNATURE_HEADER_BYTES || !value || value.trim() !== value) return null
  const entries = value.split(' ')
  if (!entries.length || entries.length > MAX_SIGNATURES || entries.some(entry => !entry)) return null
  const candidates: Buffer[] = []
  for (const entry of entries) {
    const match = /^v1,([A-Za-z0-9+/]+={0,2})$/u.exec(entry)
    if (!match) return null
    const decoded = canonicalBase64(match[1]!)
    if (!decoded || decoded.byteLength !== 32) return null
    candidates.push(decoded)
  }
  return candidates
}

export function verifyResendWebhookSignature(input: {
  rawBody: Uint8Array
  svixId: unknown
  svixTimestamp: unknown
  svixSignature: unknown
  secret: unknown
  now: Date
}): boolean {
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength === 0 || input.rawBody.byteLength > RESEND_EVENTS_MAX_BYTES
    || !validMessageId(input.svixId) || !validTimestampHeader(input.svixTimestamp)
    || !isResendWebhookSecret(input.secret) || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) return false
  const timestamp = Number(input.svixTimestamp)
  const nowSeconds = input.now.getTime() / 1000
  if (Math.abs(nowSeconds - timestamp) > 300) return false
  const candidates = signatureCandidates(input.svixSignature)
  if (!candidates) return false

  const secret = canonicalBase64((input.secret as string).slice('whsec_'.length))
  if (!secret) return false
  const expected = createHmac('sha256', secret)
    .update(`${input.svixId}.${input.svixTimestamp}.`, 'utf8')
    .update(input.rawBody)
    .digest()
  let matched = false
  for (const candidate of candidates) matched = timingSafeEqual(candidate, expected) || matched
  return matched
}

function invalidEvent(): never {
  throw createError({ statusCode: 400, statusMessage: 'Resend webhook event is invalid.' })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseEventDate(value: unknown, now: Date): Date {
  if (typeof value !== 'string') return invalidEvent()
  const match = UTC_ISO.exec(value)
  if (!match) return invalidEvent()
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondsText] = match
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || Number(yearText) < 1000
    || parsed.getUTCFullYear() !== Number(yearText)
    || parsed.getUTCMonth() + 1 !== Number(monthText)
    || parsed.getUTCDate() !== Number(dayText)
    || parsed.getUTCHours() !== Number(hourText)
    || parsed.getUTCMinutes() !== Number(minuteText)
    || parsed.getUTCSeconds() !== Number(secondText)
    || parsed.getUTCMilliseconds() !== Number((millisecondsText || '').padEnd(3, '0') || 0)
    || parsed.getTime() > now.getTime() + 300_000) return invalidEvent()
  return parsed
}

export function parseResendWebhookEvent(rawBody: Uint8Array, now: Date): {
  type: ResendEventType
  providerReceiptId: string
  occurredAt: Date
} | null {
  if (!(rawBody instanceof Uint8Array) || rawBody.byteLength === 0 || rawBody.byteLength > RESEND_EVENTS_MAX_BYTES || !(now instanceof Date) || !Number.isFinite(now.getTime())) return invalidEvent()
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))
  } catch {
    return invalidEvent()
  }
  if (!isPlainRecord(payload) || typeof payload.type !== 'string') return invalidEvent()
  if (!(RESEND_EVENT_TYPES as readonly string[]).includes(payload.type)) return null
  if (!isPlainRecord(payload.data) || typeof payload.data.email_id !== 'string' || !UUID.test(payload.data.email_id)) return invalidEvent()
  const occurredAt = parseEventDate(payload.created_at, now)
  return { type: payload.type as ResendEventType, providerReceiptId: payload.data.email_id.toLowerCase(), occurredAt }
}
