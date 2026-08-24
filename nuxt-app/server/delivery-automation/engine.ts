import { isValidSha256, computeDeliveryIdempotencyKey } from './idempotency'
import {
  ALLOWED_DELIVERY_TRANSITIONS,
  MAX_ATTEMPT_HISTORY,
  MAX_DELIVERY_ATTEMPTS,
  isAllowedDeliveryTransition,
  isRetryableFailure,
  isTerminalDeliveryState,
  normalizedFailureCode,
  retryDelaySeconds,
} from './policy-catalog'
import { validateDeliveryTarget } from './target-guard'
import type {
  ApprovedPublicationInput,
  DeliveryAdapter,
  DeliveryAttemptRecord,
  DeliveryCommandMetadata,
  DeliveryEligibilityResult,
  DeliveryDecisionCode,
  DeliveryFailureClassification,
  DeliveryFailureInput,
  DeliveryFailureHistoryRecord,
  DeliveryPlanInput,
  DeliveryPlanResult,
  DeliveryResultInput,
  DeliveryState,
  DeliveryStateResult,
  DeliveryTargetInput,
  DeliveryTransitionEvent,
  IdempotencyResult,
  PublicationIdentity,
  ValidatedDeliveryTarget,
} from './types'

type BlockedCode = DeliveryDecisionCode
type PlanBlockedCode = Extract<DeliveryPlanResult, { status: 'blocked' }>['code']
type StateBlockedCode = Extract<DeliveryStateResult, { status: 'blocked' }>['code']

