import { createHash } from 'node:crypto'
import { DELIVERY_AUTOMATION_ENGINE_VERSION } from './types'
import type { DeliveryAdapter, IdempotencyPayload, IdempotencyResult } from './types'

const adapters = new Set<DeliveryAdapter>(['wordpress_rest', 'generic_http', 'manual_export'])
const sha256Pattern = /^[a-f0-9]{64}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function requiredInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value)
}

export function isValidSha256(value: unknown): value is string {
  return validHash(value)
}

export function computeDeliveryIdempotencyKey(input: unknown): IdempotencyResult {
  try {
    if (!isRecord(input)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['publication identity must be a plain object'] }
    const ownerScopeKey = read(input, 'ownerScopeKey')
    const targetId = read(input, 'targetId')
    const adapter = read(input, 'adapter')
    const scheduleEntryId = read(input, 'scheduleEntryId')
    const scheduleKey = read(input, 'scheduleKey')
    const jobId = read(input, 'jobId')
    const draftId = read(input, 'draftId')
    const draftVersion = read(input, 'draftVersion')
    const reviewId = read(input, 'reviewId')
    const evidenceSnapshotHash = read(input, 'evidenceSnapshotHash')
    const contentHash = read(input, 'contentHash')

    if (!requiredString(ownerScopeKey) || !requiredString(targetId) || !requiredString(scheduleEntryId) || !requiredString(scheduleKey) || !requiredString(jobId) || !requiredString(draftId) || !requiredString(reviewId)) {
      return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['all publication identity strings are required'] }
    }
    if (typeof adapter !== 'string' || !adapters.has(adapter as DeliveryAdapter)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['adapter is invalid'] }
    if (!requiredInteger(draftVersion)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['draftVersion must be a positive safe integer'] }
    if (!validHash(evidenceSnapshotHash) || !validHash(contentHash)) return { status: 'blocked', code: 'INVALID_SHA256', reasons: ['evidenceSnapshotHash and contentHash must be SHA-256'] }

    const payload: IdempotencyPayload = {
      engineVersion: DELIVERY_AUTOMATION_ENGINE_VERSION,
      ownerScopeKey,
      targetId,
      adapter: adapter as DeliveryAdapter,
      scheduleEntryId,
      scheduleKey,
      jobId,
      draftId,
      draftVersion,
      reviewId,
      evidenceSnapshotHash: evidenceSnapshotHash.toLowerCase(),
      contentHash: contentHash.toLowerCase(),
    }
    const canonical = JSON.stringify(payload)
    const key = createHash('sha256').update(canonical, 'utf8').digest('hex')
    return { status: 'ok', key, payload }
  } catch {
    return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['idempotency input could not be read'] }
  }
}
