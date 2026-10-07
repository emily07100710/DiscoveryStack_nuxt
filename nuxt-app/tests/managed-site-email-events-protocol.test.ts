import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  RESEND_EVENT_TYPES,
  RESEND_EVENTS_MAX_BYTES,
  isResendWebhookSecret,
  parseResendWebhookEvent,
  verifyResendWebhookSignature,
} from '../server/managed-sites/email-events/protocol'

const KNOWN_SECRET_BYTES = Buffer.alloc(20, 0x0b)
const KNOWN_SECRET = `whsec_${KNOWN_SECRET_BYTES.toString('base64')}`
const KNOWN_ID = 'msg_known-vector_01'
const KNOWN_TIMESTAMP = '1780915200'
const KNOWN_BODY = Buffer.from('{"type":"email.sent","created_at":"2026-06-08T00:00:00Z","data":{"email_id":"ABCDEF12-3456-7890-ABCD-EF1234567890"}}')
const KNOWN_SIGNATURE = '/LXbRo0+W5pbMIe8w8aJqq0PD3s0UBhb/Q16IF68o/E='
const KNOWN_NOW = new Date(Number(KNOWN_TIMESTAMP) * 1000)
const EVENT_NOW = new Date('2026-06-08T00:00:00.000Z')

function signature(body: Uint8Array, id: string, timestamp: string, key = KNOWN_SECRET_BYTES): string {
  return createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64')
}

function signedInput(overrides: Partial<Parameters<typeof verifyResendWebhookSignature>[0]> = {}) {
  return {
    rawBody: KNOWN_BODY,
    svixId: KNOWN_ID,
    svixTimestamp: KNOWN_TIMESTAMP,
    svixSignature: `v1,${KNOWN_SIGNATURE}`,
    secret: KNOWN_SECRET,
    now: KNOWN_NOW,
    ...overrides,
  }
}

function eventBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-06-08T00:00:00.123Z',
    data: { email_id: 'ABCDEF12-3456-7890-ABCD-EF1234567890', to: ['private@example.test'], from: 'secret@example.test', subject: 'private subject', text: 'private body', ...overrides },
  }))
}

function noncanonicalFinalBase64Character(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const paddingAt = value.indexOf('=')
  const index = paddingAt < 0 ? value.length : paddingAt
  const charIndex = alphabet.indexOf(value[index - 1]!)
  if (charIndex < 0 || charIndex % 4 !== 0 || charIndex === alphabet.length - 1) throw new Error('test vector does not have unused base64 pad bits')
  return `${value.slice(0, index - 1)}${alphabet[charIndex + 1]}${value.slice(index)}`
}

