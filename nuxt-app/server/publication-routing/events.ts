import { MAX_EVENT_DETAIL_LENGTH, SHA256_PATTERN } from './constants'
import { cloneAndFreeze, cloneCanonical, fingerprint } from './canonical'
import { exactKeys, isPlainObject, normalizeBoundedString, normalizeId, normalizeOpaqueReference } from './normalization'
import { normalizeReceiptForPlan, validateReceipt, validateReceiptHistory, validateRetry } from './receipts'
import { validateRoutingPlan } from './planner'
import type { DeliveryReceipt, EventAppendResult, PlanEventAggregate, ReceiptStatus, RouteEvent, RouteEventAggregate, RoutingPlan, OpaqueReference } from './types'

const EVENT_KEYS = ['planFingerprint', 'routeId', 'sequence', 'kind', 'attempt', 'executorRunId', 'receiptFingerprint', 'occurredAt', 'detail'] as const
const EVENT_REQUIRED_KEYS = ['planFingerprint', 'routeId', 'sequence', 'kind', 'attempt', 'executorRunId', 'receiptFingerprint', 'occurredAt'] as const
const RESULT_KINDS: readonly ReceiptStatus[] = ['delivered', 'blocked', 'failed', 'retry_wait']

function rejected(...reasonCodes: string[]): EventAppendResult {
  return { accepted: false, replay: false, collision: false, events: [], reasonCodes, reasons: reasonCodes }
}

function publicEvents(events: readonly RouteEvent[]): readonly RouteEvent[] {
  return events.map((event) => cloneCanonical(event) as RouteEvent)
}

