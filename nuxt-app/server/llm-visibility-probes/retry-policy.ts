import type { AdapterFailure, ProbeFailureKind, RetryDecision } from './types'

const nonRetryableKinds = new Set<ProbeFailureKind>([
  'invalid_input', 'owner_project_query_mismatch', 'unsupported_locale', 'adapter_mismatch', 'response_too_large',
  'malformed_response', 'citation_validation_failure', 'identity_collision', 'redirect',
])

function nonRetryable(reasonCode: string): RetryDecision {
  return { retryable: false, nextDelayCategory: 'none', reasonCode }
}

export function classifyVisibilityProbeFailure(error: unknown): RetryDecision {
  if (error && typeof error === 'object') {
    const failure = error as Partial<AdapterFailure> & { name?: string, code?: string, status?: number, statusCode?: number }
    const httpStatus = typeof failure.httpStatus === 'number' ? failure.httpStatus : typeof failure.status === 'number' ? failure.status : typeof failure.statusCode === 'number' ? failure.statusCode : undefined
    if (httpStatus !== undefined) {
      if (httpStatus === 429) return { retryable: true, nextDelayCategory: 'short', reasonCode: 'HTTP_429_RETRYABLE' }
      if (httpStatus >= 500 && httpStatus <= 599) return { retryable: true, nextDelayCategory: 'medium', reasonCode: 'HTTP_5XX_RETRYABLE' }
      if ([400, 401, 403, 404, 409, 422].includes(httpStatus)) return nonRetryable(`HTTP_${httpStatus}_NOT_RETRYABLE`)
      if (httpStatus >= 300 && httpStatus <= 399) return nonRetryable('REDIRECT_NOT_RETRYABLE')
    }
    const kind = typeof failure.failureKind === 'string' ? failure.failureKind as ProbeFailureKind : undefined
    if (kind && nonRetryableKinds.has(kind)) return nonRetryable(`${kind.toUpperCase()}_NOT_RETRYABLE`)
    if (kind === 'timeout') return { retryable: true, nextDelayCategory: 'medium', reasonCode: 'TIMEOUT_RETRYABLE' }
    if (kind === 'network_unavailable') return { retryable: true, nextDelayCategory: 'short', reasonCode: 'NETWORK_UNAVAILABLE_RETRYABLE' }
    if (kind === 'http_error') return nonRetryable('HTTP_ERROR_NOT_RETRYABLE')
    if (kind === 'unknown') return nonRetryable('UNKNOWN_FAILURE_NOT_RETRYABLE')
    if (failure.name === 'AbortError' || failure.code === 'ETIMEDOUT' || failure.code === 'UND_ERR_CONNECT_TIMEOUT') return { retryable: true, nextDelayCategory: 'medium', reasonCode: 'TIMEOUT_RETRYABLE' }
    if (failure.code === 'ENETUNREACH' || failure.code === 'ECONNREFUSED' || failure.code === 'ECONNRESET') return { retryable: true, nextDelayCategory: 'short', reasonCode: 'NETWORK_UNAVAILABLE_RETRYABLE' }
  }
  return nonRetryable('UNKNOWN_FAILURE_NOT_RETRYABLE')
}

export function retryDecisionFromFailure(failure: AdapterFailure): RetryDecision {
  return classifyVisibilityProbeFailure(failure)
}
