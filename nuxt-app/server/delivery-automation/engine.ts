import { createHash } from 'node:crypto'
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
import { computeDeliveryIdempotencyKey, isOpaqueIdentifier, isValidSha256 } from './idempotency'
import { validateDeliveryTarget } from './target-guard'
import type {
  ApprovedPublicationInput,
  DeliveryAdapter,
  DeliveryAttemptRecord,
  DeliveryCommandMetadata,
  DeliveryDecisionCode,
  DeliveryEligibilityResult,
  DeliveryFailureClassification,
  DeliveryFailureHistoryRecord,
  DeliveryFailureInput,
  DeliveryPlanInput,
  DeliveryPlanResult,
  DeliveryResultFingerprintResult,
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
type PlanBlockedCode = DeliveryDecisionCode
type StateBlockedCode = DeliveryDecisionCode

type TimestampResult = { ok: true; iso: string; milliseconds: number } | { ok: false; reason: string }
type ValidatedSuccess = { result: DeliveryResultInput; targetOrigin: string; deliveryResultFingerprint: string }

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
const failureCodes = new Set<string>([
  'timeout',
  'connection_reset',
  'http_400',
  'http_401',
  'http_403',
  'http_404',
  'http_408',
  'http_409',
  'http_429',
  'http_5xx',
  'malformed_response',
  'invalid_remote_identity',
  'policy_violation',
  'credential_missing',
  'revoked_target',
  'content_hash_mismatch',
  'evidence_hash_mismatch',
  'unknown_failure',
])

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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeTimestamp(value: unknown): TimestampResult {
  if (!stringValue(value)) return { ok: false, reason: 'timestamp must be a non-empty string' }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return { ok: false, reason: 'timestamp must be a strict timezone-bearing ISO value' }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const zone = match[8]
  if (zone === undefined) return { ok: false, reason: 'timestamp timezone is missing' }
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const maximumDay = monthDays[month - 1]
  if (month < 1 || month > 12 || maximumDay === undefined || day < 1 || day > maximumDay) return { ok: false, reason: 'timestamp calendar date is invalid' }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'timestamp clock components are invalid' }
  if (zone !== 'Z' && (zoneHour > 23 || zoneMinute > 59)) return { ok: false, reason: 'timestamp timezone offset is invalid' }
  const fraction = match[7] ?? ''
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || fraction.length > 9) return { ok: false, reason: 'timestamp is invalid' }
  return { ok: true, iso: new Date(milliseconds).toISOString(), milliseconds }
}

function safeNow(value: unknown): { ok: true; iso: string; milliseconds: number } | { ok: false; code: BlockedCode; reasons: readonly string[] } {
  const timestamp = safeTimestamp(value)
  return timestamp.ok ? timestamp : { ok: false, code: 'INVALID_TIMESTAMP', reasons: [timestamp.reason] }
}

function isCanonicalSha256(value: unknown): value is string {
  return isValidSha256(value)
}

function blocked(code: BlockedCode, ...reasons: string[]): DeliveryEligibilityResult {
  return { status: 'blocked', eligible: false, code, reasons }
}

function planBlocked(code: PlanBlockedCode, ...reasons: string[]): DeliveryPlanResult {
  return { status: 'blocked', code, reasons }
}

function blockedState(code: StateBlockedCode, previousState?: DeliveryState, ...reasons: string[]): DeliveryStateResult {
  return { status: 'blocked', state: 'blocked', ...(previousState === undefined ? {} : { previousState }), code, reasons }
}

function validateOpaque(value: unknown, maximum = 128): value is string {
  return isOpaqueIdentifier(value, maximum)
}

function validatePublication(input: unknown): { ok: true; publication: ApprovedPublicationInput } | { ok: false; code: BlockedCode; reasons: readonly string[] } {
  try {
    if (!isRecord(input)) return { ok: false, code: 'INVALID_INPUT', reasons: ['publication must be a plain object'] }
    const ownerScopeKey = read(input, 'ownerScopeKey')
    const scheduleEntryId = read(input, 'scheduleEntryId')
    const productionPlanId = read(input, 'productionPlanId')
    const jobId = read(input, 'jobId')
    const draftId = read(input, 'draftId')
    const draftVersion = read(input, 'draftVersion')
    const draftStage = read(input, 'draftStage')
    const reviewId = read(input, 'reviewId')
    const reviewDecision = read(input, 'reviewDecision')
    const riskGateStatus = read(input, 'riskGateStatus')
    const evidenceSnapshotHash = read(input, 'evidenceSnapshotHash')
    const contentHash = read(input, 'contentHash')
    const contentType = read(input, 'contentType')
    const language = read(input, 'language')
    const contentByteLength = read(input, 'contentByteLength')
    const scheduledAt = read(input, 'scheduledAt')
    const scheduleKey = read(input, 'scheduleKey')

    if (!validateOpaque(ownerScopeKey) || !validateOpaque(scheduleEntryId) || !validateOpaque(productionPlanId) || !validateOpaque(jobId) || !validateOpaque(draftId) || !validateOpaque(reviewId) || !validateOpaque(scheduleKey, 256)) return { ok: false, code: 'INVALID_INPUT', reasons: ['publication identity fields must be opaque identifiers'] }
    if (typeof draftVersion !== 'number' || !Number.isSafeInteger(draftVersion) || draftVersion < 1) return { ok: false, code: 'INVALID_INPUT', reasons: ['draftVersion must be a positive safe integer'] }
    if (!stringValue(draftStage) || !stringValue(reviewDecision) || !stringValue(riskGateStatus) || !stringValue(contentType, 64) || !stringValue(language, 64) || !stringValue(scheduledAt) || !isNonNegativeInteger(contentByteLength)) return { ok: false, code: 'INVALID_INPUT', reasons: ['publication approval and payload fields are invalid'] }
    if (!isCanonicalSha256(evidenceSnapshotHash) || !isCanonicalSha256(contentHash)) return { ok: false, code: 'INVALID_SHA256', reasons: ['publication hashes must be SHA-256'] }
    const scheduled = safeTimestamp(scheduledAt)
    if (!scheduled.ok) return { ok: false, code: 'INVALID_TIMESTAMP', reasons: [scheduled.reason] }
    return {
      ok: true,
      publication: {
        ownerScopeKey,
        scheduleEntryId,
        productionPlanId,
        jobId,
        draftId,
        draftVersion,
        draftStage,
        reviewId,
        reviewDecision,
        riskGateStatus,
        evidenceSnapshotHash: evidenceSnapshotHash.toLowerCase(),
        contentHash: contentHash.toLowerCase(),
        contentType: contentType.normalize('NFKC').trim().toLowerCase(),
        language: language.normalize('NFKC').trim().toLowerCase(),
        contentByteLength,
        scheduledAt: scheduled.iso,
        scheduleKey,
      },
    }
  } catch {
    return { ok: false, code: 'INVALID_INPUT', reasons: ['publication could not be read'] }
  }
}

