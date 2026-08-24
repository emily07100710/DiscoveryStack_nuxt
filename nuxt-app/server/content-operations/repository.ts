import { and, desc, eq, inArray, isNull, lt, or, ne } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../database'
import {
  contentOperationCalendarEntries,
  contentOperationCalendars,
  contentOperationClients,
  contentOperationEvents,
  contentOperationOutcomeAssessments,
  contentOperationRuns,
  seoGeoProductionDeliverables,
  seoGeoContentJobs,
  seoGeoContentDrafts,
  seoGeoContentReviews,
} from '../database/schema'
import { getProductionPlanBundle, resolveProductionContext } from '../seo-geo-core/repository'
import type {
  ContentOperationCalendarEntryRow,
  ContentOperationCalendarRow,
  ContentOperationClientRow,
  ContentOperationEventRow,
  ContentOperationOutcomeAssessmentRow,
  ContentOperationRunRow,
  PlanBundle,
  DeliveredPublication,
} from './types'
import type { Clock } from './types'

export type CalendarInsert = Omit<ContentOperationCalendarRow, 'id' | 'createdAt' | 'updatedAt'>
export type EntryInsert = Omit<ContentOperationCalendarEntryRow, 'id' | 'createdAt' | 'updatedAt'>
export type RunInsert = Omit<ContentOperationRunRow, 'id' | 'createdAt' | 'updatedAt'>
export type EventInsert = Omit<ContentOperationEventRow, 'id' | 'occurredAt'>
export type OutcomeInsert = Omit<ContentOperationOutcomeAssessmentRow, 'id' | 'createdAt'>

export type CanonicalContext = Awaited<ReturnType<typeof resolveProductionContext>>

export type ContentOperationsRepository = {
  transaction<T>(work: (repository: ContentOperationsRepository) => Promise<T>): Promise<T>
  findClientByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationClientRow | null>
  findClientByOrigin(ownerUserId: number, canonicalSiteOrigin: string): Promise<ContentOperationClientRow | null>
  findClient(ownerUserId: number, clientId: number): Promise<ContentOperationClientRow | null>
  insertClient(input: Omit<ContentOperationClientRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<ContentOperationClientRow>
  listClients(ownerUserId: number): Promise<ContentOperationClientRow[]>
  findCalendarByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationCalendarRow | null>
  findCalendar(ownerUserId: number, calendarId: number): Promise<ContentOperationCalendarRow | null>
  insertCalendar(input: CalendarInsert): Promise<ContentOperationCalendarRow>
  updateCalendar(ownerUserId: number, calendarId: number, patch: Partial<CalendarInsert>): Promise<ContentOperationCalendarRow>
  listCalendars(ownerUserId: number): Promise<ContentOperationCalendarRow[]>
  findEntry(ownerUserId: number, entryId: number): Promise<ContentOperationCalendarEntryRow | null>
  listEntries(ownerUserId: number, calendarId?: number): Promise<ContentOperationCalendarEntryRow[]>
  insertEntry(input: EntryInsert): Promise<ContentOperationCalendarEntryRow>
  updateEntry(ownerUserId: number, entryId: number, patch: Partial<EntryInsert>): Promise<ContentOperationCalendarEntryRow>
  listRuns(ownerUserId: number, entryId?: number): Promise<ContentOperationRunRow[]>
  findRunByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationRunRow | null>
  insertRun(input: RunInsert): Promise<ContentOperationRunRow>
  acquireRunLease(ownerUserId: number, runId: number, leaseOwner: string, now: Date, leaseMs: number): Promise<ContentOperationRunRow | null>
  releaseRunLease(ownerUserId: number, runId: number, state: RunInsert['state'], now: Date, error?: { code?: string; summary?: string }): Promise<ContentOperationRunRow>
  appendEvent(input: EventInsert): Promise<ContentOperationEventRow>
  listEvents(ownerUserId: number, entryId?: number): Promise<ContentOperationEventRow[]>
  findOutcomeByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationOutcomeAssessmentRow | null>
  insertOutcome(input: OutcomeInsert): Promise<ContentOperationOutcomeAssessmentRow>
  listOutcomes(ownerUserId: number): Promise<ContentOperationOutcomeAssessmentRow[]>
  getPlanBundle(ownerUserId: number, productionPlanId: number): Promise<PlanBundle>
  resolveCanonicalContext(ownerUserId: number, productionPlanId: number, deliverableId: number): Promise<CanonicalContext>
  resolveDeliveredPublication(ownerUserId: number, entryId: number): Promise<DeliveredPublication | null>
}

function requireOperationsDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Content Operations is temporarily unavailable.' })
  return database
}

