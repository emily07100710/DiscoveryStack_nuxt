import type { IdempotencyResolution, ReasonCode, ValidationFailure, ValidationResult, ValidationSuccess } from './types'

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const KEYS = ['idempotencyKey', 'requestFingerprint'] as const

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function exactKeys(value: Record<string, unknown>): boolean { try { const keys = Object.keys(value); return keys.length === KEYS.length && keys.every(key => KEYS.includes(key as typeof KEYS[number])) } catch { return false } }
function read(value: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false } { try { return { ok: true, value: value[key] } } catch { return { ok: false } } }
function parseRecord(value: unknown, path: string): ValidationResult<{ idempotencyKey: string; requestFingerprint: string }> {
  if (!isPlainRecord(value) || !exactKeys(value)) return failure('UNKNOWN_FIELD', path)
  const key = read(value, 'idempotencyKey'); const fingerprint = read(value, 'requestFingerprint')
  if (!key.ok || !fingerprint.ok || typeof key.value !== 'string' || !KEY_PATTERN.test(key.value)) return failure('INVALID_INPUT', `${path}.idempotencyKey`)
  if (typeof fingerprint.value !== 'string' || !HASH_PATTERN.test(fingerprint.value)) return failure('INVALID_HASH', `${path}.requestFingerprint`)
  return success({ idempotencyKey: key.value, requestFingerprint: fingerprint.value })
}

export function resolveGeoFlowIdempotency(input: unknown, existing: unknown): ValidationResult<{ resolution: IdempotencyResolution; idempotencyKey: string; requestFingerprint: string }> {
  const requested = parseRecord(input, '$')
  if (!requested.ok) return requested
  if (existing === null || existing === undefined) return success({ resolution: 'new_request', ...requested.value })
  const stored = parseRecord(existing, '$.existing')
  if (!stored.ok) return stored
  if (stored.value.idempotencyKey !== requested.value.idempotencyKey) return success({ resolution: 'new_request', ...requested.value })
  if (stored.value.requestFingerprint === requested.value.requestFingerprint) return success({ resolution: 'replay', ...requested.value })
  return failure('IDEMPOTENCY_COLLISION', '$.requestFingerprint')
}