function sameAllowed(value: string, allowed: readonly string[]): boolean {
  return allowed.includes(value.normalize('NFKC').trim().toLowerCase())
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
    if (target.adapter === 'manual_export') return blocked('MANUAL_EXPORT_REQUIRES_HUMAN', 'manual export cannot enter autonomous dispatch')
    if (publication.draftStage !== 'optimized') return blocked('INVALID_INPUT', 'publication draft must be optimized')
    if (publication.reviewDecision !== 'approved_for_delivery') return blocked('INVALID_INPUT', 'publication requires delivery approval')
    if (publication.riskGateStatus !== 'passed') return blocked('INVALID_INPUT', 'publication risk gate must be passed')
    if (!sameAllowed(publication.contentType, target.allowedContentTypes)) return blocked('CONTENT_TYPE_NOT_ALLOWED', 'content type is not allowed by target')
    if (!sameAllowed(publication.language, target.allowedLanguages)) return blocked('LANGUAGE_NOT_ALLOWED', 'language is not allowed by target')
    if (publication.contentByteLength > target.maximumPayloadBytes) return blocked('CONTENT_TOO_LARGE', 'content exceeds target payload limit')
    if (!scheduled.ok) return blocked('INVALID_TIMESTAMP', 'scheduledAt is invalid')
    if (scheduled.milliseconds > nowResult.milliseconds) return blocked('SCHEDULED_IN_FUTURE', 'scheduledAt is later than injected now')
    return { status: 'eligible', eligible: true, code: 'ELIGIBLE', reasons: [], target, publication, now: nowResult.iso }
  } catch {
    return blocked('INVALID_INPUT', 'eligibility input could not be evaluated')
  }
}

function isFailureCode(value: unknown): value is string {
  return typeof value === 'string' && failureCodes.has(value)
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
}

function validSuccessHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 200 && value <= 299
}

function validRetryAfter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 86_400
}

function compatibleFailureEvidence(code: string | undefined, httpStatus: number | undefined): boolean {
  if (code === 'timeout' || code === 'connection_reset') return httpStatus === undefined
  if (code === undefined) return true
  if (httpStatus === undefined) return !code.startsWith('http_')
  if (code === 'http_400') return httpStatus === 400
  if (code === 'http_401') return httpStatus === 401
  if (code === 'http_403') return httpStatus === 403
  if (code === 'http_404') return httpStatus === 404
  if (code === 'http_408') return httpStatus === 408
  if (code === 'http_409') return httpStatus === 409
  if (code === 'http_429') return httpStatus === 429
  if (code === 'http_5xx') return httpStatus >= 500 && httpStatus <= 599
  return false
}

function invalidFailure(): DeliveryFailureClassification {
  return { status: 'blocked', code: 'INVALID_INPUT', retryable: false, nextState: 'blocked', delaySeconds: 0, reason: 'failure evidence is invalid or contradictory' }
}

export function classifyDeliveryFailure(input: unknown): DeliveryFailureClassification {
  try {
    if (!isRecord(input)) return invalidFailure()
    const attemptNumber = read(input, 'attemptNumber')
    const codeInput = read(input, 'code')
    const httpStatusInput = read(input, 'httpStatus')
    const retryAfterInput = read(input, 'retryAfterSeconds')
    const confirmedInput = read(input, 'confirmedSameIdempotentDelivery')
    if (!isPositiveInteger(attemptNumber) || attemptNumber > MAX_DELIVERY_ATTEMPTS) return invalidFailure()
    if (codeInput !== undefined && !isFailureCode(codeInput)) return invalidFailure()
    if (httpStatusInput !== undefined && !validHttpStatus(httpStatusInput)) return invalidFailure()
    if (retryAfterInput !== undefined && !validRetryAfter(retryAfterInput)) return invalidFailure()
    if (confirmedInput !== undefined && typeof confirmedInput !== 'boolean') return invalidFailure()
    if (typeof httpStatusInput === 'number' && httpStatusInput >= 200 && httpStatusInput <= 299) return invalidFailure()
    const code = codeInput as string | undefined
    const httpStatus = typeof httpStatusInput === 'number' ? httpStatusInput : undefined
    const retryAfterSeconds = typeof retryAfterInput === 'number' ? retryAfterInput : undefined
    const confirmedSameIdempotentDelivery = confirmedInput as boolean | undefined
    if (!compatibleFailureEvidence(code, httpStatus)) return invalidFailure()
    if (retryAfterSeconds !== undefined && httpStatus !== 429) return invalidFailure()
    const failure: DeliveryFailureInput = { attemptNumber, ...(code === undefined ? {} : { code }), ...(httpStatus === undefined ? {} : { httpStatus }), ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }), ...(confirmedSameIdempotentDelivery === undefined ? {} : { confirmedSameIdempotentDelivery }) }
    const normalized = normalizedFailureCode(failure)
    const configurationBlocked = normalized === 'http_401' || normalized === 'http_403' || normalized === 'credential_missing' || normalized === 'revoked_target' || normalized === 'policy_violation' || normalized === 'invalid_remote_identity' || normalized === 'content_hash_mismatch' || normalized === 'evidence_hash_mismatch'
    if (configurationBlocked) return { status: 'classified', code: normalized, retryable: false, nextState: 'blocked', delaySeconds: 0, reason: 'configuration_blocked' }
    const retryable = isRetryableFailure(failure)
    if (!retryable || attemptNumber >= MAX_DELIVERY_ATTEMPTS) return { status: 'classified', code: normalized, retryable: false, nextState: 'permanent_failed', delaySeconds: 0, reason: 'permanent_failure' }
    const policyDelay = retryDelaySeconds(attemptNumber)
    const remoteDelay = normalized === 'http_429' && retryAfterSeconds !== undefined ? retryAfterSeconds : 0
    return { status: 'classified', code: normalized, retryable: true, nextState: 'retry_wait', delaySeconds: Math.max(policyDelay, remoteDelay), reason: 'temporary_failure_retry_wait' }
  } catch {
    return invalidFailure()
  }
}

