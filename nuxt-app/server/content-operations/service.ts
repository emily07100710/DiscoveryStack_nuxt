import { createHash } from 'node:crypto'
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
import { getProductionPlanBundle } from '../seo-geo-core/repository'
import type {
  CalendarInsert,
  ContentOperationsRepository,
  EntryInsert,
  OutcomeInsert,
  RunInsert,
} from './repository'
import { createContentOperationsRepository } from './repository'
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
  ContentOperationClientInput,
  ContentOperationClientRow,
  ContentOperationRunRow,
  CreateCalendarInput,
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

function strategyFor(bundle: PlanBundle, selectionId: number) {
  const selection = bundle.selections.find(item => item.id === selectionId && item.planId === bundle.plan.id && item.ownerUserId === bundle.plan.ownerUserId && item.status === 'selected')
  if (!selection) invalid('Production Deliverable selection is not an active persisted selection.')
  const strategy = bundle.strategies.find(item => item.id === selection.strategyRecommendationId && item.ownerUserId === bundle.plan.ownerUserId && item.status !== 'rejected' && item.status !== 'superseded')
  if (!strategy) invalid('Production Strategy recommendation is not active for this owner and plan.')
  return { selection, strategy }
}

function opportunityProvenance(deliverable: PlanBundle['deliverables'][number], strategy: PlanBundle['strategies'][number]) {
  const deliverableProvenance = isRecord(deliverable.provenance) ? deliverable.provenance : null
  const strategyProvenance = isRecord(strategy.provenance) ? strategy.provenance : null
  const ruleIds = arrayOfStrings(deliverableProvenance?.ruleIds)
  const authoritySourceIds = arrayOfStrings(deliverableProvenance?.authoritySourceIds)
  const topicCluster = readString(deliverableProvenance || {}, ['topicCluster', 'topicClusterCode'])
  if (!ruleIds || !authoritySourceIds || !topicCluster) invalid('Production Plan provenance is incomplete for calendar planning.')
  return { ruleIds, authoritySourceIds, topicCluster }
}

function buildOpportunities(bundle: PlanBundle, input: CreateCalendarInput, client: ContentOperationClientRow): ContentCalendarOpportunity[] {
  if (bundle.plan.ownerUserId !== client.ownerUserId || bundle.plan.status === 'blocked' || bundle.plan.status === 'archived') invalid('Production Plan is not available for this owner calendar.')
  assertSha256(bundle.plan.evidenceSnapshotHash, 'Production Plan evidence snapshot')
  const selectedDeliverables = bundle.deliverables.filter(deliverable => deliverable.ownerUserId === bundle.plan.ownerUserId && deliverable.planId === bundle.plan.id)
  if (selectedDeliverables.length === 0) invalid('Production Plan has no persisted deliverables.')
  const hashes = new Set<string>([bundle.plan.evidenceSnapshotHash])
  const opportunities = selectedDeliverables.map((deliverable) => {
    if (deliverable.contentType !== 'article' && deliverable.contentType !== 'faq' && deliverable.contentType !== 'service_page') invalid('Production Deliverable content type is not supported by the calendar engine.')
    if (deliverable.language !== 'en' && deliverable.language !== 'zh-hant') invalid('Production Deliverable language is not supported by the calendar engine.')
    if (deliverable.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash) collision('Production Plan and Deliverable evidence snapshots are inconsistent.')
    const { strategy } = strategyFor(bundle, deliverable.selectionId)
    if (strategy.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash) collision('Production Strategy evidence snapshot is stale.')
    const provenance = opportunityProvenance(deliverable, strategy)
    hashes.add(deliverable.evidenceSnapshotHash)
    const opportunityId = `deliverable-${deliverable.id}`
    return {
      id: opportunityId,
      strategyRecommendationId: strategy.id,
      title: deliverable.title,
      contentType: deliverable.contentType as 'article' | 'faq' | 'service_page',
      language: deliverable.language as 'en' | 'zh-hant',
      priority: strategy.priority as 'high' | 'medium' | 'low',
      status: 'selected' as const,
      topicCluster: provenance.topicCluster,
      evidenceSnapshotHash: bundle.plan.evidenceSnapshotHash,
      estimatedCostUnits: input.defaultCostUnits,
      ruleIds: provenance.ruleIds,
      authoritySourceIds: provenance.authoritySourceIds,
    }
  })
  if (hashes.size !== 1) collision('All Production Plan provenance must share one evidence snapshot.')
  const request: ContentCalendarRequest = {
    clientScopeKey: `client-${client.id}`,
    planStartDate: input.planStartDate,
    planEndDate: input.planEndDate,
    timeZone: normalizeTimeZone(client.timeZone),
    publishLocalTime: input.publishLocalTime,
    cadenceDays: input.cadenceDays,
    monthlyBudgetUnits: input.monthlyBudgetUnits,
    defaultCostUnits: input.defaultCostUnits,
    maxItemsPerCalendarMonth: input.maxItemsPerCalendarMonth,
    maximumTotalItems: input.maximumTotalItems,
    catchUpPolicy: input.catchUpPolicy,
    evidenceSnapshotHash: bundle.plan.evidenceSnapshotHash,
    opportunities,
  }
  return request.opportunities
}

