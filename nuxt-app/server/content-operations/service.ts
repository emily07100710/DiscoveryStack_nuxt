import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import {
  assessPublishedContentOutcome,
  buildOutcomeLearningCandidate,
  OUTCOME_DATA_CONTRACT_VERSION,
  type PublishedContentOutcomeAssessment,
} from '../outcome-learning'
import {
  buildContentCalendar,
  materializeDueContentWork,
  replanContentCalendar,
  type ContentCalendarOpportunity,
  type ContentCalendarRequest,
  type ContentCalendarResult,
  type DueContentWork,
} from '../content-calendar'
import type { CalendarEntryStatus } from '../content-calendar/policy-catalog'
import type {
  CalendarInsert,
  CanonicalContext,
  ContentOperationsRepository,
  EntryInsert,
  OutcomeInsert,
  RunInsert,
} from './repository'
import { createContentOperationsRepository } from './repository'
import { runtimeCredentialResolverAvailable } from './runtime-dependencies'
import {
  assertDateOnly,
  assertSha256,
  normalizePublicHttpsOrigin,
  normalizeTimeZone,
  parseCalendarInput,
  parseClientInput,
  parseOutcomeInput,
  parseReplanInput,
  stableFingerprint,
  stableStringify,
  sanitizeErrorSummary,
} from './normalization'
import type {
  Clock,
  ContentOperationCalendarEntryRow,
  ContentOperationCalendarRow,
  ContentOperationEventRow,
  ContentOperationClientInput,
  ContentOperationClientRow,
  ContentOperationRunRow,
  CreateCalendarInput,
  MaterializeExecutionOptions,
  MaterializeInput,
  MaterializeResult,
  OutcomeAssessmentInput,
  OutcomeResult,
  PlanBundle,
  ReplanCalendarInput,
  WorkspacePayload,
} from './types'
import { CONTENT_OPERATIONS_LIMITATIONS } from './types'

const CALENDAR_ENGINE_VERSION = 'content-calendar-cadence-engine-v1'
const DEFAULT_LEASE_MS = 5 * 60 * 1000
const MAX_TICK_ENTRIES = 50

type AnyRecord = Record<string, unknown>

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOfStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) return null
  return [...new Set(value.map(item => item.trim()))]
}

function readString(record: AnyRecord, keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim()
  return null
}

function collision(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

function notFound(message: string): never {
  throw createError({ statusCode: 404, statusMessage: message })
}

function invalid(message: string): never {
  throw createError({ statusCode: 422, statusMessage: message })
}

function ownerMismatch(message = 'Content operation ownership validation failed.'): never {
  throw createError({ statusCode: 404, statusMessage: message })
}

function isDuplicateConstraint(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; message?: string }
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062 || /duplicate entry|unique constraint/i.test(candidate?.message || '')
}