function validateAttemptHistory(input: unknown, expectedKey: string, nowMilliseconds: number): { ok: true; attempts: DeliveryAttemptRecord[] } | { ok: false; code: PlanBlockedCode; reasons: readonly string[] } {
  try {
    if (input === undefined) return { ok: true, attempts: [] }
    if (!Array.isArray(input)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history must be an array'] }
    if (input.length > MAX_ATTEMPT_HISTORY) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history exceeds the bounded history limit'] }
    const attempts: DeliveryAttemptRecord[] = []
    let previousMilliseconds: number | undefined
    let previousState: DeliveryState | undefined
    let previousRetryEligibleMilliseconds: number | undefined
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index]
      if (!isRecord(item)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains a malformed record'] }
      const attemptNumber = read(item, 'attemptNumber')
      const state = read(item, 'state')
      const occurredAt = read(item, 'occurredAt')
      const idempotencyKey = read(item, 'idempotencyKey')
      const failureCode = read(item, 'failureCode')
      const httpStatus = read(item, 'httpStatus')
      const retryAfterSeconds = read(item, 'retryAfterSeconds')
      const confirmedSameIdempotentDelivery = read(item, 'confirmedSameIdempotentDelivery')
      const retryEligibleAt = read(item, 'retryEligibleAt')
      if (!isPositiveInteger(attemptNumber) || attemptNumber !== index + 1 || attemptNumber > MAX_DELIVERY_ATTEMPTS) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history has duplicate or out-of-order numbers'] }
      if (typeof state !== 'string' || !deliveryStates.has(state as DeliveryState)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history contains an invalid state'] }
      const occurred = safeTimestamp(occurredAt)
      if (!occurred.ok || occurred.milliseconds > nowMilliseconds || (previousMilliseconds !== undefined && occurred.milliseconds < previousMilliseconds)) return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history timestamps are invalid, future, or out of order'] }
      if (index > 0 && previousState !== 'retry_wait') return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['only retry_wait may be followed by another attempt'] }
      if (index > 0 && (previousRetryEligibleMilliseconds === undefined || occurred.milliseconds < previousRetryEligibleMilliseconds)) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['a subsequent attempt cannot precede the persisted retry deadline'] }
      previousMilliseconds = occurred.milliseconds
      if (!isCanonicalSha256(idempotencyKey)) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['attempt history idempotency key is malformed'] }
      if (idempotencyKey.toLowerCase() !== expectedKey.toLowerCase()) return { ok: false, code: 'ATTEMPT_IDEMPOTENCY_MISMATCH', reasons: ['attempt history belongs to a different publication identity'] }
      if (failureCode !== undefined && !isFailureCode(failureCode)) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['attempt history failureCode is invalid'] }
      if (httpStatus !== undefined && !validHttpStatus(httpStatus)) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['attempt history httpStatus is invalid'] }
      if (retryAfterSeconds !== undefined && !validRetryAfter(retryAfterSeconds)) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['attempt history retryAfterSeconds is invalid'] }
      if (confirmedSameIdempotentDelivery !== undefined && typeof confirmedSameIdempotentDelivery !== 'boolean') return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['attempt history confirmed idempotency evidence is invalid'] }
      const typedFailureCode = failureCode as string | undefined
      const typedHttpStatus = httpStatus as number | undefined
      const typedRetryAfter = retryAfterSeconds as number | undefined
      const typedConfirmedSameIdempotentDelivery = confirmedSameIdempotentDelivery as boolean | undefined
      const canonicalRetryEligibleAt = retryEligibleAt === undefined ? undefined : safeTimestamp(retryEligibleAt)
      if (retryEligibleAt !== undefined && (!canonicalRetryEligibleAt || !canonicalRetryEligibleAt.ok || canonicalRetryEligibleAt.milliseconds < occurred.milliseconds)) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['attempt history retryEligibleAt is invalid'] }
      if (state === 'retry_wait') {
        if (typedFailureCode === undefined && typedHttpStatus === undefined) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['retry_wait requires failure evidence'] }
        const classification = classifyDeliveryFailure({ attemptNumber, ...(typedFailureCode === undefined ? {} : { code: typedFailureCode }), ...(typedHttpStatus === undefined ? {} : { httpStatus: typedHttpStatus }), ...(typedRetryAfter === undefined ? {} : { retryAfterSeconds: typedRetryAfter }), ...(typedConfirmedSameIdempotentDelivery === undefined ? {} : { confirmedSameIdempotentDelivery: typedConfirmedSameIdempotentDelivery }) })
        if (classification.status === 'blocked' || !classification.retryable || classification.nextState !== 'retry_wait') return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['retry_wait failure evidence is not retryable'] }
        const expectedRetryMilliseconds = occurred.milliseconds + classification.delaySeconds * 1000
        if (!canonicalRetryEligibleAt || !canonicalRetryEligibleAt.ok || canonicalRetryEligibleAt.iso !== new Date(expectedRetryMilliseconds).toISOString()) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['retryEligibleAt does not match the fixed retry policy'] }
      } else if (retryEligibleAt !== undefined || typedFailureCode !== undefined || typedHttpStatus !== undefined || typedRetryAfter !== undefined || typedConfirmedSameIdempotentDelivery !== undefined) {
        return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reasons: ['failure evidence is only valid for retry_wait'] }
      }
      attempts.push({ attemptNumber, state: state as DeliveryState, occurredAt: occurred.iso, idempotencyKey: idempotencyKey.toLowerCase(), ...(typedFailureCode === undefined ? {} : { failureCode: typedFailureCode as DeliveryAttemptRecord['failureCode'] }), ...(typedHttpStatus === undefined ? {} : { httpStatus: typedHttpStatus }), ...(typedRetryAfter === undefined ? {} : { retryAfterSeconds: typedRetryAfter }), ...(typedConfirmedSameIdempotentDelivery === undefined ? {} : { confirmedSameIdempotentDelivery: typedConfirmedSameIdempotentDelivery }), ...(canonicalRetryEligibleAt === undefined || !canonicalRetryEligibleAt.ok ? {} : { retryEligibleAt: canonicalRetryEligibleAt.iso }) })
      previousState = state as DeliveryState
      previousRetryEligibleMilliseconds = state === 'retry_wait' && canonicalRetryEligibleAt?.ok ? canonicalRetryEligibleAt.milliseconds : undefined
    }
    return { ok: true, attempts }
  } catch {
    return { ok: false, code: 'ATTEMPT_HISTORY_INVALID', reasons: ['attempt history could not be read'] }
  }
}

