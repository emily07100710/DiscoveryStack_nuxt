import { createHash } from 'node:crypto'
import { createError } from 'h3'
import type { ManagedSiteEmailSafeCode, ManagedSiteEmailPurpose } from '../email-outbox/types'
import type { EmailManualReviewCommand, EmailManualReviewProjection, EmailManualReviewRecord, EmailManualReviewSnapshot } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const HASH = /^[0-9a-f]{64}$/u
const PURPOSES: readonly ManagedSiteEmailPurpose[] = ['inbox_verification', 'customer_reaccess', 'member_invitation', 'contact_form_forward', 'workspace_ready']
const SAFE_CODES: readonly ManagedSiteEmailSafeCode[] = ['outbox_disabled', 'outbox_unconfigured', 'authority_stale', 'outbox_expired', 'outbox_collision', 'outbox_busy', 'provider_unavailable', 'retry_window_expired', 'attempt_limit', 'outbox_storage_unavailable', 'invalid_input']
const REASONS = ['reviewed_no_resend', 'handled_outside_platform'] as const
const INVALID_COMMAND = '郵件人工結案資料格式不正確。'
const INVALID_REVIEW = '郵件人工結案紀錄暫時無法讀取。'

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.getUTCFullYear() >= 1000 && value.getUTCFullYear() <= 9999
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key)) && expected.every(key => Object.hasOwn(value, key))
}

export function parseEmailManualReviewCommand(input: unknown): EmailManualReviewCommand {
  if (!plainRecord(input) || !exactKeys(input, ['itemId', 'expectedVersion', 'requestId', 'reason', 'confirmNoResend'])
    || typeof input.itemId !== 'string' || !UUID.test(input.itemId)
    || typeof input.expectedVersion !== 'string' || !HASH.test(input.expectedVersion)
    || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
    || typeof input.reason !== 'string' || !REASONS.includes(input.reason as typeof REASONS[number])
    || input.confirmNoResend !== true) {
    throw createError({ statusCode: 422, statusMessage: INVALID_COMMAND })
  }
  return {
    itemId: input.itemId,
    expectedVersion: input.expectedVersion,
    requestId: input.requestId,
    reason: input.reason as EmailManualReviewCommand['reason'],
    confirmNoResend: true,
  }
}

function validManualSnapshot(snapshot: EmailManualReviewSnapshot): boolean {
  return !!snapshot && typeof snapshot === 'object'
    && typeof snapshot.id === 'string' && UUID.test(snapshot.id)
    && PURPOSES.includes(snapshot.purpose)
    && snapshot.status === 'manual_required'
    && validDate(snapshot.updatedAt)
    && validDate(snapshot.expiresAt)
    && Number.isSafeInteger(snapshot.attemptCount) && snapshot.attemptCount >= 0
    && (snapshot.lastErrorCode === null || SAFE_CODES.includes(snapshot.lastErrorCode))
}

export function emailManualReviewVersion(snapshot: EmailManualReviewSnapshot): string | null {
  if (!validManualSnapshot(snapshot)) return null
  const canonical = JSON.stringify({
    version: 'managed-site-email-manual-review-v1',
    id: snapshot.id,
    purpose: snapshot.purpose,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt.toISOString(),
    expiresAt: snapshot.expiresAt.toISOString(),
    attemptCount: snapshot.attemptCount,
    lastErrorCode: snapshot.lastErrorCode,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function validateEmailManualReviewRecord(record: unknown): record is EmailManualReviewRecord {
  if (!plainRecord(record)) return false
  return typeof record.outboxId === 'string' && UUID.test(record.outboxId)
    && Number.isSafeInteger(record.ownerUserId) && (record.ownerUserId as number) > 0
    && typeof record.requestId === 'string' && UUID.test(record.requestId)
    && typeof record.outboxVersion === 'string' && HASH.test(record.outboxVersion)
    && typeof record.reason === 'string' && REASONS.includes(record.reason as typeof REASONS[number])
    && validDate(record.closedAt)
}

function reviewUnavailable(): never {
  throw createError({ statusCode: 503, statusMessage: INVALID_REVIEW })
}

export function projectEmailManualReview(input: {
  enabled: boolean
  ownerUserId: number
  snapshot: EmailManualReviewSnapshot
  record: EmailManualReviewRecord | null
}): EmailManualReviewProjection {
  if (!input.enabled) return { manualReviewStatus: 'disabled', manualReviewVersion: null, manualReviewReason: null, manualReviewClosedAt: null }
  if (!input.snapshot || typeof input.snapshot !== 'object') reviewUnavailable()
  if (input.snapshot.status !== 'manual_required') return { manualReviewStatus: 'not_required', manualReviewVersion: null, manualReviewReason: null, manualReviewClosedAt: null }
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0) reviewUnavailable()

  const version = emailManualReviewVersion(input.snapshot)
  if (!version) reviewUnavailable()
  if (input.record === null) return { manualReviewStatus: 'open', manualReviewVersion: version, manualReviewReason: null, manualReviewClosedAt: null }
  if (!validateEmailManualReviewRecord(input.record)
    || input.record.outboxId !== input.snapshot.id
    || input.record.ownerUserId !== input.ownerUserId
    || input.record.outboxVersion !== version) reviewUnavailable()

  return {
    manualReviewStatus: 'closed_no_resend',
    manualReviewVersion: version,
    manualReviewReason: input.record.reason,
    manualReviewClosedAt: input.record.closedAt.toISOString(),
  }
}
