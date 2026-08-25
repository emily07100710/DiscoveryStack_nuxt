import { canonicalizeQualityValue } from '../geo-content-quality'
import type { EvaluationReasonCode, GeoContentEvaluationCandidateInput } from './types'

const CANDIDATE_KEYS = ['caseId', 'candidateId', 'variantLabel', 'qualityInput', 'providerOutput', 'markdown'] as const
Object.freeze(CANDIDATE_KEYS)

type RawCandidateKey = typeof CANDIDATE_KEYS[number]

export type NormalizedRawCandidateEnvelope = {
  caseId: string
  candidateId: string
  variantLabel: string
  qualityInput: unknown
  providerOutput: unknown
  markdown: unknown
}

export type RawCandidateValidation =
  | { status: 'valid', value: NormalizedRawCandidateEnvelope }
  | { status: 'invalid', caseId: string, candidateId: string, variantLabel: string, reasonCodes: EvaluationReasonCode[] }

function emptyInvalid(reasonCodes: EvaluationReasonCode[]): RawCandidateValidation {
  return { status: 'invalid', caseId: '', candidateId: '', variantLabel: '', reasonCodes: [...new Set(reasonCodes)] }
}

function inspectPlainObject(value: unknown): { valid: true } | { valid: false, unknownField: boolean } {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { valid: false, unknownField: false }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return { valid: false, unknownField: false }
    const keys = Reflect.ownKeys(value)
    for (const key of keys) {
      if (typeof key !== 'string') return { valid: false, unknownField: true }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) return { valid: false, unknownField: true }
    }
    return { valid: true }
  } catch {
    return { valid: false, unknownField: false }
  }
}

function readDataField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    throw new Error('RAW_CANDIDATE_FIELD_READ_FAILED')
  }
}

function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const normalized = value.normalize('NFKC').trim()
    if (!normalized || /[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) return null
    if (new TextEncoder().encode(normalized).length > 160) return null
    return normalized
  } catch {
    return null
  }
}

function identityValue(value: unknown): string {
  return normalizeIdentity(value) ?? ''
}

export function rawCandidateIdentityTuple(value: Pick<NormalizedRawCandidateEnvelope, 'caseId' | 'candidateId' | 'variantLabel'>): string {
  return canonicalizeQualityValue({ caseId: value.caseId, candidateId: value.candidateId, variantLabel: value.variantLabel })
}

export function validateRawCandidateEnvelope(value: unknown): RawCandidateValidation {
  try {
    const inspected = inspectPlainObject(value)
    if (!inspected.valid) return emptyInvalid(['EVALUATION_INVALID_INPUT', ...(inspected.unknownField ? ['EVALUATION_UNKNOWN_FIELD' as const] : [])])

    const candidate = value as object
    const ownKeys = Reflect.ownKeys(candidate)
    const stringKeys = ownKeys.filter((key): key is string => typeof key === 'string')
    const hasSymbolKey = ownKeys.some(key => typeof key === 'symbol')
    const hasUnknownKey = stringKeys.some(key => !(CANDIDATE_KEYS as readonly string[]).includes(key))
    const hasMissingKey = CANDIDATE_KEYS.some(key => !stringKeys.includes(key))
    const hasExactShape = !hasSymbolKey && !hasUnknownKey && !hasMissingKey && stringKeys.length === CANDIDATE_KEYS.length
    if (!hasExactShape) {
      const reasons: EvaluationReasonCode[] = ['EVALUATION_INVALID_INPUT']
      if (hasSymbolKey || hasUnknownKey) reasons.push('EVALUATION_UNKNOWN_FIELD')
      const looksLikeOutputOnlyEvaluationCase = stringKeys.includes('suiteVersion') && stringKeys.includes('status') && stringKeys.includes('metrics')
      if (looksLikeOutputOnlyEvaluationCase) reasons.push('EVALUATION_RAW_INPUT_REQUIRED')
      return { status: 'invalid', caseId: identityValue(readDataField(candidate, 'caseId')), candidateId: identityValue(readDataField(candidate, 'candidateId')), variantLabel: identityValue(readDataField(candidate, 'variantLabel')), reasonCodes: [...new Set(reasons)] }
    }

    const caseId = normalizeIdentity(readDataField(candidate, 'caseId'))
    const candidateId = normalizeIdentity(readDataField(candidate, 'candidateId'))
    const variantLabel = normalizeIdentity(readDataField(candidate, 'variantLabel'))
    if (caseId === null || candidateId === null || variantLabel === null) return emptyInvalid(['EVALUATION_INVALID_INPUT'])

    const qualityInput = readDataField(candidate, 'qualityInput')

    const providerOutput = readDataField(candidate, 'providerOutput')
    if (providerOutput !== null) {
      const providerShape = inspectPlainObject(providerOutput)
      if (!providerShape.valid) return { status: 'invalid', caseId, candidateId, variantLabel, reasonCodes: ['EVALUATION_INVALID_INPUT', ...(providerShape.unknownField ? ['EVALUATION_UNKNOWN_FIELD' as const] : [])] }
    }

    const markdown = readDataField(candidate, 'markdown')
    if (markdown !== null && typeof markdown !== 'string') return { status: 'invalid', caseId, candidateId, variantLabel, reasonCodes: ['EVALUATION_INVALID_INPUT'] }

    return { status: 'valid', value: { caseId, candidateId, variantLabel, qualityInput, providerOutput, markdown } satisfies GeoContentEvaluationCandidateInput }
  } catch {
    return emptyInvalid(['EVALUATION_INVALID_INPUT'])
  }
}

export function rawCandidateKeys(): readonly RawCandidateKey[] {
  return CANDIDATE_KEYS
}
