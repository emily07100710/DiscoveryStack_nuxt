import type { DiscoveryStackStatus, GeoFlowStatus, ReasonCode, StatusMachine, ValidationFailure, ValidationResult, ValidationSuccess } from './types'

const DISCOVERY_STATES = ['awaiting_generation', 'awaiting_review', 'ready_to_publish', 'publishing', 'delivered', 'blocked', 'failed', 'retry_wait'] as const
const GEOFLOW_STATES = ['queued', 'running', 'draft_ready', 'review_required', 'approved', 'publishing', 'published', 'blocked', 'failed', 'retry_wait'] as const
const TRANSITION_KEYS = ['machine', 'from', 'to', 'explicitRetry'] as const

type TransitionInput = {
  machine: StatusMachine
  from: string
  to: string
  explicitRetry: boolean
}

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function exactKeys(value: Record<string, unknown>): boolean { try { const keys = Object.keys(value); return keys.length === TRANSITION_KEYS.length && keys.every(key => TRANSITION_KEYS.includes(key as typeof TRANSITION_KEYS[number])) } catch { return false } }
function read(value: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false } { try { return { ok: true, value: value[key] } } catch { return { ok: false } } }
function isDiscovery(value: string): value is DiscoveryStackStatus { return DISCOVERY_STATES.includes(value as DiscoveryStackStatus) }
function isGeoFlow(value: string): value is GeoFlowStatus { return GEOFLOW_STATES.includes(value as GeoFlowStatus) }

const DISCOVERY_NEXT: Record<DiscoveryStackStatus, readonly DiscoveryStackStatus[]> = {
  awaiting_generation: ['awaiting_generation', 'awaiting_review', 'blocked', 'failed', 'retry_wait'],
  awaiting_review: ['awaiting_review', 'ready_to_publish', 'blocked', 'failed', 'retry_wait'],
  ready_to_publish: ['ready_to_publish', 'publishing', 'awaiting_review', 'blocked', 'failed'],
  publishing: ['publishing', 'delivered', 'retry_wait', 'failed', 'blocked', 'ready_to_publish'],
  delivered: ['delivered'],
  blocked: ['blocked'],
  failed: ['failed'],
  retry_wait: ['retry_wait', 'awaiting_generation', 'awaiting_review', 'publishing', 'failed', 'blocked'],
}

const GEOFLOW_NEXT: Record<GeoFlowStatus, readonly GeoFlowStatus[]> = {
  queued: ['queued', 'running', 'blocked', 'failed'],
  running: ['running', 'draft_ready', 'review_required', 'publishing', 'blocked', 'failed', 'retry_wait'],
  draft_ready: ['draft_ready', 'review_required', 'approved', 'blocked'],
  review_required: ['review_required', 'approved', 'blocked'],
  approved: ['approved', 'publishing', 'blocked'],
  publishing: ['publishing', 'published', 'retry_wait', 'failed', 'blocked'],
  published: ['published'],
  blocked: ['blocked'],
  failed: ['failed', 'running'],
  retry_wait: ['retry_wait', 'running', 'failed', 'blocked'],
}

export function mapGeoFlowStatusToDiscoveryStack(status: unknown): ValidationResult<DiscoveryStackStatus> {
  if (typeof status !== 'string' || !isGeoFlow(status)) return failure('UNKNOWN_STATE', '$.status')
  const mapped: Record<GeoFlowStatus, DiscoveryStackStatus> = { queued: 'awaiting_generation', running: 'awaiting_generation', draft_ready: 'awaiting_review', review_required: 'awaiting_review', approved: 'ready_to_publish', publishing: 'publishing', published: 'delivered', blocked: 'blocked', failed: 'failed', retry_wait: 'retry_wait' }
  return success(mapped[status])
}

export function mapDiscoveryStackStatusToGeoFlow(status: unknown): ValidationResult<GeoFlowStatus> {
  if (typeof status !== 'string' || !isDiscovery(status)) return failure('UNKNOWN_STATE', '$.status')
  const mapped: Record<DiscoveryStackStatus, GeoFlowStatus> = { awaiting_generation: 'running', awaiting_review: 'review_required', ready_to_publish: 'approved', publishing: 'publishing', delivered: 'published', blocked: 'blocked', failed: 'failed', retry_wait: 'retry_wait' }
  return success(mapped[status])
}

function parseTransition(input: unknown): ValidationResult<TransitionInput> {
  if (!isPlainRecord(input) || !exactKeys(input)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const machine = read(input, 'machine'); const from = read(input, 'from'); const to = read(input, 'to'); const explicitRetry = read(input, 'explicitRetry')
  if (!machine.ok || !from.ok || !to.ok || !explicitRetry.ok || (machine.value !== 'discovery_stack' && machine.value !== 'geoflow') || typeof from.value !== 'string' || typeof to.value !== 'string' || typeof explicitRetry.value !== 'boolean') return failure('INVALID_INPUT')
  return success({ machine: machine.value, from: from.value, to: to.value, explicitRetry: explicitRetry.value })
}

export function verifyStatusTransition(input: unknown): ValidationResult<{ machine: StatusMachine; from: string; to: string }> {
  const parsed = parseTransition(input)
  if (!parsed.ok) return parsed
  const { machine, from, to, explicitRetry } = parsed.value
  const known = machine === 'discovery_stack' ? isDiscovery(from) && isDiscovery(to) : isGeoFlow(from) && isGeoFlow(to)
  if (!known) return failure('UNKNOWN_STATE')
  if (to === 'published' && machine === 'geoflow' && from !== 'publishing') return failure('UNTRUSTED_PUBLISHED_RESULT')
  const allowed = machine === 'discovery_stack' ? DISCOVERY_NEXT[from as DiscoveryStackStatus].includes(to as DiscoveryStackStatus) : GEOFLOW_NEXT[from as GeoFlowStatus].includes(to as GeoFlowStatus)
  if (!allowed) return failure('INVALID_STATUS_TRANSITION')
  if ((from === 'delivered' || from === 'published') && from !== to) return failure('INVALID_STATUS_TRANSITION')
  if (from === 'blocked' && to === 'approved') return failure('INVALID_STATUS_TRANSITION')
  if (from === 'failed' && to === 'running' && !explicitRetry) return failure('INVALID_STATUS_TRANSITION')
  return success({ machine, from, to })
}

export function isKnownGeoFlowStatus(value: unknown): value is GeoFlowStatus { return typeof value === 'string' && isGeoFlow(value) }
export function isKnownDiscoveryStackStatus(value: unknown): value is DiscoveryStackStatus { return typeof value === 'string' && isDiscovery(value) }
