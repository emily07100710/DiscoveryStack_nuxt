import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { createError } from 'h3'
import { requireAuditDatabase } from '../audit/repository'
import { experimentResults, interventionEvents, interventionExperiments, interventionMeasurements, interventions, refreshPolicies, refreshQueue } from '../database/schema'
import type { EventCreate, ExperimentCreate, ExperimentResult, Intervention, InterventionCreate, InterventionEvent, InterventionExperiment, InterventionLoopRepository, InterventionMeasurement, InterventionPatch, MeasurementCreate, QueueCreate, RefreshPolicyInput, RefreshQueueItem, ResultCreate } from './types'

function databaseUnavailable(message = '介入實驗資料庫目前無法使用。'): never {
  throw createError({ statusCode: 503, statusMessage: message, data: { code: 'DATABASE_UNAVAILABLE' } })
}
function ownerNotFound(message = '找不到擁有者範圍內的介入資源。'): never {
  throw createError({ statusCode: 404, statusMessage: message, data: { code: 'NOT_FOUND' } })
}

function requireDatabase() {
  try { return requireAuditDatabase() } catch { databaseUnavailable() }
}

function interventionRow(row: typeof interventions.$inferSelect): Intervention {
  return { ...row, expectedImpact: row.expectedImpact && typeof row.expectedImpact === 'object' && !Array.isArray(row.expectedImpact) ? row.expectedImpact as Intervention['expectedImpact'] : null }
}
function eventRow(row: typeof interventionEvents.$inferSelect): InterventionEvent {
  return { ...row, evidence: row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence as Record<string, unknown> : {} }
}
function measurementRow(row: typeof interventionMeasurements.$inferSelect): InterventionMeasurement {
  return { ...row, metrics: row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics) ? row.metrics as InterventionMeasurement['metrics'] : {} }
}
function resultRow(row: typeof experimentResults.$inferSelect): ExperimentResult {
  return { ...row, effect: row.effect && typeof row.effect === 'object' && !Array.isArray(row.effect) ? row.effect as Record<string, unknown> : {}, limitations: Array.isArray(row.limitations) ? row.limitations.filter((item): item is string => typeof item === 'string') : [] }
}
function queueRow(row: typeof refreshQueue.$inferSelect): RefreshQueueItem {
  return { ...row, reasonEvidence: row.reasonEvidence && typeof row.reasonEvidence === 'object' && !Array.isArray(row.reasonEvidence) ? row.reasonEvidence as Record<string, unknown> : {} }
}

function duplicate(error: unknown) {
  const candidate = error as { code?: unknown, errno?: unknown }
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062
}

