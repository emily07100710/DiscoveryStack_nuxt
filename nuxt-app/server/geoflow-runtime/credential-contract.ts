import type { GeoFlowCredentialResolution, GeoFlowCredentialResolver, GeoFlowTransportResult } from './types'

const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const CREDENTIAL_MAX_BYTES = 4_096
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

type ResolvedCredential =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: { readonly code: 'CREDENTIAL_REFERENCE_INVALID' | 'CREDENTIAL_RESOLUTION_FAILED'; readonly retryable: false } }

export function validateGeoFlowCredentialReference(value: unknown): GeoFlowTransportResult<string> {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || CONTROL_CHARACTERS.test(value) || !CREDENTIAL_REFERENCE_PATTERN.test(value)) {
    return { ok: false, error: { code: 'CREDENTIAL_REFERENCE_INVALID', retryable: false } }
  }
  return { ok: true, value }
}

export async function resolveGeoFlowCredentialForTransport(reference: unknown, resolver: GeoFlowCredentialResolver): Promise<ResolvedCredential> {
  const validated = validateGeoFlowCredentialReference(reference)
  if (!validated.ok) return { ok: false, error: { code: 'CREDENTIAL_REFERENCE_INVALID', retryable: false } }
  try {
    const resolved = await resolver(validated.value)
    if (resolved?.ok !== true || typeof resolved.value !== 'string' || resolved.value.length < 1 || resolved.value.length > CREDENTIAL_MAX_BYTES || CONTROL_CHARACTERS.test(resolved.value)) {
      return { ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } }
    }
    return { ok: true, token: resolved.value }
  } catch {
    return { ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } }
  }
}
