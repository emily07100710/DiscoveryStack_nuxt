import { createHash } from 'node:crypto'

export class SystemFactoryError extends Error {
  statusCode: number
  code: string

  constructor(code: string, message: string, statusCode = 422) {
    super(message)
    this.name = 'SystemFactoryError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function normalizeText(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== 'string') throw new SystemFactoryError('INVALID_TEXT', `${label} must be text.`)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (normalized.length < minimum || normalized.length > maximum) throw new SystemFactoryError('INVALID_TEXT', `${label} is outside its allowed length.`)
  if(/[\u0000-\u001f\u007f]/u.test(normalized)) throw new SystemFactoryError('INVALID_TEXT', `${label} contains control characters.`)
  return normalized
}

export function normalizeKey(value: unknown, label: string, maximum = 64): string {
  const normalized = normalizeText(value, label, maximum).toLocaleLowerCase('en-US').replace(/[ -]+/gu, '_')
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(normalized)) throw new SystemFactoryError('INVALID_KEY', `${label} must be a bounded ASCII key.`)
  return normalized
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SystemFactoryError('NON_CANONICAL_VALUE', 'Canonical data cannot contain a non-finite number.')
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new SystemFactoryError('NON_CANONICAL_VALUE', 'Canonical data must contain plain JSON values only.')
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(input).sort()) {
    if (input[key] === undefined) throw new SystemFactoryError('NON_CANONICAL_VALUE', 'Canonical data cannot contain undefined.')
    output[key] = canonicalize(input[key])
  }
  return output
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function assertUniqueNormalized<T>(items: T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    const value = key(item).normalize('NFKC').toLocaleLowerCase('en-US')
    if (seen.has(value)) throw new SystemFactoryError('NORMALIZED_DUPLICATE', `${label} contains a normalized duplicate.`)
    seen.add(value)
  }
}
