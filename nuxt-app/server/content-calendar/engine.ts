import { createHash } from 'node:crypto'
import { CALENDAR_ENTRY_LIFECYCLE_TRANSITIONS, CALENDAR_ENTRY_STATUSES, CALENDAR_REASON_CODES, CALENDAR_STATUSES, CONTENT_CALENDAR_ENGINE_VERSION, CONTENT_CALENDAR_LIMITATIONS, CONTENT_CALENDAR_LIMITS, compareAscii, isEnumValue, isPositiveInteger, isRevision } from './policy-catalog'
import type { CalendarEntryStatus, CalendarReasonCode, CalendarStatus, ContentPriority } from './policy-catalog'
import { ContentCalendarValidationError, normalizeContentCalendarRequest } from './normalization'
import type { ContentCalendarEntry, ContentCalendarOpportunity, ContentCalendarRequest, ContentCalendarResult, DueContentWork, MaterializeDueContentWorkInput, MaterializeDueContentWorkResult, NormalizedContentCalendarRequest, ReplanContentCalendarInput, UnscheduledOpportunity } from './types'

function canonicalize(value: unknown): unknown {
  if (value === undefined) throw new Error('undefined values are not allowed in canonical JSON')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite numbers are not allowed in canonical JSON')
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return Object.keys(object).sort(compareAscii).reduce<Record<string, unknown>>((result, key) => {
      result[key] = canonicalize(object[key])
      return result
    }, {})
  }
  return value
}

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(canonicalize(value))
  if (result === undefined) throw new Error('value cannot be serialized as canonical JSON')
  return result
}

export function fingerprintCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function priorityRank(priority: ContentPriority): number {
  return priority === 'high' ? 0 : priority === 'medium' ? 1 : 2
}

function compareOpportunities(left: ContentCalendarOpportunity, right: ContentCalendarOpportunity): number {
  return priorityRank(left.priority) - priorityRank(right.priority)
    || left.strategyRecommendationId - right.strategyRecommendationId
    || compareAscii(left.id, right.id)
}

function compareEntries(left: ContentCalendarEntry, right: ContentCalendarEntry): number {
  return compareAscii(left.plannedLocalDate, right.plannedLocalDate) || compareAscii(left.scheduleKey, right.scheduleKey)
}

function compareUnscheduled(left: UnscheduledOpportunity, right: UnscheduledOpportunity): number {
  return compareAscii(left.opportunityId, right.opportunityId) || compareAscii(left.reasonCode, right.reasonCode)
}

function uniqueSortedReasonCodes(codes: CalendarReasonCode[]): CalendarReasonCode[] {
  return [...new Set(codes)].sort(compareAscii)
}

function monthKey(date: string): string {
  return date.slice(0, 7)
}

function parseDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

