import { GOOGLE_ANALYTICS_READONLY_SCOPE, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, isRecord, sanitizeError } from '../normalization'
import { MEASUREMENT_MAX_RESPONSE_BYTES, type AdapterFailure, type GoogleReadOnlyCredential, type MeasurementAdapterContext, type MeasurementAdapterResult, type FetchLike } from '../types'

export { GOOGLE_ANALYTICS_READONLY_SCOPE, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE }
export type GoogleScope = typeof GOOGLE_ANALYTICS_READONLY_SCOPE | typeof GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function safeFailure(status: AdapterFailure['status'], code: string, retryable: boolean, limitations: string[] = []): AdapterFailure {
  return { status, code, retryable, summary: code.replace(/_/gu, ' ').toLocaleLowerCase('en-US').slice(0, 240), limitations: [...new Set(limitations)].slice(0, 20) }
}

export async function resolveGoogleCredential(context: MeasurementAdapterContext, requiredScope: GoogleScope): Promise<{ credential: GoogleReadOnlyCredential } | { failure: AdapterFailure }> {
  if (!context.connection.credentialReference) return { failure: safeFailure('blocked', 'CREDENTIAL_NOT_CONFIGURED', false, ['credential_reference_not_configured']) }
  let credential: GoogleReadOnlyCredential | null
  try {
    credential = await context.resolver(context.ownerUserId, context.connection.credentialReference, [requiredScope])
  } catch {
    return { failure: safeFailure('failed', 'CREDENTIAL_RESOLVER_FAILED', false, ['credential_resolver_rejected']) }
  }
  if (!credential || typeof credential.accessToken !== 'string' || credential.accessToken.length === 0) return { failure: safeFailure('blocked', 'CREDENTIAL_MISSING', false, ['credential_not_available']) }
  const expiresAt = Date.parse(credential.expiresAt)
  const now = (context.now || new Date()).getTime()
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { failure: safeFailure('blocked', 'TOKEN_EXPIRED', false, ['credential_reauthorization_required']) }
  if (!Array.isArray(credential.grantedScopes) || !credential.grantedScopes.includes(requiredScope)) return { failure: safeFailure('blocked', 'REQUIRED_SCOPE_MISSING', false, ['required_readonly_scope_missing']) }
  return { credential }
}

export async function postFixedJson(context: MeasurementAdapterContext, endpoint: string, credential: GoogleReadOnlyCredential, requestBody: unknown, timeoutMs = 15_000): Promise<{ ok: true; body: unknown; status: number } | { ok: false; failure: AdapterFailure }> {
  const fetcher: FetchLike = context.fetcher || fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(timeoutMs, 30_000)))
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.accessToken}` },
      body: JSON.stringify(requestBody),
    })
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > MEASUREMENT_MAX_RESPONSE_BYTES) return { ok: false, failure: safeFailure('failed', 'RESPONSE_TOO_LARGE', false, ['provider_response_size_limit_exceeded']) }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MEASUREMENT_MAX_RESPONSE_BYTES) return { ok: false, failure: safeFailure('failed', 'RESPONSE_TOO_LARGE', false, ['provider_response_size_limit_exceeded']) }
    if (response.status === 401 || response.status === 403) return { ok: false, failure: safeFailure('blocked', 'NEEDS_REAUTHORIZATION', false, ['provider_authorization_rejected']) }
    if (response.status === 429 || response.status >= 500) return { ok: false, failure: safeFailure('retry_wait', 'PROVIDER_RETRYABLE_HTTP', true, ['provider_rate_limit_or_server_error']) }
    if (!response.ok) return { ok: false, failure: safeFailure('failed', `PROVIDER_HTTP_${response.status}`, false, ['provider_request_failed']) }
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return { ok: false, failure: safeFailure('failed', 'MALFORMED_RESPONSE', false, ['provider_response_not_json']) }
    }
    if (!isRecord(body)) return { ok: false, failure: safeFailure('failed', 'MALFORMED_RESPONSE', false, ['provider_response_shape_invalid']) }
    return { ok: true, body, status: response.status }
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError'
    const failure = sanitizeError(error, isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR')
    return { ok: false, failure: safeFailure('retry_wait', failure.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR', true, [isTimeout ? 'provider_request_timeout' : 'provider_network_error']) }
  } finally {
    clearTimeout(timer)
  }
}

export function adapterFailureToResult(failure: AdapterFailure): MeasurementAdapterResult {
  return failure
}