function publicationIdentity(publication: ApprovedPublicationInput): PublicationIdentity {
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

function identityInput(target: ValidatedDeliveryTarget, publication: ApprovedPublicationInput) {
  return {
    ownerScopeKey: publication.ownerScopeKey,
    targetId: target.targetId,
    adapter: target.adapter,
    scheduleEntryId: publication.scheduleEntryId,
    scheduleKey: publication.scheduleKey,
    productionPlanId: publication.productionPlanId,
    jobId: publication.jobId,
    draftId: publication.draftId,
    draftVersion: publication.draftVersion,
    reviewId: publication.reviewId,
    evidenceSnapshotHash: publication.evidenceSnapshotHash,
    contentHash: publication.contentHash,
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
        adapter: read(item, 'adapter'),
        scheduleEntryId: read(item, 'scheduleEntryId'),
        scheduleKey: read(item, 'scheduleKey'),
        productionPlanId: read(item, 'productionPlanId'),
        jobId: read(item, 'jobId'),
        draftId: read(item, 'draftId'),
        draftVersion: read(item, 'draftVersion'),
        reviewId: read(item, 'reviewId'),
        evidenceSnapshotHash: read(item, 'evidenceSnapshotHash'),
        contentHash: read(item, 'contentHash'),
        state: read(item, 'state'),
      }
      if (!isCanonicalSha256(record.idempotencyKey) || !validateOpaque(record.targetId) || !validateOpaque(record.ownerScopeKey) || !adapters.has(record.adapter as DeliveryAdapter) || !validateOpaque(record.scheduleEntryId) || !validateOpaque(record.scheduleKey, 256) || !validateOpaque(record.productionPlanId) || !validateOpaque(record.jobId) || !validateOpaque(record.draftId) || !isPositiveInteger(record.draftVersion) || !validateOpaque(record.reviewId) || !isCanonicalSha256(record.evidenceSnapshotHash) || !isCanonicalSha256(record.contentHash) || typeof record.state !== 'string' || !deliveryStates.has(record.state as DeliveryState)) return { ok: false, code: 'INVALID_INPUT', reasons: ['prior deliveries contain an invalid complete identity record'] }
      const recomputed = computeDeliveryIdempotencyKey({ ownerScopeKey: record.ownerScopeKey, targetId: record.targetId, adapter: record.adapter, scheduleEntryId: record.scheduleEntryId, scheduleKey: record.scheduleKey, productionPlanId: record.productionPlanId, jobId: record.jobId, draftId: record.draftId, draftVersion: record.draftVersion, reviewId: record.reviewId, evidenceSnapshotHash: record.evidenceSnapshotHash, contentHash: record.contentHash })
      if (recomputed.status === 'blocked' || recomputed.key !== record.idempotencyKey.toLowerCase()) return { ok: false, code: 'IDEMPOTENCY_COLLISION', reasons: ['prior delivery key does not match its complete identity'] }
      records.push({ idempotencyKey: recomputed.key, targetId: record.targetId, ownerScopeKey: record.ownerScopeKey, adapter: record.adapter as DeliveryAdapter, scheduleEntryId: record.scheduleEntryId, scheduleKey: record.scheduleKey, productionPlanId: record.productionPlanId, jobId: record.jobId, draftId: record.draftId, draftVersion: record.draftVersion, reviewId: record.reviewId, evidenceSnapshotHash: record.evidenceSnapshotHash.toLowerCase(), contentHash: record.contentHash.toLowerCase(), state: record.state as DeliveryState })
    }
    return { ok: true, records }
  } catch {
    return { ok: false, code: 'INVALID_INPUT', reasons: ['prior deliveries could not be read'] }
  }
}

