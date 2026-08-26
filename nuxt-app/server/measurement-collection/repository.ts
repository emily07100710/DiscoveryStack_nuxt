import { createError } from 'h3'
import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import { contentOperationClients, contentOperationMeasurementConnections, contentOperationMeasurementRuns, contentOperationMeasurementSnapshots, llmVisibilityProjects, llmVisibilityQueries } from '../database/schema'
import type { MeasurementRepository } from './types'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Measurement collection is temporarily unavailable.' })
  return database
}

function duplicate(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; message?: string }
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062 || /duplicate entry|unique constraint/i.test(candidate.message || '')
}

function rowId(result: any): number {
  const id = Number(result?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Measurement record could not be created.' })
  return id
}

function makeRepository(database: any): MeasurementRepository {
  const repository: MeasurementRepository = {
    async transaction<T>(work: (repository: MeasurementRepository) => Promise<T>) {
      return database.transaction(async (transaction: any) => work(makeRepository(transaction)))
    },
    async findClient(ownerUserId, clientId) {
      const [row] = await database.select({ id: contentOperationClients.id, ownerUserId: contentOperationClients.ownerUserId, canonicalSiteOrigin: contentOperationClients.canonicalSiteOrigin, timeZone: contentOperationClients.timeZone }).from(contentOperationClients).where(and(eq(contentOperationClients.id, clientId), eq(contentOperationClients.ownerUserId, ownerUserId))).limit(1)
      return row || null
    },
    async findConnection(ownerUserId, connectionId) {
      const [row] = await database.select().from(contentOperationMeasurementConnections).where(and(eq(contentOperationMeasurementConnections.ownerUserId, ownerUserId), eq(contentOperationMeasurementConnections.id, connectionId))).limit(1)
      return row || null
    },
    async findConnectionByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationMeasurementConnections).where(and(eq(contentOperationMeasurementConnections.ownerUserId, ownerUserId), eq(contentOperationMeasurementConnections.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async listConnections(ownerUserId) {
      return database.select().from(contentOperationMeasurementConnections).where(eq(contentOperationMeasurementConnections.ownerUserId, ownerUserId)).orderBy(desc(contentOperationMeasurementConnections.updatedAt)).limit(100)
    },
    async insertConnection(input) {
      try {
        const id = rowId(await database.insert(contentOperationMeasurementConnections).values(input as any))
        const row = await repository.findConnection(input.ownerUserId, id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Measurement connection could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const row = await repository.findConnection(input.ownerUserId, Number((error as any)?.connectionId || 0))
        if (row) return row
        throw createError({ statusCode: 409, statusMessage: 'Measurement connection already exists for this owner and source.' })
      }
    },
    async updateConnection(ownerUserId, connectionId, patch) {
      await database.update(contentOperationMeasurementConnections).set({ ...patch as any, updatedAt: new Date() }).where(and(eq(contentOperationMeasurementConnections.ownerUserId, ownerUserId), eq(contentOperationMeasurementConnections.id, connectionId)))
      const row = await repository.findConnection(ownerUserId, connectionId)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Measurement connection was not found.' })
      return row
    },
    async findRun(ownerUserId, runId) {
      const [row] = await database.select().from(contentOperationMeasurementRuns).where(and(eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId), eq(contentOperationMeasurementRuns.id, runId))).limit(1)
      return row || null
    },
    async findRunByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(contentOperationMeasurementRuns).where(and(eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId), eq(contentOperationMeasurementRuns.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async listRuns(ownerUserId, filters = {}) {
      return database.select().from(contentOperationMeasurementRuns).where(and(eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId), filters.entryId ? eq(contentOperationMeasurementRuns.entryId, filters.entryId) : undefined, filters.clientId ? eq(contentOperationMeasurementRuns.clientId, filters.clientId) : undefined)).orderBy(desc(contentOperationMeasurementRuns.createdAt)).limit(500)
    },
    async listEligibleRuns(now, limit, ownerUserId) {
      return database.select().from(contentOperationMeasurementRuns).where(and(ownerUserId ? eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId) : undefined, or(and(eq(contentOperationMeasurementRuns.state, 'queued'), lte(contentOperationMeasurementRuns.dueAt, now)), and(eq(contentOperationMeasurementRuns.state, 'retry_wait'), lte(contentOperationMeasurementRuns.retryEligibleAt, now)), and(eq(contentOperationMeasurementRuns.state, 'processing'), lt(contentOperationMeasurementRuns.leaseExpiresAt, now)) ))).orderBy(contentOperationMeasurementRuns.dueAt, contentOperationMeasurementRuns.createdAt, contentOperationMeasurementRuns.id).limit(Math.max(1, Math.min(50, Math.trunc(limit))))
    },
    async insertRun(input) {
      try {
        const id = rowId(await database.insert(contentOperationMeasurementRuns).values(input as any))
        const row = await repository.findRun(input.ownerUserId, id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Measurement run could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findRunByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay) return replay
        throw createError({ statusCode: 409, statusMessage: 'Measurement run idempotency conflict.' })
      }
    },
    async acquireRunLease(ownerUserId, runId, leaseOwner, now, leaseMs) {
      const leaseExpiresAt = new Date(now.getTime() + Math.max(1, Math.min(15 * 60 * 1000, Math.trunc(leaseMs))))
      const result = await database.update(contentOperationMeasurementRuns).set({ state: 'processing', leaseOwner, leaseExpiresAt, startedAt: sql`COALESCE(${contentOperationMeasurementRuns.startedAt}, ${now})`, attemptNumber: sql`${contentOperationMeasurementRuns.attemptNumber} + 1`, updatedAt: now }).where(and(eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId), eq(contentOperationMeasurementRuns.id, runId), or(and(eq(contentOperationMeasurementRuns.state, 'queued'), lte(contentOperationMeasurementRuns.dueAt, now)), and(eq(contentOperationMeasurementRuns.state, 'retry_wait'), lte(contentOperationMeasurementRuns.retryEligibleAt, now)), and(eq(contentOperationMeasurementRuns.state, 'processing'), lt(contentOperationMeasurementRuns.leaseExpiresAt, now)))))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findRun(ownerUserId, runId)
    },
    async releaseRunLease(ownerUserId, runId, leaseOwner, state, now, patch = {}) {
      const terminal = state === 'succeeded' || state === 'failed' || state === 'blocked' || state === 'insufficient_data' || state === 'cancelled'
      const result = await database.update(contentOperationMeasurementRuns).set({ state, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: patch.retryEligibleAt ?? null, outputFingerprint: patch.outputFingerprint ?? null, errorCode: patch.errorCode ?? null, errorSummary: patch.errorSummary ?? null, completedAt: terminal ? now : null, updatedAt: now }).where(and(eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId), eq(contentOperationMeasurementRuns.id, runId), eq(contentOperationMeasurementRuns.state, 'processing'), eq(contentOperationMeasurementRuns.leaseOwner, leaseOwner)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findRun(ownerUserId, runId)
    },
    async updateRun(ownerUserId, runId, patch) {
      await database.update(contentOperationMeasurementRuns).set({ ...patch as any, updatedAt: new Date() }).where(and(eq(contentOperationMeasurementRuns.ownerUserId, ownerUserId), eq(contentOperationMeasurementRuns.id, runId)))
      const row = await repository.findRun(ownerUserId, runId)
      if (!row) throw createError({ statusCode: 404, statusMessage: 'Measurement run was not found.' })
      return row
    },
    async listSnapshots(ownerUserId, runId) {
      return database.select().from(contentOperationMeasurementSnapshots).where(and(eq(contentOperationMeasurementSnapshots.ownerUserId, ownerUserId), runId ? eq(contentOperationMeasurementSnapshots.runId, runId) : undefined)).orderBy(desc(contentOperationMeasurementSnapshots.createdAt)).limit(500)
    },
    async findSnapshot(ownerUserId, runId, phase) {
      const [row] = await database.select().from(contentOperationMeasurementSnapshots).where(and(eq(contentOperationMeasurementSnapshots.ownerUserId, ownerUserId), eq(contentOperationMeasurementSnapshots.runId, runId), eq(contentOperationMeasurementSnapshots.phase, phase))).limit(1)
      return row || null
    },
    async insertSnapshot(input) {
      try {
        const id = rowId(await database.insert(contentOperationMeasurementSnapshots).values(input as any))
        const [row] = await database.select().from(contentOperationMeasurementSnapshots).where(and(eq(contentOperationMeasurementSnapshots.ownerUserId, input.ownerUserId), eq(contentOperationMeasurementSnapshots.id, id))).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Measurement snapshot could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findSnapshot(input.ownerUserId, input.runId, input.phase)
        if (replay && replay.sourceHash === input.sourceHash) return replay
        throw createError({ statusCode: 409, statusMessage: 'Measurement snapshot append-only identity conflict.' })
      }
    },
    async listLlmScope(ownerUserId, projectId) {
      const [project] = await database.select().from(llmVisibilityProjects).where(and(eq(llmVisibilityProjects.ownerUserId, ownerUserId), eq(llmVisibilityProjects.id, projectId))).limit(1)
      const queries = await database.select().from(llmVisibilityQueries).where(and(eq(llmVisibilityQueries.ownerUserId, ownerUserId), eq(llmVisibilityQueries.projectId, projectId), eq(llmVisibilityQueries.active, true))).orderBy(llmVisibilityQueries.id).limit(50)
      return { project: project || null, queries }
    },
  }
  return repository
}

export function createMeasurementCollectionRepository(): MeasurementRepository {
  return makeRepository(requireDatabase())
}

export function createMeasurementCollectionRepositoryFromDatabase(database: unknown): MeasurementRepository {
  return makeRepository(database as any)
}