function defaultClock(): Clock {
  return {
    now: () => new Date(),
    localDate: (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
  }
}

function publicClient(client: ContentOperationClientRow): ContentOperationClientRow {
  return { ...client }
}

function asPlanBundle(value: unknown): PlanBundle {
  if (!isRecord(value) || !isRecord(value.plan) || !Array.isArray(value.selections) || !Array.isArray(value.strategies) || !Array.isArray(value.deliverables)) invalid('Production Plan provenance is malformed.')
  return value as unknown as PlanBundle
}

function canonicalRuleIds(context: CanonicalContext): string[] {
  const ids = context.rules.map(rule => typeof rule.id === 'string' ? rule.id.trim() : '').filter(Boolean)
  if (!ids.length || new Set(ids).size !== ids.length) invalid('Canonical strategy rule set is missing or malformed.')
  return [...ids].sort((left, right) => left.localeCompare(right))
}

function canonicalAuthoritySourceIds(context: CanonicalContext): string[] {
  const identities = context.evidenceSnapshot.refs.flatMap(ref => {
    const sourceId = ref.sourceId
    const artifactId = ref.artifactId
    if (typeof sourceId === 'number' && Number.isSafeInteger(sourceId) && sourceId > 0) return [`source:${sourceId}`]
    if (typeof artifactId === 'number' && Number.isSafeInteger(artifactId) && artifactId > 0) return [`artifact:${artifactId}`]
    return []
  })
  const unique = [...new Set(identities)].sort((left, right) => left.localeCompare(right))
  if (!unique.length) invalid('Canonical evidence snapshot has no usable source or artifact identity.')
  return unique
}

async function resolveCanonicalContexts(repository: ContentOperationsRepository, ownerUserId: number, bundle: PlanBundle): Promise<CanonicalContext[]> {
  if (bundle.plan.ownerUserId !== ownerUserId || bundle.plan.status === 'blocked' || bundle.plan.status === 'archived' || !Number.isSafeInteger(bundle.plan.diagnosisId)) invalid('Production Plan is not available for this owner calendar.')
  assertSha256(bundle.plan.evidenceSnapshotHash, 'Production Plan evidence snapshot')
  if (!bundle.deliverables.length) invalid('Production Plan has no persisted deliverables.')
  const contexts: CanonicalContext[] = []
  for (const deliverable of bundle.deliverables) {
    const context = await repository.resolveCanonicalContext(ownerUserId, bundle.plan.id, deliverable.id)
    const plan = context.plan
    const selection = context.selection
    const strategy = context.strategy
    if (plan.ownerUserId !== ownerUserId || plan.id !== bundle.plan.id || plan.id !== deliverable.planId || deliverable.ownerUserId !== ownerUserId || deliverable.id !== context.deliverable.id || context.deliverable.planId !== plan.id || context.deliverable.selectionId !== selection.id || selection.ownerUserId !== ownerUserId || selection.planId !== plan.id || selection.status !== 'selected' || strategy.ownerUserId !== ownerUserId || strategy.id !== selection.strategyRecommendationId || strategy.diagnosisId !== plan.diagnosisId || ['rejected', 'superseded'].includes(strategy.status) || context.diagnosis.id !== plan.diagnosisId) invalid('Canonical Production Plan linkage is invalid.')
    if (deliverable.contentType !== context.opportunity.deliverableType || deliverable.title !== context.opportunity.title || deliverable.audience !== context.opportunity.audience || deliverable.opportunityKey !== `${strategy.id}:${context.opportunity.key}`) invalid('Persisted Production Deliverable opportunity is not canonical.')
    if (context.evidenceSnapshot.hash !== bundle.plan.evidenceSnapshotHash || deliverable.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash || selection.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash || strategy.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash) collision('All Production Plan provenance must share one evidence snapshot.')
    canonicalRuleIds(context)
    canonicalAuthoritySourceIds(context)
    contexts.push(context)
  }
  return contexts
}

function buildOpportunities(contexts: CanonicalContext[], input: CreateCalendarInput, client: ContentOperationClientRow): ContentCalendarOpportunity[] {
  return contexts.map(context => {
    const deliverable = context.deliverable
    if (deliverable.contentType !== 'article' && deliverable.contentType !== 'faq' && deliverable.contentType !== 'service_page') invalid('Production Deliverable content type is not supported by the calendar engine.')
    if (deliverable.language !== 'en' && deliverable.language !== 'zh-hant') invalid('Production Deliverable language is not supported by the calendar engine.')
    return { id: `deliverable-${deliverable.id}`, strategyRecommendationId: context.strategy.id, title: context.opportunity.title, contentType: context.opportunity.deliverableType, language: deliverable.language, priority: context.strategy.priority, status: 'selected' as const, topicCluster: context.opportunity.key, evidenceSnapshotHash: context.evidenceSnapshot.hash, estimatedCostUnits: input.defaultCostUnits, ruleIds: canonicalRuleIds(context), authoritySourceIds: canonicalAuthoritySourceIds(context) }
  })
}

function buildRequest(contexts: CanonicalContext[], input: CreateCalendarInput, client: ContentOperationClientRow): ContentCalendarRequest {
  const evidenceSnapshotHash = contexts[0]?.evidenceSnapshot.hash
  if (!evidenceSnapshotHash) invalid('Canonical evidence snapshot is missing.')
  return { clientScopeKey: `client-${client.id}`, planStartDate: input.planStartDate, planEndDate: input.planEndDate, timeZone: normalizeTimeZone(client.timeZone), publishLocalTime: input.publishLocalTime, cadenceDays: input.cadenceDays, monthlyBudgetUnits: input.monthlyBudgetUnits, defaultCostUnits: input.defaultCostUnits, maxItemsPerCalendarMonth: input.maxItemsPerCalendarMonth, maximumTotalItems: input.maximumTotalItems, catchUpPolicy: input.catchUpPolicy, evidenceSnapshotHash, opportunities: buildOpportunities(contexts, input, client) }
}

function entryStatusForDatabase(status: string): ContentOperationCalendarEntryRow['status'] {
  if (status === 'planned' || status === 'materialized' || status === 'completed' || status === 'cancelled' || status === 'skipped' || status === 'blocked') return status
  return 'blocked'
}

function engineStatusForDatabase(status: ContentOperationCalendarEntryRow['status']): CalendarEntryStatus {
  if (status === 'delivered' || status === 'completed') return 'completed'
  if (status === 'awaiting_generation' || status === 'awaiting_review' || status === 'ready_to_publish' || status === 'publishing') return 'materialized'
  if (status === 'planned' || status === 'materialized' || status === 'cancelled' || status === 'skipped' || status === 'blocked') return status
  return 'blocked'
}


function calendarInsert(ownerUserId: number, clientId: number, productionPlanId: number, input: CreateCalendarInput, request: ContentCalendarRequest, result: ContentCalendarResult): CalendarInsert {
  return {
    ownerUserId,
    clientId,
    productionPlanId,
    engineVersion: result.engineVersion,
    status: result.status,
    planStartDate: input.planStartDate,
    planEndDate: input.planEndDate,
    timeZone: request.timeZone,
    publishLocalTime: input.publishLocalTime,
    cadenceDays: input.cadenceDays,
    monthlyBudgetUnits: input.monthlyBudgetUnits,
    defaultCostUnits: input.defaultCostUnits,
    maxItemsPerCalendarMonth: input.maxItemsPerCalendarMonth,
    maximumTotalItems: input.maximumTotalItems,
    catchUpPolicy: input.catchUpPolicy,
    evidenceSnapshotHash: request.evidenceSnapshotHash,
    revision: result.revision,
    previousPlanFingerprint: result.previousPlanFingerprint,
    planFingerprint: result.planFingerprint,
    normalizedRequestSnapshot: result.normalizedRequest,
    resultSnapshot: result,
    idempotencyKey: input.idempotencyKey,
  }
}

function calendarPatchFromResult(result: ContentCalendarResult): Partial<CalendarInsert> {
  if (!result.normalizedRequest) invalid('Calendar result is missing its normalized request.')
  return { engineVersion: result.engineVersion, status: result.status, planStartDate: result.normalizedRequest.planStartDate, planEndDate: result.normalizedRequest.planEndDate, timeZone: result.normalizedRequest.timeZone, publishLocalTime: result.normalizedRequest.publishLocalTime, cadenceDays: result.normalizedRequest.cadenceDays, monthlyBudgetUnits: result.normalizedRequest.monthlyBudgetUnits, defaultCostUnits: result.normalizedRequest.defaultCostUnits, maxItemsPerCalendarMonth: result.normalizedRequest.maxItemsPerCalendarMonth, maximumTotalItems: result.normalizedRequest.maximumTotalItems, catchUpPolicy: result.normalizedRequest.catchUpPolicy, evidenceSnapshotHash: result.normalizedRequest.evidenceSnapshotHash, revision: result.revision, previousPlanFingerprint: result.previousPlanFingerprint, planFingerprint: result.planFingerprint, normalizedRequestSnapshot: result.normalizedRequest, resultSnapshot: result }
}

function assertCalendarState(calendar: ContentOperationCalendarRow, rows: ContentOperationCalendarEntryRow[]): ContentCalendarResult {
  if (calendar.resultSnapshot === null || !isRecord(calendar.resultSnapshot) || calendar.planFingerprint !== (calendar.resultSnapshot as { planFingerprint?: unknown }).planFingerprint) collision('Calendar snapshot is stale or malformed.')
  const snapshot = calendar.resultSnapshot as unknown as ContentCalendarResult
  if (!isRecord(calendar.normalizedRequestSnapshot) || !isRecord(snapshot.normalizedRequest)) collision('Calendar snapshot normalized request is malformed.')
  const check = materializeDueContentWork({ calendar: snapshot, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: calendar.planStartDate, eligibleEntryIds: [] })
  if (!check.calendar || check.calendar.planFingerprint !== calendar.planFingerprint || check.calendar.revision !== calendar.revision || stableFingerprint(calendar.normalizedRequestSnapshot) !== stableFingerprint(snapshot.normalizedRequest) || check.calendar.entries.length > rows.length) collision('Calendar snapshot and durable entries are inconsistent.')
  const byEngineId = new Map(rows.map(row => [row.engineEntryId, row]))
  if (byEngineId.size !== rows.length || snapshot.entries.some(entry => !byEngineId.has(entry.entryId) || engineStatusForDatabase(byEngineId.get(entry.entryId)!.status) !== entry.status)) collision('Calendar snapshot and durable entry lifecycle are inconsistent.')
  const activeEntryIds = new Set(snapshot.entries.map(entry => entry.entryId))
  if (rows.some(row => !activeEntryIds.has(row.engineEntryId) && row.status !== 'cancelled')) collision('Calendar has a non-cancelled durable entry outside its active snapshot.')
  return snapshot
}

function operationClaimFingerprint(ownerUserId: number, calendarId: number, operation: 'replan' | 'materialize', idempotencyKey: string): string {
  return stableFingerprint({ ownerUserId, calendarId, operation, idempotencyKey })
}

function operationRequestFingerprint(value: unknown): string {
  return stableFingerprint(value)
}

function durableEntryIdempotencyKey(calendarId: number, entry: ContentCalendarResult['entries'][number]): string {
  return `content-operation-entry:${stableFingerprint({
    calendarId,
    engineEntryId: entry.entryId,
    engineIdempotencyKey: entry.idempotencyKey,
  })}`
}

function entryInsert(ownerUserId: number, calendarId: number, deliverableId: number, entry: ContentCalendarResult['entries'][number]): EntryInsert {
  return {
    ownerUserId,
    calendarId,
    productionDeliverableId: deliverableId,
    strategyRecommendationId: entry.strategyRecommendationId,
    jobId: null,
    draftId: null,
    reviewId: null,
    scheduleKey: entry.scheduleKey,
    plannedLocalDate: entry.plannedLocalDate,
    publishLocalTime: entry.publishLocalTime,
    timeZone: entry.timeZone,
    contentType: entry.contentType,
    language: entry.language,
    topicCluster: entry.topicCluster,
    evidenceSnapshotHash: entry.evidenceSnapshotHash,
    contentHash: null,
    publicationTargetId: null,
    publicationSlug: null,
    publicationPath: null,
    publicationIdentityFingerprint: null,
    status: entryStatusForDatabase(entry.status),
    engineEntryId: entry.entryId,
    idempotencyKey: durableEntryIdempotencyKey(calendarId, entry),
  }
}

function eventInput(ownerUserId: number, input: { clientId?: number | null; calendarId?: number | null; entryId?: number | null; runId?: number | null; eventType: string; fromStatus?: string | null; toStatus?: string | null; metadata: unknown; key: unknown }) {
  return {
    ownerUserId,
    clientId: input.clientId ?? null,
    calendarId: input.calendarId ?? null,
    entryId: input.entryId ?? null,
    runId: input.runId ?? null,
    eventType: input.eventType,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    eventFingerprint: stableFingerprint(input.key),
    metadata: input.metadata,
  }
}

function runInsert(ownerUserId: number, entry: ContentOperationCalendarEntryRow, stage: RunInsert['stage'], planFingerprint: string): RunInsert {
  return {
    ownerUserId,
    entryId: entry.id,
    stage,
    state: 'queued',
    attemptNumber: 0,
    idempotencyKey: `content-operation-run:${entry.idempotencyKey}:${stage}`.slice(0, 128),
    inputFingerprint: stableFingerprint({ entryId: entry.engineEntryId, stage, evidenceSnapshotHash: entry.evidenceSnapshotHash, planFingerprint }),
    outputFingerprint: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryEligibleAt: null,
    errorCode: null,
    errorSummary: null,
    startedAt: null,
    completedAt: null,
  }
}

function assertRunIdentity(run: ContentOperationRunRow, expected: RunInsert): void {
  if (run.ownerUserId !== expected.ownerUserId || run.entryId !== expected.entryId || run.stage !== expected.stage || run.idempotencyKey !== expected.idempotencyKey || run.inputFingerprint !== expected.inputFingerprint) collision('Content operation run identity does not match the current calendar entry and plan fingerprint.')
  if (run.state === 'succeeded' || run.state === 'failed' || run.state === 'blocked' || run.state === 'cancelled') collision('A terminal content operation run cannot be reused for a planned calendar entry.')
}

async function getRepository(repository?: ContentOperationsRepository) {
  return repository || createContentOperationsRepository()
}

export async function createOwnerContentClient(ownerUserId: number, input: unknown, repository?: ContentOperationsRepository) {
  const db = await getRepository(repository)
  const parsed = parseClientInput(input)
  const canonicalSiteOrigin = normalizePublicHttpsOrigin(parsed.canonicalSiteOrigin)
  const byKey = await db.findClientByIdempotency(ownerUserId, parsed.idempotencyKey)
  const normalized = { ...parsed, canonicalSiteOrigin }
  if (byKey) {
    const samePayload = byKey.ownerUserId === ownerUserId && byKey.status === 'active' && byKey.displayName === normalized.displayName && byKey.canonicalSiteOrigin === normalized.canonicalSiteOrigin && byKey.framework === normalized.framework && byKey.publicationTransport === normalized.publicationTransport && byKey.timeZone === normalized.timeZone && byKey.defaultCadenceDays === normalized.defaultCadenceDays && byKey.defaultPublishLocalTime === normalized.defaultPublishLocalTime && byKey.monthlyBudgetUnits === normalized.monthlyBudgetUnits && byKey.idempotencyKey === normalized.idempotencyKey
    if (!samePayload) collision('Client idempotency key is already associated with a different payload.')
    return publicClient(byKey)
  }
  const byOrigin = await db.findClientByOrigin(ownerUserId, canonicalSiteOrigin)
  if (byOrigin) collision('Client origin is already registered for this owner.')
  return db.transaction(async transaction => {
    try {
      return await transaction.insertClient({ ownerUserId, status: 'active', ...normalized })
    } catch (error) {
      if (!isDuplicateConstraint(error)) throw error
      const replay = await transaction.findClientByIdempotency(ownerUserId, normalized.idempotencyKey)
      if (replay) {
        const samePayload = replay.ownerUserId === ownerUserId && replay.status === 'active' && replay.displayName === normalized.displayName && replay.canonicalSiteOrigin === normalized.canonicalSiteOrigin && replay.framework === normalized.framework && replay.publicationTransport === normalized.publicationTransport && replay.timeZone === normalized.timeZone && replay.defaultCadenceDays === normalized.defaultCadenceDays && replay.defaultPublishLocalTime === normalized.defaultPublishLocalTime && replay.monthlyBudgetUnits === normalized.monthlyBudgetUnits && replay.idempotencyKey === normalized.idempotencyKey
        if (!samePayload) collision('Client idempotency key is already associated with a different payload.')
        return publicClient(replay)
      }
      const origin = await transaction.findClientByOrigin(ownerUserId, normalized.canonicalSiteOrigin)
      if (origin) collision('Client origin is already registered for this owner.')
      throw error
    }
  })
}

export async function createCalendarFromProductionPlan(ownerUserId: number, input: unknown, repository?: ContentOperationsRepository) {
  const db = await getRepository(repository)
  const parsed = parseCalendarInput(input)
  const client = await db.findClient(ownerUserId, parsed.clientId)
  if (!client || client.status === 'archived') ownerMismatch('Content operation client was not found for this owner.')
  const existing = await db.findCalendarByIdempotency(ownerUserId, parsed.idempotencyKey)
  if (existing) {
    const samePayload = existing.clientId === parsed.clientId && existing.productionPlanId === parsed.productionPlanId && existing.planStartDate === parsed.planStartDate && existing.planEndDate === parsed.planEndDate && existing.publishLocalTime === parsed.publishLocalTime && existing.cadenceDays === parsed.cadenceDays && existing.monthlyBudgetUnits === parsed.monthlyBudgetUnits && existing.defaultCostUnits === parsed.defaultCostUnits && existing.maxItemsPerCalendarMonth === parsed.maxItemsPerCalendarMonth && existing.maximumTotalItems === parsed.maximumTotalItems && existing.catchUpPolicy === parsed.catchUpPolicy
    if (!samePayload) collision('Calendar idempotency key is already associated with a different payload.')
    return { calendar: existing, entries: await db.listEntries(ownerUserId, existing.id), replayed: true }
  }
  const bundle = asPlanBundle(await db.getPlanBundle(ownerUserId, parsed.productionPlanId))
  const contexts = await resolveCanonicalContexts(db, ownerUserId, bundle)
  const request = buildRequest(contexts, parsed, client)
  const result = buildContentCalendar(request)
  if (!result.normalizedRequest || result.status === 'blocked') invalid('Production Plan could not produce a valid content calendar.')
  return db.transaction(async transaction => {
    let calendar: ContentOperationCalendarRow
    try {
      calendar = await transaction.insertCalendar(calendarInsert(ownerUserId, client.id, parsed.productionPlanId, parsed, request, result))
    } catch (error) {
      if (!isDuplicateConstraint(error)) throw error
      const replay = await transaction.findCalendarByIdempotency(ownerUserId, parsed.idempotencyKey)
      if (!replay) throw error
      const samePayload = replay.clientId === parsed.clientId && replay.productionPlanId === parsed.productionPlanId && replay.planStartDate === parsed.planStartDate && replay.planEndDate === parsed.planEndDate && replay.publishLocalTime === parsed.publishLocalTime && replay.cadenceDays === parsed.cadenceDays && replay.monthlyBudgetUnits === parsed.monthlyBudgetUnits && replay.defaultCostUnits === parsed.defaultCostUnits && replay.maxItemsPerCalendarMonth === parsed.maxItemsPerCalendarMonth && replay.maximumTotalItems === parsed.maximumTotalItems && replay.catchUpPolicy === parsed.catchUpPolicy
      if (!samePayload) collision('Calendar idempotency key is already associated with a different payload.')
      return { calendar: replay, entries: await transaction.listEntries(ownerUserId, replay.id), replayed: true }
    }
    const deliverableByOpportunity = new Map(contexts.map(context => [`deliverable-${context.deliverable.id}`, context.deliverable.id]))
    const entries: ContentOperationCalendarEntryRow[] = []
    for (const entry of result.entries) {
      const deliverableId = deliverableByOpportunity.get(entry.opportunityId)
      if (!deliverableId) invalid('Calendar opportunity does not map to a persisted Production Deliverable.')
      entries.push(await transaction.insertEntry(entryInsert(ownerUserId, calendar.id, deliverableId, entry)))
    }
    await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, eventType: 'calendar_created', toStatus: calendar.status, metadata: { engineVersion: result.engineVersion, revision: result.revision, planFingerprint: result.planFingerprint, entryCount: entries.length }, key: { calendarId: calendar.id, event: 'calendar_created', planFingerprint: result.planFingerprint } }))
    return { calendar, entries, replayed: false }
  })
}