async function verifyCanonicalContexts(repository: ContentOperationsRepository, ownerUserId: number, bundle: PlanBundle): Promise<void> {
  for (const deliverable of bundle.deliverables) {
    const context = await repository.resolveCanonicalContext(ownerUserId, bundle.plan.id, deliverable.id)
    if (context.plan.ownerUserId !== ownerUserId || context.deliverable.id !== deliverable.id || context.evidenceSnapshot.hash !== bundle.plan.evidenceSnapshotHash || context.deliverable.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash || context.strategy.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash) collision('Persisted Production Plan context is stale or inconsistent.')
    if (!context.opportunity || context.opportunity.deliverableType !== deliverable.contentType || context.opportunity.title !== deliverable.title || context.opportunity.audience !== deliverable.audience) collision('Persisted Production Deliverable opportunity is not canonical.')
  }
}

function buildRequest(bundle: PlanBundle, input: CreateCalendarInput, client: ContentOperationClientRow): ContentCalendarRequest {
  const opportunities = buildOpportunities(bundle, input, client)
  return {
    clientScopeKey: `client-${client.id}`,
    planStartDate: input.planStartDate,
    planEndDate: input.planEndDate,
    timeZone: normalizeTimeZone(client.timeZone),
    publishLocalTime: input.publishLocalTime,
    cadenceDays: input.cadenceDays,
    monthlyBudgetUnits: input.monthlyBudgetUnits,
    defaultCostUnits: input.defaultCostUnits,
    maxItemsPerCalendarMonth: input.maxItemsPerCalendarMonth,
    maximumTotalItems: input.maximumTotalItems,
    catchUpPolicy: input.catchUpPolicy,
    evidenceSnapshotHash: bundle.plan.evidenceSnapshotHash,
    opportunities,
  }
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
    status: entryStatusForDatabase(entry.status),
    engineEntryId: entry.entryId,
    idempotencyKey: entry.idempotencyKey,
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
  return db.insertClient({ ownerUserId, status: 'active', ...normalized })
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
  if (bundle.plan.ownerUserId !== ownerUserId) ownerMismatch('Production Plan was not found for this owner.')
  await verifyCanonicalContexts(db, ownerUserId, bundle)
  const request = buildRequest(bundle, parsed, client)
  const result = buildContentCalendar(request)
  if (!result.normalizedRequest || result.status === 'blocked') invalid('Production Plan could not produce a valid content calendar.')
  return db.transaction(async transaction => {
    const calendar = await transaction.insertCalendar(calendarInsert(ownerUserId, client.id, parsed.productionPlanId, parsed, request, result))
    const deliverableByOpportunity = new Map(bundle.deliverables.map(deliverable => [`deliverable-${deliverable.id}`, deliverable.id]))
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
  assertSha256(parsed.expectedPlanFingerprint, 'Expected plan fingerprint')
  if (calendar.planFingerprint !== parsed.expectedPlanFingerprint) collision('Calendar plan fingerprint is stale.')
  const client = await db.findClient(ownerUserId, calendar.clientId)
  if (!client || client.status === 'archived') ownerMismatch('Content operation client was not found for this owner.')
  const bundle = asPlanBundle(await db.getPlanBundle(ownerUserId, calendar.productionPlanId))
  await verifyCanonicalContexts(db, ownerUserId, bundle)
  const replanInput: CreateCalendarInput = { ...parsed.request, clientId: client.id, productionPlanId: calendar.productionPlanId, idempotencyKey: calendar.idempotencyKey }
  const request = buildRequest(bundle, replanInput, client)
  const persistedEntries = await db.listEntries(ownerUserId, calendar.id)
  const current = calendar.resultSnapshot as unknown as ContentCalendarResult
  const result = replanContentCalendar({ calendar: current, expectedPlanFingerprint: parsed.expectedPlanFingerprint, request })
  if (result.status === 'blocked') invalid(`Content calendar replan was blocked by the pure calendar engine: ${result.reasonCodes.join(',') || 'INVALID_INPUT'}.`)
  return db.transaction(async transaction => {
    const updatedCalendar = await transaction.updateCalendar(ownerUserId, calendar.id, {
      status: result.status,
      planStartDate: replanInput.planStartDate,
      planEndDate: replanInput.planEndDate,
      timeZone: request.timeZone,
      publishLocalTime: replanInput.publishLocalTime,
      cadenceDays: replanInput.cadenceDays,
      monthlyBudgetUnits: replanInput.monthlyBudgetUnits,
      defaultCostUnits: replanInput.defaultCostUnits,
      maxItemsPerCalendarMonth: replanInput.maxItemsPerCalendarMonth,
      maximumTotalItems: replanInput.maximumTotalItems,
      catchUpPolicy: replanInput.catchUpPolicy,
      evidenceSnapshotHash: request.evidenceSnapshotHash,
      revision: result.revision,
      previousPlanFingerprint: result.previousPlanFingerprint,
      planFingerprint: result.planFingerprint,
      normalizedRequestSnapshot: result.normalizedRequest,
      resultSnapshot: result,
    })
    const byEngineId = new Map(persistedEntries.map(entry => [entry.engineEntryId, entry]))
    const activeEngineIds = new Set(result.entries.map(entry => entry.entryId))
    const entries: ContentOperationCalendarEntryRow[] = []
    for (const entry of result.entries) {
      const old = byEngineId.get(entry.entryId)
      if (old) {
        const durableStatus = old.status === 'delivered' || old.status === 'completed' ? old.status : entryStatusForDatabase(entry.status)
        entries.push(await transaction.updateEntry(ownerUserId, old.id, { scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, status: durableStatus }))
      } else {
        const deliverableId = bundle.deliverables.find(deliverable => `deliverable-${deliverable.id}` === entry.opportunityId)?.id
        if (!deliverableId) invalid('Replanned opportunity does not map to a persisted Production Deliverable.')
        entries.push(await transaction.insertEntry(entryInsert(ownerUserId, calendar.id, deliverableId, entry)))
      }
    }
    for (const old of persistedEntries) {
      if (old.status === 'planned' && !activeEngineIds.has(old.engineEntryId)) entries.push(await transaction.updateEntry(ownerUserId, old.id, { status: 'cancelled' }))
    }
    await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, eventType: 'calendar_replanned', fromStatus: calendar.status, toStatus: updatedCalendar.status, metadata: { revision: updatedCalendar.revision, previousPlanFingerprint: updatedCalendar.previousPlanFingerprint, planFingerprint: updatedCalendar.planFingerprint }, key: { calendarId: calendar.id, event: 'calendar_replanned', planFingerprint: updatedCalendar.planFingerprint } }))
    return { calendar: updatedCalendar, entries, replayed: false }
  })
}

