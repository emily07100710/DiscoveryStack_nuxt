import { MAX_ATTEMPTS, DEFAULT_MAXIMUM_ATTEMPTS, SHA256_PATTERN } from './constants'
import { canonicalJson, fingerprint } from './canonical'
import { exactKeys, isPlainObject, normalizeHash, normalizeId, normalizeLineage, normalizeOpaqueReference } from './normalization'
import { validateRoutingPlan } from './planner'
import type { DeliveryReceipt, ReceiptHistoryValidationResult, ReceiptStatus, ReceiptValidationResult, RetryValidationResult, RouteIntent, RoutingPlan } from './types'

const RECEIPT_KEYS = ['planFingerprint', 'routeId', 'targetId', 'siteIdentity', 'sourcePublicationIdentity', 'destinationPublicationIdentity', 'draftId', 'reviewId', 'evidenceSnapshotHash', 'contentHash', 'executor', 'executorAuthority', 'executorRunId', 'attempt', 'status', 'plannedAt', 'completedAt', 'occurredAt'] as const
const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['delivered', 'blocked', 'failed', 'retry_wait']

type NormalizedReceiptResult = { readonly receipt: DeliveryReceipt | null; readonly reasonCodes: readonly string[] }

function invalid(...reasonCodes: string[]): ReceiptValidationResult {
  return { valid: false, replay: false, collision: false, receiptFingerprint: null, reasonCodes, reasons: reasonCodes }
}

function invalidRetry(...reasonCodes: string[]): RetryValidationResult {
  return { valid: false, reasonCodes, reasons: reasonCodes }
}

function historyInvalid(...reasonCodes: string[]): ReceiptHistoryValidationResult {
  return { valid: false, receipts: [], reasonCodes, reasons: reasonCodes }
}

function historyValid(receipts: readonly DeliveryReceipt[]): ReceiptHistoryValidationResult {
  return { valid: true, receipts: [...receipts], reasonCodes: [], reasons: [] }
}

function validReceipt(receiptFingerprint: string, replay = false): ReceiptValidationResult {
  return { valid: true, replay, collision: false, receiptFingerprint, reasonCodes: [], reasons: [] }
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return typeof value === 'string' && RECEIPT_STATUSES.includes(value as ReceiptStatus)
}

function receiptKey(receipt: Pick<DeliveryReceipt, 'planFingerprint' | 'routeId' | 'attempt'>): string {
  return `${receipt.planFingerprint}\u0000${receipt.routeId}\u0000${receipt.attempt}`
}

function sameLineage(left: DeliveryReceipt, right: DeliveryReceipt): boolean {
  return canonicalJson({
    planFingerprint: left.planFingerprint,
    routeId: left.routeId,
    targetId: left.targetId,
    siteIdentity: left.siteIdentity,
    sourcePublicationIdentity: left.sourcePublicationIdentity,
    destinationPublicationIdentity: left.destinationPublicationIdentity,
    draftId: left.draftId,
    reviewId: left.reviewId,
    evidenceSnapshotHash: left.evidenceSnapshotHash,
    contentHash: left.contentHash,
    executor: left.executor,
    executorAuthority: left.executorAuthority,
    plannedAt: left.plannedAt,
  }) === canonicalJson({
    planFingerprint: right.planFingerprint,
    routeId: right.routeId,
    targetId: right.targetId,
    siteIdentity: right.siteIdentity,
    sourcePublicationIdentity: right.sourcePublicationIdentity,
    destinationPublicationIdentity: right.destinationPublicationIdentity,
    draftId: right.draftId,
    reviewId: right.reviewId,
    evidenceSnapshotHash: right.evidenceSnapshotHash,
    contentHash: right.contentHash,
    executor: right.executor,
    executorAuthority: right.executorAuthority,
    plannedAt: right.plannedAt,
  })
}