export async function replanOwnerContentCalendar(ownerUserId: number, calendarId: number, input: unknown, repository?: ContentOperationsRepository) {
  const db = await getRepository(repository)
  const parsed = parseReplanInput(input)
  const calendar = await db.findCalendar(ownerUserId, calendarId)
  if (!calendar) notFound('Content operation calendar was not found.')
  const client = await db.findClient(ownerUserId, calendar.clientId)
  if (!client || client.status === 'archived') ownerMismatch('Content operation client was not found for this owner.')
  const bundle = asPlanBundle(await db.getPlanBundle(ownerUserId, calendar.productionPlanId))
  const contexts = await resolveCanonicalContexts(db, ownerUserId, bundle)
  const replanInput: CreateCalendarInput = { ...parsed.request, clientId: client.id, productionPlanId: calendar.productionPlanId, idempotencyKey: calendar.idempotencyKey }
  const request = buildRequest(contexts, replanInput, client)
  const requestFingerprint = operationRequestFingerprint({ expectedPlanFingerprint: parsed.expectedPlanFingerprint, request })
  const claimFingerprint = operationClaimFingerprint(ownerUserId, calendar.id, 'replan', parsed.idempotencyKey)
  const persistedEntries = await db.listEntries(ownerUserId, calendar.id)
  const current = assertCalendarState(calendar, persistedEntries)
  return db.transaction(async transaction => {
    const claim = await transaction.claimOperation({ ownerUserId, calendarId: calendar.id, operation: 'replan', idempotencyKey: parsed.idempotencyKey, requestFingerprint, eventFingerprint: claimFingerprint })
    if (!claim.claimed) {
      if (claim.requestFingerprint !== requestFingerprint) collision('Replan idempotency key is already associated with a different payload.')
      const replayCalendar = await transaction.findCalendar(ownerUserId, calendar.id)
      if (!replayCalendar) notFound('Content operation calendar was not found.')
      return { calendar: replayCalendar, entries: await transaction.listEntries(ownerUserId, calendar.id), replayed: true }
    }
    if (calendar.planFingerprint !== parsed.expectedPlanFingerprint) collision('Calendar plan fingerprint is stale.')
    const result = replanContentCalendar({ calendar: current, expectedPlanFingerprint: parsed.expectedPlanFingerprint, request })
    if (result.status === 'blocked') invalid(`Content calendar replan was blocked by the pure calendar engine: ${result.reasonCodes.join(',') || 'INVALID_INPUT'}.`)
    const updatedCalendar = await transaction.updateCalendarIfFingerprint(ownerUserId, calendar.id, parsed.expectedPlanFingerprint, calendarPatchFromResult(result))
    if (!updatedCalendar) collision('Calendar plan fingerprint is stale.')
    const currentEntryIds = new Set(current.entries.map(entry => entry.entryId))
    const currentRows = persistedEntries.filter(entry => currentEntryIds.has(entry.engineEntryId))
    const historicalRows = persistedEntries.filter(entry => !currentEntryIds.has(entry.engineEntryId))
    if (historicalRows.some(entry => entry.status !== 'cancelled')) invalid('Only cancelled durable history may exist outside the active calendar snapshot.')
    const byEngineId = new Map(currentRows.map(entry => [entry.engineEntryId, entry]))
    const historicalByEngineId = new Map(historicalRows.map(entry => [entry.engineEntryId, entry]))
    const byOpportunity = new Map(currentRows.filter(entry => entry.status === 'planned').map(entry => [entry.engineEntryId, entry]))
    const usedRows = new Set<number>()
    const reactivatedHistoricalRows = new Set<number>()
    const entries: ContentOperationCalendarEntryRow[] = []
    for (const entry of result.entries) {
      const deliverableId = contexts.find(context => `deliverable-${context.deliverable.id}` === entry.opportunityId)?.deliverable.id
      if (!deliverableId) invalid('Replanned opportunity does not map to a persisted Production Deliverable.')
      const historical = historicalByEngineId.get(entry.entryId)
      const old = byEngineId.get(entry.entryId) || (!historical ? [...byOpportunity.values()].find(candidate => !usedRows.has(candidate.id) && candidate.productionDeliverableId === deliverableId) : undefined)
      if (old) {
        usedRows.add(old.id)
        const expectedStatus = engineStatusForDatabase(old.status)
        if (old.status !== 'planned' && expectedStatus !== entry.status) invalid('Replan attempted to move a durable entry backwards or across an invalid lifecycle.')
        const patch = old.status === 'planned' ? { engineEntryId: entry.entryId, idempotencyKey: durableEntryIdempotencyKey(calendar.id, entry), scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, status: entryStatusForDatabase(entry.status) } : { status: old.status }
        entries.push(await transaction.updateEntry(ownerUserId, old.id, patch))
        continue
      }
      if (historical) {
        if (entry.status !== 'planned' || historical.productionDeliverableId !== deliverableId || historical.strategyRecommendationId !== entry.strategyRecommendationId || historical.evidenceSnapshotHash !== entry.evidenceSnapshotHash || historical.jobId !== null || historical.draftId !== null || historical.reviewId !== null || historical.contentHash !== null) invalid('A cancelled historical entry with execution lineage cannot be reactivated by replan.')
        reactivatedHistoricalRows.add(historical.id)
        entries.push(await transaction.updateEntry(ownerUserId, historical.id, { idempotencyKey: durableEntryIdempotencyKey(calendar.id, entry), scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, topicCluster: entry.topicCluster, status: 'planned' }))
        await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, entryId: historical.id, eventType: 'entry_reactivated_by_replan', fromStatus: 'cancelled', toStatus: 'planned', metadata: { previousPlanFingerprint: calendar.planFingerprint, nextPlanFingerprint: updatedCalendar.planFingerprint }, key: { calendarId: calendar.id, entryId: historical.id, event: 'entry_reactivated_by_replan', planFingerprint: updatedCalendar.planFingerprint } }))
        continue
      }
      entries.push(await transaction.insertEntry(entryInsert(ownerUserId, calendar.id, deliverableId, entry)))
    }
    for (const old of currentRows) {
      if (usedRows.has(old.id)) continue
      if (old.status === 'planned') {
        const cancelled = await transaction.updateEntry(ownerUserId, old.id, { status: 'cancelled' })
        entries.push(cancelled)
        await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, entryId: old.id, eventType: 'entry_cancelled_by_replan', fromStatus: 'planned', toStatus: 'cancelled', metadata: { previousPlanFingerprint: calendar.planFingerprint, nextPlanFingerprint: updatedCalendar.planFingerprint }, key: { calendarId: calendar.id, entryId: old.id, event: 'entry_cancelled_by_replan', planFingerprint: updatedCalendar.planFingerprint } }))
        continue
      }
      invalid('Replan result omitted a non-planned durable entry.')
    }
    entries.push(...historicalRows.filter(entry => !reactivatedHistoricalRows.has(entry.id)))
    await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, eventType: 'calendar_replanned', fromStatus: calendar.status, toStatus: updatedCalendar.status, metadata: { revision: updatedCalendar.revision, previousPlanFingerprint: updatedCalendar.previousPlanFingerprint, planFingerprint: updatedCalendar.planFingerprint }, key: { calendarId: calendar.id, event: 'calendar_replanned', planFingerprint: updatedCalendar.planFingerprint } }))
    return { calendar: updatedCalendar, entries, replayed: false }
  })
}