export function createInterventionLoopRepository(): InterventionLoopRepository {
  return {
    async findInterventionByIdempotencyKey(ownerUserId, key) {
      const [row] = await requireDatabase().select().from(interventions).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.idempotencyKey, key))).limit(1)
      return row ? interventionRow(row) : null
    },
    async createIntervention(input) {
      const database = requireDatabase()
      try {
        const inserted = await database.insert(interventions).values(input)
        const [row] = await database.select().from(interventions).where(and(eq(interventions.id, Number(inserted[0].insertId)), eq(interventions.ownerUserId, input.ownerUserId))).limit(1)
        if (!row) databaseUnavailable('無法建立介入紀錄。')
        return interventionRow(row)
      } catch (error) {
        if (!duplicate(error)) throw error
        const [row] = await database.select().from(interventions).where(and(eq(interventions.ownerUserId, input.ownerUserId), eq(interventions.idempotencyKey, input.idempotencyKey))).limit(1)
        if (!row) throw error
        return interventionRow(row)
      }
    },
    async getIntervention(ownerUserId, id) {
      const [row] = await requireDatabase().select().from(interventions).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.id, id))).limit(1)
      return row ? interventionRow(row) : null
    },
    async listInterventions(ownerUserId, options = {}) {
      const statuses = Array.isArray(options.status) ? options.status : options.status ? [options.status] : []
      const predicate = statuses.length ? and(eq(interventions.ownerUserId, ownerUserId), inArray(interventions.status, statuses)) : eq(interventions.ownerUserId, ownerUserId)
      const rows = await requireDatabase().select().from(interventions).where(predicate).orderBy(desc(interventions.registeredAt), desc(interventions.id)).limit(options.limit || 200)
      return rows.map(interventionRow)
    },
    async listInterventionsPage(ownerUserId, options) {
      const statuses = Array.isArray(options.status) ? options.status : options.status ? [options.status] : []
      const predicate = statuses.length
        ? and(eq(interventions.ownerUserId, ownerUserId), gt(interventions.id, options.afterId), inArray(interventions.status, statuses))
        : and(eq(interventions.ownerUserId, ownerUserId), gt(interventions.id, options.afterId))
      return (await requireDatabase().select().from(interventions).where(predicate).orderBy(asc(interventions.id)).limit(options.limit)).map(interventionRow)
    },
    async listInterventionsByUrlHash(ownerUserId, hash) {
      return (await requireDatabase().select().from(interventions).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.urlHash, hash))).orderBy(desc(interventions.registeredAt), desc(interventions.id))).map(interventionRow)
    },
    async listInterventionsByEntry(ownerUserId, entryId, targetId) {
      const base = and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.entryId, entryId))
      const rows = targetId === undefined ? await requireDatabase().select().from(interventions).where(base) : await requireDatabase().select().from(interventions).where(and(base, targetId === null ? isNull(interventions.targetId) : eq(interventions.targetId, targetId)))
      return rows.map(interventionRow).filter(row => targetId === undefined || row.targetId === targetId)
    },
    async updateIntervention(ownerUserId, id, patch) {
      const database = requireDatabase()
      await database.update(interventions).set(patch).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.id, id)))
      const [row] = await database.select().from(interventions).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.id, id))).limit(1)
      return row ? interventionRow(row) : null
    },
    async transition(ownerUserId, id, patch, event) {
      const database = requireDatabase()
      return database.transaction(async tx => {
        const [owned] = await tx.select({ id: interventions.id }).from(interventions).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.id, id))).limit(1)
        if (!owned) return null
        await tx.update(interventions).set(patch).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.id, id)))
        await tx.insert(interventionEvents).values(event)
        const [row] = await tx.select().from(interventions).where(and(eq(interventions.ownerUserId, ownerUserId), eq(interventions.id, id))).limit(1)
        return row ? interventionRow(row) : null
      })
    },
    async appendEvent(input) {
      const database = requireDatabase()
      const [owned] = await database.select({ id: interventions.id }).from(interventions).where(and(eq(interventions.ownerUserId, input.ownerUserId), eq(interventions.id, input.interventionId))).limit(1)
      if (!owned) ownerNotFound()
      const inserted = await database.insert(interventionEvents).values(input)
      const [row] = await database.select().from(interventionEvents).where(and(eq(interventionEvents.id, Number(inserted[0].insertId)), eq(interventionEvents.ownerUserId, input.ownerUserId))).limit(1)
      if (!row) databaseUnavailable('無法寫入介入事件。')
      return eventRow(row)
    },
    async listEvents(ownerUserId, interventionId) {
      return (await requireDatabase().select().from(interventionEvents).where(and(eq(interventionEvents.ownerUserId, ownerUserId), eq(interventionEvents.interventionId, interventionId))).orderBy(interventionEvents.occurredAt, interventionEvents.id)).map(eventRow)
    },
    async upsertMeasurement(input) {
      const database = requireDatabase()
      const [owned] = await database.select({ id: interventions.id }).from(interventions).where(and(eq(interventions.ownerUserId, input.ownerUserId), eq(interventions.id, input.interventionId))).limit(1)
      if (!owned) ownerNotFound()
      const predicate = and(eq(interventionMeasurements.ownerUserId, input.ownerUserId), eq(interventionMeasurements.interventionId, input.interventionId), eq(interventionMeasurements.origin, input.origin), eq(interventionMeasurements.source, input.source), eq(interventionMeasurements.windowStart, input.windowStart), eq(interventionMeasurements.windowEnd, input.windowEnd))
      const [existing] = await database.select().from(interventionMeasurements).where(predicate).limit(1)
      if (existing) {
        await database.update(interventionMeasurements).set(input).where(and(predicate, eq(interventionMeasurements.id, existing.id)))
        const [updated] = await database.select().from(interventionMeasurements).where(and(eq(interventionMeasurements.id, existing.id), eq(interventionMeasurements.ownerUserId, input.ownerUserId))).limit(1)
        if (!updated) databaseUnavailable('無法更新量測資料。')
        return { row: measurementRow(updated), replaced: true }
      }
      try {
        const inserted = await database.insert(interventionMeasurements).values(input)
        const [row] = await database.select().from(interventionMeasurements).where(and(eq(interventionMeasurements.id, Number(inserted[0].insertId)), eq(interventionMeasurements.ownerUserId, input.ownerUserId))).limit(1)
        if (!row) databaseUnavailable('無法建立量測資料。')
        return { row: measurementRow(row), replaced: false }
      } catch (error) {
        if (!duplicate(error)) throw error
        const [row] = await database.select().from(interventionMeasurements).where(predicate).limit(1)
        if (!row) throw error
        await database.update(interventionMeasurements).set(input).where(and(predicate, eq(interventionMeasurements.id, row.id)))
        const [updated] = await database.select().from(interventionMeasurements).where(and(eq(interventionMeasurements.id, row.id), eq(interventionMeasurements.ownerUserId, input.ownerUserId))).limit(1)
        if (!updated) databaseUnavailable('無法更新量測資料。')
        return { row: measurementRow(updated), replaced: true }
      }
    },
    async listMeasurements(ownerUserId, interventionId) {
      return (await requireDatabase().select().from(interventionMeasurements).where(and(eq(interventionMeasurements.ownerUserId, ownerUserId), eq(interventionMeasurements.interventionId, interventionId))).orderBy(interventionMeasurements.windowStart, interventionMeasurements.id)).map(measurementRow)
    },
    async findExperimentByIdempotencyKey(ownerUserId, key) {
      const [row] = await requireDatabase().select().from(interventionExperiments).where(and(eq(interventionExperiments.ownerUserId, ownerUserId), eq(interventionExperiments.idempotencyKey, key))).limit(1)
      return row || null
    },
    async createExperiment(input) {
      const database = requireDatabase()
      try {
        const inserted = await database.insert(interventionExperiments).values(input)
        const [row] = await database.select().from(interventionExperiments).where(and(eq(interventionExperiments.id, Number(inserted[0].insertId)), eq(interventionExperiments.ownerUserId, input.ownerUserId))).limit(1)
        if (!row) databaseUnavailable('無法建立實驗。')
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const [row] = await database.select().from(interventionExperiments).where(and(eq(interventionExperiments.ownerUserId, input.ownerUserId), eq(interventionExperiments.idempotencyKey, input.idempotencyKey))).limit(1)
        if (!row) throw error
        return row
      }
    },
    async getExperiment(ownerUserId, id) {
      const [row] = await requireDatabase().select().from(interventionExperiments).where(and(eq(interventionExperiments.ownerUserId, ownerUserId), eq(interventionExperiments.id, id))).limit(1)
      return row || null
    },
    async updateExperiment(ownerUserId, id, patch) {
      const database = requireDatabase(); await database.update(interventionExperiments).set(patch).where(and(eq(interventionExperiments.ownerUserId, ownerUserId), eq(interventionExperiments.id, id)))
      const [row] = await database.select().from(interventionExperiments).where(and(eq(interventionExperiments.ownerUserId, ownerUserId), eq(interventionExperiments.id, id))).limit(1); return row || null
    },
    async listExperiments(ownerUserId) { return requireDatabase().select().from(interventionExperiments).where(eq(interventionExperiments.ownerUserId, ownerUserId)).orderBy(desc(interventionExperiments.createdAt), desc(interventionExperiments.id)) },
    async createResult(input) {
      const database = requireDatabase()
      const [ownedExperiment] = await database.select({ id: interventionExperiments.id }).from(interventionExperiments).where(and(eq(interventionExperiments.ownerUserId, input.ownerUserId), eq(interventionExperiments.id, input.experimentId))).limit(1)
      if (!ownedExperiment) ownerNotFound()
      if (input.interventionId !== null) {
        const [ownedIntervention] = await database.select({ id: interventions.id }).from(interventions).where(and(eq(interventions.ownerUserId, input.ownerUserId), eq(interventions.id, input.interventionId))).limit(1)
        if (!ownedIntervention) ownerNotFound()
      }
      try {
        const inserted = await database.insert(experimentResults).values(input)
        const [row] = await database.select().from(experimentResults).where(and(eq(experimentResults.id, Number(inserted[0].insertId)), eq(experimentResults.ownerUserId, input.ownerUserId))).limit(1)
        if (!row) databaseUnavailable('無法建立實驗結果。')
        return resultRow(row)
      } catch (error) {
        if (!duplicate(error)) throw error
        const [row] = await database.select().from(experimentResults).where(and(eq(experimentResults.ownerUserId, input.ownerUserId), eq(experimentResults.resultFingerprint, input.resultFingerprint))).limit(1)
        if (!row) throw error
        return resultRow(row)
      }
    },
    async findResultByFingerprint(ownerUserId, value) { const [row] = await requireDatabase().select().from(experimentResults).where(and(eq(experimentResults.ownerUserId, ownerUserId), eq(experimentResults.resultFingerprint, value))).limit(1); return row ? resultRow(row) : null },
    async findLatestResultForIntervention(ownerUserId, interventionId) { const [row] = await requireDatabase().select().from(experimentResults).where(and(eq(experimentResults.ownerUserId, ownerUserId), eq(experimentResults.interventionId, interventionId))).orderBy(desc(experimentResults.computedAt), desc(experimentResults.id)).limit(1); return row ? resultRow(row) : null },
    async listResultsForIntervention(ownerUserId, interventionId) { return (await requireDatabase().select().from(experimentResults).where(and(eq(experimentResults.ownerUserId, ownerUserId), eq(experimentResults.interventionId, interventionId))).orderBy(desc(experimentResults.computedAt), desc(experimentResults.id))).map(resultRow) },
    async listResultsForExperiment(ownerUserId, experimentId) { return (await requireDatabase().select().from(experimentResults).where(and(eq(experimentResults.ownerUserId, ownerUserId), eq(experimentResults.experimentId, experimentId))).orderBy(desc(experimentResults.computedAt), desc(experimentResults.id))).map(resultRow) },
    async getPolicy(ownerUserId) { const [row] = await requireDatabase().select().from(refreshPolicies).where(eq(refreshPolicies.ownerUserId, ownerUserId)).limit(1); return row || null },
    async upsertPolicy(ownerUserId, input, now) {
      const database = requireDatabase(); const [existing] = await database.select().from(refreshPolicies).where(eq(refreshPolicies.ownerUserId, ownerUserId)).limit(1)
      if (existing) { await database.update(refreshPolicies).set({ ...input, updatedAt: now }).where(and(eq(refreshPolicies.id, existing.id), eq(refreshPolicies.ownerUserId, ownerUserId))) } else { await database.insert(refreshPolicies).values({ ownerUserId, regressionDropPercent: input.regressionDropPercent ?? 20, minimumSampleSize: input.minimumSampleSize ?? 30, staleAfterDays: input.staleAfterDays ?? 90, createdAt: now, updatedAt: now }) }
      const [row] = await database.select().from(refreshPolicies).where(eq(refreshPolicies.ownerUserId, ownerUserId)).limit(1); if (!row) databaseUnavailable('無法儲存更新政策。'); return row
    },
    async createQueueItem(input) { const database = requireDatabase(); if (input.interventionId !== null) { const [owned] = await database.select({ id: interventions.id }).from(interventions).where(and(eq(interventions.ownerUserId, input.ownerUserId), eq(interventions.id, input.interventionId))).limit(1); if (!owned) ownerNotFound() } const inserted = await database.insert(refreshQueue).values(input); const [row] = await database.select().from(refreshQueue).where(and(eq(refreshQueue.id, Number(inserted[0].insertId)), eq(refreshQueue.ownerUserId, input.ownerUserId))).limit(1); if (!row) databaseUnavailable('無法建立更新佇列項目。'); return queueRow(row) },
    async getQueueItem(ownerUserId, id) { const [row] = await requireDatabase().select().from(refreshQueue).where(and(eq(refreshQueue.ownerUserId, ownerUserId), eq(refreshQueue.id, id))).limit(1); return row ? queueRow(row) : null },
    async updateQueueItem(ownerUserId, id, patch) { const database = requireDatabase(); await database.update(refreshQueue).set(patch).where(and(eq(refreshQueue.ownerUserId, ownerUserId), eq(refreshQueue.id, id))); const [row] = await database.select().from(refreshQueue).where(and(eq(refreshQueue.ownerUserId, ownerUserId), eq(refreshQueue.id, id))).limit(1); return row ? queueRow(row) : null },
    async listQueue(ownerUserId, status) { const where = status ? and(eq(refreshQueue.ownerUserId, ownerUserId), eq(refreshQueue.status, status)) : eq(refreshQueue.ownerUserId, ownerUserId); return (await requireDatabase().select().from(refreshQueue).where(where).orderBy(desc(refreshQueue.createdAt), desc(refreshQueue.id))).map(queueRow) },
    async findActiveQueueItemByDedupeKey(ownerUserId, key) { const [row] = await requireDatabase().select().from(refreshQueue).where(and(eq(refreshQueue.ownerUserId, ownerUserId), eq(refreshQueue.dedupeKey, key), inArray(refreshQueue.status, ['open', 'in_progress']))).limit(1); return row ? queueRow(row) : null },
  }
}