describe('Resend provider event protocol', () => {
  it('exports the bounded event vocabulary and validates canonical webhook secrets', () => {
    expect(RESEND_EVENTS_MAX_BYTES).toBe(65_536)
    expect(RESEND_EVENT_TYPES).toEqual(['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'])
    expect(isResendWebhookSecret(KNOWN_SECRET)).toBe(true)
    expect(isResendWebhookSecret(`whsec_${Buffer.alloc(16).toString('base64')}`)).toBe(true)
    expect(isResendWebhookSecret(`whsec_${Buffer.alloc(128).toString('base64')}`)).toBe(true)
    expect(isResendWebhookSecret(`whsec_${Buffer.alloc(15).toString('base64')}`)).toBe(false)
    expect(isResendWebhookSecret(`whsec_${Buffer.alloc(129).toString('base64')}`)).toBe(false)
    expect(isResendWebhookSecret(`whsec_${noncanonicalFinalBase64Character(KNOWN_SECRET_BYTES.toString('base64'))}`)).toBe(false)
    for (const invalid of [undefined, null, '', 'secret', 'whsec_-_8=', 'whsec_abc', 42]) expect(isResendWebhookSecret(invalid)).toBe(false)
  })

  it('matches a fixed raw-byte HMAC vector and rejects changed body, ID, timestamp, or key', () => {
    expect(signature(KNOWN_BODY, KNOWN_ID, KNOWN_TIMESTAMP)).toBe(KNOWN_SIGNATURE)
    expect(verifyResendWebhookSignature(signedInput())).toBe(true)
    expect(verifyResendWebhookSignature(signedInput({ rawBody: Buffer.from([...KNOWN_BODY, 0x20]) }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixId: 'msg_changed-vector_01' }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixTimestamp: '1780915201' }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ secret: `whsec_${Buffer.alloc(20, 0x0c).toString('base64')}` }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ rawBody: new Uint8Array() }))).toBe(false)
  })

  it('accepts any matching v1 rotation signature and rejects malformed or noncanonical signature encodings', () => {
    const wrong = Buffer.alloc(32, 0x12).toString('base64')
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: `v1,${wrong} v1,${KNOWN_SIGNATURE}` }))).toBe(true)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: Array(7).fill(`v1,${wrong}`).concat(`v1,${KNOWN_SIGNATURE}`).join(' ') }))).toBe(true)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: `v1,${wrong} v1,${signature(KNOWN_BODY, KNOWN_ID, KNOWN_TIMESTAMP, Buffer.alloc(20, 0x0c))}` }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: `v1,${noncanonicalFinalBase64Character(KNOWN_SIGNATURE)}` }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: `v2,${KNOWN_SIGNATURE}` }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: `v1,${KNOWN_SIGNATURE}  v1,${KNOWN_SIGNATURE}` }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: Array(9).fill(`v1,${KNOWN_SIGNATURE}`).join(' ') }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixSignature: `v1,${KNOWN_SIGNATURE}${' '.repeat(2049)}` }))).toBe(false)
  })

  it('enforces canonical headers and inclusive 300-second clock skew', () => {
    const nowSeconds = Number(KNOWN_TIMESTAMP)
    for (const timestamp of [String(nowSeconds - 300), String(nowSeconds + 300)]) {
      const sig = signature(KNOWN_BODY, KNOWN_ID, timestamp)
      expect(verifyResendWebhookSignature(signedInput({ svixTimestamp: timestamp, svixSignature: `v1,${sig}` }))).toBe(true)
    }
    for (const timestamp of [String(nowSeconds - 301), String(nowSeconds + 301)]) {
      const sig = signature(KNOWN_BODY, KNOWN_ID, timestamp)
      expect(verifyResendWebhookSignature(signedInput({ svixTimestamp: timestamp, svixSignature: `v1,${sig}` }))).toBe(false)
    }
    const fractionalNow = new Date((nowSeconds * 1000) + 999)
    const lowerBoundSignature = signature(KNOWN_BODY, KNOWN_ID, String(nowSeconds - 300))
    expect(verifyResendWebhookSignature(signedInput({ now: fractionalNow, svixTimestamp: String(nowSeconds - 300), svixSignature: `v1,${lowerBoundSignature}` }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ svixId: `msg_${'a'.repeat(124)}`, svixSignature: `v1,${signature(KNOWN_BODY, `msg_${'a'.repeat(124)}`, KNOWN_TIMESTAMP)}` }))).toBe(true)
    for (const svixId of ['msg_', 'msg_has.dot', `msg_${'a'.repeat(125)}`, 'msg_bad\n']) expect(verifyResendWebhookSignature(signedInput({ svixId }))).toBe(false)
    for (const svixTimestamp of ['01780915200', '+1780915200', '1780915200.0', 1780915200, '']) expect(verifyResendWebhookSignature(signedInput({ svixTimestamp }))).toBe(false)
    expect(verifyResendWebhookSignature(signedInput({ now: new Date(Number.NaN) }))).toBe(false)
  })

  it('allows exactly the body byte limit and refuses larger bodies', () => {
    const exact = Buffer.alloc(RESEND_EVENTS_MAX_BYTES, 0x61)
    const over = Buffer.alloc(RESEND_EVENTS_MAX_BYTES + 1, 0x61)
    const exactSignature = signature(exact, KNOWN_ID, KNOWN_TIMESTAMP)
    expect(verifyResendWebhookSignature(signedInput({ rawBody: exact, svixSignature: `v1,${exactSignature}` }))).toBe(true)
    expect(verifyResendWebhookSignature(signedInput({ rawBody: over, svixSignature: `v1,${signature(over, KNOWN_ID, KNOWN_TIMESTAMP)}` }))).toBe(false)
  })

  it('projects only supported event type, normalized provider UUID, and strict UTC occurrence time', () => {
    const result = parseResendWebhookEvent(eventBody(), EVENT_NOW)
    expect(result).toEqual({ type: 'email.delivered', providerReceiptId: 'abcdef12-3456-7890-abcd-ef1234567890', occurredAt: new Date('2026-06-08T00:00:00.123Z') })
    expect(Object.keys(result!).sort()).toEqual(['occurredAt', 'providerReceiptId', 'type'])
    expect(result!.occurredAt).toBeInstanceOf(Date)
  })

  it('ignores authenticated unsupported types before requiring supported-event fields', () => {
    expect(parseResendWebhookEvent(Buffer.from('{"type":"email.opened"}'), EVENT_NOW)).toBeNull()
  })

  it('rejects malformed UTF-8, JSON shapes, supported schemas, and UUIDs with one generic 400', () => {
    const invalidBodies = [
      Buffer.alloc(0),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('{'),
      Buffer.from('[]'),
      Buffer.from('null'),
      Buffer.from('{"type":5}'),
      Buffer.from('{"type":"email.sent","created_at":"2026-06-08T00:00:00Z","data":[]}'),
      eventBody({ email_id: 'not-a-uuid' }),
      eventBody({ email_id: 'abcdef12-3456-7890-abcd-ef1234567890\n' }),
    ]
    for (const body of invalidBodies) {
      try {
        parseResendWebhookEvent(body, EVENT_NOW)
        throw new Error('expected malformed event rejection')
      } catch (error) {
        expect(error).toMatchObject({ statusCode: 400, statusMessage: 'Resend webhook event is invalid.' })
        expect(JSON.stringify(error)).not.toContain('private@example.test')
      }
    }
  })

  it('accepts 1-3 fractional digits and rejects date overflow, non-UTC forms, and future times beyond 300 seconds', () => {
    for (const created_at of ['2026-06-08T00:00:00.1Z', '2026-06-08T00:00:00.12Z', '2026-06-08T00:00:00Z', '2026-06-08T00:05:00Z']) {
      expect(parseResendWebhookEvent(Buffer.from(JSON.stringify({ type: 'email.sent', created_at, data: { email_id: 'abcdef12-3456-7890-abcd-ef1234567890' } })), EVENT_NOW)).not.toBeNull()
    }
    for (const created_at of ['0001-01-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-06-08T24:00:00Z', '2026-06-08T00:00:00.1234Z', '2026-06-08T00:00:00+00:00', '2026-06-08T00:05:00.001Z']) {
      expect(() => parseResendWebhookEvent(Buffer.from(JSON.stringify({ type: 'email.sent', created_at, data: { email_id: 'abcdef12-3456-7890-abcd-ef1234567890' } })), EVENT_NOW)).toThrow()
    }
  })

  it('rejects oversized parsed bodies without leaking provider payload fields', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'email.sent', created_at: '2026-06-08T00:00:00Z', data: { email_id: 'abcdef12-3456-7890-abcd-ef1234567890', subject: 'private subject', text: 'private body' }, padding: 'x'.repeat(RESEND_EVENTS_MAX_BYTES) }))
    expect(raw.byteLength).toBeGreaterThan(RESEND_EVENTS_MAX_BYTES)
    try {
      parseResendWebhookEvent(raw, EVENT_NOW)
      throw new Error('expected oversized event rejection')
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, statusMessage: 'Resend webhook event is invalid.' })
      expect(JSON.stringify(error)).not.toContain('private subject')
      expect(JSON.stringify(error)).not.toContain('private body')
    }
  })
})