function addCalendarDays(date: string, days: number): string {
  const next = parseDateOnly(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = parseDateOnly(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function assertExactKeys(object: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(object).sort(compareAscii)
  const allowed = [...expected].sort(compareAscii)
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new Error(`${label} contains missing or unexpected fields`)
}

function assertRequiredAndOptionalKeys(object: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const actual = Object.keys(object)
  const allowed = new Set([...required, ...optional])
  if (actual.some(key => !allowed.has(key)) || required.some(key => !actual.includes(key))) throw new Error(`${label} contains missing or unexpected fields`)
}

function assertTrustedExpectedPlanFingerprint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('expectedPlanFingerprint is malformed')
}

function entryIdentityInput(entry: Pick<ContentCalendarEntry, 'scheduleKey' | 'plannedLocalDate' | 'opportunityId' | 'evidenceSnapshotHash'>): Record<string, unknown> {
  return { engineVersion: CONTENT_CALENDAR_ENGINE_VERSION, scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, opportunityId: entry.opportunityId, evidenceSnapshotHash: entry.evidenceSnapshotHash }
}

function expectedEntryId(entry: Pick<ContentCalendarEntry, 'scheduleKey' | 'plannedLocalDate' | 'opportunityId' | 'evidenceSnapshotHash'>): string {
  return `entry-${fingerprintCanonical(entryIdentityInput(entry))}`
}

function expectedIdempotencyKey(entry: Pick<ContentCalendarEntry, 'scheduleKey' | 'opportunityId' | 'strategyRecommendationId' | 'evidenceSnapshotHash'>): string {
  return `content-calendar-${fingerprintCanonical({ scheduleKey: entry.scheduleKey, opportunityId: entry.opportunityId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash })}`
}

function createSlots(request: NormalizedContentCalendarRequest): string[] {
  const slots: string[] = []
  let cursor = request.planStartDate
  while (cursor <= request.planEndDate && slots.length <= CONTENT_CALENDAR_LIMITS.maxTotalItems * 4) {
    slots.push(cursor)
    cursor = addCalendarDays(cursor, request.cadenceDays)
  }
  return slots
}

function createEntry(request: NormalizedContentCalendarRequest, opportunity: ContentCalendarOpportunity, plannedLocalDate: string, ordinal: number): ContentCalendarEntry {
  const scheduleKey = `${request.clientScopeKey}|${plannedLocalDate}|slot-${String(ordinal).padStart(4, '0')}`
  const entryIdentity = { scheduleKey, plannedLocalDate, opportunityId: opportunity.id, evidenceSnapshotHash: opportunity.evidenceSnapshotHash }
  const idempotencyInput = { scheduleKey, opportunityId: opportunity.id, strategyRecommendationId: opportunity.strategyRecommendationId, evidenceSnapshotHash: opportunity.evidenceSnapshotHash }
  return { entryId: expectedEntryId(entryIdentity), scheduleKey, plannedLocalDate, publishLocalTime: request.publishLocalTime, timeZone: request.timeZone, opportunityId: opportunity.id, strategyRecommendationId: opportunity.strategyRecommendationId, contentType: opportunity.contentType, language: opportunity.language, topicCluster: opportunity.topicCluster, evidenceSnapshotHash: opportunity.evidenceSnapshotHash, estimatedCostUnits: opportunity.estimatedCostUnits, status: 'planned', idempotencyKey: expectedIdempotencyKey(idempotencyInput) }
}

function acceptedOpportunityInput(opportunity: ContentCalendarOpportunity): Record<string, unknown> {
  return { id: opportunity.id, strategyRecommendationId: opportunity.strategyRecommendationId, title: opportunity.title, contentType: opportunity.contentType, language: opportunity.language, priority: opportunity.priority, topicCluster: opportunity.topicCluster, evidenceSnapshotHash: opportunity.evidenceSnapshotHash, estimatedCostUnits: opportunity.estimatedCostUnits, ruleIds: opportunity.ruleIds, authoritySourceIds: opportunity.authoritySourceIds }
}

function entryFingerprintInput(entry: ContentCalendarEntry): Record<string, unknown> {
  return { entryId: entry.entryId, scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, opportunityId: entry.opportunityId, strategyRecommendationId: entry.strategyRecommendationId, contentType: entry.contentType, language: entry.language, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, estimatedCostUnits: entry.estimatedCostUnits, status: entry.status, idempotencyKey: entry.idempotencyKey }
}

function calculatePlanFingerprint(request: NormalizedContentCalendarRequest, entries: ContentCalendarEntry[], unscheduled: UnscheduledOpportunity[], reasonCodes: CalendarReasonCode[], revision: number, previousPlanFingerprint: string | null): string {
  return fingerprintCanonical({
    engineVersion: CONTENT_CALENDAR_ENGINE_VERSION,
    revision,
    previousPlanFingerprint,
    settings: { clientScopeKey: request.clientScopeKey, planStartDate: request.planStartDate, planEndDate: request.planEndDate, timeZone: request.timeZone, publishLocalTime: request.publishLocalTime, cadenceDays: request.cadenceDays, monthlyBudgetUnits: request.monthlyBudgetUnits, defaultCostUnits: request.defaultCostUnits, maxItemsPerCalendarMonth: request.maxItemsPerCalendarMonth, maximumTotalItems: request.maximumTotalItems, catchUpPolicy: request.catchUpPolicy, evidenceSnapshotHash: request.evidenceSnapshotHash },
    acceptedOpportunities: request.opportunities.filter(opportunity => opportunity.status === 'selected').map(acceptedOpportunityInput).sort((left, right) => compareAscii(`${left.strategyRecommendationId}|${left.id}`, `${right.strategyRecommendationId}|${right.id}`)),
    entries: [...entries].sort(compareEntries).map(entryFingerprintInput),
    unscheduled: [...unscheduled].sort(compareUnscheduled),
    reasonCodes: uniqueSortedReasonCodes(reasonCodes),
  })
}

function resultStatus(entries: ContentCalendarEntry[], unscheduled: UnscheduledOpportunity[]): CalendarStatus {
  if (entries.length === 0) return 'blocked'
  return unscheduled.length > 0 ? 'partial' : 'ready'
}

function buildResult(request: NormalizedContentCalendarRequest, entries: ContentCalendarEntry[], unscheduled: UnscheduledOpportunity[], reasonCodes: CalendarReasonCode[], revision = 1, previousPlanFingerprint: string | null = null): ContentCalendarResult {
  const sortedEntries = [...entries].sort(compareEntries)
  const sortedUnscheduled = [...unscheduled].sort(compareUnscheduled)
  const normalizedReasons = uniqueSortedReasonCodes(reasonCodes)
  const status = resultStatus(sortedEntries, sortedUnscheduled)
  const effectiveRevision = sortedEntries.length === 0 ? 0 : revision
  if (effectiveRevision > 0 && !isRevision(effectiveRevision)) throw new Error('calendar revision exceeds bounded safe range')
  const effectivePrevious = effectiveRevision > 1 ? previousPlanFingerprint : null
  if (effectiveRevision > 1 && (typeof effectivePrevious !== 'string' || !/^[0-9a-f]{64}$/.test(effectivePrevious))) throw new Error('calendar previousPlanFingerprint is required for revision continuity')
  return { engineVersion: CONTENT_CALENDAR_ENGINE_VERSION, status, revision: effectiveRevision, previousPlanFingerprint: effectivePrevious, normalizedRequest: request, entries: sortedEntries, unscheduledOpportunities: sortedUnscheduled, reasonCodes: normalizedReasons, limitations: [...CONTENT_CALENDAR_LIMITATIONS], planFingerprint: calculatePlanFingerprint(request, sortedEntries, sortedUnscheduled, normalizedReasons, effectiveRevision, effectivePrevious) }
}

function safeBlocked(reasonCode: CalendarReasonCode, normalizedRequest: NormalizedContentCalendarRequest | null = null): ContentCalendarResult {
  const revision = 0
  const previousPlanFingerprint = null
  return { engineVersion: CONTENT_CALENDAR_ENGINE_VERSION, status: 'blocked', revision, previousPlanFingerprint, normalizedRequest, entries: [], unscheduledOpportunities: [], reasonCodes: [reasonCode], limitations: [...CONTENT_CALENDAR_LIMITATIONS], planFingerprint: fingerprintCanonical({ engineVersion: CONTENT_CALENDAR_ENGINE_VERSION, status: 'blocked', revision, previousPlanFingerprint, reasonCodes: [reasonCode] }) }
}

function validateFixedEntries(entries: ContentCalendarEntry[], request: NormalizedContentCalendarRequest, requireCurrentCadenceSlot = true): void {
  const scheduleKeys = new Set<string>()
  const entryIds = new Set<string>()
  const opportunityIds = new Set<string>()
  const dates = new Set<string>()
  for (const entry of entries) {
    if (!isRecordSafe(entry)) throw new Error('calendar entry must be an object')
    assertExactKeys(entry as unknown as Record<string, unknown>, ['entryId', 'scheduleKey', 'plannedLocalDate', 'publishLocalTime', 'timeZone', 'opportunityId', 'strategyRecommendationId', 'contentType', 'language', 'topicCluster', 'evidenceSnapshotHash', 'estimatedCostUnits', 'status', 'idempotencyKey'], 'calendar entry')
    if (typeof entry.entryId !== 'string' || entry.entryId.length !== 70 || !/^entry-[0-9a-f]{64}$/.test(entry.entryId)) throw new Error('calendar entryId is malformed')
    if (typeof entry.scheduleKey !== 'string' || entry.scheduleKey.length > CONTENT_CALENDAR_LIMITS.maxIdentifierLength * 2) throw new Error('calendar scheduleKey is malformed')
    const scheduleParts = /^(?:([A-Za-z0-9_:-]+))\|(\d{4}-\d{2}-\d{2})\|slot-(\d{4})$/.exec(entry.scheduleKey)
    if (!scheduleParts || scheduleParts[1] !== request.clientScopeKey || scheduleParts[2] !== entry.plannedLocalDate) throw new Error('calendar scheduleKey does not match scope or date')
    if (!isDateOnly(entry.plannedLocalDate)) throw new Error('calendar plannedLocalDate is malformed')
    const slotOrdinal = Number(scheduleParts[3])
    if (!Number.isInteger(slotOrdinal) || slotOrdinal < 0 || slotOrdinal >= CONTENT_CALENDAR_LIMITS.maxTotalItems * 4) throw new Error('calendar schedule slot ordinal is malformed')
    if (typeof entry.publishLocalTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry.publishLocalTime)) throw new Error('calendar publishLocalTime is malformed')
    if (typeof entry.timeZone !== 'string' || entry.timeZone.length === 0) throw new Error('calendar timeZone is malformed')
    if (typeof entry.opportunityId !== 'string' || entry.opportunityId.length === 0) throw new Error('calendar opportunityId is malformed')
    if (!isPositiveInteger(entry.strategyRecommendationId, CONTENT_CALENDAR_LIMITS.maxStrategyRecommendationId)) throw new Error('calendar strategyRecommendationId is malformed')
    if (!isEnumValue(['article', 'faq', 'service_page'] as const, entry.contentType) || !isEnumValue(['en', 'zh-hant'] as const, entry.language)) throw new Error('calendar content type or language is malformed')
    if (typeof entry.topicCluster !== 'string' || entry.topicCluster.length === 0 || entry.topicCluster.length > CONTENT_CALENDAR_LIMITS.maxTopicClusterLength) throw new Error('calendar topicCluster is malformed')
    if (typeof entry.evidenceSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.evidenceSnapshotHash)) throw new Error('calendar evidence hash is malformed')
    if (!isPositiveInteger(entry.estimatedCostUnits, CONTENT_CALENDAR_LIMITS.maxBudgetUnits)) throw new Error('calendar estimated cost is malformed')
    if (!isEnumValue(CALENDAR_ENTRY_STATUSES, entry.status)) throw new Error('calendar entry status is unknown')
    if (typeof entry.idempotencyKey !== 'string' || !/^content-calendar-[0-9a-f]{64}$/.test(entry.idempotencyKey)) throw new Error('calendar idempotencyKey is malformed')
    const opportunity = request.opportunities.find(candidate => candidate.id === entry.opportunityId)
    if (!opportunity || opportunity.status !== 'selected') throw new Error('calendar entry opportunity does not exist as selected in normalizedRequest')
    if (entry.strategyRecommendationId !== opportunity.strategyRecommendationId || entry.contentType !== opportunity.contentType || entry.language !== opportunity.language || entry.topicCluster !== opportunity.topicCluster || entry.evidenceSnapshotHash !== opportunity.evidenceSnapshotHash || entry.estimatedCostUnits !== opportunity.estimatedCostUnits || entry.publishLocalTime !== request.publishLocalTime || entry.timeZone !== request.timeZone) throw new Error('calendar entry does not match its opportunity or request')
    if (entry.evidenceSnapshotHash !== request.evidenceSnapshotHash) throw new Error('calendar entry evidence does not match request')
    if (entry.entryId !== expectedEntryId(entry)) throw new Error('calendar entryId integrity mismatch')
    if (entry.idempotencyKey !== expectedIdempotencyKey(entry)) throw new Error('calendar idempotencyKey integrity mismatch')
    if (entry.status === 'blocked') throw new Error('blocked entries are not emitted by this engine')
    if (requireCurrentCadenceSlot || entry.status === 'planned') {
      const slots = createSlots(request)
      const slotIndex = slots.indexOf(entry.plannedLocalDate)
      if (slotIndex < 0 || slotOrdinal !== slotIndex) throw new Error('calendar entry date or slot ordinal is not a legal deterministic cadence slot')
    }
    if (scheduleKeys.has(entry.scheduleKey) || entryIds.has(entry.entryId) || opportunityIds.has(entry.opportunityId) || dates.has(entry.plannedLocalDate)) throw new Error('calendar contains duplicate entry identity or date')
    scheduleKeys.add(entry.scheduleKey)
    entryIds.add(entry.entryId)
    opportunityIds.add(entry.opportunityId)
    dates.add(entry.plannedLocalDate)
  }
  if (entries.length > request.maximumTotalItems) throw new Error('calendar entries exceed maximumTotalItems')
}

