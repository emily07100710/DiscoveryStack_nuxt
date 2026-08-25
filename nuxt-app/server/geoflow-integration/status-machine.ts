import { createHash } from 'node:crypto'
import type { AcceptedStatusEvent, DiscoveryStackStatus, GeoFlowRequest, GeoFlowResponse, GeoFlowStatus, ReasonCode, StatusMachine, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { canonicalizeContractValue } from './fingerprint'
import { validateGeoFlowRequest, validateGeoFlowResponse, responseFingerprint } from './schemas'
import { verifyGeoFlowLineage } from './lineage'

const DISCOVERY_STATES = ['awaiting_generation', 'awaiting_review', 'ready_to_publish', 'publishing', 'delivered', 'blocked', 'failed', 'retry_wait'] as const
const GEOFLOW_STATES = ['queued', 'running', 'draft_ready', 'review_required', 'blocked', 'failed', 'retry_wait'] as const
const TRANSITION_KEYS = ['machine', 'from', 'to', 'explicitRetry'] as const
const EVENT_KEYS = ['previousResponse', 'request', 'response', 'explicitRetry'] as const
const RESPONSE_IDENTITY_KEYS = ['externalProjectKey', 'externalTaskKey', 'externalJobKey', 'externalArticleKey'] as const

type TransitionInput = { machine: StatusMachine; from: string; to: string; explicitRetry: boolean }
type CandidateResponse = Extract<GeoFlowResponse, { status: 'draft_ready' | 'review_required' }>

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
function responseEventTime(response: GeoFlowResponse): string { return 'observedAt' in response ? response.observedAt : response.completedAt }
function sameExternalIdentity(previous: GeoFlowResponse, current: GeoFlowResponse): boolean { return RESPONSE_IDENTITY_KEYS.every(key => previous[key] === current[key]) }
function isCandidate(response: GeoFlowResponse): response is CandidateResponse { return response.status === 'draft_ready' || response.status === 'review_required' }
function candidateLineageFingerprint(response: CandidateResponse): ValidationResult<string> {
  const canonical = canonicalizeContractValue({
    draftIdentity: response.draftIdentity,
    contentArtifact: response.contentArtifact,
    evidenceSnapshotHash: response.evidenceSnapshotHash,
    citationBindings: response.citationBindings,
    appliedRuleIds: response.appliedRuleIds,
    providerProvenance: response.providerProvenance,
    limitations: response.limitations,
    requestFingerprint: response.requestFingerprint,
    externalArticleKey: response.externalArticleKey,
  })
  if (!canonical.ok) return canonical
  return success(createHash('sha256').update(Buffer.from(canonical.value, 'utf8')).digest('hex'))
}
function retryTransition(machine: StatusMachine, from: string, to: string): boolean {
  if (machine === 'geoflow') return (from === 'retry_wait' && (to === 'queued' || to === 'running')) || (from === 'failed' && to === 'queued')
  return (from === 'retry_wait' && to === 'awaiting_generation') || (from === 'failed' && to === 'awaiting_generation')
}

const DISCOVERY_NEXT: Record<DiscoveryStackStatus, readonly DiscoveryStackStatus[]> = {
  awaiting_generation: ['awaiting_generation', 'awaiting_review', 'blocked', 'failed', 'retry_wait'],
  awaiting_review: ['awaiting_review', 'ready_to_publish', 'blocked', 'failed', 'retry_wait'],
  ready_to_publish: ['ready_to_publish', 'publishing', 'awaiting_review', 'blocked', 'failed'],
  publishing: ['publishing', 'delivered', 'retry_wait', 'failed', 'blocked', 'ready_to_publish'],
  delivered: ['delivered'],
  blocked: ['blocked'],
  failed: ['failed', 'awaiting_generation'],
  retry_wait: ['retry_wait', 'awaiting_generation', 'failed', 'blocked'],
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
  if (machine === 'discovery_stack' && from === 'delivered' && to !== 'delivered') return failure('INVALID_STATUS_TRANSITION')
  if (from === 'blocked' && to !== 'blocked') return failure('INVALID_STATUS_TRANSITION')
  if (machine === 'discovery_stack' && from === 'failed' && to !== 'awaiting_generation') return failure('INVALID_STATUS_TRANSITION')
  if (machine === 'geoflow' && from === 'failed' && to !== 'queued') return failure('INVALID_STATUS_TRANSITION')
  if (explicitRetry && !retryTransition(machine, from, to)) return failure('INVALID_STATUS_TRANSITION')
  if (retryTransition(machine, from, to) && !explicitRetry) return failure('INVALID_STATUS_TRANSITION')
  return success({ machine, from, to })
}

function parseStatusEvent(input: unknown): ValidationResult<{ previousResponse: unknown; request: unknown; response: unknown; explicitRetry: boolean }> {
  if (!isPlainRecord(input) || !exactKeys(input, EVENT_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const previousResponse = safeRead(input, 'previousResponse'); const request = safeRead(input, 'request'); const response = safeRead(input, 'response'); const explicitRetry = safeRead(input, 'explicitRetry')
  if (!previousResponse.ok || !request.ok || !response.ok || !explicitRetry.ok || typeof explicitRetry.value !== 'boolean') return failure('INVALID_INPUT')
  return success({ previousResponse: previousResponse.value, request: request.value, response: response.value, explicitRetry: explicitRetry.value })
}

export function validateGeoFlowStatusEventForStoredState(input: unknown): ValidationResult<AcceptedStatusEvent> {
  const parsed = parseStatusEvent(input); if (!parsed.ok) return parsed
  const request = validateGeoFlowRequest(parsed.value.request); if (!request.ok) return request
  const current = validateGeoFlowResponse(parsed.value.response, request.value); if (!current.ok) return current
  const currentLineage = verifyGeoFlowLineage(request.value, current.value); if (!currentLineage.ok) return currentLineage
  if (parsed.value.previousResponse === null) {
    if (current.value.status !== 'queued') return failure('INVALID_STATUS_TRANSITION', '$.previousResponse')
    if (current.value.attempt !== 1 || parsed.value.explicitRetry) return failure('RETRY_ATTEMPT_INVALID', '$.response.attempt')
    return success({ previousResponse: null, request: request.value, response: current.value })
  }
  const previous = validateGeoFlowResponse(parsed.value.previousResponse, request.value); if (!previous.ok) return previous
  const previousLineage = verifyGeoFlowLineage(request.value, previous.value); if (!previousLineage.ok) return previousLineage
  if (!sameExternalIdentity(previous.value, current.value)) return failure('IDENTITY_MISMATCH', '$.response')
  const previousTime = Date.parse(responseEventTime(previous.value)); const currentTime = Date.parse(responseEventTime(current.value))
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime < previousTime) return failure('RESPONSE_TIME_INVALID', '$.response')
  if (currentTime === previousTime) {
    const previousFingerprint = responseFingerprint(previous.value); if (!previousFingerprint.ok) return previousFingerprint
    const currentFingerprint = responseFingerprint(current.value); if (!currentFingerprint.ok) return currentFingerprint
    if (previousFingerprint.value !== currentFingerprint.value) return failure('RESPONSE_TIME_INVALID', '$.response')
  }
  const from = previous.value.status; const to = current.value.status
  const transition = verifyStatusTransition({ machine: 'geoflow', from, to, explicitRetry: parsed.value.explicitRetry })
  if (!transition.ok) return transition
  if (retryTransition('geoflow', from, to)) {
    if (previous.value.attempt >= 10 || current.value.attempt !== previous.value.attempt + 1) return failure('RETRY_ATTEMPT_INVALID', '$.response.attempt')
    if (from === 'failed' && (previous.value.status !== 'failed' || !previous.value.failure.retryable)) return failure('RETRY_ATTEMPT_INVALID', '$.previousResponse.failure.retryable')
  } else {
    if (parsed.value.explicitRetry || current.value.attempt !== previous.value.attempt) return failure('RETRY_ATTEMPT_INVALID', '$.response.attempt')
  }
  if (isCandidate(previous.value) && isCandidate(current.value)) {
    const previousCandidate = candidateLineageFingerprint(previous.value); if (!previousCandidate.ok) return previousCandidate
    const currentCandidate = candidateLineageFingerprint(current.value); if (!currentCandidate.ok) return currentCandidate
    if (previousCandidate.value !== currentCandidate.value) return failure('CANDIDATE_LINEAGE_MISMATCH', '$.response')
  }
  return success({ previousResponse: previous.value, request: request.value, response: current.value })
}

export function isKnownGeoFlowStatus(value: unknown): value is GeoFlowStatus { return typeof value === 'string' && isGeoFlow(value) }
export function isKnownDiscoveryStackStatus(value: unknown): value is DiscoveryStackStatus { return typeof value === 'string' && isDiscovery(value) }
export type { GeoFlowRequest, GeoFlowResponse }