function samePublicationIdentity(record: DeliveryFailureHistoryRecord, target: ValidatedDeliveryTarget, publication: ApprovedPublicationInput): boolean {
  return record.targetId === target.targetId && record.ownerScopeKey === publication.ownerScopeKey && record.adapter === target.adapter && record.scheduleEntryId === publication.scheduleEntryId && record.scheduleKey === publication.scheduleKey && record.productionPlanId === publication.productionPlanId && record.jobId === publication.jobId && record.draftId === publication.draftId && record.draftVersion === publication.draftVersion && record.reviewId === publication.reviewId && record.evidenceSnapshotHash === publication.evidenceSnapshotHash && record.contentHash === publication.contentHash
}

export function planDeliveryAttempt(input: unknown): DeliveryPlanResult {
  try {
    if (!isRecord(input)) return planBlocked('INVALID_INPUT', 'delivery plan input must be a plain object')
    const eligibility = evaluateDeliveryEligibility(read(input, 'target'), read(input, 'publication'), read(input, 'now'))
    if (eligibility.status === 'blocked') return planBlocked(eligibility.code, ...eligibility.reasons)
    if (!eligibility.target || !eligibility.publication || !eligibility.now) return planBlocked('INVALID_INPUT', 'eligible result is incomplete')
    const target = eligibility.target
    const publication = eligibility.publication
    const plannedNow = safeTimestamp(eligibility.now)
    if (!plannedNow.ok) return planBlocked('INVALID_INPUT', 'eligible now could not be canonicalized')
    const keyResult = computeDeliveryIdempotencyKey(identityInput(target, publication))
    if (keyResult.status === 'blocked') return planBlocked(keyResult.code, ...keyResult.reasons)
    const attemptHistory = validateAttemptHistory(read(input, 'attempts'), keyResult.key, plannedNow.milliseconds)
    if (!attemptHistory.ok) return planBlocked(attemptHistory.code, ...attemptHistory.reasons)
    const attempts = attemptHistory.attempts
    if (attempts.length >= MAX_DELIVERY_ATTEMPTS) return planBlocked('ATTEMPT_CAP_REACHED', 'maximum delivery attempts reached')
    let attemptNumber = 1
    let eligibleAt = eligibility.now
    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1]
      if (!last) return planBlocked('ATTEMPT_HISTORY_INVALID', 'attempt history is empty after validation')
      if (last.state === 'dispatch_planned') return planBlocked('ATTEMPT_STILL_IN_FLIGHT', 'the previous dispatch is still in flight')
      if (last.state === 'retry_wait') {
        if (!last.retryEligibleAt) return planBlocked('ATTEMPT_RETRY_EVIDENCE_INVALID', 'retry_wait is missing retryEligibleAt')
        const retryAt = safeTimestamp(last.retryEligibleAt)
        if (!retryAt.ok) return planBlocked('ATTEMPT_RETRY_EVIDENCE_INVALID', 'retryEligibleAt is invalid')
        if (plannedNow.milliseconds < retryAt.milliseconds) return planBlocked('RETRY_NOT_DUE', 'retryEligibleAt has not been reached')
        attemptNumber = last.attemptNumber + 1
        eligibleAt = retryAt.iso
      } else if (isTerminalDeliveryState(last.state)) {
        return planBlocked('TERMINAL_STATE', 'delivery history is terminal')
      } else {
        return planBlocked('INVALID_STATE_TRANSITION', 'only retry_wait can create a subsequent attempt')
      }
    }
    if (attemptNumber > MAX_DELIVERY_ATTEMPTS) return planBlocked('ATTEMPT_CAP_REACHED', 'maximum delivery attempts reached')
    const priorDeliveries = validatePriorDeliveries(read(input, 'priorDeliveries'))
    if (!priorDeliveries.ok) return planBlocked(priorDeliveries.code, ...priorDeliveries.reasons)
    for (const record of priorDeliveries.records) {
      if (record.idempotencyKey !== keyResult.key) continue
      if (!samePublicationIdentity(record, target, publication)) return planBlocked('IDEMPOTENCY_COLLISION', 'idempotency key maps to a different complete publication identity')
      return planBlocked('DUPLICATE_PUBLICATION', 'publication already has a delivery record')
    }
    const command: DeliveryCommandMetadata = {
      commandVersion: 'delivery-command-v1',
      targetId: target.targetId,
      adapter: target.adapter as Exclude<DeliveryAdapter, 'manual_export'>,
      targetOrigin: target.normalizedOrigin,
      endpointPath: target.normalizedEndpointPath,
      publicationIdentity: publicationIdentity(publication),
      contentHash: publication.contentHash,
      evidenceSnapshotHash: publication.evidenceSnapshotHash,
      idempotencyKey: keyResult.key,
      attemptNumber,
      eligibleAt,
      timeoutClass: 'standard',
      limitations: ['metadata_only', 'not_delivered', 'executor_must_revalidate'],
    }
    return { status: 'dispatch_planned', command }
  } catch {
    return planBlocked('INVALID_INPUT', 'delivery plan input could not be evaluated')
  }
}

function normalizedTargetOrigin(value: unknown): { ok: true; origin: string } | { ok: false } {
  const result = validateDeliveryTarget({
    targetId: 'result-target',
    ownerScopeKey: 'result-owner',
    adapter: 'generic_http',
    targetOrigin: value,
    endpointPath: '/',
    status: 'active',
    serverCredentialConfigured: true,
    allowedContentTypes: ['text/plain'],
    allowedLanguages: ['en'],
    maximumPayloadBytes: 1,
    policyVersion: 'delivery-policy-v1',
  })
  return result.status === 'valid' && result.target ? { ok: true, origin: result.target.normalizedOrigin } : { ok: false }
}