function normalizeReceiptCore(plan: RoutingPlan, value: unknown): NormalizedReceiptResult {
  try {
    if (!isPlainObject(value) || !exactKeys(value, RECEIPT_KEYS)) return { receipt: null, reasonCodes: ['RECEIPT_SHAPE_INVALID'] }
    const raw = value as Record<string, unknown>
    if (typeof raw.planFingerprint !== 'string' || !SHA256_PATTERN.test(raw.planFingerprint) || raw.planFingerprint !== plan.planFingerprint) return { receipt: null, reasonCodes: ['RECEIPT_PLAN_FINGERPRINT_INVALID'] }
    const route = plan.routes.find((candidate) => candidate.routeId === raw.routeId)
    if (!route) return { receipt: null, reasonCodes: ['RECEIPT_ROUTE_UNKNOWN'] }
    const routeId = normalizeId(raw.routeId, 'receipt.routeId')
    const targetId = normalizeId(raw.targetId, 'receipt.targetId')
    const siteIdentity = normalizeId(raw.siteIdentity, 'receipt.siteIdentity')
    const sourcePublicationIdentity = normalizeId(raw.sourcePublicationIdentity, 'receipt.sourcePublicationIdentity')
    const destinationPublicationIdentity = normalizeId(raw.destinationPublicationIdentity, 'receipt.destinationPublicationIdentity')
    const draftId = normalizeId(raw.draftId, 'receipt.draftId')
    const reviewId = normalizeId(raw.reviewId, 'receipt.reviewId')
    const evidenceSnapshotHash = normalizeHash(raw.evidenceSnapshotHash, 'receipt.evidenceSnapshotHash')
    const contentHash = normalizeHash(raw.contentHash, 'receipt.contentHash')
    const executorRunId = normalizeOpaqueReference(raw.executorRunId, 'receipt.executorRunId')
    if (!isReceiptStatus(raw.status)) return { receipt: null, reasonCodes: ['RECEIPT_STATUS_INVALID'] }
    if (raw.executor !== route.executor || raw.executorAuthority !== route.executorAuthority) return { receipt: null, reasonCodes: ['RECEIPT_EXECUTOR_BINDING_INVALID'] }
    if (raw.targetId !== route.targetId || raw.siteIdentity !== route.siteIdentity || raw.sourcePublicationIdentity !== route.sourcePublicationIdentity || raw.destinationPublicationIdentity !== route.destinationPublicationIdentity || raw.draftId !== route.draftId || raw.reviewId !== route.reviewId || raw.evidenceSnapshotHash !== route.evidenceSnapshotHash || raw.contentHash !== route.contentHash) return { receipt: null, reasonCodes: ['RECEIPT_LINEAGE_INVALID'] }
    const attempt = raw.attempt
    if (!isEpoch(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) return { receipt: null, reasonCodes: ['RECEIPT_ATTEMPT_INVALID'] }
    const plannedAt = raw.plannedAt
    const completedAt = raw.completedAt
    const occurredAt = raw.occurredAt
    if (!isEpoch(plannedAt) || !isEpoch(completedAt) || !isEpoch(occurredAt)) return { receipt: null, reasonCodes: ['RECEIPT_TIME_INVALID'] }
    if (plannedAt !== plan.plannedAt || plannedAt > completedAt || completedAt > occurredAt) return { receipt: null, reasonCodes: ['RECEIPT_TIME_ORDER_INVALID'] }
    const receipt: DeliveryReceipt = {
      planFingerprint: plan.planFingerprint,
      routeId,
      targetId,
      siteIdentity,
      sourcePublicationIdentity,
      destinationPublicationIdentity,
      draftId,
      reviewId,
      evidenceSnapshotHash,
      contentHash,
      executor: route.executor,
      executorAuthority: route.executorAuthority,
      executorRunId: executorRunId as DeliveryReceipt['executorRunId'],
      attempt,
      status: raw.status,
      plannedAt,
      completedAt,
      occurredAt,
    }
    return { receipt, reasonCodes: [] }
  } catch {
    return { receipt: null, reasonCodes: ['RECEIPT_RUNTIME_VALIDATION_FAILED'] }
  }
}

export function normalizeReceiptForPlan(plan: RoutingPlan, value: unknown): DeliveryReceipt | null {
  return normalizeReceiptCore(plan, value).receipt
}

function compareReceipts(left: DeliveryReceipt, right: DeliveryReceipt): number {
  if (left.routeId < right.routeId) return -1
  if (left.routeId > right.routeId) return 1
  if (left.attempt !== right.attempt) return left.attempt - right.attempt
  const leftFingerprint = fingerprint(left)
  const rightFingerprint = fingerprint(right)
  return leftFingerprint < rightFingerprint ? -1 : leftFingerprint > rightFingerprint ? 1 : 0
}

export function validateReceiptHistory(plan: unknown, values: readonly unknown[], maximumAttempts = MAX_ATTEMPTS): ReceiptHistoryValidationResult {
  try {
    const verifiedPlan = validateRoutingPlan(plan)
    if (!verifiedPlan.valid) return historyInvalid('PLAN_INVALID', ...verifiedPlan.reasonCodes)
    if (!Array.isArray(values)) return historyInvalid('RECEIPT_HISTORY_INVALID')
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > MAX_ATTEMPTS) return historyInvalid('RETRY_MAXIMUM_ATTEMPTS_INVALID')
    const normalized: DeliveryReceipt[] = []
    for (const value of values) {
      const result = normalizeReceiptCore(verifiedPlan.plan, value)
      if (!result.receipt) return historyInvalid(...result.reasonCodes)
      normalized.push(result.receipt)
    }
    const byKey = new Map<string, DeliveryReceipt>()
    const byRunId = new Map<string, DeliveryReceipt>()
    for (const receipt of normalized) {
      const key = receiptKey(receipt)
      const existing = byKey.get(key)
      if (existing) {
        if (fingerprint(existing) !== fingerprint(receipt)) return historyInvalid('RECEIPT_ATTEMPT_COLLISION')
        continue
      }
      const reused = byRunId.get(receipt.executorRunId)
      if (reused && (reused.attempt !== receipt.attempt || fingerprint(reused) !== fingerprint(receipt))) return historyInvalid('RECEIPT_EXECUTOR_RUN_REUSED')
      byKey.set(key, receipt)
      byRunId.set(receipt.executorRunId, receipt)
    }
    const receipts = [...byKey.values()].sort(compareReceipts)
    const routeGroups = new Map<string, DeliveryReceipt[]>()
    for (const receipt of receipts) {
      const group = routeGroups.get(receipt.routeId) ?? []
      group.push(receipt)
      routeGroups.set(receipt.routeId, group)
    }
    for (const group of routeGroups.values()) {
      group.sort((left, right) => left.attempt - right.attempt)
      const first = group[0]
      if (!first || first.attempt !== 1) return historyInvalid('RECEIPT_ATTEMPT_SEQUENCE_INVALID')
      if (group.length > maximumAttempts) return historyInvalid('RETRY_ATTEMPTS_EXCEEDED')
      for (let index = 0; index < group.length; index += 1) {
        const current = group[index]
        if (!current) return historyInvalid('RECEIPT_HISTORY_INVALID')
        if (current.attempt !== index + 1) return historyInvalid('RECEIPT_ATTEMPT_SEQUENCE_INVALID')
        if (index === 0) continue
        const previous = group[index - 1]
        if (!previous) return historyInvalid('RECEIPT_PREVIOUS_ATTEMPT_MISSING')
        if (previous.status !== 'failed' && previous.status !== 'retry_wait') return historyInvalid('RECEIPT_ROUTE_TERMINAL')
        if (current.completedAt < previous.occurredAt) return historyInvalid('RECEIPT_RETRY_TIME_ROLLBACK')
      }
    }
    return historyValid(receipts)
  } catch {
    return historyInvalid('RECEIPT_HISTORY_RUNTIME_VALIDATION_FAILED')
  }
}