const deliveryStates = new Set<DeliveryState>([
  'scheduled',
  'eligible',
  'dispatch_planned',
  'retry_wait',
  'delivered',
  'permanent_failed',
  'blocked',
  'cancelled',
])
const adapters = new Set<DeliveryAdapter>(['wordpress_rest', 'generic_http', 'manual_export'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function read(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function stringValue(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function safeNow(value: unknown): { ok: true; iso: string; milliseconds: number } | { ok: false; code: BlockedCode; reasons: readonly string[] } {
  if (!stringValue(value)) return { ok: false, code: 'INVALID_TIMESTAMP', reasons: ['injected now must be a timestamp string'] }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return { ok: false, code: 'INVALID_TIMESTAMP', reasons: ['injected now must include a timezone'] }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return { ok: false, code: 'INVALID_TIMESTAMP', reasons: ['injected now is invalid'] }
  return { ok: true, iso: new Date(milliseconds).toISOString(), milliseconds }
}

function safeTimestamp(value: unknown): { ok: true; milliseconds: number } | { ok: false; reason: string } {
  if (!stringValue(value)) return { ok: false, reason: 'timestamp must be a non-empty string' }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return { ok: false, reason: 'timestamp must include a timezone' }
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? { ok: true, milliseconds } : { ok: false, reason: 'timestamp is invalid' }
}

function blocked(code: BlockedCode, ...reasons: string[]): DeliveryEligibilityResult {
  return { status: 'blocked', eligible: false, code, reasons }
}

function planBlocked(code: PlanBlockedCode, ...reasons: string[]): DeliveryPlanResult {
  return { status: 'blocked', code, reasons }
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validatePublication(input: unknown): { ok: true; publication: ApprovedPublicationInput } | { ok: false; code: BlockedCode; reasons: readonly string[] } {
  try {
    if (!isRecord(input)) return { ok: false, code: 'INVALID_INPUT', reasons: ['publication must be a plain object'] }
    const fields = {
      ownerScopeKey: read(input, 'ownerScopeKey'),
      scheduleEntryId: read(input, 'scheduleEntryId'),
      productionPlanId: read(input, 'productionPlanId'),
      jobId: read(input, 'jobId'),
      draftId: read(input, 'draftId'),
      draftVersion: read(input, 'draftVersion'),
      draftStage: read(input, 'draftStage'),
      reviewId: read(input, 'reviewId'),
      reviewDecision: read(input, 'reviewDecision'),
      riskGateStatus: read(input, 'riskGateStatus'),
      evidenceSnapshotHash: read(input, 'evidenceSnapshotHash'),
      contentHash: read(input, 'contentHash'),
      contentType: read(input, 'contentType'),
      language: read(input, 'language'),
      contentByteLength: read(input, 'contentByteLength'),
      scheduledAt: read(input, 'scheduledAt'),
      scheduleKey: read(input, 'scheduleKey'),
    }
    const ownerScopeKey = fields.ownerScopeKey
    const scheduleEntryId = fields.scheduleEntryId
    const productionPlanId = fields.productionPlanId
    const jobId = fields.jobId
    const draftId = fields.draftId
    const draftStage = fields.draftStage
    const reviewId = fields.reviewId
    const reviewDecision = fields.reviewDecision
    const riskGateStatus = fields.riskGateStatus
    const contentType = fields.contentType
    const language = fields.language
    const scheduledAt = fields.scheduledAt
    const scheduleKey = fields.scheduleKey
    if (!stringValue(ownerScopeKey) || !stringValue(scheduleEntryId) || !stringValue(productionPlanId) || !stringValue(jobId) || !stringValue(draftId) || !stringValue(draftStage) || !stringValue(reviewId) || !stringValue(reviewDecision) || !stringValue(riskGateStatus) || !stringValue(contentType) || !stringValue(language) || !stringValue(scheduledAt) || !stringValue(scheduleKey)) return { ok: false, code: 'INVALID_INPUT', reasons: ['publication identity and approval fields are required'] }
    if (!isPositiveInteger(fields.draftVersion)) return { ok: false, code: 'INVALID_INPUT', reasons: ['draftVersion must be a positive safe integer'] }
    if (!isFiniteNonNegativeInteger(fields.contentByteLength)) return { ok: false, code: 'INVALID_INPUT', reasons: ['contentByteLength must be a finite non-negative integer'] }
    if (!isValidSha256(fields.evidenceSnapshotHash) || !isValidSha256(fields.contentHash)) return { ok: false, code: 'INVALID_SHA256', reasons: ['publication hashes must be SHA-256'] }
    const scheduled = safeTimestamp(scheduledAt)
    if (!scheduled.ok) return { ok: false, code: 'INVALID_TIMESTAMP', reasons: [scheduled.reason] }
    return { ok: true, publication: {
      ownerScopeKey,
      scheduleEntryId,
      productionPlanId,
      jobId,
      draftId,
      draftVersion: fields.draftVersion,
      draftStage,
      reviewId,
      reviewDecision,
      riskGateStatus,
      evidenceSnapshotHash: fields.evidenceSnapshotHash.toLowerCase(),
      contentHash: fields.contentHash.toLowerCase(),
      contentType,
      language,
      contentByteLength: fields.contentByteLength,
      scheduledAt,
      scheduleKey,
    } }
  } catch {
    return { ok: false, code: 'INVALID_INPUT', reasons: ['publication could not be read'] }
  }
}

function sameAllowed(value: string, allowed: readonly string[]): boolean {
  const normalized = value.toLowerCase()
  return allowed.some((candidate) => candidate.toLowerCase() === normalized)
}

export function evaluateDeliveryEligibility(targetInput: unknown, publicationInput: unknown, nowInput: unknown): DeliveryEligibilityResult {
  try {
    const targetResult = validateDeliveryTarget(targetInput)
    if (targetResult.status === 'blocked') return blocked(targetResult.code ?? 'INVALID_TARGET', ...targetResult.reasons)
    if (!targetResult.target) return blocked('INVALID_TARGET', 'validated target is missing')
    const nowResult = safeNow(nowInput)
    if (!nowResult.ok) return blocked(nowResult.code, ...nowResult.reasons)
    const publicationResult = validatePublication(publicationInput)
    if (!publicationResult.ok) return blocked(publicationResult.code, ...publicationResult.reasons)
    const target = targetResult.target
    const publication = publicationResult.publication
    const scheduled = safeTimestamp(publication.scheduledAt)

    if (target.status !== 'active') return blocked('TARGET_NOT_ACTIVE', 'target is not active')
    if (!target.serverCredentialConfigured) return blocked('CREDENTIAL_NOT_CONFIGURED', 'server credential is not configured')
    if (target.ownerScopeKey !== publication.ownerScopeKey) return blocked('OWNER_SCOPE_MISMATCH', 'owner scope does not match target')
    if (!adapters.has(target.adapter)) return blocked('UNSUPPORTED_ADAPTER', 'adapter is not supported')
    const adapter = target.adapter
    if (adapter === 'manual_export') return blocked('MANUAL_EXPORT_REQUIRES_HUMAN', 'manual export cannot enter autonomous dispatch')
    if (adapter !== 'wordpress_rest' && adapter !== 'generic_http') return blocked('UNSUPPORTED_ADAPTER', 'adapter is not an autonomous adapter')
    if (publication.draftStage !== 'optimized') return blocked('INVALID_INPUT', 'publication draft must be optimized')
    if (publication.reviewDecision !== 'approved_for_delivery') return blocked('INVALID_INPUT', 'publication requires delivery approval')
    if (publication.riskGateStatus !== 'passed') return blocked('INVALID_INPUT', 'publication risk gate must be passed')
    if (!sameAllowed(publication.contentType, target.allowedContentTypes)) return blocked('CONTENT_TYPE_NOT_ALLOWED', 'content type is not allowed by target')
    if (!sameAllowed(publication.language, target.allowedLanguages)) return blocked('LANGUAGE_NOT_ALLOWED', 'language is not allowed by target')
    if (publication.contentByteLength > target.maximumPayloadBytes) return blocked('CONTENT_TOO_LARGE', 'content exceeds target payload limit')
    if (!scheduled.ok) return blocked('INVALID_TIMESTAMP', 'scheduledAt is invalid')
    if (scheduled.milliseconds > nowResult.milliseconds) return blocked('SCHEDULED_IN_FUTURE', 'scheduledAt is later than injected now')
    return {
      status: 'eligible',
      eligible: true,
      code: 'ELIGIBLE',
      reasons: [],
      target,
      publication,
      now: nowResult.iso,
    }
  } catch {
    return blocked('INVALID_INPUT', 'eligibility input could not be evaluated')
  }
}

function validateAttemptHistory(input: unknown, nowMilliseconds: number): { ok: true; attempts: DeliveryAttemptRecord[] } | { ok: false; code: PlanBlockedCode; reasons: readonly string[] } {
  try {
    if (input === undefined) return { ok: true, attempts: [] }
    if (!Array.isArray(input)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history must be an array'] }
    if (input.length > MAX_ATTEMPT_HISTORY) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history exceeds the bounded history limit'] }
    const attempts: DeliveryAttemptRecord[] = []
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index]
      if (!isRecord(item)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains a malformed record'] }
      const attemptNumber = read(item, 'attemptNumber')
      const state = read(item, 'state')
      const occurredAt = read(item, 'occurredAt')
      const idempotencyKey = read(item, 'idempotencyKey')
      const failureCode = read(item, 'failureCode')
      const httpStatus = read(item, 'httpStatus')
      if (!isPositiveInteger(attemptNumber) || attemptNumber !== index + 1 || attemptNumber > MAX_DELIVERY_ATTEMPTS) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history has duplicate or out-of-order numbers'] }
      if (typeof state !== 'string' || !deliveryStates.has(state as DeliveryState)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains an invalid state'] }
      if (!stringValue(occurredAt)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains an invalid timestamp'] }
      const occurred = safeTimestamp(occurredAt)
      if (!occurred.ok || occurred.milliseconds > nowMilliseconds) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains a future or invalid timestamp'] }
      if (!isValidSha256(idempotencyKey)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains an invalid idempotency key'] }
      if (failureCode !== undefined && !stringValue(failureCode, 64)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains an invalid failure code'] }
      if (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains an invalid HTTP status'] }
      const typedHttpStatus = typeof httpStatus === 'number' ? httpStatus : undefined
      attempts.push({ attemptNumber, state: state as DeliveryState, occurredAt, idempotencyKey, ...(failureCode === undefined ? {} : { failureCode: failureCode as DeliveryAttemptRecord['failureCode'] }), ...(typedHttpStatus === undefined ? {} : { httpStatus: typedHttpStatus }) })
    }
    return { ok: true, attempts }
  } catch {
    return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history could not be read'] }
  }
}

function validatePriorDeliveries(input: unknown): { ok: true; records: DeliveryFailureHistoryRecord[] } | { ok: false; code: PlanBlockedCode; reasons: readonly string[] } {
  try {
    if (input === undefined) return { ok: true, records: [] }
    if (!Array.isArray(input) || input.length > MAX_ATTEMPT_HISTORY) return { ok: false, code: 'INVALID_INPUT', reasons: ['prior deliveries must be a bounded array'] }
    const records: DeliveryFailureHistoryRecord[] = []
    for (const item of input) {
      if (!isRecord(item)) return { ok: false, code: 'INVALID_INPUT', reasons: ['prior deliveries contain a malformed record'] }
      const record = {
        idempotencyKey: read(item, 'idempotencyKey'),
        targetId: read(item, 'targetId'),
        ownerScopeKey: read(item, 'ownerScopeKey'),
        draftId: read(item, 'draftId'),
        contentHash: read(item, 'contentHash'),
        reviewId: read(item, 'reviewId'),
        state: read(item, 'state'),
      }
      if (!isValidSha256(record.idempotencyKey) || !stringValue(record.targetId) || !stringValue(record.ownerScopeKey) || !stringValue(record.draftId) || !isValidSha256(record.contentHash) || !stringValue(record.reviewId) || typeof record.state !== 'string' || !deliveryStates.has(record.state as DeliveryState)) return { ok: false, code: 'INVALID_INPUT', reasons: ['prior deliveries contain an invalid identity record'] }
      records.push(record as DeliveryFailureHistoryRecord)
    }
    return { ok: true, records }
  } catch {
    return { ok: false, code: 'INVALID_INPUT', reasons: ['prior deliveries could not be read'] }
  }
}

function hasIdentityDifference(record: DeliveryFailureHistoryRecord, target: ValidatedDeliveryTarget, publication: ApprovedPublicationInput): boolean {
  return record.targetId !== target.targetId || record.ownerScopeKey !== publication.ownerScopeKey || record.draftId !== publication.draftId || record.contentHash.toLowerCase() !== publication.contentHash.toLowerCase() || record.reviewId !== publication.reviewId
}

function publicationIdentity(target: ValidatedDeliveryTarget, publication: ApprovedPublicationInput): PublicationIdentity {
  return {
    ownerScopeKey: publication.ownerScopeKey,
    scheduleEntryId: publication.scheduleEntryId,
    productionPlanId: publication.productionPlanId,
    jobId: publication.jobId,
    draftId: publication.draftId,
    draftVersion: publication.draftVersion,
    reviewId: publication.reviewId,
    scheduleKey: publication.scheduleKey,
  }
}

export function planDeliveryAttempt(input: unknown): DeliveryPlanResult {
  try {
    if (!isRecord(input)) return planBlocked('INVALID_INPUT', 'delivery plan input must be a plain object')
    const targetInput = read(input, 'target')
    const publicationInput = read(input, 'publication')
    const nowInput = read(input, 'now')
    const eligibility = evaluateDeliveryEligibility(targetInput, publicationInput, nowInput)
    if (eligibility.status === 'blocked') return planBlocked(eligibility.code, ...eligibility.reasons)
    if (!eligibility.target || !eligibility.publication || !eligibility.now) return planBlocked('INVALID_INPUT', 'eligible result is incomplete')
    const adapter = eligibility.target.adapter
    if (adapter !== 'wordpress_rest' && adapter !== 'generic_http') return planBlocked('UNSUPPORTED_ADAPTER', 'adapter is not an autonomous adapter')
    const attemptHistory = validateAttemptHistory(read(input, 'attempts'), Date.parse(eligibility.now))
    if (!attemptHistory.ok) return planBlocked(attemptHistory.code, ...attemptHistory.reasons)
    if (attemptHistory.attempts.some((attempt) => isTerminalDeliveryState(attempt.state))) return planBlocked('TERMINAL_STATE', 'delivery history is terminal')
    if (attemptHistory.attempts.length >= MAX_DELIVERY_ATTEMPTS) return planBlocked('ATTEMPT_CAP_REACHED', 'maximum delivery attempts reached')
    const priorDeliveries = validatePriorDeliveries(read(input, 'priorDeliveries'))
    if (!priorDeliveries.ok) return planBlocked(priorDeliveries.code, ...priorDeliveries.reasons)
    const identityInput = {
      ownerScopeKey: eligibility.publication.ownerScopeKey,
      targetId: eligibility.target.targetId,
      adapter,
      scheduleEntryId: eligibility.publication.scheduleEntryId,
      scheduleKey: eligibility.publication.scheduleKey,
      jobId: eligibility.publication.jobId,
      draftId: eligibility.publication.draftId,
      draftVersion: eligibility.publication.draftVersion,
      reviewId: eligibility.publication.reviewId,
      evidenceSnapshotHash: eligibility.publication.evidenceSnapshotHash,
      contentHash: eligibility.publication.contentHash,
    }
    const idempotency = computeDeliveryIdempotencyKey(identityInput)
    if (idempotency.status === 'blocked') return planBlocked(idempotency.code, ...idempotency.reasons)
    for (const record of priorDeliveries.records) {
      if (record.idempotencyKey !== idempotency.key) continue
      if (hasIdentityDifference(record, eligibility.target, eligibility.publication)) return planBlocked('IDEMPOTENCY_COLLISION', 'idempotency key maps to a different publication identity')
      return planBlocked('DUPLICATE_PUBLICATION', 'publication already has a delivery record')
    }
    const command: DeliveryCommandMetadata = {
      commandVersion: 'delivery-command-v1',
      targetId: eligibility.target.targetId,
      adapter,
      targetOrigin: eligibility.target.normalizedOrigin,
      endpointPath: eligibility.target.normalizedEndpointPath,
      publicationIdentity: publicationIdentity(eligibility.target, eligibility.publication),
      contentHash: eligibility.publication.contentHash,
      evidenceSnapshotHash: eligibility.publication.evidenceSnapshotHash,
      idempotencyKey: idempotency.key,
      attemptNumber: attemptHistory.attempts.length + 1,
      eligibleAt: eligibility.now,
      timeoutClass: 'standard',
      limitations: ['metadata_only', 'not_delivered', 'executor_must_revalidate'],
    }
    return { status: 'dispatch_planned', command }
  } catch {
    return planBlocked('INVALID_INPUT', 'delivery plan input could not be evaluated')
  }
}

function invalidFailure(): DeliveryFailureClassification {
  return { status: 'blocked', code: 'INVALID_INPUT', retryable: false, nextState: 'blocked', delaySeconds: 0, reason: 'failure input is invalid' }
}

export function classifyDeliveryFailure(input: unknown): DeliveryFailureClassification {
  try {
    if (!isRecord(input)) return invalidFailure()
    const attemptNumber = read(input, 'attemptNumber')
    const code = read(input, 'code')
    const httpStatus = read(input, 'httpStatus')
    const retryAfterSeconds = read(input, 'retryAfterSeconds')
    const confirmedSameIdempotentDelivery = read(input, 'confirmedSameIdempotentDelivery')
    if (!isPositiveInteger(attemptNumber) || attemptNumber > MAX_DELIVERY_ATTEMPTS) return invalidFailure()
    if (code !== undefined && !stringValue(code, 64)) return invalidFailure()
    if (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) return invalidFailure()
    if (retryAfterSeconds !== undefined && (typeof retryAfterSeconds !== 'number' || !Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 86400)) return invalidFailure()
    if (confirmedSameIdempotentDelivery !== undefined && typeof confirmedSameIdempotentDelivery !== 'boolean') return invalidFailure()
    const typedHttpStatus = typeof httpStatus === 'number' ? httpStatus : undefined
    const typedRetryAfterSeconds = typeof retryAfterSeconds === 'number' ? retryAfterSeconds : undefined
    const failure = { code: code as DeliveryFailureInput['code'], httpStatus: typedHttpStatus, confirmedSameIdempotentDelivery: confirmedSameIdempotentDelivery as boolean | undefined }
    const normalized = normalizedFailureCode(failure)
    const isConfigurationBlocked = normalized === 'http_401' || normalized === 'http_403' || normalized === 'credential_missing' || normalized === 'revoked_target' || normalized === 'policy_violation' || normalized === 'invalid_remote_identity' || normalized === 'content_hash_mismatch' || normalized === 'evidence_hash_mismatch'
    if (isConfigurationBlocked) return { status: 'classified', code: normalized, retryable: false, nextState: 'blocked', delaySeconds: 0, reason: 'configuration_blocked' }
    const retryable = isRetryableFailure(failure)
    if (!retryable || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return { status: 'classified', code: normalized, retryable: false, nextState: 'permanent_failed', delaySeconds: 0, reason: 'permanent_failure' }
    const policyDelay = retryDelaySeconds(attemptNumber)
    const remoteDelay = normalized === 'http_429' && typedRetryAfterSeconds !== undefined ? typedRetryAfterSeconds : 0
    return { status: 'classified', code: normalized, retryable: true, nextState: 'retry_wait', delaySeconds: Math.max(policyDelay, remoteDelay), reason: 'temporary_failure_retry_wait' }
  } catch {
    return invalidFailure()
  }
}

function validState(value: unknown): value is DeliveryState {
  return typeof value === 'string' && deliveryStates.has(value as DeliveryState)
}

function blockedState(code: StateBlockedCode, previousState?: DeliveryState, ...reasons: string[]): DeliveryStateResult {
  return { status: 'blocked', state: 'blocked', ...(previousState === undefined ? {} : { previousState }), code, reasons }
}

function validateRemoteUrl(remoteUrl: string, targetOrigin: string): boolean {
  try {
    const parsed = new URL(remoteUrl)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return false
    const targetCheck = validateDeliveryTarget({
      targetId: 'remote-result-validation',
      ownerScopeKey: 'remote-result-validation',
      adapter: 'generic_http',
      targetOrigin: parsed.origin,
      endpointPath: '/',
      status: 'active',
      serverCredentialConfigured: true,
      allowedContentTypes: ['text/plain'],
      allowedLanguages: ['en'],
      maximumPayloadBytes: 1,
      policyVersion: 'delivery-policy-v1',
    })
    return targetCheck.status === 'valid' && targetCheck.target?.normalizedOrigin === targetOrigin
  } catch {
    return false
  }
}

function validateSuccessResult(result: unknown, expectedKey: unknown, targetOrigin: unknown): { ok: true; result: DeliveryResultInput } | { ok: false; code: StateBlockedCode; reason: string } {
  try {
    if (!isRecord(result) || !isValidSha256(expectedKey) || !stringValue(targetOrigin)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'success result identity is invalid' }
    const idempotencyKey = read(result, 'idempotencyKey')
    const remoteContentId = read(result, 'remoteContentId')
    const publishedAt = read(result, 'publishedAt')
    const remoteUrl = read(result, 'remoteUrl')
    const noPublicUrl = read(result, 'noPublicUrl')
    const responseFingerprint = read(result, 'responseFingerprint')
    if (idempotencyKey !== expectedKey) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'idempotency key does not match' }
    if (!stringValue(remoteContentId, 512)) return { ok: false, code: 'HTTP_SUCCESS_MISSING_REMOTE_ID', reason: 'successful result lacks remote content identity' }
    if (!stringValue(publishedAt)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'publishedAt is required' }
    const published = safeTimestamp(publishedAt)
    if (!published.ok) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'publishedAt is invalid' }
    if (typeof noPublicUrl !== 'boolean') return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'noPublicUrl must be boolean' }
    if (!noPublicUrl && !stringValue(remoteUrl)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'remoteUrl or noPublicUrl is required' }
    if (remoteUrl !== undefined && (!stringValue(remoteUrl) || !validateRemoteUrl(remoteUrl, targetOrigin))) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'remoteUrl is not an allowed HTTPS identity' }
    if (!stringValue(responseFingerprint, 512)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'responseFingerprint is required' }
    return { ok: true, result: { idempotencyKey, remoteContentId, publishedAt, ...(remoteUrl === undefined ? {} : { remoteUrl }), noPublicUrl, responseFingerprint } }
  } catch {
    return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'success result could not be read' }
  }
}

export function reduceDeliveryAttemptState(currentState: unknown, eventInput: unknown): DeliveryStateResult {
  try {
    if (!validState(currentState)) return blockedState('INVALID_INPUT', undefined, 'current state is invalid')
    const state = currentState
    if (!isRecord(eventInput)) return blockedState('INVALID_INPUT', state, 'transition event must be a plain object')
    const event = eventInput as Record<string, unknown>
    const eventType = read(event, 'type')
    if (state === 'delivered' && eventType === 'success') {
      const success = validateSuccessResult(read(event, 'result'), read(event, 'expectedIdempotencyKey'), read(event, 'targetOrigin'))
      if (!success.ok) return blockedState(success.code, state, success.reason)
      const priorRemoteContentId = read(event, 'priorRemoteContentId')
      if (priorRemoteContentId !== success.result.remoteContentId) return blockedState('REMOTE_IDENTITY_COLLISION', state, 'remote content identity differs for the same idempotency key')
      return {
        status: 'ok',
        state: 'delivered',
        previousState: 'delivered',
        transition: 'delivered->delivered',
        remoteContentId: success.result.remoteContentId,
      }
    }
    if (isTerminalDeliveryState(state)) return blockedState('TERMINAL_STATE', state, 'terminal state cannot transition')
    const type = read(event, 'type')
    if (typeof type !== 'string') return blockedState('INVALID_INPUT', state, 'transition event type is required')
    let nextState: DeliveryState | undefined
    let classification: DeliveryFailureClassification | undefined
    let remoteContentId: string | undefined
    if (type === 'mark_eligible') nextState = 'eligible'
    else if (type === 'plan_dispatch' || type === 'retry_due') nextState = 'dispatch_planned'
    else if (type === 'block') nextState = 'blocked'
    else if (type === 'cancel') nextState = 'cancelled'
    else if (type === 'failure') {
      const failure = read(event, 'failure')
      classification = classifyDeliveryFailure(failure)
      if (classification.status === 'blocked') return blockedState('INVALID_INPUT', state, classification.reason)
      nextState = classification.nextState
    } else if (type === 'success') {
      const success = validateSuccessResult(read(event, 'result'), read(event, 'expectedIdempotencyKey'), read(event, 'targetOrigin'))
      if (!success.ok) return blockedState(success.code, state, success.reason)
      const priorRemoteContentId = read(event, 'priorRemoteContentId')
      if (priorRemoteContentId !== undefined && (!stringValue(priorRemoteContentId) || priorRemoteContentId !== success.result.remoteContentId)) return blockedState('REMOTE_IDENTITY_COLLISION', state, 'remote content identity differs for the same idempotency key')
      remoteContentId = success.result.remoteContentId
      nextState = 'delivered'
    } else return blockedState('INVALID_INPUT', state, 'transition event type is invalid')
    if (!nextState || !isAllowedDeliveryTransition(state, nextState)) return blockedState('INVALID_STATE_TRANSITION', state, `transition from ${state} is not allowed`)
    return {
      status: 'ok',
      state: nextState,
      previousState: state,
      transition: `${state}->${nextState}` as `${DeliveryState}->${DeliveryState}`,
      ...(classification === undefined ? {} : { classification }),
      ...(remoteContentId === undefined ? {} : { remoteContentId }),
    }
  } catch {
    return blockedState('INVALID_INPUT', undefined, 'transition could not be evaluated')
  }
}

export { ALLOWED_DELIVERY_TRANSITIONS }
export type { DeliveryPlanInput, DeliveryTargetInput }
