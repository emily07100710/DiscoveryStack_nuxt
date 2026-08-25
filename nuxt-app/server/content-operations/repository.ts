import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../database'
import {
  contentOperationCalendarEntries,
  contentOperationCalendars,
  contentOperationClients,
  contentOperationOutcomeAssessments,
  contentOperationPublicationAttempts,
  contentOperationPublicationTargets,
  contentOperationRuns,
  contentOperationEvents,
  seoGeoProductionDeliverables,
  seoGeoContentJobs,
  seoGeoContentDrafts,
  seoGeoContentReviews,
  seoGeoContentRiskGates,
} from '../database/schema'
import { getProductionPlanBundle, resolveProductionContext } from '../seo-geo-core/repository'
import type {
  ContentOperationCalendarEntryRow,
  ContentOperationCalendarRow,
  ContentOperationClientRow,
  ContentOperationEventRow,
  ContentOperationOutcomeAssessmentRow,
  ContentOperationPublicationAttemptRow,
  ContentOperationPublicationTargetRow,
  ContentOperationRunRow,
  PlanBundle,
  DeliveredPublication,
} from './types'
import type { OperationClaim } from './types'

export type CalendarInsert = Omit<ContentOperationCalendarRow, 'id' | 'createdAt' | 'updatedAt'>
export type EntryInsert = Omit<ContentOperationCalendarEntryRow, 'id' | 'createdAt' | 'updatedAt'>
export type RunInsert = Omit<ContentOperationRunRow, 'id' | 'createdAt' | 'updatedAt'>
export type EventInsert = Omit<ContentOperationEventRow, 'id' | 'occurredAt'>
export type OperationClaimInput = { ownerUserId: number; calendarId: number; operation: 'replan' | 'materialize'; idempotencyKey: string; requestFingerprint: string; eventFingerprint: string }
export type LeaseError = { code?: string; summary?: string; retryEligibleAt?: Date | null }
export type WorkspaceEntryLineage = { entry: ContentOperationCalendarEntryRow; calendar: ContentOperationCalendarRow; client: ContentOperationClientRow; target?: ContentOperationPublicationTargetRow | null; deliverable: Record<string, unknown> & { id: number; ownerUserId: number; planId: number; briefId: number | null; jobId: number | null; selectionId: number; contentType: string; title: string; audience: string; language: string; evidenceSnapshotHash: string; opportunityKey: string; provenance: unknown }; job: (Record<string, unknown> & { id: number; ownerUserId: number; productionPlanId: number | null; productionDeliverableId: number | null; strategyRecommendationId: number | null; evidenceSnapshotHash: string; briefId: number }) | null; draft: (Record<string, unknown> & { id: number; jobId: number; version: number; contentHash: string; evidenceRefs: unknown; safetyStatus: string }) | null; review: (Record<string, unknown> & { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string }) | null; riskGate: (Record<string, unknown> & { id: number; draftId: number; status: string; evidenceSnapshotHash: string }) | null }
export type OutcomeInsert = Omit<ContentOperationOutcomeAssessmentRow, 'id' | 'createdAt'>
export type PublicationTargetInsert = Omit<ContentOperationPublicationTargetRow, 'id' | 'createdAt' | 'updatedAt'>
export type PublicationAttemptInsert = Omit<ContentOperationPublicationAttemptRow, 'id' | 'createdAt'>

export type CanonicalContext = Awaited<ReturnType<typeof resolveProductionContext>>