function stableDueCandidates(calendar: ContentCalendarResult, entries: ContentOperationCalendarEntryRow[], nowLocalDate: string, allowedEntryIds?: Set<number>): ContentOperationCalendarEntryRow[] {
  return entries.filter(entry => entry.status === 'planned' && (!allowedEntryIds || allowedEntryIds.has(entry.id)) && entry.plannedLocalDate <= nowLocalDate && calendar.entries.some(engineEntry => engineEntry.entryId === entry.engineEntryId)).sort((left, right) => left.plannedLocalDate.localeCompare(right.plannedLocalDate) || left.scheduleKey.localeCompare(right.scheduleKey) || left.id - right.id)
}

function materializeLeaseMs(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value as number), 15 * 60 * 1000)) : DEFAULT_LEASE_MS
}

export async function materializeOwnerDueContent(ownerUserId: number, input: MaterializeInput, repository?: ContentOperationsRepository, options: MaterializeExecutionOptions = {}) {
  const db = await getRepository(repository)
  assertSha256(input.expectedPlanFingerprint, 'Expected plan fingerprint')
  const calendar = await db.findCalendar(ownerUserId, input.calendarId)
  if (!calendar) notFound('Content operation calendar was not found.')
  const client = await db.findClient(ownerUserId, calendar.clientId)
  if (!client || client.status !== 'active' || calendar.status === 'archived' || calendar.status === 'paused') invalid('Calendar is not active for materialization.')
  const clock = options.clock || defaultClock()
  const now = clock.now()
  const nowLocalDate = clock.localDate(now, calendar.timeZone)
  assertDateOnly(nowLocalDate)
  const requestFingerprint = operationRequestFingerprint({ expectedPlanFingerprint: input.expectedPlanFingerprint, idempotencyKey: input.idempotencyKey })
  const claimFingerprint = operationClaimFingerprint(ownerUserId, calendar.id, 'materialize', input.idempotencyKey)
  return db.transaction(async transaction => {
    const claim = await transaction.claimOperation({ ownerUserId, calendarId: calendar.id, operation: 'materialize', idempotencyKey: input.idempotencyKey, requestFingerprint, eventFingerprint: claimFingerprint })
    if (!claim.claimed) {
      if (claim.requestFingerprint !== requestFingerprint) collision('Materialize idempotency key is already associated with a different payload.')
      const replayCalendar = await transaction.findCalendar(ownerUserId, calendar.id)
      if (!replayCalendar) notFound('Content operation calendar was not found.')
      return { calendar: replayCalendar, dueWork: [], entries: await transaction.listEntries(ownerUserId, calendar.id), runs: [], events: [], replayed: true } satisfies MaterializeResult
    }
    const currentCalendar = await transaction.findCalendar(ownerUserId, calendar.id)
    if (!currentCalendar) notFound('Content operation calendar was not found.')
    if (currentCalendar.planFingerprint !== input.expectedPlanFingerprint) collision('Calendar plan fingerprint is stale.')
    const persistedEntries = await transaction.listEntries(ownerUserId, calendar.id)
    const current = assertCalendarState(currentCalendar, persistedEntries)
    const allowedEntryIds = options.eligibleEntryIds ? new Set(options.eligibleEntryIds) : undefined
    const candidates = stableDueCandidates(current, persistedEntries, nowLocalDate, allowedEntryIds).slice(0, MAX_TICK_ENTRIES)
    const initial = materializeDueContentWork({ calendar: current, expectedPlanFingerprint: currentCalendar.planFingerprint, nowLocalDate, eligibleEntryIds: candidates.map(entry => entry.engineEntryId) })
    if (!initial.calendar) invalid('Due content materialization was blocked by the pure calendar engine.')
    const runs: ContentOperationRunRow[] = []
    const events: ContentOperationEventRow[] = []
    const rowsByEngineId = new Map(persistedEntries.map(entry => [entry.engineEntryId, entry]))
    const leaseToken = options.leaseToken || randomUUID()
    const leasedByEngineId = new Map<string, { run: ContentOperationRunRow; row: ContentOperationCalendarEntryRow; work: DueContentWork }>()
    for (const work of initial.dueWork) {
      const row = rowsByEngineId.get(work.entryId)
      if (!row || row.status !== 'planned') continue
      const fresh = await transaction.findEntry(ownerUserId, row.id)
      if (!fresh || fresh.status !== 'planned') continue
      const stage: RunInsert['stage'] = fresh.draftId ? 'review_wait' : 'generation'
      const runPayload = runInsert(ownerUserId, fresh, stage, currentCalendar.planFingerprint)
      let run = await transaction.findRunByIdempotency(ownerUserId, runPayload.idempotencyKey)
      if (!run) run = await transaction.insertRun(runPayload)
      assertRunIdentity(run, runPayload)
      const leased = await transaction.acquireRunLease(ownerUserId, run.id, leaseToken, now, materializeLeaseMs(options.leaseMs))
      if (leased) leasedByEngineId.set(work.entryId, { run: leased, row: fresh, work })
    }
    const leaseConflict = initial.dueWork.some(work => !leasedByEngineId.has(work.entryId))
    const normalizedRequest = current.normalizedRequest
    if (!normalizedRequest) invalid('Calendar normalized request is missing.')
    const safeSkipped = normalizedRequest.catchUpPolicy === 'one_catch_up' && leaseConflict ? [] : initial.skippedEntryIds
    if (initial.dueWork.length > 0 && leasedByEngineId.size === 0 && safeSkipped.length === 0) collision('Due content work is currently held by another materialization lease.')
    const finalEligibleIds = [...leasedByEngineId.keys(), ...safeSkipped]
    const engineResult = materializeDueContentWork({ calendar: current, expectedPlanFingerprint: currentCalendar.planFingerprint, nowLocalDate, eligibleEntryIds: finalEligibleIds })
    if (!engineResult.calendar) invalid('Due content materialization was blocked by the pure calendar engine.')
    let updatedCalendar = currentCalendar
    if (engineResult.calendar.planFingerprint !== currentCalendar.planFingerprint) {
      const conditional = await transaction.updateCalendarIfFingerprint(ownerUserId, currentCalendar.id, currentCalendar.planFingerprint, calendarPatchFromResult(engineResult.calendar))
      if (!conditional) collision('Calendar plan fingerprint is stale.')
      updatedCalendar = conditional
    }
    for (const work of engineResult.dueWork) {
      const leased = leasedByEngineId.get(work.entryId)
      if (!leased) continue
      const updatedEntry = await transaction.updateEntry(ownerUserId, leased.row.id, { status: 'materialized' })
      const released = await transaction.releaseRunLease(ownerUserId, leased.run.id, 'queued', leaseToken, now)
      if (!released) collision('Materialization lease release was rejected.')
      runs.push(released)
      events.push(await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: currentCalendar.id, entryId: updatedEntry.id, runId: released.id, eventType: 'entry_materialized', fromStatus: leased.row.status, toStatus: updatedEntry.status, metadata: { stage: leased.run.stage, workId: work.workId, engineEntryId: work.entryId, providerExecution: false }, key: { runId: released.id, event: 'entry_materialized' } })))
    }
    for (const skippedId of engineResult.skippedEntryIds) {
      const row = rowsByEngineId.get(skippedId)
      if (!row || row.status !== 'planned') continue
      const fresh = await transaction.findEntry(ownerUserId, row.id)
      if (!fresh || fresh.status !== 'planned') continue
      const updatedEntry = await transaction.updateEntry(ownerUserId, fresh.id, { status: 'skipped' })
      events.push(await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: currentCalendar.id, entryId: updatedEntry.id, eventType: 'entry_skipped', fromStatus: fresh.status, toStatus: updatedEntry.status, metadata: { providerExecution: false }, key: { entryId: fresh.id, event: 'entry_skipped', fingerprint: currentCalendar.planFingerprint } })))
    }
    return { calendar: updatedCalendar, dueWork: engineResult.dueWork, entries: await transaction.listEntries(ownerUserId, currentCalendar.id), runs, events, replayed: false } satisfies MaterializeResult
  })
}

