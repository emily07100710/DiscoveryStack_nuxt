import { createHash } from 'node:crypto'
import { normalizeContentQualityInput } from './normalization'
import type { ReasonCode } from './reason-codes'
import type { ContentQualityInput } from './types'

export type FingerprintResult =
  | { status: 'valid', fingerprint: string, canonicalInput: string, reasonCodes: [] }
  | { status: 'invalid', fingerprint: null, canonicalInput: null, reasonCodes: ReasonCode[] }

function canonicalValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVALID_INPUT')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error('INVALID_INPUT')
  if (seen.has(value)) throw new Error('INVALID_INPUT')
  seen.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== 'string')) throw new Error('UNKNOWN_FIELD')
    const sortedKeys = keys.sort((left, right) => codeUnitCompare(left as string, right as string)) as string[]
    return `{${sortedKeys.map(key => `${JSON.stringify(key)}:${canonicalValue((value as Record<string, unknown>)[key], seen)}`).join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function codeUnitCompare(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    const delta = left.charCodeAt(index) - right.charCodeAt(index)
    if (delta !== 0) return delta
  }
  return left.length - right.length
}

export function canonicalizeQualityValue(value: unknown): string {
  return canonicalValue(value, new WeakSet<object>())
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function fingerprintContentQualityInput(value: unknown): FingerprintResult {
  const normalized = normalizeContentQualityInput(value)
  if (normalized.status !== 'valid') return { status: 'invalid', fingerprint: null, canonicalInput: null, reasonCodes: normalized.reasonCodes }
  try {
    const canonicalInput = canonicalizeQualityValue(normalized.input)
    return { status: 'valid', fingerprint: sha256Text(canonicalInput), canonicalInput, reasonCodes: [] }
  } catch (error: unknown) {
    const reasonCodes: ReasonCode[] = [error instanceof Error && error.message === 'UNKNOWN_FIELD' ? 'UNKNOWN_FIELD' : 'INVALID_INPUT']
    return { status: 'invalid', fingerprint: null, canonicalInput: null, reasonCodes }
  }
}

export function contentQualityFingerprintForNormalizedInput(input: ContentQualityInput): string {
  return sha256Text(canonicalizeQualityValue(input))
}