function normalizeRemoteUrl(value: unknown, targetOrigin: string): { ok: true; url: string } | { ok: false } {
  if (!stringValue(value)) return { ok: false }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return { ok: false }
    const remoteOrigin = normalizedTargetOrigin(parsed.origin)
    if (!remoteOrigin.ok || remoteOrigin.origin !== targetOrigin) return { ok: false }
    const path = parsed.pathname || '/'
    const target = validateDeliveryTarget({
      targetId: 'result-path',
      ownerScopeKey: 'result-owner',
      adapter: 'generic_http',
      targetOrigin: remoteOrigin.origin,
      endpointPath: path,
      status: 'active',
      serverCredentialConfigured: true,
      allowedContentTypes: ['text/plain'],
      allowedLanguages: ['en'],
      maximumPayloadBytes: 1,
      policyVersion: 'delivery-policy-v1',
    })
    if (target.status !== 'valid') return { ok: false }
    return { ok: true, url: `${remoteOrigin.origin}${target.target?.normalizedEndpointPath ?? path}` }
  } catch {
    return { ok: false }
  }
}

function resultFingerprintPayload(result: DeliveryResultInput, targetOrigin: string): Record<string, string | boolean | number> {
  return {
    idempotencyKey: result.idempotencyKey,
    remoteContentId: result.remoteContentId ?? '',
    publishedAt: result.publishedAt ?? '',
    remoteUrl: result.remoteUrl ?? '',
    noPublicUrl: result.noPublicUrl === true,
    responseFingerprint: result.responseFingerprint ?? '',
    httpStatus: result.httpStatus ?? 0,
    targetOrigin,
  }
}

export function computeDeliveryResultFingerprint(result: unknown, targetOrigin: unknown): DeliveryResultFingerprintResult {
  try {
    if (!isRecord(result)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['delivery result must be a plain object'] }
    if (!isCanonicalSha256(read(result, 'idempotencyKey')) || !validateOpaque(read(result, 'remoteContentId')) || !stringValue(read(result, 'publishedAt')) || typeof read(result, 'noPublicUrl') !== 'boolean' || !isCanonicalSha256(read(result, 'responseFingerprint')) || !validSuccessHttpStatus(read(result, 'httpStatus'))) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['delivery result identity is incomplete or HTTP status is not successful'] }
    const origin = normalizedTargetOrigin(targetOrigin)
    if (!origin.ok) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['target origin is invalid'] }
    const noPublicUrl = read(result, 'noPublicUrl') as boolean
    const remoteUrl = read(result, 'remoteUrl')
    if (!noPublicUrl && !stringValue(remoteUrl)) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['remoteUrl is required when noPublicUrl is false'] }
    const normalizedRemoteUrl = remoteUrl === undefined ? undefined : normalizeRemoteUrl(remoteUrl, origin.origin)
    if (normalizedRemoteUrl !== undefined && !normalizedRemoteUrl.ok) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['remoteUrl is invalid'] }
    const published = safeTimestamp(read(result, 'publishedAt'))
    if (!published.ok) return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['publishedAt is invalid'] }
    const canonical: DeliveryResultInput = {
      idempotencyKey: (read(result, 'idempotencyKey') as string).toLowerCase(),
      remoteContentId: read(result, 'remoteContentId') as string,
      publishedAt: published.iso,
      ...(normalizedRemoteUrl === undefined || !normalizedRemoteUrl.ok ? {} : { remoteUrl: normalizedRemoteUrl.url }),
      noPublicUrl,
      responseFingerprint: (read(result, 'responseFingerprint') as string).toLowerCase(),
      httpStatus: read(result, 'httpStatus') as number,
    }
    const payload = JSON.stringify(resultFingerprintPayload(canonical, origin.origin))
    return { status: 'ok', fingerprint: createHash('sha256').update(payload, 'utf8').digest('hex') }
  } catch {
    return { status: 'blocked', code: 'INVALID_INPUT', reasons: ['delivery result fingerprint could not be computed'] }
  }
}

