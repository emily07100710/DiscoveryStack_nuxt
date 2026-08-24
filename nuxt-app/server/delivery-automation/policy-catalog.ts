import type { DeliveryAdapter, DeliveryFailureCode, DeliveryState } from './types'

export const DELIVERY_POLICY_VERSION = 'delivery-policy-v1' as const
export const MAX_DELIVERY_ATTEMPTS = 5 as const
export const MAX_ATTEMPT_HISTORY = 20 as const
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 0] as const
export const SUPPORTED_DELIVERY_ADAPTERS = ['wordpress_rest', 'generic_http', 'manual_export'] as const satisfies readonly DeliveryAdapter[]

export const TERMINAL_DELIVERY_STATES = ['delivered', 'permanent_failed', 'blocked', 'cancelled'] as const satisfies readonly DeliveryState[]

export const ALLOWED_DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  scheduled: ['eligible', 'blocked', 'cancelled'],
  eligible: ['dispatch_planned', 'blocked', 'cancelled'],
  dispatch_planned: ['retry_wait', 'delivered', 'permanent_failed', 'blocked', 'cancelled'],
  retry_wait: ['dispatch_planned', 'permanent_failed', 'blocked', 'cancelled'],
  delivered: [],
  permanent_failed: [],
  blocked: [],
  cancelled: [],
}

export function isTerminalDeliveryState(state: DeliveryState): boolean {
  return (TERMINAL_DELIVERY_STATES as readonly string[]).includes(state)
}

export function isAllowedDeliveryTransition(from: DeliveryState, to: DeliveryState): boolean {
  return ALLOWED_DELIVERY_TRANSITIONS[from]?.includes(to) ?? false
}

export function retryDelaySeconds(attemptNumber: number): number {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > MAX_DELIVERY_ATTEMPTS) return 0
  return RETRY_DELAYS_SECONDS[attemptNumber - 1] ?? 0
}

export function isRetryableFailure(input: {
  readonly code?: DeliveryFailureCode | string
  readonly httpStatus?: number
  readonly confirmedSameIdempotentDelivery?: boolean
}): boolean {
  if (input.code === 'timeout' || input.code === 'connection_reset') return true
  if (input.httpStatus === 408 || input.httpStatus === 429) return true
  if (typeof input.httpStatus === 'number' && input.httpStatus >= 500 && input.httpStatus <= 599) return true
  if (input.httpStatus === 409 && input.confirmedSameIdempotentDelivery === true) return true
  return false
}

export function normalizedFailureCode(input: {
  readonly code?: DeliveryFailureCode | string
  readonly httpStatus?: number
}): DeliveryFailureCode {
  if (input.code === 'timeout' || input.code === 'connection_reset' || input.code === 'malformed_response' || input.code === 'invalid_remote_identity' || input.code === 'policy_violation' || input.code === 'credential_missing' || input.code === 'revoked_target' || input.code === 'content_hash_mismatch' || input.code === 'evidence_hash_mismatch') return input.code
  if (typeof input.httpStatus === 'number') {
    if (input.httpStatus === 400) return 'http_400'
    if (input.httpStatus === 401) return 'http_401'
    if (input.httpStatus === 403) return 'http_403'
    if (input.httpStatus === 404) return 'http_404'
    if (input.httpStatus === 408) return 'http_408'
    if (input.httpStatus === 409) return 'http_409'
    if (input.httpStatus === 429) return 'http_429'
    if (input.httpStatus >= 500 && input.httpStatus <= 599) return 'http_5xx'
  }
  return 'unknown_failure'
}