export type ContentOperationsRepository = {
  transaction<T>(work: (repository: ContentOperationsRepository) => Promise<T>): Promise<T>
  findClientByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationClientRow | null>
  findClientByOrigin(ownerUserId: number, canonicalSiteOrigin: string): Promise<ContentOperationClientRow | null>
  findClient(ownerUserId: number, clientId: number): Promise<ContentOperationClientRow | null>
  insertClient(input: Omit<ContentOperationClientRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<ContentOperationClientRow>
  listClients(ownerUserId: number): Promise<ContentOperationClientRow[]>
  findPublicationTargetByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationPublicationTargetRow | null>
  findPublicationTarget(ownerUserId: number, targetRowId: number): Promise<ContentOperationPublicationTargetRow | null>
  findActivePublicationTarget(ownerUserId: number, clientId: number): Promise<ContentOperationPublicationTargetRow | null>
  insertPublicationTarget(input: PublicationTargetInsert): Promise<ContentOperationPublicationTargetRow>
  updatePublicationTarget(ownerUserId: number, targetRowId: number, patch: Partial<PublicationTargetInsert>): Promise<ContentOperationPublicationTargetRow>
  listPublicationTargets(ownerUserId: number): Promise<ContentOperationPublicationTargetRow[]>
  findCalendarByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationCalendarRow | null>
  findCalendar(ownerUserId: number, calendarId: number): Promise<ContentOperationCalendarRow | null>
  insertCalendar(input: CalendarInsert): Promise<ContentOperationCalendarRow>
  updateCalendar(ownerUserId: number, calendarId: number, patch: Partial<CalendarInsert>): Promise<ContentOperationCalendarRow>
  updateCalendarIfFingerprint(ownerUserId: number, calendarId: number, expectedPlanFingerprint: string, patch: Partial<CalendarInsert>): Promise<ContentOperationCalendarRow | null>
  claimOperation(input: OperationClaimInput): Promise<OperationClaim>
  listCalendars(ownerUserId: number): Promise<ContentOperationCalendarRow[]>
  findEntry(ownerUserId: number, entryId: number): Promise<ContentOperationCalendarEntryRow | null>
  listEntries(ownerUserId: number, calendarId?: number): Promise<ContentOperationCalendarEntryRow[]>
  insertEntry(input: EntryInsert): Promise<ContentOperationCalendarEntryRow>
  updateEntry(ownerUserId: number, entryId: number, patch: Partial<EntryInsert>): Promise<ContentOperationCalendarEntryRow>
  listRuns(ownerUserId: number, entryId?: number): Promise<ContentOperationRunRow[]>
  listEligibleRuns(now: Date, limit: number, ownerUserId?: number): Promise<ContentOperationRunRow[]>
  findRunByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationRunRow | null>
  insertRun(input: RunInsert): Promise<ContentOperationRunRow>
  acquireRunLease(ownerUserId: number, runId: number, leaseToken: string, now: Date, leaseMs: number): Promise<ContentOperationRunRow | null>
  releaseRunLease(ownerUserId: number, runId: number, state: RunInsert['state'], leaseToken: string, now: Date, error?: LeaseError): Promise<ContentOperationRunRow | null>
  updateRun(ownerUserId: number, runId: number, patch: Partial<RunInsert>): Promise<ContentOperationRunRow>
  appendEvent(input: EventInsert): Promise<ContentOperationEventRow>
  listEvents(ownerUserId: number, entryId?: number): Promise<ContentOperationEventRow[]>
  findLatestOptimizedDraft(ownerUserId: number, jobId: number): Promise<Record<string, unknown> & { id: number; jobId: number; version: number; title: string; body: string; contentHash: string; provenance: unknown; safetyStatus: string } | null>
  findRiskGate(ownerUserId: number, draftId: number, evidenceSnapshotHash: string): Promise<Record<string, unknown> & { id: number; draftId: number; status: string; evidenceSnapshotHash: string } | null>
  findLatestReview(ownerUserId: number, jobId: number, draftId: number, evidenceSnapshotHash: string): Promise<Record<string, unknown> & { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string } | null>
  findPublicationAttemptByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationPublicationAttemptRow | null>
  listPublicationAttempts(ownerUserId: number, entryId?: number): Promise<ContentOperationPublicationAttemptRow[]>
  insertPublicationAttempt(input: PublicationAttemptInsert): Promise<ContentOperationPublicationAttemptRow>
  findOutcomeByIdempotency(ownerUserId: number, idempotencyKey: string): Promise<ContentOperationOutcomeAssessmentRow | null>
  insertOutcome(input: OutcomeInsert): Promise<ContentOperationOutcomeAssessmentRow>
  listOutcomes(ownerUserId: number): Promise<ContentOperationOutcomeAssessmentRow[]>
  getPlanBundle(ownerUserId: number, productionPlanId: number): Promise<PlanBundle>
  resolveCanonicalContext(ownerUserId: number, productionPlanId: number, deliverableId: number): Promise<CanonicalContext>
  resolveDeliveredPublication(ownerUserId: number, entryId: number): Promise<DeliveredPublication | null>
  resolveWorkspaceEntry(ownerUserId: number, entryId: number): Promise<WorkspaceEntryLineage | null>
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

function isDuplicateError(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; message?: string }
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062 || /duplicate entry|unique constraint/i.test(candidate?.message || '')
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
    async findPublicationTargetByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId, ownerUserId), eq(contentOperationPublicationTargets.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async findPublicationTarget(ownerUserId, targetRowId) {
      const [row] = await database.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId, ownerUserId), eq(contentOperationPublicationTargets.id, targetRowId))).limit(1)
      return row || null
    },
    async findActivePublicationTarget(ownerUserId, clientId) {
      const [row] = await database.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId, ownerUserId), eq(contentOperationPublicationTargets.clientId, clientId), eq(contentOperationPublicationTargets.status, 'active'))).orderBy(desc(contentOperationPublicationTargets.updatedAt)).limit(1)
      return row || null
    },
    async insertPublicationTarget(input) {
      try {
        const id = rowId(await database.insert(contentOperationPublicationTargets).values(input as any))
        const row = await repository.findPublicationTarget(input.ownerUserId, id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Publication target could not be loaded.' })
        return row
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        const replay = await repository.findPublicationTargetByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay && replay.configurationFingerprint === input.configurationFingerprint) return replay
        if (replay) throw createError({ statusCode: 409, statusMessage: 'Publication target idempotency key is associated with a different configuration.' })
        throw error
      }
    },
    async updatePublicationTarget(ownerUserId, targetRowId, patch) {
      await database.update(contentOperationPublicationTargets).set(patch as any).where(and(eq(contentOperationPublicationTargets.ownerUserId, ownerUserId), eq(contentOperationPublicationTargets.id, targetRowId)))
      const row = await repository.findPublicationTarget(ownerUserId, targetRowId)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Publication target was not found.' })
      return row
    },
    async listPublicationTargets(ownerUserId) {
      return database.select().from(contentOperationPublicationTargets).where(eq(contentOperationPublicationTargets.ownerUserId, ownerUserId)).orderBy(desc(contentOperationPublicationTargets.createdAt)).limit(100)
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
    async updateCalendarIfFingerprint(ownerUserId, calendarId, expectedPlanFingerprint, patch) {
      const result = await database.update(contentOperationCalendars).set(patch as any).where(and(eq(contentOperationCalendars.id, calendarId), eq(contentOperationCalendars.ownerUserId, ownerUserId), eq(contentOperationCalendars.planFingerprint, expectedPlanFingerprint)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findCalendar(ownerUserId, calendarId)
    },
    async claimOperation(input) {
      const metadata = { operation: input.operation, calendarId: input.calendarId, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint, claim: true }
      try {
        await database.insert(contentOperationEvents).values({ ownerUserId: input.ownerUserId, clientId: null, calendarId: input.calendarId, entryId: null, runId: null, eventType: 'operation_claim', fromStatus: null, toStatus: null, eventFingerprint: input.eventFingerprint, metadata })
        return { claimed: true, requestFingerprint: input.requestFingerprint, operation: input.operation, ownerUserId: input.ownerUserId, calendarId: input.calendarId, idempotencyKey: input.idempotencyKey }
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        const [existing] = await database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, input.ownerUserId), eq(contentOperationEvents.eventFingerprint, input.eventFingerprint))).limit(1)
        if (!existing) throw error
        const existingMetadata = existing.metadata as { requestFingerprint?: unknown }
        if (typeof existingMetadata?.requestFingerprint !== 'string') throw createError({ statusCode: 500, statusMessage: 'Content operation claim metadata is malformed.' })
        return { claimed: false, requestFingerprint: existingMetadata.requestFingerprint, operation: input.operation, ownerUserId: input.ownerUserId, calendarId: input.calendarId, idempotencyKey: input.idempotencyKey }
      }
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
    async listEligibleRuns(now, limit, ownerUserId) {
      return database.select().from(contentOperationRuns).where(and(ownerUserId ? eq(contentOperationRuns.ownerUserId, ownerUserId) : undefined, or(
        eq(contentOperationRuns.state, 'queued'),
        and(eq(contentOperationRuns.state, 'retry_wait'), lte(contentOperationRuns.retryEligibleAt, now)),
        and(eq(contentOperationRuns.state, 'processing'), lt(contentOperationRuns.leaseExpiresAt, now)),
      ))).orderBy(sql`COALESCE(${contentOperationRuns.retryEligibleAt}, ${contentOperationRuns.createdAt})`, contentOperationRuns.createdAt, contentOperationRuns.id).limit(Math.max(1, Math.min(50, Math.trunc(limit))))
    },
    async findRunByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertRun(input) {
      try {
        const id = rowId(await database.insert(contentOperationRuns).values(input as any))
        const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, input.ownerUserId), eq(contentOperationRuns.id, id))).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation run could not be loaded.' })
        return row
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        const [existing] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, input.ownerUserId), eq(contentOperationRuns.idempotencyKey, input.idempotencyKey))).limit(1)
        if (!existing) throw error
        return existing
      }
    },
    async acquireRunLease(ownerUserId, runId, leaseToken, now, leaseMs) {
      const leaseExpiresAt = new Date(now.getTime() + leaseMs)
      const result = await database.update(contentOperationRuns).set({ state: 'processing', leaseOwner: leaseToken, leaseExpiresAt, startedAt: sql`COALESCE(${contentOperationRuns.startedAt}, ${now})`, updatedAt: now }).where(and(
        eq(contentOperationRuns.id, runId),
        eq(contentOperationRuns.ownerUserId, ownerUserId),
        or(
          eq(contentOperationRuns.state, 'queued'),
          and(eq(contentOperationRuns.state, 'retry_wait'), lte(contentOperationRuns.retryEligibleAt, now)),
          and(eq(contentOperationRuns.state, 'processing'), lt(contentOperationRuns.leaseExpiresAt, now)),
        ),
      ))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId), eq(contentOperationRuns.leaseOwner, leaseToken), eq(contentOperationRuns.state, 'processing'))).limit(1)
      return row || null
    },
    async releaseRunLease(ownerUserId, runId, state, leaseToken, now, error) {
      const result = await database.update(contentOperationRuns).set({ state, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: error?.retryEligibleAt || null, completedAt: state === 'succeeded' || state === 'failed' || state === 'blocked' || state === 'cancelled' ? now : null, errorCode: error?.code || null, errorSummary: error?.summary || null, updatedAt: now }).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId), eq(contentOperationRuns.state, 'processing'), eq(contentOperationRuns.leaseOwner, leaseToken)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId))).limit(1)
      return row || null
    },
    async updateRun(ownerUserId, runId, patch) {
      await database.update(contentOperationRuns).set({ ...patch as any, updatedAt: new Date() }).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId)))
      const [row] = await database.select().from(contentOperationRuns).where(and(eq(contentOperationRuns.ownerUserId, ownerUserId), eq(contentOperationRuns.id, runId))).limit(1)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Content operation run was not found.' })
      return row
    },
    async appendEvent(input) {
      try {
        const id = rowId(await database.insert(contentOperationEvents).values(input as any))
        const [row] = await database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, input.ownerUserId), eq(contentOperationEvents.id, id))).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Content operation event could not be loaded.' })
        return row
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        const [existing] = await database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, input.ownerUserId), eq(contentOperationEvents.eventFingerprint, input.eventFingerprint))).limit(1)
        if (!existing) throw error
        return existing
      }
    },
    async listEvents(ownerUserId, entryId) {
      return database.select().from(contentOperationEvents).where(and(eq(contentOperationEvents.ownerUserId, ownerUserId), entryId ? eq(contentOperationEvents.entryId, entryId) : undefined)).orderBy(desc(contentOperationEvents.occurredAt)).limit(500)
    },
    async findLatestOptimizedDraft(ownerUserId, jobId) {
      const [row] = await database.select({ id: seoGeoContentDrafts.id, jobId: seoGeoContentDrafts.jobId, version: seoGeoContentDrafts.version, title: seoGeoContentDrafts.title, body: seoGeoContentDrafts.body, contentHash: seoGeoContentDrafts.contentHash, provenance: seoGeoContentDrafts.provenance, safetyStatus: seoGeoContentDrafts.safetyStatus }).from(seoGeoContentDrafts).innerJoin(seoGeoContentJobs, eq(seoGeoContentDrafts.jobId, seoGeoContentJobs.id)).where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), eq(seoGeoContentDrafts.jobId, jobId))).orderBy(desc(seoGeoContentDrafts.version)).limit(10)
      const optimized = row && typeof row.provenance === 'object' && row.provenance !== null && !Array.isArray(row.provenance) && (row.provenance as { stage?: unknown }).stage === 'optimized' ? row : null
      return optimized ? optimized as Record<string, unknown> & { id: number; jobId: number; version: number; title: string; body: string; contentHash: string; provenance: unknown; safetyStatus: string } : null
    },
    async findRiskGate(ownerUserId, draftId, evidenceSnapshotHash) {
      const [row] = await database.select({ id: seoGeoContentRiskGates.id, draftId: seoGeoContentRiskGates.draftId, status: seoGeoContentRiskGates.status, evidenceSnapshotHash: seoGeoContentRiskGates.evidenceSnapshotHash }).from(seoGeoContentRiskGates).innerJoin(seoGeoContentDrafts, eq(seoGeoContentRiskGates.draftId, seoGeoContentDrafts.id)).innerJoin(seoGeoContentJobs, eq(seoGeoContentDrafts.jobId, seoGeoContentJobs.id)).where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), eq(seoGeoContentRiskGates.draftId, draftId), eq(seoGeoContentRiskGates.evidenceSnapshotHash, evidenceSnapshotHash))).orderBy(desc(seoGeoContentRiskGates.id)).limit(1)
      return row ? row as Record<string, unknown> & { id: number; draftId: number; status: string; evidenceSnapshotHash: string } : null
    },
    async findLatestReview(ownerUserId, jobId, draftId, evidenceSnapshotHash) {
      const [row] = await database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.reviewerUserId, ownerUserId), eq(seoGeoContentReviews.jobId, jobId), eq(seoGeoContentReviews.draftId, draftId), eq(seoGeoContentReviews.evidenceSnapshotHash, evidenceSnapshotHash))).orderBy(desc(seoGeoContentReviews.id)).limit(1)
      return row ? row as Record<string, unknown> & { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string } : null
    },
    async findPublicationAttemptByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, ownerUserId), eq(contentOperationPublicationAttempts.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async listPublicationAttempts(ownerUserId, entryId) {
      return database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, ownerUserId), entryId ? eq(contentOperationPublicationAttempts.entryId, entryId) : undefined)).orderBy(desc(contentOperationPublicationAttempts.createdAt)).limit(500)
    },
    async insertPublicationAttempt(input) {
      try {
        const id = rowId(await database.insert(contentOperationPublicationAttempts).values(input as any))
        const [row] = await database.select().from(contentOperationPublicationAttempts).where(and(eq(contentOperationPublicationAttempts.ownerUserId, input.ownerUserId), eq(contentOperationPublicationAttempts.id, id))).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Publication attempt could not be loaded.' })
        return row
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        const replay = await repository.findPublicationAttemptByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay) return replay
        throw error
      }
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
    async resolveWorkspaceEntry(ownerUserId, entryId) {
      const [entry] = await database.select().from(contentOperationCalendarEntries).where(and(eq(contentOperationCalendarEntries.ownerUserId, ownerUserId), eq(contentOperationCalendarEntries.id, entryId))).limit(1)
      if (!entry) return null
      const [calendar] = await database.select().from(contentOperationCalendars).where(and(eq(contentOperationCalendars.ownerUserId, ownerUserId), eq(contentOperationCalendars.id, entry.calendarId))).limit(1)
      const [client] = await database.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId, ownerUserId), eq(contentOperationClients.id, calendar?.clientId || -1))).limit(1)
      const [target] = entry.publicationTargetId ? await database.select().from(contentOperationPublicationTargets).where(and(eq(contentOperationPublicationTargets.ownerUserId, ownerUserId), eq(contentOperationPublicationTargets.id, entry.publicationTargetId), eq(contentOperationPublicationTargets.clientId, calendar?.clientId || -1))).limit(1) : [null]
      const [deliverable] = await database.select().from(seoGeoProductionDeliverables).where(and(eq(seoGeoProductionDeliverables.ownerUserId, ownerUserId), eq(seoGeoProductionDeliverables.id, entry.productionDeliverableId), eq(seoGeoProductionDeliverables.planId, calendar?.productionPlanId || -1))).limit(1)
      if (!calendar || !client || !deliverable) return null
      const [job] = entry.jobId ? await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), eq(seoGeoContentJobs.id, entry.jobId), eq(seoGeoContentJobs.productionPlanId, calendar.productionPlanId), eq(seoGeoContentJobs.productionDeliverableId, entry.productionDeliverableId), eq(seoGeoContentJobs.strategyRecommendationId, entry.strategyRecommendationId), eq(seoGeoContentJobs.evidenceSnapshotHash, entry.evidenceSnapshotHash))).limit(1) : [null]
      const [draft] = job && entry.draftId ? await database.select().from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, entry.draftId), eq(seoGeoContentDrafts.jobId, job.id))).limit(1) : [null]
      const [review] = job && draft && entry.reviewId ? await database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.id, entry.reviewId), eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, draft.id), eq(seoGeoContentReviews.reviewerUserId, ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, entry.evidenceSnapshotHash))).limit(1) : [null]
      const [riskGate] = draft ? await database.select().from(seoGeoContentRiskGates).where(and(eq(seoGeoContentRiskGates.draftId, draft.id), eq(seoGeoContentRiskGates.status, 'passed'), eq(seoGeoContentRiskGates.evidenceSnapshotHash, entry.evidenceSnapshotHash))).orderBy(desc(seoGeoContentRiskGates.createdAt)).limit(1) : [null]
      return { entry, calendar, client, target: target || null, deliverable, job: job || null, draft: draft || null, review: review || null, riskGate: riskGate || null }
    },
    async resolveDeliveredPublication(ownerUserId, entryId) {
      const lineage = await repository.resolveWorkspaceEntry(ownerUserId, entryId)
      if (!lineage || !lineage.job || !lineage.draft || !lineage.review || lineage.review.decision !== 'approved_for_delivery' || lineage.entry.status !== 'delivered' && lineage.entry.status !== 'completed' || !lineage.entry.contentHash || lineage.draft.contentHash !== lineage.entry.contentHash || lineage.review.evidenceSnapshotHash !== lineage.entry.evidenceSnapshotHash) return null
      const publicationRuns = await repository.listRuns(ownerUserId, entryId)
      const publicationRun = publicationRuns.find(run => run.stage === 'publication' && run.state === 'succeeded' && run.ownerUserId === ownerUserId && run.entryId === entryId) || null
      if (!publicationRun) return null
      return { entry: lineage.entry, calendar: lineage.calendar, deliverable: lineage.deliverable, job: lineage.job, draft: lineage.draft, review: lineage.review, riskGate: lineage.riskGate || undefined, publicationRun, publicationIdentity: lineage.entry.publicationSlug && lineage.entry.publicationPath && lineage.entry.publicationIdentityFingerprint ? { publicationId: `publication-${lineage.entry.id}`, slug: lineage.entry.publicationSlug, path: lineage.entry.publicationPath, identityFingerprint: lineage.entry.publicationIdentityFingerprint } : null }
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