function limitMaterializeResult(result: ReturnType<typeof materializeDueContentWork>, maxEntries: number, allowedEntryIds?: Set<number>, persistedEntries: ContentOperationCalendarEntryRow[] = []) {
  const durableByEngineId = new Map(persistedEntries.map(entry => [entry.engineEntryId, entry]))
  const selected = result.dueWork.filter(work => {
    const row = durableByEngineId.get(work.entryId)
    return row && (!allowedEntryIds || allowedEntryIds.has(row.id))
  }).slice(0, maxEntries)
  const selectedIds = new Set(selected.map(work => work.entryId))
  const skipped = result.skippedEntryIds.filter(engineEntryId => {
    const row = durableByEngineId.get(engineEntryId)
    return row && (!allowedEntryIds || allowedEntryIds.has(row.id))
  }).slice(0, Math.max(0, maxEntries - selected.length))
  const processedIds = new Set([...selectedIds, ...skipped])
  const durableStatuses = new Map(persistedEntries.map(entry => [entry.engineEntryId, entry.status]))
  const calendar = result.calendar
    ? { ...result.calendar, entries: result.calendar.entries.map(entry => processedIds.has(entry.entryId) ? entry : { ...entry, status: engineStatusForDatabase(durableStatuses.get(entry.entryId) || entry.status) }) }
    : null
  return { calendar, dueWork: selected, skippedEntryIds: skipped }
}