function assertCalendarTopLevel(value: Record<string, unknown>): void {
  assertExactKeys(value, ['engineVersion', 'status', 'revision', 'previousPlanFingerprint', 'normalizedRequest', 'entries', 'unscheduledOpportunities', 'reasonCodes', 'limitations', 'planFingerprint'], 'calendar result')
  if (value.engineVersion !== CONTENT_CALENDAR_ENGINE_VERSION || !isEnumValue(CALENDAR_STATUSES, value.status)) throw new Error('calendar top-level version or status is malformed')
  if (!isRevision(value.revision) && value.revision !== 0) throw new Error('calendar revision is malformed')
  if (value.revision === 0 && value.status !== 'blocked') throw new Error('only blocked calendar may have revision zero')
  if (value.revision === 1 && value.previousPlanFingerprint !== null) throw new Error('revision one must have null previousPlanFingerprint')
  if (value.revision > 1 && (typeof value.previousPlanFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.previousPlanFingerprint))) throw new Error('revision continuity fingerprint is malformed')
  if (value.revision === 0 && value.previousPlanFingerprint !== null) throw new Error('blocked calendar must have null previousPlanFingerprint')
  if (!Array.isArray(value.entries) || !Array.isArray(value.unscheduledOpportunities) || !Array.isArray(value.reasonCodes) || !Array.isArray(value.limitations)) throw new Error('calendar top-level arrays are malformed')
  if (value.revision === 0 && value.entries.length > 0) throw new Error('blocked calendar cannot contain entries')
  if (typeof value.planFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.planFingerprint)) throw new Error('calendar planFingerprint is malformed')
}