function rowId(result: any): number {
  const id = Number(result?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Content operation record could not be recorded.' })
  return id
}

function makeRepository(database: any): ContentOperationsRepository {
  const repository: ContentOperationsRepository = {
    async transaction<T>(work: (repository: ContentOperationsRepository) => Promise<T>) {
      return database.transaction(async (transaction: any) => work(makeRepository(transaction)))
    },
    async findClientByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId, ownerUserId), eq(contentOperationClients.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async findClientByOrigin(ownerUserId, canonicalSiteOrigin) {
      const [row] = await database.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId, ownerUserId), eq(contentOperationClients.canonicalSiteOrigin, canonicalSiteOrigin))).limit(1)
      return row || null
    },
    async findClient(ownerUserId, clientId) {
      const [row] = await database.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId, ownerUserId), eq(contentOperationClients.id, clientId))).limit(1)
      return row || null
    },
    async insertClient(input) {
      const id = rowId(await database.insert(contentOperationClients).values(input as any))
      const row = await repository.findClient(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation client could not be loaded.' })
      return row
    },
    async listClients(ownerUserId) {
      return database.select().from(contentOperationClients).where(eq(contentOperationClients.ownerUserId, ownerUserId)).orderBy(desc(contentOperationClients.createdAt)).limit(100)
    },
    async findCalendarByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationCalendars).where(and(eq(contentOperationCalendars.ownerUserId, ownerUserId), eq(contentOperationCalendars.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async findCalendar(ownerUserId, calendarId) {
      const [row] = await database.select().from(contentOperationCalendars).where(and(eq(contentOperationCalendars.ownerUserId, ownerUserId), eq(contentOperationCalendars.id, calendarId))).limit(1)
      return row || null
    },
    async insertCalendar(input) {
      const id = rowId(await database.insert(contentOperationCalendars).values(input as any))
      const row = await repository.findCalendar(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation calendar could not be loaded.' })
      return row
    },
    async updateCalendar(ownerUserId, calendarId, patch) {
      await database.update(contentOperationCalendars).set(patch as any).where(and(eq(contentOperationCalendars.id, calendarId), eq(contentOperationCalendars.ownerUserId, ownerUserId)))
      const row = await repository.findCalendar(ownerUserId, calendarId)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Content operation calendar was not found.' })
      return row
    },
    async listCalendars(ownerUserId) {
      return database.select().from(contentOperationCalendars).where(eq(contentOperationCalendars.ownerUserId, ownerUserId)).orderBy(desc(contentOperationCalendars.createdAt)).limit(100)
    },
    async findEntry(ownerUserId, entryId) {
      const [row] = await database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.ownerUserId, ownerUserId), eq(contentOperationCalendarEntries.id, entryId))).limit(1)
      return row || null
    },
    async listEntries(ownerUserId, calendarId) {
      return database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.ownerUserId, ownerUserId), calendarId ? eq(contentOperationCalendarEntries.calendarId, calendarId) : undefined)).orderBy(contentOperationCalendarEntries.plannedLocalDate, contentOperationCalendarEntries.scheduleKey).limit(500)
    },
    async insertEntry(input) {
      const id = rowId(await database.insert(contentOperationCalendarEntries).values(input as any))
      const row = await repository.findEntry(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation calendar entry could not be loaded.' })
      return row
    },
    async updateEntry(ownerUserId, entryId, patch) {
      await database.update(contentOperationCalendarEntries).set(patch as any).where(and(eq(contentOperationCalendarEntries.id, entryId), eq(contentOperationCalendarEntries.ownerUserId, ownerUserId)))
      const row = await repository.findEntry(ownerUserId, entryId)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Content operation calendar entry was not found.' })
      return row
    },
    async listRuns(ownerUserId, entryId) {
      return database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), entryId ? eq(contentOperationRuns.entryId, entryId) : undefined)).orderBy(desc(contentOperationRuns.createdAt)).limit(500)
    },
    async findRunByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertRun(input) {
      const id = rowId(await database.insert(contentOperationRuns).values(input as any))
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, input.ownerUserId), eq(contentOperationRuns.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation run could not be loaded.' })
      return row
    },
    async acquireRunLease(ownerUserId, runId, leaseOwner, now, leaseMs) {
      const leaseExpiresAt = new Date(now.getTime() + leaseMs)
      await database.update(contentOperationRuns).set({ state: 'processing', leaseOwner, leaseExpiresAt, startedAt: now, updatedAt: now }).where(and(
        eq(contentOperationRuns.id, runId),
        eq(contentOperationRuns.ownerUserId, ownerUserId),
        or(ne(contentOperationRuns.state, 'processing'), isNull(contentOperationRuns.leaseExpiresAt), lt(contentOperationRuns.leaseExpiresAt, now)),
      ))
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId), eq(contentOperationRuns.leaseOwner, leaseOwner))).limit(1)
      return row || null
    },
    async releaseRunLease(ownerUserId, runId, state, now, error) {
      await database.update(contentOperationRuns).set({ state, leaseOwner: null, leaseExpiresAt: null, completedAt: state === 'succeeded' || state === 'failed' || state === 'blocked' || state === 'cancelled' ? now : null, errorCode: error?.code || null, errorSummary: error?.summary || null, updatedAt: now }).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId)))
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId))).limit(1)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Content operation run was not found.' })
      return row
    },
    async appendEvent(input) {
      const [existing] = await database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, input.ownerUserId), eq(contentOperationEvents.eventFingerprint, input.eventFingerprint))).limit(1)
      if (existing) return existing
      const id = rowId(await database.insert(contentOperationEvents).values(input as any))
      const [row] = await database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, input.ownerUserId), eq(contentOperationEvents.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation event could not be loaded.' })
      return row
    },
    async listEvents(ownerUserId, entryId) {
      return database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, ownerUserId), entryId ? eq(contentOperationEvents.entryId, entryId) : undefined)).orderBy(desc(contentOperationEvents.occurredAt)).limit(500)
    },
    async findOutcomeByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationOutcomeAssessments).where(and(eq(contentOperationOutcomeAssessments.ownerUserId, ownerUserId), eq(contentOperationOutcomeAssessments.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertOutcome(input) {
      const id = rowId(await database.insert(contentOperationOutcomeAssessments).values(input as any))
      const [row] = await database.select().from(contentOperationOutcomeAssessments).where(and(eq(contentOperationOutcomeAssessments.ownerUserId, input.ownerUserId), eq(contentOperationOutcomeAssessments.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation outcome could not be loaded.' })
      return row
    },
    async listOutcomes(ownerUserId) {
      return database.select().from(contentOperationOutcomeAssessments).where(eq(contentOperationOutcomeAssessments.ownerUserId, ownerUserId)).orderBy(desc(contentOperationOutcomeAssessments.measuredAt)).limit(100)
    },
    async getPlanBundle(ownerUserId, productionPlanId) {
      return await getProductionPlanBundle(ownerUserId, productionPlanId) as unknown as PlanBundle
    },
    async resolveCanonicalContext(ownerUserId, productionPlanId, deliverableId) {
      return resolveProductionContext({ ownerUserId, planId: productionPlanId, deliverableId })
    },
    async resolveDeliveredPublication(ownerUserId, entryId) {
      const [entry] = await database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.ownerUserId, ownerUserId), eq(contentOperationCalendarEntries.id, entryId))).limit(1)
      if (!entry) return null
      const [calendar] = await database.select().from(contentOperationCalendars).where(and(eq(contentOperationCalendars.ownerUserId, ownerUserId), eq(contentOperationCalendars.id, entry.calendarId))).limit(1)
      const [deliverable] = await database.select().from(seoGeoProductionDeliverables).where(and(eq(seoGeoProductionDeliverables.ownerUserId, ownerUserId), eq(seoGeoProductionDeliverables.id, entry.productionDeliverableId), eq(seoGeoProductionDeliverables.planId, calendar?.productionPlanId || -1))).limit(1)
      if (!calendar || !deliverable || !entry.jobId || !entry.draftId || !entry.reviewId) return null
      const [job] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), eq(seoGeoContentJobs.id, entry.jobId))).limit(1)
      const [draft] = await database.select().from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, entry.draftId), eq(seoGeoContentDrafts.jobId, entry.jobId))).limit(1)
      const [review] = await database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.id, entry.reviewId), eq(seoGeoContentReviews.jobId, entry.jobId), eq(seoGeoContentReviews.draftId, entry.draftId), eq(seoGeoContentReviews.reviewerUserId, ownerUserId))).limit(1)
      if (!job || !draft || !review) return null
      const publicationRuns = await repository.listRuns(ownerUserId, entry.id)
      const publicationRun = publicationRuns.find(run => run.stage === 'publication') || null
      return { entry, calendar, deliverable, job, draft, review, publicationRun }
    },
  }
  return repository
}

export function createContentOperationsRepository(): ContentOperationsRepository {
  return makeRepository(requireOperationsDatabase())
}

export function createContentOperationsRepositoryFromDatabase(database: unknown): ContentOperationsRepository {
  return makeRepository(database as any)
}

export function createInMemoryRepositoryForTests(): ContentOperationsRepository {
  throw new Error('Tests must provide an explicit mocked ContentOperationsRepository boundary.')
}