function validateSuccessResult(result: unknown, expectedKey: unknown, targetOrigin: unknown, nowInput: unknown, attemptStartedInput: unknown): { ok: true; value: ValidatedSuccess } | { ok: false; code: StateBlockedCode; reason: string } {
  try {
    const now = safeNow(nowInput)
    const attemptStarted = safeTimestamp(attemptStartedInput)
    if (!now.ok || !attemptStarted.ok) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'success event requires timezone-bearing now and attemptStartedAt' }
    if (!isRecord(result) || !isCanonicalSha256(expectedKey)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'success result identity is invalid' }
    const origin = normalizedTargetOrigin(targetOrigin)
    if (!origin.ok) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'targetOrigin is not a valid public HTTPS origin' }
    const idempotencyKey = read(result, 'idempotencyKey')
    const remoteContentId = read(result, 'remoteContentId')
    const publishedAt = read(result, 'publishedAt')
    const remoteUrl = read(result, 'remoteUrl')
    const noPublicUrl = read(result, 'noPublicUrl')
    const responseFingerprint = read(result, 'responseFingerprint')
    const httpStatus = read(result, 'httpStatus')
    if (!isCanonicalSha256(idempotencyKey)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'idempotency key is invalid' }
    if (idempotencyKey.toLowerCase() !== expectedKey.toLowerCase()) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'idempotency key does not match' }
    if (!validateOpaque(remoteContentId)) return { ok: false, code: 'HTTP_SUCCESS_MISSING_REMOTE_ID', reason: 'successful result lacks an opaque remote content identity' }
    if (!stringValue(publishedAt)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'publishedAt is required' }
    const published = safeTimestamp(publishedAt)
    if (!published.ok) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'publishedAt is invalid' }
    if (attemptStarted.milliseconds > published.milliseconds) return { ok: false, code: 'PUBLISHED_AT_BEFORE_ATTEMPT', reason: 'publishedAt precedes attemptStartedAt' }
    if (published.milliseconds > now.milliseconds) return { ok: false, code: 'PUBLISHED_AT_IN_FUTURE', reason: 'publishedAt is later than event now' }
    if (typeof noPublicUrl !== 'boolean') return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'noPublicUrl must be boolean' }
    if (!noPublicUrl && !stringValue(remoteUrl)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'remoteUrl is required when noPublicUrl is false' }
    let normalizedUrl: string | undefined
    if (remoteUrl !== undefined) {
      const normalized = normalizeRemoteUrl(remoteUrl, origin.origin)
      if (!normalized.ok) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'remoteUrl is not an allowed HTTPS identity' }
      normalizedUrl = normalized.url
    }
    if (!isCanonicalSha256(responseFingerprint)) return { ok: false, code: 'RESPONSE_FINGERPRINT_INVALID', reason: 'responseFingerprint must be a SHA-256 value' }
    if (!validSuccessHttpStatus(httpStatus)) return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'httpStatus must be a safe integer from 200 through 299' }
    const canonicalResult: DeliveryResultInput = { idempotencyKey: idempotencyKey as string, remoteContentId, publishedAt: published.iso, ...(normalizedUrl === undefined ? {} : { remoteUrl: normalizedUrl }), noPublicUrl, responseFingerprint: responseFingerprint.toLowerCase(), httpStatus }
    const fingerprint = computeDeliveryResultFingerprint(canonicalResult, origin.origin)
    if (fingerprint.status === 'blocked') return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'delivery result fingerprint could not be computed' }
    return { ok: true, value: { result: canonicalResult, targetOrigin: origin.origin, deliveryResultFingerprint: fingerprint.fingerprint } }
  } catch {
    return { ok: false, code: 'REMOTE_RESULT_INVALID', reason: 'success result could not be read' }
  }
}

type PersistedAttemptProof =
  | { ok: true; now: TimestampResult & { ok: true }; attempts: DeliveryAttemptRecord[]; last: DeliveryAttemptRecord }
  | { ok: false; code: StateBlockedCode; reason: string }

function validatePersistedAttemptProof(event: Record<string, unknown>, mode: 'current' | 'next' = 'current'): PersistedAttemptProof {
  const now = safeNow(read(event, 'now'))
  const expectedIdempotencyKey = read(event, 'expectedIdempotencyKey')
  const attemptNumber = read(event, 'attemptNumber')
  if (!now.ok || !isCanonicalSha256(expectedIdempotencyKey) || !isPositiveInteger(attemptNumber) || attemptNumber > MAX_DELIVERY_ATTEMPTS) {
    return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'transition requires injected now, expected key, and attempt number' }
  }
  const history = validateAttemptHistory(read(event, 'attempts'), expectedIdempotencyKey.toLowerCase(), now.milliseconds)
  if (!history.ok) return { ok: false, code: history.code, reason: history.reasons.join('; ') }
  const last = history.attempts[history.attempts.length - 1]
  if (!last) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'transition requires a persisted attempt record' }
  if (last.idempotencyKey !== expectedIdempotencyKey.toLowerCase()) return { ok: false, code: 'ATTEMPT_IDEMPOTENCY_MISMATCH', reason: 'event key does not match persisted attempt key' }
  const expectedAttemptNumber = mode === 'next' ? last.attemptNumber + 1 : last.attemptNumber
  if (attemptNumber !== expectedAttemptNumber || attemptNumber > MAX_DELIVERY_ATTEMPTS) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'event attempt number does not match persisted attempt proof' }
  return { ok: true, now, attempts: history.attempts, last }
}

function failureInputFromAttempt(attempt: DeliveryAttemptRecord): DeliveryFailureInput {
  return {
    attemptNumber: attempt.attemptNumber,
    ...(attempt.failureCode === undefined ? {} : { code: attempt.failureCode }),
    ...(attempt.httpStatus === undefined ? {} : { httpStatus: attempt.httpStatus }),
    ...(attempt.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: attempt.retryAfterSeconds }),
    ...(attempt.confirmedSameIdempotentDelivery === undefined ? {} : { confirmedSameIdempotentDelivery: attempt.confirmedSameIdempotentDelivery }),
  }
}

function validateRetryDueEvent(event: Record<string, unknown>): { ok: true; retryEligibleAt: string } | { ok: false; code: StateBlockedCode; reason: string } {
  const proof = validatePersistedAttemptProof(event, 'next')
  if (!proof.ok) return proof
  if (proof.last.state !== 'retry_wait') return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'retry_due requires the persisted latest attempt to be retry_wait' }
  const attemptNumber = read(event, 'attemptNumber')
  const persistedRetryEligibleAt = proof.last.retryEligibleAt
  const eventRetryEligibleAt = safeTimestamp(read(event, 'retryEligibleAt'))
  if (!persistedRetryEligibleAt || !eventRetryEligibleAt.ok || eventRetryEligibleAt.iso !== persistedRetryEligibleAt) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'retry_due deadline does not match persisted retry evidence' }
  const classification = classifyDeliveryFailure(failureInputFromAttempt(proof.last))
  if (classification.status === 'blocked' || !classification.retryable || classification.nextState !== 'retry_wait') return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'persisted retry failure evidence is not retryable' }
  const expectedRetryMilliseconds = safeTimestamp(proof.last.occurredAt)
  if (!expectedRetryMilliseconds.ok || expectedRetryMilliseconds.milliseconds + classification.delaySeconds * 1000 !== eventRetryEligibleAt.milliseconds) return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'persisted retry deadline cannot be recomputed from failure evidence' }
  if (proof.now.milliseconds < eventRetryEligibleAt.milliseconds) return { ok: false, code: 'RETRY_NOT_DUE', reason: 'retryEligibleAt has not been reached' }
  return { ok: true, retryEligibleAt: eventRetryEligibleAt.iso }
}