export async function materializeOwnerDueContent(ownerUserId: number, input: MaterializeInput, repository?: ContentOperationsRepository) {
  const db = await getRepository(repository)
  const calendar = await db.findCalendar(ownerUserId, input.calendarId)
  if (!calendar) notFound('Content operation calendar was not found.')
  const client = await db.findClient(ownerUserId, calendar.clientId)
  if (!client || client.status !== 'active' || calendar.status === 'archived' || calendar.status === 'paused') invalid('Calendar is not active for materialization.')
  const persistedEntries = await db.listEntries(ownerUserId, calendar.id)
  const clock = input.clock || defaultClock()
  const now = clock.now()
  const nowLocalDate = clock.localDate(now, calendar.timeZone)
  assertDateOnly(nowLocalDate)
  const current = calendar.resultSnapshot as unknown as ContentCalendarResult
  const engineResult = materializeDueContentWork({ calendar: current, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate })
  const maxEntries = Math.max(1, Math.min(input.maxEntries || MAX_TICK_ENTRIES, MAX_TICK_ENTRIES))
  const limited = limitMaterializeResult(engineResult, maxEntries, input.onlyEntryIds ? new Set(input.onlyEntryIds) : undefined, persistedEntries)
  if (!limited.calendar) invalid('Due content materialization was blocked by the pure calendar engine.')
  return db.transaction(async transaction => {
    const updatedCalendar = calendar
    const runs: ContentOperationRunRow[] = []
    const events = []
    const entryRows = new Map(persistedEntries.map(entry => [entry.engineEntryId, entry]))
    const leaseOwner = input.leaseOwner
    for (const work of limited.dueWork) {
      const candidate = entryRows.get(work.entryId)
      if (!candidate) continue
      const row = await transaction.findEntry(ownerUserId, candidate.id)
      if (!row || row.status !== 'planned') continue
      const stage: RunInsert['stage'] = row.draftId ? 'review_wait' : 'generation'
      const runPayload = runInsert(ownerUserId, row, stage, calendar.planFingerprint)
      let run = await transaction.findRunByIdempotency(ownerUserId, runPayload.idempotencyKey)
      if (!run) run = await transaction.insertRun(runPayload)
      if (leaseOwner) {
        const leased = await transaction.acquireRunLease(ownerUserId, run.id, leaseOwner, now, input.leaseMs || DEFAULT_LEASE_MS)
        if (!leased) continue
        run = leased
      }
      const updatedEntry = await transaction.updateEntry(ownerUserId, row.id, { status: 'materialized' })
      if (run.state === 'processing' && leaseOwner) run = await transaction.releaseRunLease(ownerUserId, run.id, 'queued', now)
      runs.push(run)
      events.push(await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, entryId: updatedEntry.id, runId: run.id, eventType: 'entry_materialized', fromStatus: row.status, toStatus: updatedEntry.status, metadata: { stage, workId: work.workId, engineEntryId: work.entryId, providerExecution: false }, key: { runId: run.id, event: 'entry_materialized' } })))
    }
    for (const skippedId of limited.skippedEntryIds) {
      const row = entryRows.get(skippedId)
      if (!row || row.status !== 'planned') continue
      const updatedEntry = await transaction.updateEntry(ownerUserId, row.id, { status: 'skipped' })
      events.push(await transaction.appendEvent(eventInput(ownerUserId, { clientId: client.id, calendarId: calendar.id, entryId: updatedEntry.id, eventType: 'entry_skipped', fromStatus: row.status, toStatus: updatedEntry.status, metadata: { providerExecution: false }, key: { entryId: row.id, event: 'entry_skipped', fingerprint: calendar.planFingerprint } })))
    }
    return { calendar: updatedCalendar, dueWork: limited.dueWork, entries: await transaction.listEntries(ownerUserId, calendar.id), runs, events } satisfies MaterializeResult
  })
}

