import type { GeoFlowFailureClassification, GeoFlowFailureClassificationInput, GeoFlowTransportError } from './types'

export const DEFAULT_MAX_ATTEMPTS = 3 as const
export const MAX_ALLOWED_ATTEMPTS = 10 as const
export const DEFAULT_MAX_RETRY_AFTER_SECONDS = 300 as const

function nonRetryable(code: GeoFlowTransportError['code'], httpStatus?: number): GeoFlowTransportError {
  return { code, retryable: false, ...(httpStatus === undefined ? {} : { httpStatus }) }
}

function safeMaxRetryAfter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3_600 ? value : DEFAULT_MAX_RETRY_AFTER_SECONDS
}

export function parseGeoFlowRetryAfter(value: unknown, maximumSeconds: number = DEFAULT_MAX_RETRY_AFTER_SECONDS): { readonly ok: true; readonly seconds: number | undefined } | { readonly ok: false; readonly code: 'RETRY_AFTER_INVALID' } {
  const maximum = safeMaxRetryAfter(maximumSeconds)
  if (value === undefined || value === null || value === '') return { ok: true, seconds: undefined }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return { ok: false, code: 'RETRY_AFTER_INVALID' }
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= maximum ? { ok: true, seconds } : { ok: false, code: 'RETRY_AFTER_INVALID' }
}

export function validateGeoFlowAttempt(value: unknown): GeoFlowTransportResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_ALLOWED_ATTEMPTS) return { ok: false, error: { code: 'ATTEMPT_INVALID', retryable: false } }
  return { ok: true, value: value as number }
}

export function classifyGeoFlowTransportFailure(input: GeoFlowFailureClassificationInput): GeoFlowFailureClassification {
  const kind = typeof input.kind === 'string' ? input.kind : undefined
  if (kind === 'timeout') return { code: 'TRANSPORT_TIMEOUT', retryable: true }
  if (kind === 'network') return { code: 'NETWORK_FAILURE', retryable: true }
  if (kind === 'malformed') return nonRetryable('RESPONSE_MALFORMED')
  if (kind === 'identity') return nonRetryable('RESULT_INVALID')
  if (kind === 'hash') return nonRetryable('CONTENT_HASH_MISMATCH')
  if (kind === 'not_ready') return nonRetryable('ARTICLE_NOT_READY')
  if (typeof input.status !== 'number' || !Number.isSafeInteger(input.status) || input.status < 100 || input.status > 599) return nonRetryable('RESPONSE_MALFORMED')
  const status = input.status
  if (status >= 300 && status <= 399) return nonRetryable('REDIRECT_BLOCKED', status)
  if (status === 401 || status === 403) return nonRetryable('REMOTE_UNAUTHORIZED', status)
  if (status === 404) return nonRetryable('REMOTE_NOT_FOUND', status)
  if (status === 409) return nonRetryable('REMOTE_CONFLICT', status)
  if (status === 422) return nonRetryable('REMOTE_UNPROCESSABLE', status)
  if (status === 429) {
    const retryAfter = parseGeoFlowRetryAfter(input.retryAfter)
    if (!retryAfter.ok) return nonRetryable('RETRY_AFTER_INVALID', status)
    return { code: 'REMOTE_RATE_LIMITED', retryable: true, httpStatus: status, ...(retryAfter.seconds === undefined ? {} : { retryAfterSeconds: retryAfter.seconds }) }
  }
  if (status >= 500 && status <= 599) return { code: 'REMOTE_SERVER_ERROR', retryable: true, httpStatus: status }
  if (status >= 400 && status <= 499) return nonRetryable('REMOTE_REJECTED', status)
  return nonRetryable('REMOTE_REJECTED', status)
}

export function retryAllowedForAttempt(attempt: number, error: GeoFlowTransportError, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  const boundedMax = typeof maxAttempts === 'number' && Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= MAX_ALLOWED_ATTEMPTS ? maxAttempts : DEFAULT_MAX_ATTEMPTS
  return error.retryable === true && Number.isSafeInteger(attempt) && attempt >= 1 && attempt < boundedMax
}

export type GeoFlowTransportResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: GeoFlowTransportError }
