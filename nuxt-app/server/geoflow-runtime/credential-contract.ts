import { validateGeoFlowBaseUrl } from './target-guard'
import type { GeoFlowCredentialResolution, GeoFlowCredentialResolver, GeoFlowTransportResult } from './types'

const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const CREDENTIAL_MAX_BYTES = 4_096
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const RESOLUTION_KEYS = ['ok', 'value'] as const
const VALUE_KEYS = ['token', 'allowedBaseUrl'] as const

type ResolvedCredential =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: { readonly code: 'CREDENTIAL_REFERENCE_INVALID' | 'CREDENTIAL_RESOLUTION_FAILED' | 'CREDENTIAL_TARGET_MISMATCH'; readonly retryable: false } }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const keys = Object.keys(record).sort()
    return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
  } catch {
    return false
  }
}

export function validateGeoFlowCredentialReference(value: unknown): GeoFlowTransportResult<string> {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || CONTROL_CHARACTERS.test(value) || !CREDENTIAL_REFERENCE_PATTERN.test(value)) {
    return { ok: false, error: { code: 'CREDENTIAL_REFERENCE_INVALID', retryable: false } }
  }
  return { ok: true, value }
}

function validToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > CREDENTIAL_MAX_BYTES || CONTROL_CHARACTERS.test(value)) return false
  try {
    return new TextEncoder().encode(value).byteLength <= CREDENTIAL_MAX_BYTES
  } catch {
    return false
  }
}

export async function resolveGeoFlowCredentialForTransport(reference: unknown, resolver: GeoFlowCredentialResolver, expectedBaseUrl: string): Promise<ResolvedCredential> {
  const validated = validateGeoFlowCredentialReference(reference)
  if (!validated.ok) return { ok: false, error: { code: 'CREDENTIAL_REFERENCE_INVALID', retryable: false } }
  try {
    const resolved: GeoFlowCredentialResolution = await resolver(validated.value)
    if (!isPlainRecord(resolved) || !hasExactKeys(resolved, RESOLUTION_KEYS) || resolved.ok !== true || !isPlainRecord(resolved.value) || !hasExactKeys(resolved.value, VALUE_KEYS)) {
      return { ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } }
    }
    if (!validToken(resolved.value.token)) return { ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } }
    const allowedBaseUrl = validateGeoFlowBaseUrl(resolved.value.allowedBaseUrl)
    if (!allowedBaseUrl.ok || allowedBaseUrl.value !== expectedBaseUrl) return { ok: false, error: { code: 'CREDENTIAL_TARGET_MISMATCH', retryable: false } }
    return { ok: true, token: resolved.value.token }
  } catch {
    return { ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } }
  }
}