async function deliveredPublication(repository: ContentOperationsRepository, ownerUserId: number, entryId: number) {
  const resolved = await repository.resolveDeliveredPublication(ownerUserId, entryId)
  if (!resolved || (resolved.entry.status !== 'delivered' && resolved.entry.status !== 'completed') || !resolved.entry.contentHash || !resolved.job || !resolved.draft || !resolved.review || resolved.review.decision !== 'approved_for_delivery' || !resolved.riskGate || resolved.riskGate.status !== 'passed' || !resolved.publicationRun || resolved.publicationRun.ownerUserId !== ownerUserId || resolved.publicationRun.entryId !== resolved.entry.id || resolved.publicationRun.stage !== 'publication' || resolved.publicationRun.state !== 'succeeded') invalid('Outcome assessment requires a delivered publication identity.')
  if (resolved.calendar.ownerUserId !== ownerUserId || resolved.entry.ownerUserId !== ownerUserId || resolved.deliverable.ownerUserId !== ownerUserId || resolved.job.ownerUserId !== ownerUserId || resolved.draft.jobId !== resolved.job.id || resolved.review.jobId !== resolved.job.id || resolved.review.draftId !== resolved.draft.id || resolved.review.reviewerUserId !== ownerUserId || resolved.job.productionPlanId !== resolved.calendar.productionPlanId || resolved.job.productionDeliverableId !== resolved.entry.productionDeliverableId || resolved.job.strategyRecommendationId !== resolved.entry.strategyRecommendationId || resolved.job.evidenceSnapshotHash !== resolved.entry.evidenceSnapshotHash || resolved.draft.contentHash !== resolved.entry.contentHash || resolved.review.evidenceSnapshotHash !== resolved.entry.evidenceSnapshotHash || resolved.riskGate.draftId !== resolved.draft.id || resolved.riskGate.evidenceSnapshotHash !== resolved.entry.evidenceSnapshotHash) invalid('Delivered publication content/evidence lineage is inconsistent.')
  const context = await repository.resolveCanonicalContext(ownerUserId, resolved.calendar.productionPlanId, resolved.entry.productionDeliverableId)
  if (context.evidenceSnapshot.hash !== resolved.entry.evidenceSnapshotHash || context.deliverable.id !== resolved.entry.productionDeliverableId || context.strategy.id !== resolved.entry.strategyRecommendationId || context.opportunity.key !== resolved.entry.topicCluster) invalid('Delivered publication canonical context is inconsistent.')
  const ruleIds = canonicalRuleIds(context)
  const topicCluster = resolved.entry.topicCluster
  return { ...resolved, ruleIds, topicCluster }
}

