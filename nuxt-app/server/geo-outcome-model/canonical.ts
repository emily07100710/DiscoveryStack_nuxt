import { createHash } from 'node:crypto'

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue }

function normalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers cannot be canonicalized.')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(item => normalize(item))
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const result: Record<string, CanonicalValue> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) result[key] = normalize(item)
    }
    return result
  }
  throw new Error(`Unsupported canonical value: ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

export function boundedText(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`${field} must be a non-empty bounded string.`)
  return value
}

export function boundedArray<T>(value: unknown, maxLength: number, field: string): T[] {
  if (!Array.isArray(value) || value.length > maxLength) throw new Error(`${field} must be a bounded array.`)
  return value as T[]
}