async function deliveredPublication(repository: ContentOperationsRepository, ownerUserId: number, entryId: number) {
  const resolved = await repository.resolveDeliveredPublication(ownerUserId, entryId)
  if (!resolved || (resolved.entry.status !== 'delivered' && resolved.entry.status !== 'completed') || !resolved.entry.contentHash || !resolved.job || !resolved.draft || !resolved.review || resolved.review.decision !== 'approved_for_delivery' || !resolved.publicationRun || resolved.publicationRun.state !== 'succeeded') invalid('Outcome assessment requires a delivered publication identity.')
  if (resolved.draft.contentHash !== resolved.entry.contentHash || resolved.review.evidenceSnapshotHash !== resolved.entry.evidenceSnapshotHash) invalid('Delivered publication content/evidence lineage is inconsistent.')
  const provenance = isRecord(resolved.deliverable.provenance) ? resolved.deliverable.provenance : {}
  const ruleIds = arrayOfStrings(provenance.ruleIds)
  const topicCluster = readString(provenance, ['topicCluster', 'topicClusterCode'])
  if (!ruleIds || !topicCluster) invalid('Delivered publication provenance is incomplete for outcome learning.')
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
      metrics: isRecord(value.metrics) ? Object.fromEntries(Object.entries(value.metrics).filter(([, metric]) => typeof metric === 'number').slice(0, 50)) : {},
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

export async function getOwnerContentOperationsWorkspace(ownerUserId: number, repository?: ContentOperationsRepository): Promise<WorkspacePayload> {
  const db = await getRepository(repository)
  const [clients, calendars, entries, runs, outcomeAssessments] = await Promise.all([db.listClients(ownerUserId), db.listCalendars(ownerUserId), db.listEntries(ownerUserId), db.listRuns(ownerUserId), db.listOutcomes(ownerUserId)])
  return { clients: clients.map(publicClient), calendars, entries, runs, outcomeAssessments, capabilities: { schedulerAvailable: true, generationExecutorConfigured: false, firstPartyPublisherConfigured: false, outcomeCollectionConfigured: false }, limitations: [...CONTENT_OPERATIONS_LIMITATIONS] }
}

export function getDefaultContentOperationsClock(): Clock {
  return defaultClock()
}

export const CONTENT_OPERATIONS_MAX_TICK_ENTRIES = MAX_TICK_ENTRIES