function accepted(events: readonly RouteEvent[], replay = false): EventAppendResult {
  return { accepted: true, replay, collision: false, events: publicEvents(events), reasonCodes: [], reasons: [] }
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function statusFor(events: readonly RouteEvent[]): RouteEventAggregate['status'] {
  return events[events.length - 1]?.kind ?? 'planned'
}

function normalizeEvent(plan: RoutingPlan, event: unknown): { event: RouteEvent | null; reasonCodes: readonly string[] } {
  try {
    if (!isPlainObject(event) || !exactKeys(event, EVENT_KEYS, EVENT_REQUIRED_KEYS)) return { event: null, reasonCodes: ['EVENT_SHAPE_INVALID'] }
    const raw = event as Record<string, unknown>
    const rawPlanFingerprint = raw.planFingerprint
    const rawRouteId = raw.routeId
    const rawSequence = raw.sequence
    const rawKind = raw.kind
    const rawOccurredAt = raw.occurredAt
    if (rawPlanFingerprint !== plan.planFingerprint || typeof rawPlanFingerprint !== 'string' || !SHA256_PATTERN.test(rawPlanFingerprint)) return { event: null, reasonCodes: ['EVENT_PLAN_FINGERPRINT_INVALID'] }
    if (typeof rawRouteId !== 'string') return { event: null, reasonCodes: ['EVENT_ROUTE_ID_INVALID'] }
    const routeId = normalizeId(rawRouteId, 'event.routeId')
    if (!plan.routes.some((route) => route.routeId === routeId)) return { event: null, reasonCodes: ['EVENT_ROUTE_UNKNOWN'] }
    if (!isPositiveInteger(rawSequence)) return { event: null, reasonCodes: ['EVENT_SEQUENCE_INVALID'] }
    if (!isEpoch(rawOccurredAt) || rawOccurredAt < plan.plannedAt) return { event: null, reasonCodes: ['EVENT_OCCURRED_AT_INVALID'] }
    if (Object.prototype.hasOwnProperty.call(event, 'detail')) normalizeBoundedString(raw.detail, 'event.detail', MAX_EVENT_DETAIL_LENGTH)
    const detail = Object.prototype.hasOwnProperty.call(event, 'detail') ? { detail: raw.detail as string } : {}
    if (rawKind === 'planned') {
      if (rawSequence !== 1 || raw.attempt !== null || raw.executorRunId !== null || raw.receiptFingerprint !== null) return { event: null, reasonCodes: ['PLANNED_EVENT_CONTRACT_INVALID'] }
      return { event: { planFingerprint: plan.planFingerprint, routeId, sequence: 1, kind: 'planned', attempt: null, executorRunId: null, receiptFingerprint: null, occurredAt: rawOccurredAt, ...detail }, reasonCodes: [] }
    }
    if (!RESULT_KINDS.includes(rawKind as ReceiptStatus)) return { event: null, reasonCodes: ['EVENT_KIND_INVALID'] }
    const rawAttempt = raw.attempt
    if (!isPositiveInteger(rawAttempt)) return { event: null, reasonCodes: ['RESULT_EVENT_ATTEMPT_INVALID'] }
    const executorRunId = normalizeOpaqueReference(raw.executorRunId, 'event.executorRunId') as OpaqueReference
    if (typeof raw.receiptFingerprint !== 'string' || !SHA256_PATTERN.test(raw.receiptFingerprint)) return { event: null, reasonCodes: ['EVENT_RECEIPT_FINGERPRINT_INVALID'] }
    return { event: { planFingerprint: plan.planFingerprint, routeId, sequence: rawSequence, kind: rawKind as Exclude<ReceiptStatus, 'planned'>, attempt: rawAttempt, executorRunId, receiptFingerprint: raw.receiptFingerprint, occurredAt: rawOccurredAt, ...detail }, reasonCodes: [] }
  } catch {
    return { event: null, reasonCodes: ['EVENT_RUNTIME_VALIDATION_FAILED'] }
  }
}

export class RouteEventLedger {
  private readonly byRoute = new Map<string, RouteEvent[]>()
  private readonly receipts: DeliveryReceipt[] = []
  private readonly plan: RoutingPlan

  constructor(plan: unknown) {
    const verified = validateRoutingPlan(plan)
    if (!verified.valid) throw new Error(`invalid routing plan: ${verified.reasonCodes.join('; ')}`)
    this.plan = cloneAndFreeze(verified.plan)
  }

  append(value: unknown, receiptValue?: unknown): EventAppendResult {
    try {
      const normalized = normalizeEvent(this.plan, value)
      if (!normalized.event) return rejected(...normalized.reasonCodes)
      const event = normalized.event
      const events = this.byRoute.get(event.routeId) ?? []
      const sameSequence = events.find((candidate) => candidate.sequence === event.sequence)
      let normalizedReceipt: DeliveryReceipt | null = null
      let resultReceiptFingerprint: string | null = null
      if (event.kind !== 'planned') {
        if (receiptValue === undefined) return rejected('RESULT_EVENT_RECEIPT_REQUIRED')
        const receiptResult = validateReceipt(this.plan, receiptValue, this.receipts)
        if (!receiptResult.valid || !receiptResult.receiptFingerprint) {
          if (receiptResult.collision) return { ...rejected('EVENT_RECEIPT_COLLISION', ...receiptResult.reasonCodes), collision: true }
          return rejected('EVENT_RECEIPT_INVALID', ...receiptResult.reasonCodes)
        }
        normalizedReceipt = normalizeReceiptForPlan(this.plan, receiptValue)
        if (!normalizedReceipt) return rejected('EVENT_RECEIPT_INVALID', 'RECEIPT_NORMALIZATION_FAILED')
        resultReceiptFingerprint = receiptResult.receiptFingerprint
        if (normalizedReceipt.occurredAt !== event.occurredAt) return rejected('EVENT_RECEIPT_TIMESTAMP_MISMATCH')
        if (normalizedReceipt.routeId !== event.routeId || normalizedReceipt.status !== event.kind || normalizedReceipt.attempt !== event.attempt || normalizedReceipt.executorRunId !== event.executorRunId || resultReceiptFingerprint !== event.receiptFingerprint || normalizedReceipt.planFingerprint !== event.planFingerprint) return rejected('EVENT_RECEIPT_BINDING_INVALID')
      } else if (receiptValue !== undefined) {
        return rejected('PLANNED_EVENT_RECEIPT_FORBIDDEN')
      }
      const eventFingerprint = fingerprint(event)
      if (sameSequence) {
        if (fingerprint(sameSequence) === eventFingerprint) return accepted(events, true)
        return { ...rejected('EVENT_SEQUENCE_COLLISION'), collision: true }
      }
      if (events.length === 0 && event.kind !== 'planned') return rejected('EVENT_PLANNED_REQUIRED')
      const expectedSequence = events.length + 1
      if (event.sequence !== expectedSequence) return rejected('EVENT_SEQUENCE_NOT_CONTIGUOUS')
      const previousEvent = events[events.length - 1]
      if (previousEvent && event.occurredAt < previousEvent.occurredAt) return rejected('EVENT_TIME_ROLLBACK')
      if (event.kind === 'planned') {
        if (events.length !== 0) return rejected('PLANNED_EVENT_MUST_BE_FIRST')
        const updated = [...events, cloneAndFreeze(event)]
        this.byRoute.set(event.routeId, updated)
        return accepted(updated)
      }
      const currentStatus = statusFor(events)
      if (currentStatus === 'delivered' || currentStatus === 'blocked') return rejected('EVENT_ROUTE_TERMINAL')
      const previousResultEvent = [...events].reverse().find((candidate) => candidate.kind !== 'planned')
      if (previousResultEvent) {
        const previousReceipt = this.receipts.find((candidate) => candidate.routeId === event.routeId && candidate.attempt === previousResultEvent.attempt)
        if (!previousReceipt || !normalizedReceipt) return rejected('EVENT_PREVIOUS_RECEIPT_MISSING')
        const retryResult = validateRetry(this.plan, previousReceipt, normalizedReceipt, this.receipts)
        if (!retryResult.valid) return rejected('EVENT_RETRY_INVALID', ...retryResult.reasonCodes)
      } else if (event.attempt !== 1) {
        return rejected('EVENT_FIRST_RESULT_ATTEMPT_INVALID')
      }
      if (!normalizedReceipt || !resultReceiptFingerprint) return rejected('EVENT_RECEIPT_REQUIRED')
      const storedEvent = cloneAndFreeze(event)
      const storedReceipt = cloneAndFreeze(normalizedReceipt)
      const updated = [...events, storedEvent]
      this.byRoute.set(event.routeId, updated)
      this.receipts.push(storedReceipt)
      return accepted(updated)
    } catch {
      return rejected('EVENT_RUNTIME_VALIDATION_FAILED')
    }
  }

  eventsFor(routeId: string): readonly RouteEvent[] {
    if (!this.plan.routes.some((route) => route.routeId === routeId)) return []
    return publicEvents(this.byRoute.get(routeId) ?? [])
  }

  aggregateRoute(routeId: string): RouteEventAggregate {
    if (!this.plan.routes.some((route) => route.routeId === routeId)) throw new Error('EVENT_ROUTE_UNKNOWN')
    const events = this.byRoute.get(routeId) ?? []
    return {
      routeId,
      status: statusFor(events),
      delivered: events.filter((event) => event.kind === 'delivered').length,
      blocked: events.filter((event) => event.kind === 'blocked').length,
      failed: events.filter((event) => event.kind === 'failed').length,
      retryWait: events.filter((event) => event.kind === 'retry_wait').length,
      eventCount: events.length,
    }
  }

  aggregate(): PlanEventAggregate {
    const routes = this.plan.routes.map((route) => this.aggregateRoute(route.routeId))
    const statuses = routes.map((route) => route.status)
    let overall: PlanEventAggregate['overall'] = 'planned'
    if (statuses.every((status) => status === 'delivered')) overall = 'delivered'
    else if (statuses.every((status) => status === 'blocked')) overall = 'blocked'
    else if (statuses.every((status) => status === 'failed')) overall = 'failed'
    else if (statuses.every((status) => status === 'retry_wait')) overall = 'retry_wait'
    else if (statuses.some((status) => status !== 'planned')) overall = 'partial'
    return cloneAndFreeze({ planFingerprint: this.plan.planFingerprint, overall, routes })
  }
}

export function aggregateEvents(plan: unknown, events: readonly unknown[], receipts: readonly unknown[] = []): PlanEventAggregate {
  if (!Array.isArray(events) || !Array.isArray(receipts)) throw new Error('events and receipts must be arrays')
  const history = validateReceiptHistory(plan, receipts)
  if (!history.valid) throw new Error(history.reasonCodes.join('; '))
  const receiptByFingerprint = new Map(history.receipts.map((receipt) => [fingerprint(receipt), receipt]))
  const usedReceiptFingerprints = new Set<string>()
  const ledger = new RouteEventLedger(plan)
  for (const event of events) {
    if (!isPlainObject(event)) throw new Error('EVENT_SHAPE_INVALID')
    const kind = event.kind
    const receiptFingerprint = event.receiptFingerprint
    const receipt = kind === 'planned' ? undefined : receiptByFingerprint.get(typeof receiptFingerprint === 'string' ? receiptFingerprint : '')
    if (kind !== 'planned') {
      if (!receipt) throw new Error('EVENT_RECEIPT_MISSING')
      usedReceiptFingerprints.add(fingerprint(receipt))
    }
    const result = ledger.append(event, receipt)
    if (!result.accepted && !result.replay) throw new Error(result.reasonCodes.join('; '))
  }
  for (const receipt of history.receipts) {
    if (!usedReceiptFingerprints.has(fingerprint(receipt))) throw new Error('EVENT_RECEIPT_UNUSED')
  }
  return ledger.aggregate()
}
