import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emailManualReviewVersion, parseEmailManualReviewCommand, projectEmailManualReview, validateEmailManualReviewRecord } from '../server/managed-sites/email-review/model'
import type { EmailManualReviewRecord, EmailManualReviewSnapshot } from '../server/managed-sites/email-review/types'

const ITEM_ID = '12345678-90ab-cdef-1234-567890abcdef'
const REQUEST_ID = 'abcdefab-cdef-abcd-efab-cdefabcdefab'
const VERSION = 'a'.repeat(64)
const snapshot = (): EmailManualReviewSnapshot => ({ id: ITEM_ID, purpose: 'member_invitation', status: 'manual_required', updatedAt: new Date('2026-10-07T01:02:03.456Z'), expiresAt: new Date('2026-10-08T01:02:03.000Z'), attemptCount: 6, lastErrorCode: 'attempt_limit' })
const command = () => ({ itemId: ITEM_ID, expectedVersion: VERSION, requestId: REQUEST_ID, reason: 'reviewed_no_resend', confirmNoResend: true })

describe('email manual review model', () => {
  it('accepts exactly the five permitted command fields and rejects extras or unsafe values with generic 422', () => {
    expect(parseEmailManualReviewCommand(command())).toEqual(command())
    const symbolExtra = { ...command(), [Symbol('extra')]: true }
    const customPrototype = Object.assign(Object.create({ inherited: true }) as object, command())
    const missingField = { itemId: ITEM_ID, expectedVersion: VERSION, requestId: REQUEST_ID, reason: 'reviewed_no_resend' }
    for (const value of [null, [], missingField, { ...command(), ownerUserId: 7 }, symbolExtra, customPrototype, { ...command(), itemId: ITEM_ID.toUpperCase() }, { ...command(), requestId: REQUEST_ID.toUpperCase() }, { ...command(), confirmNoResend: false }, { ...command(), reason: 'sent' }, { ...command(), requestId: 'bad' }, { ...command(), expectedVersion: 'private-body' }]) {
      expect(() => parseEmailManualReviewCommand(value)).toThrowError(expect.objectContaining({ statusCode: 422, statusMessage: '郵件人工結案資料格式不正確。' }))
    }
  })

  it('uses a deterministic digest of only the reduced valid manual-required snapshot', () => {
    const value = snapshot()
    const expected = createHash('sha256').update(JSON.stringify({ version: 'managed-site-email-manual-review-v1', id: ITEM_ID, purpose: 'member_invitation', status: 'manual_required', updatedAt: value.updatedAt.toISOString(), expiresAt: value.expiresAt.toISOString(), attemptCount: 6, lastErrorCode: 'attempt_limit' })).digest('hex')
    expect(emailManualReviewVersion(value)).toBe(expected)
    expect(emailManualReviewVersion({ ...value, attemptCount: 5 })).not.toBe(expected)
    expect(emailManualReviewVersion({ ...value, status: 'accepted' })).toBeNull()
    expect(emailManualReviewVersion({ ...value, updatedAt: new Date('0999-12-31T23:59:59.999Z') })).toBeNull()
    expect(emailManualReviewVersion({ ...value, updatedAt: new Date(Number.NaN) })).toBeNull()
    expect(emailManualReviewVersion({ ...value, id: 'not-an-id' })).toBeNull()
    expect(emailManualReviewVersion({ ...value, purpose: 'unknown' as EmailManualReviewSnapshot['purpose'] })).toBeNull()
    expect(emailManualReviewVersion({ ...value, lastErrorCode: 'private-code' as EmailManualReviewSnapshot['lastErrorCode'] })).toBeNull()
    expect(emailManualReviewVersion({ ...value, attemptCount: -1 })).toBeNull()
    expect(emailManualReviewVersion({ ...value, attemptCount: 1.5 })).toBeNull()
    expect(emailManualReviewVersion({ ...value, attemptCount: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(emailManualReviewVersion({ ...value, attemptCount: 0 })).not.toBeNull()
    expect(emailManualReviewVersion({ ...value, attemptCount: Number.MAX_SAFE_INTEGER })).not.toBeNull()
  })

  it('fails closed for corrupt or differently-bound records and projects only the explicit safe allowlist', () => {
    const value = snapshot()
    const version = emailManualReviewVersion(value)!
    expect(projectEmailManualReview({ enabled: false, ownerUserId: 7, snapshot: { ...value, id: 'bad' }, record: null })).toEqual({ manualReviewStatus: 'disabled', manualReviewVersion: null, manualReviewReason: null, manualReviewClosedAt: null })
    expect(projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: { ...value, status: 'accepted' }, record: null }).manualReviewStatus).toBe('not_required')
    expect(projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: value, record: null })).toMatchObject({ manualReviewStatus: 'open', manualReviewVersion: version })
    const record: EmailManualReviewRecord & { privateNote: string } = { outboxId: ITEM_ID, ownerUserId: 7, requestId: REQUEST_ID, outboxVersion: version, reason: 'handled_outside_platform', closedAt: new Date('2026-10-07T02:00:00.000Z'), privateNote: 'private@example.test' }
    expect(validateEmailManualReviewRecord(record)).toBe(true)
    const projection = projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: value, record })
    expect(projection).toEqual({ manualReviewStatus: 'closed_no_resend', manualReviewVersion: version, manualReviewReason: 'handled_outside_platform', manualReviewClosedAt: record.closedAt.toISOString() })
    expect(JSON.stringify(projection)).not.toContain('private@example.test')
    expect(() => projectEmailManualReview({ enabled: true, ownerUserId: 8, snapshot: value, record })).toThrowError(expect.objectContaining({ statusCode: 503, statusMessage: '郵件人工結案紀錄暫時無法讀取。' }))
    expect(() => projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: value, record: { ...record, outboxVersion: 'b'.repeat(64) } })).toThrowError(expect.objectContaining({ statusCode: 503 }))
    expect(() => projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: value, record: { ...record, outboxId: '11111111-1111-1111-1111-111111111111' } })).toThrowError(expect.objectContaining({ statusCode: 503 }))
    expect(() => projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: value, record: { ...record, closedAt: new Date(Number.NaN) } })).toThrowError(expect.objectContaining({ statusCode: 503 }))
    expect(() => projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: { ...value, updatedAt: new Date(Number.NaN) }, record: null })).toThrowError(expect.objectContaining({ statusCode: 503 }))
    expect(() => projectEmailManualReview({ enabled: true, ownerUserId: 7, snapshot: { ...value, attemptCount: Number.MAX_SAFE_INTEGER + 1 }, record: null })).toThrowError(expect.objectContaining({ statusCode: 503 }))
  })
})
