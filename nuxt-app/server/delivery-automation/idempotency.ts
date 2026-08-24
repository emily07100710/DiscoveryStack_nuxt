import { createHash } from 'node:crypto'
import { DELIVERY_AUTOMATION_ENGINE_VERSION } from './types'
import type { DeliveryAdapter, IdempotencyPayload, IdempotencyResult } from './types'

const adapters = new Set<DeliveryAdapter>(['wordpress_rest', 'generic_http', 'manual_export'])
const sha256Pattern = /^[a-f0-9]{64}$/i
const opaquePattern = /^[A-Za-z0-9_.:-]+$/
const forbiddenIdentityWordPattern = /(bearer|token|secret|password|credential)/i

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

export function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value)
}

export function isOpaqueIdentifier(value: unknown, maximum = 128): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return false
  if (!opaquePattern.test(value) || forbiddenIdentityWordPattern.test(value)) return false
  if (value.includes('://') || value.includes('..')) return false
  return value === value.normalize('NFKC')
}

function validIdentity(value: unknown, maximum = 128): value is string {
  return isOpaqueIdentifier(value, maximum)
}

export function computeDeliveryIdempotencyKey(input: unknown): IdempotencyResult {
  try {
    if (!isRecord(input)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['publication identity must be a plain object'] }
    const ownerScopeKey = read(input, 'ownerScopeKey')
    const targetId = read(input, 'targetId')
    const adapter = read(input, 'adapter')
    const scheduleEntryId = read(input, 'scheduleEntryId')
    const scheduleKey = read(input, 'scheduleKey')
    const productionPlanId = read(input, 'productionPlanId')
    const jobId = read(input, 'jobId')
    const draftId = read(input, 'draftId')
    const draftVersion = read(input, 'draftVersion')
    const reviewId = read(input, 'reviewId')
    const evidenceSnapshotHash = read(input, 'evidenceSnapshotHash')
    const contentHash = read(input, 'contentHash')

    if (!validIdentity(ownerScopeKey) || !validIdentity(targetId) || !validIdentity(scheduleEntryId) || !validIdentity(productionPlanId) || !validIdentity(jobId) || !validIdentity(draftId) || !validIdentity(reviewId) || !validIdentity(scheduleKey, 256)) {
      return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['all identity fields must be opaque identifiers'] }
    }
    if (typeof adapter !== 'string' || !adapters.has(adapter as DeliveryAdapter)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['adapter is invalid'] }
    if (typeof draftVersion !== 'number' || !Number.isSafeInteger(draftVersion) || draftVersion < 1) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['draftVersion must be a positive safe integer'] }
    if (!isValidSha256(evidenceSnapshotHash) || !isValidSha256(contentHash)) return { status: 'blocked', code: 'INVALID_SHA256', reasons: ['evidenceSnapshotHash and contentHash must be SHA-256'] }

    const payload: IdempotencyPayload = {
      engineVersion: DELIVERY_AUTOMATION_ENGINE_VERSION,
      ownerScopeKey,
      targetId,
      adapter: adapter as DeliveryAdapter,
      scheduleEntryId,
      scheduleKey,
      productionPlanId,
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