function isRecordSafe(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateUnscheduled(value: unknown, request: NormalizedContentCalendarRequest): UnscheduledOpportunity[] {
  if (!Array.isArray(value) || value.length > CONTENT_CALENDAR_LIMITS.maxUnscheduledItems) throw new Error('unscheduledOpportunities is malformed')
  const result = value.map((item, index) => {
    if (!isRecordSafe(item)) throw new Error(`unscheduledOpportunities[${index}] is malformed`)
    assertExactKeys(item, ['opportunityId', 'reasonCode'], `unscheduledOpportunities[${index}]`)
    if (typeof item.opportunityId !== 'string' || !request.opportunities.some(opportunity => opportunity.id === item.opportunityId)) throw new Error('unscheduled opportunity id does not exist')
    if (!isEnumValue(CALENDAR_REASON_CODES, item.reasonCode)) throw new Error('unscheduled reasonCode is unknown')
    return { opportunityId: item.opportunityId, reasonCode: item.reasonCode }
  })
  const opportunityIds = result.map(item => item.opportunityId)
  if (new Set(opportunityIds).size !== opportunityIds.length) throw new Error('an opportunity cannot have multiple unscheduled reasons')
  return result.sort(compareUnscheduled)
}

function validateReasonCodes(value: unknown): CalendarReasonCode[] {
  if (!Array.isArray(value) || value.some(code => !isEnumValue(CALENDAR_REASON_CODES, code))) throw new Error('reasonCodes are malformed')
  const result = value as CalendarReasonCode[]
  if (new Set(result).size !== result.length || result.some((code, index) => index > 0 && compareAscii(result[index - 1] as string, code) >= 0)) throw new Error('reasonCodes must be unique and ASCII sorted')
  return result
}

function validateCalendarInput(value: unknown): ContentCalendarResult {
  if (!isRecordSafe(value)) throw new Error('calendar must be an object')
  assertCalendarTopLevel(value)
  const normalizedRequestValue = value.normalizedRequest
  const normalizedRequest = normalizeContentCalendarRequest(normalizedRequestValue)
  if (canonicalJson(normalizedRequest) !== canonicalJson(normalizedRequestValue)) throw new Error('calendar normalizedRequest is not canonical or was tampered')
  const entries = value.entries as ContentCalendarEntry[]
  if (entries.length > CONTENT_CALENDAR_LIMITS.maxTotalItems) throw new Error('calendar entries exceed global maximum')
  const sortedEntries = [...entries].sort(compareEntries)
  validateFixedEntries(entries, normalizedRequest, false)
  const unscheduled = validateUnscheduled(value.unscheduledOpportunities, normalizedRequest)
  const reasonCodes = validateReasonCodes(value.reasonCodes)
  const entryOpportunityIds = new Set(entries.map(entry => entry.opportunityId))
  const unscheduledOpportunityIds = new Set(unscheduled.map(item => item.opportunityId))
  if ([...entryOpportunityIds].some(id => unscheduledOpportunityIds.has(id))) throw new Error('an opportunity cannot be both scheduled and unscheduled')
  for (const opportunity of normalizedRequest.opportunities) {
    const represented = entryOpportunityIds.has(opportunity.id) || unscheduledOpportunityIds.has(opportunity.id)
    if (!represented) throw new Error('calendar does not account for every opportunity')
    const unscheduledItem = unscheduled.find(item => item.opportunityId === opportunity.id)
    if (opportunity.status === 'selected' && unscheduledItem?.reasonCode === 'OPPORTUNITY_NOT_SELECTED') throw new Error('selected opportunity cannot use OPPORTUNITY_NOT_SELECTED')
    if (opportunity.status !== 'selected' && entryOpportunityIds.has(opportunity.id)) throw new Error('non-selected opportunity cannot have a calendar entry')
    if (opportunity.status !== 'selected' && unscheduledItem?.reasonCode !== 'OPPORTUNITY_NOT_SELECTED') throw new Error('non-selected opportunity must use OPPORTUNITY_NOT_SELECTED')
  }
  if (!Array.isArray(value.limitations) || canonicalJson(value.limitations) !== canonicalJson([...CONTENT_CALENDAR_LIMITATIONS])) throw new Error('calendar limitations are malformed or tampered')
  const fixedEntries = entries.filter(entry => entry.status !== 'planned')
  const expectedCalendar = buildNormalizedCalendar(normalizedRequest, fixedEntries, false)
  const executedPreserved = fixedEntries.some(entry => entry.status === 'materialized' || entry.status === 'completed')
  const expectedReasons = uniqueSortedReasonCodes([...expectedCalendar.reasonCodes, ...(executedPreserved && reasonCodes.includes('REPLAN_PRESERVED_EXECUTED') ? ['REPLAN_PRESERVED_EXECUTED'] as CalendarReasonCode[] : [])])
  if (!executedPreserved && reasonCodes.includes('REPLAN_PRESERVED_EXECUTED')) throw new Error('REPLAN_PRESERVED_EXECUTED requires a preserved executed entry')
  if (canonicalJson(reasonCodes) !== canonicalJson(expectedReasons)) throw new Error('calendar reasonCodes do not match semantic state')
  if (canonicalJson(sortedEntries) !== canonicalJson(expectedCalendar.entries) || canonicalJson(unscheduled) !== canonicalJson(expectedCalendar.unscheduledOpportunities)) throw new Error('calendar entries or unscheduled state does not match deterministic reconstruction')
  const revision = value.revision as number
  const previousPlanFingerprint = value.previousPlanFingerprint as string | null
  const expectedStatus = resultStatus(entries, unscheduled)
  if (value.status !== expectedStatus || expectedStatus !== expectedCalendar.status) throw new Error('calendar status does not match reconstructed state')
  const expectedFingerprint = calculatePlanFingerprint(normalizedRequest, entries, unscheduled, reasonCodes, revision, previousPlanFingerprint)
  if (value.planFingerprint !== expectedFingerprint) throw new Error('calendar planFingerprint integrity mismatch')
  return { engineVersion: CONTENT_CALENDAR_ENGINE_VERSION, status: expectedStatus, revision, previousPlanFingerprint, normalizedRequest, entries: sortedEntries, unscheduledOpportunities: unscheduled, reasonCodes, limitations: [...CONTENT_CALENDAR_LIMITATIONS], planFingerprint: expectedFingerprint }
}

function buildNormalizedCalendar(request: NormalizedContentCalendarRequest, fixedEntries: ContentCalendarEntry[] = [], fixedEntriesMustMatchCurrentCadence = false): ContentCalendarResult {
  validateFixedEntries(fixedEntries, request, fixedEntriesMustMatchCurrentCadence)
  if (fixedEntries.length > request.maximumTotalItems) return safeBlocked('PLAN_ITEM_CAP_REACHED', request)
  const entries = [...fixedEntries]
  const usedOpportunityIds = new Set(fixedEntries.map(entry => entry.opportunityId))
  const usedDates = new Set(fixedEntries.map(entry => entry.plannedLocalDate))
  const monthlySpend = new Map<string, number>()
  const monthlyCount = new Map<string, number>()
  const historicalReasons: CalendarReasonCode[] = []
  for (const entry of fixedEntries) {
    const key = monthKey(entry.plannedLocalDate)
    monthlySpend.set(key, (monthlySpend.get(key) ?? 0) + entry.estimatedCostUnits)
    monthlyCount.set(key, (monthlyCount.get(key) ?? 0) + 1)
  }
  if ([...monthlySpend.entries()].some(([key, spend]) => spend > request.monthlyBudgetUnits)) historicalReasons.push('HISTORICAL_FIXED_OVER_BUDGET')
  if ([...monthlyCount.entries()].some(([key, count]) => count > request.maxItemsPerCalendarMonth)) historicalReasons.push('HISTORICAL_MONTHLY_ITEM_CAP_EXCEEDED')
  const selected = request.opportunities.filter(opportunity => opportunity.status === 'selected' && !usedOpportunityIds.has(opportunity.id)).sort(compareOpportunities)
  const nonSelected = request.opportunities.filter(opportunity => opportunity.status !== 'selected').map(opportunity => ({ opportunityId: opportunity.id, reasonCode: 'OPPORTUNITY_NOT_SELECTED' as const }))
  const slots = createSlots(request).map((date, index) => ({ date, index })).filter(slot => !usedDates.has(slot.date))
  const scheduledOpportunityIds = new Set<string>()
  let previousTopicCluster = [...entries].sort(compareEntries).at(-1)?.topicCluster

  for (const { date: slot, index: slotIndex } of slots) {
    if (entries.length >= request.maximumTotalItems) break
    const key = monthKey(slot)
    if ((monthlyCount.get(key) ?? 0) >= request.maxItemsPerCalendarMonth) continue
    const remainingCandidates = selected.filter(opportunity => !scheduledOpportunityIds.has(opportunity.id))
    if (remainingCandidates.length === 0) break
    const affordableCandidates = remainingCandidates.filter(opportunity => (monthlySpend.get(key) ?? 0) + opportunity.estimatedCostUnits <= request.monthlyBudgetUnits)
    const differentTopic = previousTopicCluster === undefined ? affordableCandidates : affordableCandidates.filter(opportunity => opportunity.topicCluster !== previousTopicCluster)
    const affordable = (differentTopic.length > 0 ? differentTopic : affordableCandidates)[0]
    if (!affordable) continue
    const entry = createEntry(request, affordable, slot, slotIndex)
    entries.push(entry)
    scheduledOpportunityIds.add(affordable.id)
    usedOpportunityIds.add(affordable.id)
    usedDates.add(entry.plannedLocalDate)
    monthlySpend.set(key, (monthlySpend.get(key) ?? 0) + affordable.estimatedCostUnits)
    monthlyCount.set(key, (monthlyCount.get(key) ?? 0) + 1)
    previousTopicCluster = affordable.topicCluster
  }

  const unscheduled: UnscheduledOpportunity[] = [...nonSelected]
  for (const opportunity of selected) {
    if (scheduledOpportunityIds.has(opportunity.id) || usedOpportunityIds.has(opportunity.id)) continue
    let reasonCode: CalendarReasonCode = 'NO_AVAILABLE_SLOT'
    if (opportunity.estimatedCostUnits > request.monthlyBudgetUnits) reasonCode = 'OPPORTUNITY_COST_EXCEEDS_BUDGET'
    else if (entries.length >= request.maximumTotalItems) reasonCode = 'PLAN_ITEM_CAP_REACHED'
    else if (slots.length === 0) reasonCode = 'NO_AVAILABLE_SLOT'
    else if (slots.every(slot => (monthlyCount.get(monthKey(slot.date)) ?? 0) >= request.maxItemsPerCalendarMonth)) reasonCode = 'MONTHLY_ITEM_CAP_REACHED'
    else reasonCode = 'MONTHLY_BUDGET_EXHAUSTED'
    unscheduled.push({ opportunityId: opportunity.id, reasonCode })
  }
  return buildResult(request, entries, unscheduled, [...historicalReasons, ...unscheduled.map(item => item.reasonCode)])
}

export function buildContentCalendar(input: unknown): ContentCalendarResult {
  try {
    return buildNormalizedCalendar(normalizeContentCalendarRequest(input))
  } catch (error) {
    return safeBlocked(error instanceof ContentCalendarValidationError ? error.reasonCode : 'INVALID_INPUT')
  }
}

function cloneCalendarWithEntries(calendar: ContentCalendarResult, entries: ContentCalendarEntry[], extraReasons: CalendarReasonCode[] = []): ContentCalendarResult {
  if (!calendar.normalizedRequest) return safeBlocked('INVALID_INPUT')
  const changed = canonicalJson([...entries].sort(compareEntries)) !== canonicalJson(calendar.entries)
  const revision = changed ? calendar.revision + 1 : calendar.revision
  const previousPlanFingerprint = changed ? calendar.planFingerprint : calendar.previousPlanFingerprint
  return buildResult(calendar.normalizedRequest, entries, calendar.unscheduledOpportunities, [...calendar.reasonCodes, ...extraReasons], revision, previousPlanFingerprint)
}

function validateIdArray(value: unknown, label: string, entries: ContentCalendarEntry[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > entries.length || value.some(id => typeof id !== 'string')) throw new Error(`${label} must contain existing unique entry IDs`)
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate IDs`)
  const known = new Set(entries.map(entry => entry.entryId))
  if (ids.some(id => !known.has(id))) throw new Error(`${label} contains an unknown entry ID`)
  return [...ids].sort(compareAscii)
}

function transitionEntry(entry: ContentCalendarEntry, target: CalendarEntryStatus): ContentCalendarEntry {
  if (!CALENDAR_ENTRY_LIFECYCLE_TRANSITIONS[entry.status].includes(target)) throw new Error(`invalid calendar entry transition ${entry.status}->${target}`)
  return entry.status === target ? entry : { ...entry, status: target }
}

function materializeWork(entry: ContentCalendarEntry): DueContentWork {
  return { workId: `work-${fingerprintCanonical({ entryId: entry.entryId, scheduleKey: entry.scheduleKey, idempotencyKey: entry.idempotencyKey })}`, entryId: entry.entryId, scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, opportunityId: entry.opportunityId, strategyRecommendationId: entry.strategyRecommendationId, contentType: entry.contentType, language: entry.language, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, estimatedCostUnits: entry.estimatedCostUnits, idempotencyKey: entry.idempotencyKey, status: 'materialized' }
}

export function materializeDueContentWork(input: unknown): MaterializeDueContentWorkResult {
  try {
    if (!isRecordSafe(input)) throw new Error('materialize input must be an object')
    assertRequiredAndOptionalKeys(input, ['calendar', 'expectedPlanFingerprint', 'nowLocalDate'], ['completedEntryIds', 'cancelledEntryIds'], 'materialize input')
    const request = input as unknown as MaterializeDueContentWorkInput
    assertTrustedExpectedPlanFingerprint(request.expectedPlanFingerprint)
    if (!isRecordSafe(request.calendar) || request.expectedPlanFingerprint !== request.calendar.planFingerprint) throw new Error('expectedPlanFingerprint does not match calendar.planFingerprint')
    const calendar = validateCalendarInput(request.calendar)
    const normalizedRequest = calendar.normalizedRequest
    if (!normalizedRequest) throw new Error('calendar has no normalized request')
    if (!isDateOnly(request.nowLocalDate)) throw new Error('nowLocalDate must be a real YYYY-MM-DD')
    const completed = validateIdArray(request.completedEntryIds, 'completedEntryIds', calendar.entries)
    const cancelled = validateIdArray(request.cancelledEntryIds, 'cancelledEntryIds', calendar.entries)
    if (completed.some(id => cancelled.includes(id))) throw new Error('completedEntryIds and cancelledEntryIds must not overlap')
    const completedSet = new Set(completed)
    const cancelledSet = new Set(cancelled)
    const entries = calendar.entries.map(entry => completedSet.has(entry.entryId) ? transitionEntry(entry, 'completed') : cancelledSet.has(entry.entryId) ? transitionEntry(entry, 'cancelled') : entry)
    const planned = entries.filter(entry => entry.status === 'planned')
    const missedEntries = planned.filter(entry => entry.plannedLocalDate < request.nowLocalDate).sort(compareEntries)
    const todayEntries = planned.filter(entry => entry.plannedLocalDate === request.nowLocalDate).sort(compareEntries)
    const dueWork: DueContentWork[] = []
    const skippedEntryIds: string[] = []
    const materializedIds = new Set<string>()
    if (normalizedRequest.catchUpPolicy === 'skip_missed') {
      for (const entry of missedEntries) {
        skippedEntryIds.push(entry.entryId)
        materializedIds.add(entry.entryId)
      }
      for (const entry of todayEntries) {
        dueWork.push(materializeWork(entry))
        materializedIds.add(entry.entryId)
      }
    } else {
      const catchUpEntry = missedEntries[0]
      if (catchUpEntry) {
        dueWork.push(materializeWork(catchUpEntry))
        materializedIds.add(catchUpEntry.entryId)
      }
      for (const entry of missedEntries.slice(catchUpEntry ? 1 : 0)) {
        skippedEntryIds.push(entry.entryId)
        materializedIds.add(entry.entryId)
      }
      for (const entry of todayEntries) {
        dueWork.push(materializeWork(entry))
        materializedIds.add(entry.entryId)
      }
    }
    const nextEntries = entries.map(entry => skippedEntryIds.includes(entry.entryId) ? transitionEntry(entry, 'skipped') : materializedIds.has(entry.entryId) && !skippedEntryIds.includes(entry.entryId) ? transitionEntry(entry, 'materialized') : entry)
    const reasonCodes: CalendarReasonCode[] = dueWork.length === 0 ? ['NO_DUE_WORK'] : []
    const updatedCalendar = cloneCalendarWithEntries(calendar, nextEntries)
    return { calendar: updatedCalendar, dueWork: dueWork.sort((left, right) => compareAscii(left.plannedLocalDate, right.plannedLocalDate) || compareAscii(left.scheduleKey, right.scheduleKey)), skippedEntryIds: [...skippedEntryIds].sort(compareAscii), reasonCodes: uniqueSortedReasonCodes(reasonCodes), limitations: [...CONTENT_CALENDAR_LIMITATIONS] }
  } catch {
    return { calendar: null, dueWork: [], skippedEntryIds: [], reasonCodes: ['INVALID_INPUT'], limitations: [...CONTENT_CALENDAR_LIMITATIONS] }
  }
}

export function replanContentCalendar(input: unknown): ContentCalendarResult {
  try {
    if (!isRecordSafe(input)) throw new Error('replan input must be an object')
    assertExactKeys(input, ['calendar', 'expectedPlanFingerprint', 'request'], 'replan input')
    const replan = input as unknown as ReplanContentCalendarInput
    assertTrustedExpectedPlanFingerprint(replan.expectedPlanFingerprint)
    if (!isRecordSafe(replan.calendar) || replan.expectedPlanFingerprint !== replan.calendar.planFingerprint) throw new Error('expectedPlanFingerprint does not match calendar.planFingerprint')
    const calendar = validateCalendarInput(replan.calendar)
    const request = normalizeContentCalendarRequest(replan.request)
    const previousRequest = calendar.normalizedRequest
    if (!previousRequest) return safeBlocked('INVALID_INPUT')
    if (request.evidenceSnapshotHash !== previousRequest.evidenceSnapshotHash) return safeBlocked('EVIDENCE_SNAPSHOT_MISMATCH', request)
    const fixedEntries = calendar.entries.filter(entry => entry.status !== 'planned')
    for (const entry of fixedEntries) {
      const preservedOpportunity = request.opportunities.find(opportunity => opportunity.id === entry.opportunityId)
      if (!preservedOpportunity) return safeBlocked('PRESERVED_OPPORTUNITY_MISSING', request)
      if (preservedOpportunity.status !== 'selected') return safeBlocked('INVALID_INPUT', request)
    }
    if (fixedEntries.length > request.maximumTotalItems) return safeBlocked('PLAN_ITEM_CAP_REACHED', request)
    const result = buildNormalizedCalendar(request, fixedEntries)
    if (result.entries.length === 0) return result
    const preservedExecutedIds = new Set(fixedEntries.filter(entry => entry.status === 'materialized' || entry.status === 'completed').map(entry => entry.opportunityId))
    const selectedPreserved = request.opportunities.filter(opportunity => opportunity.status === 'selected' && preservedExecutedIds.has(opportunity.id))
    const reasonCodes = uniqueSortedReasonCodes([...result.reasonCodes, ...(selectedPreserved.length > 0 ? ['REPLAN_PRESERVED_EXECUTED'] as CalendarReasonCode[] : [])])
    const stateChanged = canonicalJson({ normalizedRequest: request, entries: result.entries, unscheduledOpportunities: result.unscheduledOpportunities, reasonCodes }) !== canonicalJson({ normalizedRequest: calendar.normalizedRequest, entries: calendar.entries, unscheduledOpportunities: calendar.unscheduledOpportunities, reasonCodes: calendar.reasonCodes })
    return buildResult(request, result.entries, result.unscheduledOpportunities, reasonCodes, stateChanged ? calendar.revision + 1 : calendar.revision, stateChanged ? calendar.planFingerprint : calendar.previousPlanFingerprint)
  } catch (error) {
    return safeBlocked(error instanceof ContentCalendarValidationError ? error.reasonCode : 'INVALID_INPUT')
  }
}