export function validateReceipt(plan: unknown, value: unknown, knownReceipts: readonly unknown[] = []): ReceiptValidationResult {
  try {
    const verifiedPlan = validateRoutingPlan(plan)
    if (!verifiedPlan.valid) return invalid('PLAN_INVALID', ...verifiedPlan.reasonCodes)
    if (!Array.isArray(knownReceipts)) return invalid('RECEIPT_HISTORY_INVALID')
    const known = validateReceiptHistory(verifiedPlan.plan, knownReceipts)
    if (!known.valid) return invalid(...known.reasonCodes)
    const normalized = normalizeReceiptCore(verifiedPlan.plan, value)
    if (!normalized.receipt) return invalid(...normalized.reasonCodes)
    const receipt = normalized.receipt
    const receiptFingerprint = fingerprint(receipt)
    if (receipt.attempt > 1 && !known.receipts.some((candidate) => candidate.routeId === receipt.routeId && candidate.attempt === receipt.attempt - 1)) return invalid('RECEIPT_PREVIOUS_ATTEMPT_MISSING')
    const existing = known.receipts.find((candidate) => receiptKey(candidate) === receiptKey(receipt))
    if (existing) {
      if (fingerprint(existing) === receiptFingerprint) return validReceipt(receiptFingerprint, true)
      return { ...invalid('RECEIPT_ATTEMPT_COLLISION'), collision: true }
    }
    const completedHistory = validateReceiptHistory(verifiedPlan.plan, [...known.receipts, receipt])
    if (!completedHistory.valid) return invalid(...completedHistory.reasonCodes)
    if (completedHistory.receipts.some((candidate) => candidate.executorRunId === receipt.executorRunId && fingerprint(candidate) !== receiptFingerprint)) return invalid('RECEIPT_EXECUTOR_RUN_REUSED')
    return validReceipt(receiptFingerprint)
  } catch {
    return invalid('RECEIPT_RUNTIME_VALIDATION_FAILED')
  }
}

