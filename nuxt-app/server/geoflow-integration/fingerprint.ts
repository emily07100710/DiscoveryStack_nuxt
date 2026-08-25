import { createHash } from 'node:crypto'
import type { GeoFlowRequestDraft, ReasonCode, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { normalizeGeoFlowRequestDraft } from './normalization'

function failure(reason: ReasonCode, path = '$'): ValidationFailure {
  return { ok: false, reason, issues: [{ path, code: reason }] }
}

function success<T>(value: T): ValidationSuccess<T> {
  return { ok: true, value }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function canonicalize(value: unknown, path: string, seen: Set<object>): ValidationResult<string> {
  if (value === null) return success('null')
  if (typeof value === 'string') return success(JSON.stringify(value))
  if (typeof value === 'boolean') return success(value ? 'true' : 'false')
  if (typeof value === 'number') {
    return Number.isFinite(value) ? success(Object.is(value, -0) ? '0' : JSON.stringify(value)) : failure('INVALID_INPUT', path)
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return failure('INVALID_INPUT', path)
  if (typeof value !== 'object' || value === null) return failure('INVALID_INPUT', path)
  if (value instanceof Date || value instanceof Map || value instanceof Set) return failure('INVALID_INPUT', path)
  if (seen.has(value)) return failure('INVALID_INPUT', path)
  seen.add(value)
  let result: ValidationResult<string>
  if (Array.isArray(value)) {
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      let item: unknown
      try { item = value[index] } catch { seen.delete(value); return failure('INVALID_INPUT', `${path}[${index}]`) }
      const canonical = canonicalize(item, `${path}[${index}]`, seen)
      if (!canonical.ok) { seen.delete(value); return canonical }
      items.push(canonical.value)
    }
    result = success(`[${items.join(',')}]`)
  } else if (isPlainRecord(value)) {
    let keys: string[]
    try { keys = Object.keys(value).sort() } catch { seen.delete(value); return failure('INVALID_INPUT', path) }
    const items: string[] = []
    for (const key of keys) {
      let item: unknown
      try { item = value[key] } catch { seen.delete(value); return failure('INVALID_INPUT', `${path}.${key}`) }
      const canonical = canonicalize(item, `${path}.${key}`, seen)
      if (!canonical.ok) { seen.delete(value); return canonical }
      items.push(`${JSON.stringify(key)}:${canonical.value}`)
    }
    result = success(`{${items.join(',')}}`)
  } else {
    result = failure('INVALID_INPUT', path)
  }
  seen.delete(value)
  return result
}

export function canonicalizeContractValue(input: unknown): ValidationResult<string> {
  return canonicalize(input, '$', new Set<object>())
}

export function requestFingerprintFromDraft(draft: GeoFlowRequestDraft): string {
  const canonical = canonicalizeContractValue(draft)
  if (!canonical.ok) throw new Error('Request draft was not canonicalizable.')
  return createHash('sha256').update(canonical.value, 'utf8').digest('hex')
}

export function canonicalRequestFingerprint(input: unknown): ValidationResult<string> {
  const normalized = normalizeGeoFlowRequestDraft(input)
  if (!normalized.ok) return normalized
  return success(requestFingerprintFromDraft(normalized.value))
}

export function canonicalizeRequestDraft(input: unknown): ValidationResult<{ draft: GeoFlowRequestDraft; canonical: string; requestFingerprint: string }> {
  const normalized = normalizeGeoFlowRequestDraft(input)
  if (!normalized.ok) return normalized
  const canonical = canonicalizeContractValue(normalized.value)
  if (!canonical.ok) return canonical
  return success({ draft: normalized.value, canonical: canonical.value, requestFingerprint: createHash('sha256').update(canonical.value, 'utf8').digest('hex') })
}