function deidentifiedOwnerKey(ownerUserId: number): string {
  return createHash('sha256').update(`content-operations:${ownerUserId}`).digest('hex')
}

function safeMeasurementSnapshot(values: unknown[]): unknown[] {
  return values.slice(0, 100).map(value => {
    if (!isRecord(value)) return { invalid: true }
    return {
      source: value.source,
      deidentifiedSubjectKey: value.deidentifiedSubjectKey,
      scopeFingerprint: value.scopeFingerprint,
      phase: value.phase,
      windowStart: value.windowStart,
      windowEnd: value.windowEnd,
      capturedAt: value.capturedAt,
      sourceHash: value.sourceHash,
      metrics: isRecord(value.metrics) ? Object.fromEntries(Object.entries(value.metrics).filter(([, metric]) => typeof metric === 'number' && Number.isFinite(metric)).slice(0, 50)) : {},
    }
  })
}

function safeConsentSnapshot(value: unknown): AnyRecord {
  if (!isRecord(value)) return { consentStatus: 'unknown', consentVersion: '', consentedAt: null, consentAllowedUses: [], consentRevokedAt: null, rightsConfirmed: false }
  return { consentStatus: value.consentStatus, consentVersion: value.consentVersion, consentedAt: value.consentedAt ?? null, consentAllowedUses: Array.isArray(value.consentAllowedUses) ? value.consentAllowedUses.slice(0, 20) : [], consentRevokedAt: value.consentRevokedAt ?? null, rightsConfirmed: value.rightsConfirmed === true }
}