export function createInMemoryInterventionLoopRepository(): InterventionLoopRepository {
  const state = {
    interventions: [] as Intervention[], events: [] as InterventionEvent[], measurements: [] as InterventionMeasurement[], experiments: [] as InterventionExperiment[], results: [] as ExperimentResult[], policies: [] as Array<Awaited<ReturnType<InterventionLoopRepository['getPolicy']>> extends infer P ? Exclude<P, null> : never>, queue: [] as RefreshQueueItem[],
  }
  const next = (rows: Array<{ id: number }>) => rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  const repository: InterventionLoopRepository = {
    async findInterventionByIdempotencyKey(owner, key) { return state.interventions.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null },
    async createIntervention(input) { const existing = await repository.findInterventionByIdempotencyKey(input.ownerUserId, input.idempotencyKey); if (existing) return existing; const row = { ...input, id: next(state.interventions) } as Intervention; state.interventions.push(row); return row },
    async getIntervention(owner, id) { return state.interventions.find(row => row.ownerUserId === owner && row.id === id) || null },
    async listInterventions(owner, options = {}) { const statuses = Array.isArray(options.status) ? options.status : options.status ? [options.status] : null; return state.interventions.filter(row => row.ownerUserId === owner && (!statuses || statuses.includes(row.status))).sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime() || b.id - a.id).slice(0, options.limit || 200) },
    async listInterventionsPage(owner, options) { const statuses = Array.isArray(options.status) ? options.status : options.status ? [options.status] : null; return state.interventions.filter(row => row.ownerUserId === owner && row.id > options.afterId && (!statuses || statuses.includes(row.status))).sort((a, b) => a.id - b.id).slice(0, options.limit) },
    async listInterventionsByUrlHash(owner, hash) { return state.interventions.filter(row => row.ownerUserId === owner && row.urlHash === hash).sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime()) },
    async listInterventionsByEntry(owner, entryId, targetId) { return state.interventions.filter(row => row.ownerUserId === owner && row.entryId === entryId && (targetId === undefined || row.targetId === targetId)) },
    async updateIntervention(owner, id, patch) { const row = await repository.getIntervention(owner, id); if (!row) return null; Object.assign(row, patch); return row },
    async transition(owner, id, patch, event) { const row = await repository.updateIntervention(owner, id, patch); if (!row) return null; await repository.appendEvent(event); return row },
    async appendEvent(input) { if (!await repository.getIntervention(input.ownerUserId, input.interventionId)) ownerNotFound(); const row = { ...input, id: next(state.events) } as InterventionEvent; state.events.push(row); return row },
    async listEvents(owner, interventionId) { return state.events.filter(row => row.ownerUserId === owner && row.interventionId === interventionId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id) },
    async upsertMeasurement(input) { if (!await repository.getIntervention(input.ownerUserId, input.interventionId)) ownerNotFound(); const existing = state.measurements.find(row => row.ownerUserId === input.ownerUserId && row.interventionId === input.interventionId && row.origin === input.origin && row.source === input.source && row.windowStart.getTime() === input.windowStart.getTime() && row.windowEnd.getTime() === input.windowEnd.getTime()); if (existing) { Object.assign(existing, input); return { row: existing, replaced: true } } const row = { ...input, id: next(state.measurements) } as InterventionMeasurement; state.measurements.push(row); return { row, replaced: false } },
    async listMeasurements(owner, interventionId) { return state.measurements.filter(row => row.ownerUserId === owner && row.interventionId === interventionId).sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime() || a.id - b.id) },
    async findExperimentByIdempotencyKey(owner, key) { return state.experiments.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null },
    async createExperiment(input) { const existing = await repository.findExperimentByIdempotencyKey(input.ownerUserId, input.idempotencyKey); if (existing) return existing; const row = { ...input, id: next(state.experiments) } as InterventionExperiment; state.experiments.push(row); return row },
    async getExperiment(owner, id) { return state.experiments.find(row => row.ownerUserId === owner && row.id === id) || null },
    async updateExperiment(owner, id, patch) { const row = await repository.getExperiment(owner, id); if (!row) return null; Object.assign(row, patch); return row },
    async listExperiments(owner) { return state.experiments.filter(row => row.ownerUserId === owner).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id) },
    async createResult(input) { if (!await repository.getExperiment(input.ownerUserId, input.experimentId) || (input.interventionId !== null && !await repository.getIntervention(input.ownerUserId, input.interventionId))) ownerNotFound(); const existing = await repository.findResultByFingerprint(input.ownerUserId, input.resultFingerprint); if (existing) return existing; const row = { ...input, id: next(state.results) } as ExperimentResult; state.results.push(row); return row },
    async findResultByFingerprint(owner, value) { return state.results.find(row => row.ownerUserId === owner && row.resultFingerprint === value) || null },
    async findLatestResultForIntervention(owner, interventionId) { return state.results.filter(row => row.ownerUserId === owner && row.interventionId === interventionId).sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime() || b.id - a.id)[0] || null },
    async listResultsForIntervention(owner, interventionId) { return state.results.filter(row => row.ownerUserId === owner && row.interventionId === interventionId).sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime() || b.id - a.id) },
    async listResultsForExperiment(owner, experimentId) { return state.results.filter(row => row.ownerUserId === owner && row.experimentId === experimentId).sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime() || b.id - a.id) },
    async getPolicy(owner) { return state.policies.find(row => row.ownerUserId === owner) || null },
    async upsertPolicy(owner, input: RefreshPolicyInput, now) { let row = await repository.getPolicy(owner); if (row) { Object.assign(row, input, { updatedAt: now }); return row } row = { id: next(state.policies), ownerUserId: owner, regressionDropPercent: input.regressionDropPercent ?? 20, minimumSampleSize: input.minimumSampleSize ?? 30, staleAfterDays: input.staleAfterDays ?? 90, createdAt: now, updatedAt: now }; state.policies.push(row); return row },
    async createQueueItem(input) { if (input.interventionId !== null && !await repository.getIntervention(input.ownerUserId, input.interventionId)) ownerNotFound(); const row = { ...input, id: next(state.queue) } as RefreshQueueItem; state.queue.push(row); return row },
    async getQueueItem(owner, id) { return state.queue.find(row => row.ownerUserId === owner && row.id === id) || null },
    async updateQueueItem(owner, id, patch) { const row = await repository.getQueueItem(owner, id); if (!row) return null; Object.assign(row, patch); return row },
    async listQueue(owner, status) { return state.queue.filter(row => row.ownerUserId === owner && (!status || row.status === status)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id) },
    async findActiveQueueItemByDedupeKey(owner, key) { return state.queue.find(row => row.ownerUserId === owner && row.dedupeKey === key && (row.status === 'open' || row.status === 'in_progress')) || null },
  }
  return repository
}