export function validateRetry(plan: unknown, previous: unknown, next: unknown, history: readonly unknown[] = [], maximumAttempts = DEFAULT_MAXIMUM_ATTEMPTS): RetryValidationResult {
  try {
    const verifiedPlan = validateRoutingPlan(plan)
    if (!verifiedPlan.valid) return invalidRetry('PLAN_INVALID', ...verifiedPlan.reasonCodes)
    if (!Array.isArray(history)) return invalidRetry('RETRY_HISTORY_INVALID')
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > MAX_ATTEMPTS) return invalidRetry('RETRY_MAXIMUM_ATTEMPTS_INVALID')
    const previousNormalized = normalizeReceiptCore(verifiedPlan.plan, previous)
    const nextNormalized = normalizeReceiptCore(verifiedPlan.plan, next)
    if (!previousNormalized.receipt) return invalidRetry('PREVIOUS_RECEIPT_INVALID', ...previousNormalized.reasonCodes)
    if (!nextNormalized.receipt) return invalidRetry('NEXT_RECEIPT_INVALID', ...nextNormalized.reasonCodes)
    const before = previousNormalized.receipt
    const after = nextNormalized.receipt
    const historyWithPrevious = [...history, before]
    const beforeHistory = validateReceiptHistory(verifiedPlan.plan, historyWithPrevious, maximumAttempts)
    if (!beforeHistory.valid) return invalidRetry('PREVIOUS_HISTORY_INVALID', ...beforeHistory.reasonCodes)
    const latest = beforeHistory.receipts.filter((receipt) => receipt.routeId === before.routeId).at(-1)
    if (!latest || latest.attempt !== before.attempt || fingerprint(latest) !== fingerprint(before)) return invalidRetry('RETRY_PREVIOUS_NOT_LATEST')
    if (before.status !== 'failed' && before.status !== 'retry_wait') return invalidRetry('RETRY_PREVIOUS_STATUS_FORBIDDEN')
    if (after.routeId !== before.routeId) return invalidRetry('RETRY_ROUTE_MISMATCH')
    if (!sameLineage(before, after)) return invalidRetry('RETRY_LINEAGE_DRIFT')
    if (after.attempt !== before.attempt + 1) return invalidRetry('RETRY_ATTEMPT_NOT_CONTIGUOUS')
    if (after.attempt > maximumAttempts) return invalidRetry('RETRY_ATTEMPTS_EXCEEDED')
    if (after.executorRunId === before.executorRunId || beforeHistory.receipts.some((receipt) => receipt.executorRunId === after.executorRunId)) return invalidRetry('RETRY_EXECUTOR_RUN_REUSED')
    if (after.completedAt < before.occurredAt) return invalidRetry('RETRY_TIME_ROLLBACK')
    if (after.occurredAt < after.completedAt) return invalidRetry('RETRY_TIME_ORDER_INVALID')
    const complete = validateReceiptHistory(verifiedPlan.plan, [...beforeHistory.receipts, after], maximumAttempts)
    if (!complete.valid) return invalidRetry('NEXT_RECEIPT_INVALID', ...complete.reasonCodes)
    return { valid: true, reasonCodes: [], reasons: [] }
  } catch {
    return invalidRetry('RETRY_RUNTIME_VALIDATION_FAILED')
  }
}

export function routeForReceipt(plan: unknown, receipt: unknown): RouteIntent | null {
  try {
    const verifiedPlan = validateRoutingPlan(plan)
    if (!verifiedPlan.valid) return null
    if (!validateReceipt(verifiedPlan.plan, receipt).valid) return null
    const normalized = normalizeReceiptCore(verifiedPlan.plan, receipt)
    return normalized.receipt ? verifiedPlan.plan.routes.find((route) => route.routeId === normalized.receipt?.routeId) ?? null : null
  } catch {
    return null
  }
}