export async function recordOwnerOutcomeAssessment(ownerUserId: number, input: unknown, repository?: ContentOperationsRepository): Promise<OutcomeResult> {
  const db = await getRepository(repository)
  const parsed = parseOutcomeInput(input)
  if (parsed.dataContractVersion !== OUTCOME_DATA_CONTRACT_VERSION) invalid('Outcome data contract version is unsupported.')
  const publication = await deliveredPublication(db, ownerUserId, parsed.entryId)
  if (parsed.runId && parsed.runId !== publication.publicationRun?.id) collision('Outcome runId does not match the delivered publication run.')
  const publishedAt = publication.publicationRun?.completedAt || publication.entry.updatedAt
  const publicationIdentity = {
    deidentifiedSubjectKey: deidentifiedOwnerKey(ownerUserId),
    scheduleEntryId: publication.entry.engineEntryId,
    scheduleKey: publication.entry.scheduleKey,
    productionPlanId: String(publication.calendar.productionPlanId),
    jobId: String(publication.job.id),
    draftId: String(publication.draft.id),
    draftVersion: String(publication.draft.version),
    contentHash: publication.entry.contentHash,
    evidenceSnapshotHash: publication.entry.evidenceSnapshotHash,
    publishedAt: publishedAt.toISOString(),
    contentType: publication.entry.contentType,
    language: publication.entry.language,
    appliedRuleIds: publication.ruleIds,
    topicClusterCode: publication.topicCluster,
  }
  const outcomeRequest = { publication: publicationIdentity, baselineMeasurements: parsed.baselineMeasurements, followUpMeasurements: parsed.followUpMeasurements, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
  const assessment = assessPublishedContentOutcome(outcomeRequest)
  const learningCandidate = parsed.learningCandidate ? buildOutcomeLearningCandidate({ outcomeRequest, assessment, consent: parsed.consent, piiScanStatus: 'unknown', dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }) : null
  const fingerprint = stableFingerprint({ entryId: parsed.entryId, idempotencyKey: parsed.idempotencyKey, outcomeRequest, consent: safeConsentSnapshot(parsed.consent), assessmentFingerprint: assessment.assessmentFingerprint })
  const existing = await db.findOutcomeByIdempotency(ownerUserId, parsed.idempotencyKey)
  if (existing) {
    if (existing.assessmentFingerprint !== assessment.assessmentFingerprint || stableFingerprint(existing.baselineSnapshot) !== stableFingerprint(safeMeasurementSnapshot(parsed.baselineMeasurements)) || stableFingerprint(existing.followUpSnapshot) !== stableFingerprint(safeMeasurementSnapshot(parsed.followUpMeasurements)) || stableFingerprint(existing.consentLineageSnapshot) !== stableFingerprint(safeConsentSnapshot(parsed.consent))) collision('Outcome idempotency key is already associated with a different assessment payload.')
    return { assessment: existing.assessmentSnapshot as unknown as PublishedContentOutcomeAssessment, learningCandidate, persisted: existing }
  }
  const measuredAt = parsed.measuredAt ? new Date(parsed.measuredAt) : new Date()
  const outcomeInsert: OutcomeInsert = {
    ownerUserId,
    entryId: publication.entry.id,
    runId: publication.publicationRun?.id || null,
    assessmentStatus: assessment.status,
    assessmentFingerprint: assessment.assessmentFingerprint,
    baselineSnapshot: safeMeasurementSnapshot(parsed.baselineMeasurements),
    followUpSnapshot: safeMeasurementSnapshot(parsed.followUpMeasurements),
    assessmentSnapshot: assessment,
    consentLineageSnapshot: safeConsentSnapshot(parsed.consent),
    idempotencyKey: parsed.idempotencyKey,
    measuredAt,
  }
  return db.transaction(async transaction => {
    const persisted = await transaction.insertOutcome(outcomeInsert)
    await transaction.appendEvent(eventInput(ownerUserId, { entryId: publication.entry.id, runId: outcomeInsert.runId, eventType: 'outcome_assessed', fromStatus: publication.entry.status, toStatus: assessment.status, metadata: { assessmentStatus: assessment.status, assessmentFingerprint: assessment.assessmentFingerprint, learningCandidateStatus: learningCandidate?.candidateStatus || 'not_requested', providerExecution: false }, key: { event: 'outcome_assessed', fingerprint, idempotencyKey: parsed.idempotencyKey } }))
    return { assessment, learningCandidate, persisted }
  })
}

function nextActionForEntry(entry: ContentOperationCalendarEntryRow, hasApprovedDraft: boolean, hasPassedRiskGate: boolean, hasOutcome: boolean): WorkspacePayload['entries'][number]['nextAction'] {
  if (entry.status === 'planned') return 'generate'
  if (entry.status === 'materialized' || entry.status === 'awaiting_generation') return hasApprovedDraft && hasPassedRiskGate ? 'publish' : 'generate'
  if (entry.status === 'awaiting_review') return 'review'
  if (entry.status === 'ready_to_publish' || entry.status === 'publishing') return 'publish'
  if (entry.status === 'delivered') return hasOutcome ? 'learn' : 'measure'
  if (entry.status === 'completed') return hasOutcome ? 'learn' : 'measure'
  return 'none'
}

function outcomeValidPairCount(snapshot: unknown): number | null {
  if (!isRecord(snapshot) || typeof snapshot.validPairCount !== 'number' || !Number.isSafeInteger(snapshot.validPairCount) || snapshot.validPairCount < 0) return null
  return snapshot.validPairCount
}

export async function getOwnerContentOperationsWorkspace(ownerUserId: number, repository?: ContentOperationsRepository): Promise<WorkspacePayload> {
  const db = await getRepository(repository)
  const [clients, calendars, entries, runs, outcomeAssessments, targets] = await Promise.all([db.listClients(ownerUserId), db.listCalendars(ownerUserId), db.listEntries(ownerUserId), db.listRuns(ownerUserId), db.listOutcomes(ownerUserId), db.listPublicationTargets(ownerUserId)])
  const lineages = await Promise.all(entries.map(entry => db.resolveWorkspaceEntry(ownerUserId, entry.id)))
  const projections = entries.map((entry, index) => {
    const lineage = lineages[index]
    const hasApprovedDraft = Boolean(lineage?.draft && lineage.review && ['approved_for_preview', 'approved_for_delivery'].includes(lineage.review.decision) && lineage.review.evidenceSnapshotHash === entry.evidenceSnapshotHash && lineage.draft.jobId === lineage.job?.id)
    const hasPassedRiskGate = Boolean(lineage?.riskGate && lineage.riskGate.status === 'passed' && lineage.riskGate.evidenceSnapshotHash === entry.evidenceSnapshotHash && lineage.riskGate.draftId === lineage.draft?.id)
    const hasOutcome = outcomeAssessments.some(outcome => outcome.entryId === entry.id)
    return { ...entry, topic: entry.topicCluster, framework: lineage?.client.framework || null, target: lineage?.client.canonicalSiteOrigin || null, hasApprovedDraft, hasPassedRiskGate, nextAction: nextActionForEntry(entry, hasApprovedDraft, hasPassedRiskGate, hasOutcome) }
  })
  const activeTargets = targets.filter(target => target.status === 'active')
  const publicationTargets = targets.map(target => ({ id: target.id, clientId: target.clientId, targetId: target.targetId, framework: target.framework, transport: target.transport, targetOrigin: target.targetOrigin, contentRoot: target.contentRoot, defaultBranch: target.defaultBranch, repositoryOwner: target.repositoryOwner, repositoryName: target.repositoryName, endpointPath: target.endpointPath, allowedContentTypes: target.allowedContentTypes, allowedLanguages: target.allowedLanguages, maximumPayloadBytes: target.maximumPayloadBytes, status: target.status, activeSlot: target.activeSlot, executionEnabled: target.executionEnabled, credentialConfigured: Boolean(target.credentialReference), configurationFingerprint: target.configurationFingerprint, idempotencyKey: target.idempotencyKey, createdAt: target.createdAt, updatedAt: target.updatedAt }))
  return { clients: clients.map(publicClient), calendars, entries: projections, runs, outcomeAssessments: outcomeAssessments.map(outcome => ({ ...outcome, validPairCount: outcomeValidPairCount(outcome.assessmentSnapshot) })), publicationTargets, capabilities: { schedulerAvailable: true, generationExecutorConfigured: false, firstPartyPublisherConfigured: false, outcomeCollectionConfigured: false }, readiness: { schedulerAvailable: true, generationExecutorAvailable: true, publicationTargetConfigured: activeTargets.length > 0, publicationExecutionEnabled: activeTargets.some(target => target.executionEnabled), credentialReferenceConfigured: activeTargets.some(target => Boolean(target.credentialReference)), runtimeCredentialResolverAvailable: runtimeCredentialResolverAvailable(), outcomeCollectionConfigured: false }, limitations: [...CONTENT_OPERATIONS_LIMITATIONS] }
}

export function getDefaultContentOperationsClock(): Clock {
  return defaultClock()
}

export const CONTENT_OPERATIONS_MAX_TICK_ENTRIES = MAX_TICK_ENTRIES