function validateLatestDispatchAttempt(event: Record<string, unknown>): PersistedAttemptProof | { ok: false; code: StateBlockedCode; reason: string } {
  const proof = validatePersistedAttemptProof(event)
  if (!proof.ok) return proof
  if (proof.last.state !== 'dispatch_planned') return { ok: false, code: 'ATTEMPT_RETRY_EVIDENCE_INVALID', reason: 'transition requires the persisted latest attempt to be dispatch_planned' }
  return proof
}

export function reduceDeliveryAttemptState(currentState: unknown, eventInput: unknown): DeliveryStateResult {
  try {
    if (!validState(currentState)) return blockedState('INVALID_INPUT', undefined, 'current state is invalid')
    const state = currentState
    if (!isRecord(eventInput)) return blockedState('INVALID_INPUT', state, 'transition event must be a plain object')
    const event = eventInput
    const eventType = read(event, 'type')
    if (state === 'delivered' && eventType === 'success') {
      const success = validateSuccessResult(read(event, 'result'), read(event, 'expectedIdempotencyKey'), read(event, 'targetOrigin'), read(event, 'now'), read(event, 'attemptStartedAt'))
      if (!success.ok) return blockedState(success.code, state, success.reason)
      const priorFingerprint = read(event, 'priorDeliveryResultFingerprint')
      if (!isCanonicalSha256(priorFingerprint) || priorFingerprint.toLowerCase() !== success.value.deliveryResultFingerprint) return blockedState('REMOTE_IDENTITY_COLLISION', state, 'delivery result fingerprint differs from prior delivered identity')
      return { status: 'ok', state: 'delivered', previousState: 'delivered', transition: 'delivered->delivered', remoteContentId: success.value.result.remoteContentId, deliveryResultFingerprint: success.value.deliveryResultFingerprint }
    }
    if (isTerminalDeliveryState(state)) return blockedState('TERMINAL_STATE', state, 'terminal state cannot transition')
    if (eventType === 'retry_due') {
      if (state !== 'retry_wait') return blockedState('INVALID_STATE_TRANSITION', state, 'retry_due is only valid from retry_wait')
      const retryDue = validateRetryDueEvent(event)
      if (!retryDue.ok) return blockedState(retryDue.code, state, retryDue.reason)
      return { status: 'ok', state: 'dispatch_planned', previousState: state, transition: 'retry_wait->dispatch_planned' }
    }
    const type = eventType
    if (typeof type !== 'string') return blockedState('INVALID_INPUT', state, 'transition event type is required')
    let nextState: DeliveryState | undefined
    let classification: DeliveryFailureClassification | undefined
    let remoteContentId: string | undefined
    let deliveryResultFingerprint: string | undefined
    if (type === 'mark_eligible') nextState = 'eligible'
    else if (type === 'plan_dispatch') nextState = 'dispatch_planned'
    else if (type === 'block') nextState = 'blocked'
    else if (type === 'cancel') nextState = 'cancelled'
    else if (type === 'failure') {
      const proof = validateLatestDispatchAttempt(event)
      if (!proof.ok) return blockedState(proof.code, state, proof.reason)
      const failure = read(event, 'failure')
      classification = classifyDeliveryFailure(failure)
      if (classification.status === 'blocked') return blockedState('INVALID_INPUT', state, classification.reason)
      if (!isRecord(failure) || read(failure, 'attemptNumber') !== proof.last.attemptNumber) return blockedState('ATTEMPT_RETRY_EVIDENCE_INVALID', state, 'failure event attempt number does not match persisted attempt')
      nextState = classification.nextState
    } else if (type === 'success') {
      const proof = validateLatestDispatchAttempt(event)
      if (!proof.ok) return blockedState(proof.code, state, proof.reason)
      const success = validateSuccessResult(read(event, 'result'), read(event, 'expectedIdempotencyKey'), read(event, 'targetOrigin'), read(event, 'now'), read(event, 'attemptStartedAt'))
      if (!success.ok) return blockedState(success.code, state, success.reason)
      const attemptStarted = safeTimestamp(read(event, 'attemptStartedAt'))
      const persistedDispatch = safeTimestamp(proof.last.occurredAt)
      if (!attemptStarted.ok || !persistedDispatch.ok || attemptStarted.milliseconds < persistedDispatch.milliseconds) return blockedState('ATTEMPT_RETRY_EVIDENCE_INVALID', state, 'attemptStartedAt precedes the persisted dispatch attempt')
      remoteContentId = success.value.result.remoteContentId
      deliveryResultFingerprint = success.value.deliveryResultFingerprint
      nextState = 'delivered'
    } else return blockedState('INVALID_INPUT', state, 'transition event type is invalid')
    if (!nextState || !isAllowedDeliveryTransition(state, nextState)) return blockedState('INVALID_STATE_TRANSITION', state, `transition from ${state} is not allowed`)
    return { status: 'ok', state: nextState, previousState: state, transition: `${state}->${nextState}` as `${DeliveryState}->${DeliveryState}`, ...(classification === undefined ? {} : { classification }), ...(remoteContentId === undefined ? {} : { remoteContentId }), ...(deliveryResultFingerprint === undefined ? {} : { deliveryResultFingerprint }) }
  } catch {
    return blockedState('INVALID_INPUT', undefined, 'transition could not be evaluated')
  }
}

function validState(value: unknown): value is DeliveryState {
  return typeof value === 'string' && deliveryStates.has(value as DeliveryState)
}

export { ALLOWED_DELIVERY_TRANSITIONS }
export type { DeliveryPlanInput, DeliveryTargetInput }
