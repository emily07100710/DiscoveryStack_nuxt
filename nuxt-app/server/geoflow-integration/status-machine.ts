import type { AcceptedStatusEvent, DiscoveryStackStatus, GeoFlowRequest, GeoFlowResponse, GeoFlowStatus, ReasonCode, StatusMachine, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { validateGeoFlowRequest, validateGeoFlowResponse } from './schemas'
import { verifyGeoFlowLineage } from './lineage'

const DISCOVERY_STATES = ['awaiting_generation', 'awaiting_review', 'ready_to_publish', 'publishing', 'delivered', 'blocked', 'failed', 'retry_wait'] as const
const GEOFLOW_STATES = ['queued', 'running', 'draft_ready', 'review_required', 'blocked', 'failed', 'retry_wait'] as const
const TRANSITION_KEYS = ['machine', 'from', 'to', 'explicitRetry'] as const
const EVENT_KEYS = ['previousStatus', 'request', 'response', 'explicitRetry'] as const

type TransitionInput = { machine: StatusMachine; from: string; to: string; explicitRetry: boolean }

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { try { const keys = Object.keys(value); return keys.length === expected.length && keys.every(key => expected.includes(key)) } catch { return false } }
function safeRead(value: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false } { try { return { ok: true, value: value[key] } } catch { return { ok: false } } }
function isDiscovery(value: string): value is DiscoveryStackStatus { return DISCOVERY_STATES.includes(value as DiscoveryStackStatus) }
function isGeoFlow(value: string): value is GeoFlowStatus { return GEOFLOW_STATES.includes(value as GeoFlowStatus) }

const DISCOVERY_NEXT: Record<DiscoveryStackStatus, readonly DiscoveryStackStatus[]> = {
  awaiting_generation: ['awaiting_generation', 'awaiting_review', 'blocked', 'failed', 'retry_wait'],
  awaiting_review: ['awaiting_review', 'ready_to_publish', 'blocked', 'failed', 'retry_wait'],
  ready_to_publish: ['ready_to_publish', 'publishing', 'awaiting_review', 'blocked', 'failed'],
  publishing: ['publishing', 'delivered', 'retry_wait', 'failed', 'blocked', 'ready_to_publish'],
  delivered: ['delivered'],
  blocked: ['blocked'],
  failed: ['failed', 'awaiting_generation'],
  retry_wait: ['retry_wait', 'awaiting_generation', 'awaiting_review', 'failed', 'blocked'],
}
const GEOFLOW_NEXT: Record<GeoFlowStatus, readonly GeoFlowStatus[]> = {
  queued: ['queued', 'running', 'blocked', 'failed', 'retry_wait'],
  running: ['running', 'draft_ready', 'review_required', 'blocked', 'failed', 'retry_wait'],
  draft_ready: ['draft_ready', 'review_required'],
  review_required: ['review_required', 'blocked', 'failed'],
  blocked: ['blocked'],
  failed: ['failed', 'queued'],
  retry_wait: ['retry_wait', 'queued', 'running', 'blocked', 'failed'],
}

export function mapGeoFlowStatusToDiscoveryStack(status: unknown): ValidationResult<DiscoveryStackStatus> {
  if (status === 'approved' || status === 'publishing' || status === 'published') return failure('UNTRUSTED_DELIVERY_STATE', '$.status')
  if (typeof status !== 'string' || !isGeoFlow(status)) return failure('UNKNOWN_STATE', '$.status')
  const mapped: Record<GeoFlowStatus, DiscoveryStackStatus> = { queued: 'awaiting_generation', running: 'awaiting_generation', draft_ready: 'awaiting_review', review_required: 'awaiting_review', blocked: 'blocked', failed: 'failed', retry_wait: 'retry_wait' }
  return success(mapped[status])
}

export function mapDiscoveryStackStatusToGeoFlow(status: unknown): ValidationResult<GeoFlowStatus> {
  if (status === 'ready_to_publish' || status === 'publishing' || status === 'delivered') return failure('UNTRUSTED_DELIVERY_STATE', '$.status')
  if (typeof status !== 'string' || !isDiscovery(status)) return failure('UNKNOWN_STATE', '$.status')
  const mapped: Record<'awaiting_generation' | 'awaiting_review' | 'blocked' | 'failed' | 'retry_wait', GeoFlowStatus> = { awaiting_generation: 'running', awaiting_review: 'review_required', blocked: 'blocked', failed: 'failed', retry_wait: 'retry_wait' }
  return success(mapped[status as keyof typeof mapped])
}

function parseTransition(input: unknown): ValidationResult<TransitionInput> {
  if (!isPlainRecord(input) || !exactKeys(input, TRANSITION_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const machine = safeRead(input, 'machine'); const from = safeRead(input, 'from'); const to = safeRead(input, 'to'); const explicitRetry = safeRead(input, 'explicitRetry')
  if (!machine.ok || !from.ok || !to.ok || !explicitRetry.ok || (machine.value !== 'discovery_stack' && machine.value !== 'geoflow') || typeof from.value !== 'string' || typeof to.value !== 'string' || typeof explicitRetry.value !== 'boolean') return failure('INVALID_INPUT')
  return success({ machine: machine.value, from: from.value, to: to.value, explicitRetry: explicitRetry.value })
}

export function verifyStatusTransition(input: unknown): ValidationResult<{ machine: StatusMachine; from: string; to: string }> {
  const parsed = parseTransition(input); if (!parsed.ok) return parsed
  const { machine, from, to, explicitRetry } = parsed.value
  if (machine === 'geoflow' && (to === 'approved' || to === 'publishing' || to === 'published' || from === 'approved' || from === 'publishing' || from === 'published')) return failure('UNTRUSTED_DELIVERY_STATE')
  const known = machine === 'discovery_stack' ? isDiscovery(from) && isDiscovery(to) : isGeoFlow(from) && isGeoFlow(to)
  if (!known) return failure('UNKNOWN_STATE')
  const allowed = machine === 'discovery_stack' ? DISCOVERY_NEXT[from as DiscoveryStackStatus].includes(to as DiscoveryStackStatus) : GEOFLOW_NEXT[from as GeoFlowStatus].includes(to as GeoFlowStatus)
  if (!allowed) return failure('INVALID_STATUS_TRANSITION')
  if (machine === 'discovery_stack' && (from === 'delivered' && to !== 'delivered')) return failure('INVALID_STATUS_TRANSITION')
  if (from === 'blocked' && to !== 'blocked') return failure('INVALID_STATUS_TRANSITION')
  if (from === 'failed' && to !== 'queued') return failure('INVALID_STATUS_TRANSITION')
  if ((from === 'failed' || from === 'retry_wait') && to !== from && !explicitRetry) return failure('INVALID_STATUS_TRANSITION')
  return success({ machine, from, to })
}

function parseStatusEvent(input: unknown): ValidationResult<{ previousStatus: unknown; request: unknown; response: unknown; explicitRetry: boolean }> {
  if (!isPlainRecord(input) || !exactKeys(input, EVENT_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const previousStatus = safeRead(input, 'previousStatus'); const request = safeRead(input, 'request'); const response = safeRead(input, 'response'); const explicitRetry = safeRead(input, 'explicitRetry')
  if (!previousStatus.ok || !request.ok || !response.ok || !explicitRetry.ok || typeof explicitRetry.value !== 'boolean') return failure('INVALID_INPUT')
  return success({ previousStatus: previousStatus.value, request: request.value, response: response.value, explicitRetry: explicitRetry.value })
}

export function validateGeoFlowStatusEventForStoredState(input: unknown): ValidationResult<AcceptedStatusEvent> {
  const parsed = parseStatusEvent(input); if (!parsed.ok) return parsed
  const request = validateGeoFlowRequest(parsed.value.request); if (!request.ok) return request
  const response = validateGeoFlowResponse(parsed.value.response, request.value); if (!response.ok) return response
  const lineage = verifyGeoFlowLineage(request.value, response.value); if (!lineage.ok) return lineage
  if (parsed.value.previousStatus === null) {
    return response.value.status === 'queued' ? success({ previousStatus: null, request: request.value, response: response.value }) : failure('INVALID_STATUS_TRANSITION', '$.previousStatus')
  }
  if (typeof parsed.value.previousStatus !== 'string' || !isGeoFlow(parsed.value.previousStatus)) return failure('UNKNOWN_STATE', '$.previousStatus')
  const transition = verifyStatusTransition({ machine: 'geoflow', from: parsed.value.previousStatus, to: response.value.status, explicitRetry: parsed.value.explicitRetry })
  if (!transition.ok) return transition
  return success({ previousStatus: parsed.value.previousStatus, request: request.value, response: response.value })
}

export function isKnownGeoFlowStatus(value: unknown): value is GeoFlowStatus { return typeof value === 'string' && isGeoFlow(value) }
export function isKnownDiscoveryStackStatus(value: unknown): value is DiscoveryStackStatus { return typeof value === 'string' && isDiscovery(value) }
export type { GeoFlowRequest, GeoFlowResponse }
