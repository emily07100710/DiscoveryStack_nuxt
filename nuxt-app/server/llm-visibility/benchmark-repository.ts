import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { getDatabase } from '../database'
import { llmVisibilityBenchmarkRuns, llmVisibilityBenchmarkSamples, llmVisibilityCompetitors, llmVisibilityObservations, llmVisibilityProjects, llmVisibilityPromptVersions, llmVisibilityQueries, llmVisibilityRuns } from '../database/schema'
import { VisibilityContractError } from './contracts'
import { createDrizzleVisibilityRegistryRepository, createDrizzleVisibilityWorkflowRepository } from './repository'
import { persistProviderObservationCandidate, type ProjectRecord, type QueryRecord, type VisibilityWorkflowRepository } from './service'
import type { ObservationCandidate, ProviderTarget } from '../llm-visibility-probes/types'
import type { CitationFreshnessRecord, CitationHeadFetchOptions } from './citation-freshness'
import type { CompetitorRecord, PromptVersionRecord, VisibilityRegistryRepository } from './registry'
import type { BenchmarkAggregateObservation } from './benchmark-aggregate'

export type BenchmarkStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed'
export type BenchmarkSampleStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type BenchmarkRow = {
  id: number
  ownerUserId: number
  projectId: number
  label: string | null
  brandName: string
  brandAliases: string[]
  measuredDomain: string
  status: BenchmarkStatus
  sampleSize: number
  requestedSamples: number
  succeededSamples: number
  failedSamples: number
  queryIds: number[]
  providerTargets: ProviderTarget[]
  promptVersionIds: Record<string, number>
  competitorSnapshot: Array<{ id: number, name: string, canonicalKey: string, aliases: string[], active?: boolean }>
  engineVersion: string
  maximumProbes: number
  concurrency: number
  limitationCodes: string[]
  aggregateSnapshot: unknown | null
  aggregateComputedAt: Date | null
  startedAt: Date | null
  lastProgressAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type BenchmarkSampleRow = {
  id: number
  ownerUserId: number
  benchmarkRunId: number
  projectId: number
  queryId: number
  promptVersionId: number
  sampleIndex: number
  provider: 'chatgpt' | 'gemini' | 'perplexity'
  modelLabel: string
  adapterKey: string
  locale: 'en' | 'zh-hant'
  observationWindowKey: string
  requestFingerprint: string
  status: BenchmarkSampleStatus
  attempts: number
  failureKind: string | null
  failureCode: string | null
  runId: number | null
  observationId: number | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type BenchmarkContext = { project: ProjectRecord, queries: QueryRecord[], competitors: CompetitorRecord[], promptVersions: PromptVersionRecord[] }
export type BenchmarkWithSamples = { benchmark: BenchmarkRow, samples: BenchmarkSampleRow[] }

export interface VisibilityBenchmarkRepository {
  readonly registry: VisibilityRegistryRepository
  loadProjectContext(ownerUserId: number, projectId: number): Promise<BenchmarkContext | null>
  createBenchmark(values: Omit<BenchmarkRow, 'id' | 'createdAt' | 'updatedAt'>, buildSamples: (benchmarkId: number) => Omit<BenchmarkSampleRow, 'id' | 'benchmarkRunId' | 'createdAt' | 'updatedAt'>[]): Promise<BenchmarkWithSamples>
  listBenchmarks(ownerUserId: number, projectId: number, limit?: number): Promise<BenchmarkWithSamples[]>
  getBenchmark(ownerUserId: number, benchmarkId: number): Promise<BenchmarkWithSamples | null>
  claimBenchmarkForExecution(ownerUserId: number, benchmarkId: number, now: Date, staleBefore: Date): Promise<boolean>
  updateSample(ownerUserId: number, sampleId: number, values: Partial<Omit<BenchmarkSampleRow, 'id' | 'ownerUserId' | 'benchmarkRunId' | 'projectId' | 'queryId' | 'promptVersionId' | 'provider' | 'modelLabel' | 'adapterKey' | 'locale' | 'observationWindowKey' | 'requestFingerprint' | 'createdAt'>>): Promise<void>
  touchProgress(ownerUserId: number, benchmarkId: number, now: Date): Promise<{ succeeded: number, failed: number }>
  finalizeBenchmark(ownerUserId: number, benchmarkId: number, input: { status: BenchmarkStatus, limitationCodes: string[], aggregateSnapshot: unknown, aggregateComputedAt: Date, completedAt: Date }): Promise<void>
  findRunByFingerprint(ownerUserId: number, requestFingerprint: string): Promise<{ runId: number, observationId: number } | null>
  persistSampleObservation(ownerUserId: number, candidate: ObservationCandidate, input: { promptVersionId: number, benchmarkRunId: number, sampleIndex: number, now: Date, headFetch?: CitationHeadFetchOptions }): Promise<{ runId: number, observationId: number }>
  loadSucceededObservations(ownerUserId: number, benchmarkId: number): Promise<BenchmarkAggregateObservation[]>
}

function asDate(value: unknown): Date | null { return value ? new Date(value as Date | string) : null }
function benchmarkProjection(row: any): BenchmarkRow {
  return { ...row, brandAliases: Array.isArray(row.brandAliases) ? row.brandAliases : [], queryIds: Array.isArray(row.queryIds) ? row.queryIds : [], providerTargets: Array.isArray(row.providerTargets) ? row.providerTargets : [], promptVersionIds: row.promptVersionIds && typeof row.promptVersionIds === 'object' ? row.promptVersionIds : {}, competitorSnapshot: Array.isArray(row.competitorSnapshot) ? row.competitorSnapshot : [], limitationCodes: Array.isArray(row.limitationCodes) ? row.limitationCodes : [], aggregateComputedAt: asDate(row.aggregateComputedAt), startedAt: asDate(row.startedAt), lastProgressAt: asDate(row.lastProgressAt), completedAt: asDate(row.completedAt), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) }
}
function sampleProjection(row: any): BenchmarkSampleRow {
  return { ...row, startedAt: asDate(row.startedAt), completedAt: asDate(row.completedAt), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) }
}

export function createDrizzleVisibilityBenchmarkRepository(database: any = getDatabase()): VisibilityBenchmarkRepository {
  if (!database) throw new VisibilityContractError(503, 'LLM Visibility benchmark 暫時無法連線。')
  const registry = createDrizzleVisibilityRegistryRepository(database)
  return {
    registry,
    async loadProjectContext(ownerUserId, projectId) {
      const [project, queries, competitors, promptVersions] = await Promise.all([
        registry.getProject(ownerUserId, projectId),
        registry.listProjectQueries(ownerUserId, projectId),
        registry.listCompetitors(ownerUserId, projectId, { limit: 500 }),
        database.select().from(llmVisibilityPromptVersions).where(and(eq(llmVisibilityPromptVersions.ownerUserId, ownerUserId), eq(llmVisibilityPromptVersions.projectId, projectId))).orderBy(asc(llmVisibilityPromptVersions.queryId), desc(llmVisibilityPromptVersions.versionNumber)),
      ])
      return project ? { project, queries, competitors, promptVersions } : null
    },
    async createBenchmark(values, buildSamples) {
      return database.transaction(async (transaction: any) => {
        const result = await transaction.insert(llmVisibilityBenchmarkRuns).values(values)
        const id = Number(result[0].insertId)
        const now = new Date()
        const samples = buildSamples(id)
        if (samples.length) await transaction.insert(llmVisibilityBenchmarkSamples).values(samples.map(row => ({ ...row, benchmarkRunId: id })))
        const [benchmarkRow] = await transaction.select().from(llmVisibilityBenchmarkRuns).where(eq(llmVisibilityBenchmarkRuns.id, id)).limit(1)
        const sampleRows = await transaction.select().from(llmVisibilityBenchmarkSamples).where(eq(llmVisibilityBenchmarkSamples.benchmarkRunId, id)).orderBy(asc(llmVisibilityBenchmarkSamples.sampleIndex), asc(llmVisibilityBenchmarkSamples.id))
        return { benchmark: benchmarkProjection(benchmarkRow || { ...values, id, createdAt: now, updatedAt: now }), samples: sampleRows.map(sampleProjection) }
      })
    },
    async listBenchmarks(ownerUserId, projectId, limit = 50) {
      const rows = await database.select().from(llmVisibilityBenchmarkRuns).where(and(eq(llmVisibilityBenchmarkRuns.ownerUserId, ownerUserId), eq(llmVisibilityBenchmarkRuns.projectId, projectId))).orderBy(desc(llmVisibilityBenchmarkRuns.createdAt)).limit(Math.min(limit, 50))
      if (!rows.length) return []
      const ids = rows.map((row: any) => row.id)
      const samples = await database.select().from(llmVisibilityBenchmarkSamples).where(and(eq(llmVisibilityBenchmarkSamples.ownerUserId, ownerUserId), inArray(llmVisibilityBenchmarkSamples.benchmarkRunId, ids))).orderBy(asc(llmVisibilityBenchmarkSamples.sampleIndex), asc(llmVisibilityBenchmarkSamples.id))
      return rows.map((row: any) => ({ benchmark: benchmarkProjection(row), samples: samples.filter((sample: any) => sample.benchmarkRunId === row.id).map(sampleProjection) }))
    },
    async getBenchmark(ownerUserId, benchmarkId) {
      const [row] = await database.select().from(llmVisibilityBenchmarkRuns).where(and(eq(llmVisibilityBenchmarkRuns.id, benchmarkId), eq(llmVisibilityBenchmarkRuns.ownerUserId, ownerUserId))).limit(1)
      if (!row) return null
      const samples = await database.select().from(llmVisibilityBenchmarkSamples).where(and(eq(llmVisibilityBenchmarkSamples.ownerUserId, ownerUserId), eq(llmVisibilityBenchmarkSamples.benchmarkRunId, benchmarkId))).orderBy(asc(llmVisibilityBenchmarkSamples.sampleIndex), asc(llmVisibilityBenchmarkSamples.id))
      return { benchmark: benchmarkProjection(row), samples: samples.map(sampleProjection) }
    },
    async claimBenchmarkForExecution(ownerUserId, benchmarkId, now, staleBefore) {
      const result = await database.update(llmVisibilityBenchmarkRuns).set({ status: 'running', startedAt: now, lastProgressAt: now }).where(and(
        eq(llmVisibilityBenchmarkRuns.id, benchmarkId),
        eq(llmVisibilityBenchmarkRuns.ownerUserId, ownerUserId),
        or(
          inArray(llmVisibilityBenchmarkRuns.status, ['queued', 'partial', 'failed']),
          and(eq(llmVisibilityBenchmarkRuns.status, 'running'), or(
            lte(llmVisibilityBenchmarkRuns.lastProgressAt, staleBefore),
            and(isNull(llmVisibilityBenchmarkRuns.lastProgressAt), lte(llmVisibilityBenchmarkRuns.startedAt, staleBefore)),
            and(isNull(llmVisibilityBenchmarkRuns.lastProgressAt), isNull(llmVisibilityBenchmarkRuns.startedAt), lte(llmVisibilityBenchmarkRuns.createdAt, staleBefore)),
          )),
        ),
      ))
      return Number(result?.[0]?.affectedRows || 0) === 1
    },
    async updateSample(ownerUserId, sampleId, values) {
      await database.update(llmVisibilityBenchmarkSamples).set(values).where(and(eq(llmVisibilityBenchmarkSamples.id, sampleId), eq(llmVisibilityBenchmarkSamples.ownerUserId, ownerUserId)))
    },
    async touchProgress(ownerUserId, benchmarkId, now) {
      const samples = await database.select({ status: llmVisibilityBenchmarkSamples.status }).from(llmVisibilityBenchmarkSamples).where(and(eq(llmVisibilityBenchmarkSamples.ownerUserId, ownerUserId), eq(llmVisibilityBenchmarkSamples.benchmarkRunId, benchmarkId)))
      const succeeded = samples.filter((row: any) => row.status === 'succeeded').length
      const failed = samples.filter((row: any) => row.status === 'failed').length
      await database.update(llmVisibilityBenchmarkRuns).set({ succeededSamples: succeeded, failedSamples: failed, lastProgressAt: now }).where(and(eq(llmVisibilityBenchmarkRuns.id, benchmarkId), eq(llmVisibilityBenchmarkRuns.ownerUserId, ownerUserId)))
      return { succeeded, failed }
    },
    async finalizeBenchmark(ownerUserId, benchmarkId, input) {
      await database.update(llmVisibilityBenchmarkRuns).set(input).where(and(eq(llmVisibilityBenchmarkRuns.id, benchmarkId), eq(llmVisibilityBenchmarkRuns.ownerUserId, ownerUserId)))
    },
    async findRunByFingerprint(ownerUserId, requestFingerprint) {
      const [row] = await database.select({ runId: llmVisibilityRuns.id, observationId: llmVisibilityObservations.id }).from(llmVisibilityRuns).innerJoin(llmVisibilityObservations, eq(llmVisibilityObservations.runId, llmVisibilityRuns.id)).where(and(eq(llmVisibilityRuns.ownerUserId, ownerUserId), eq(llmVisibilityRuns.requestFingerprint, requestFingerprint))).limit(1)
      return row || null
    },
    async persistSampleObservation(ownerUserId, candidate, input) {
      return persistProviderObservationCandidate(createDrizzleVisibilityWorkflowRepository(database), ownerUserId, candidate, input.now, input)
    },
    async loadSucceededObservations(ownerUserId, benchmarkId) {
      const rows = await database.select({ id: llmVisibilityObservations.id, queryId: llmVisibilityObservations.queryId, promptVersionId: llmVisibilityObservations.promptVersionId, versionNumber: llmVisibilityPromptVersions.versionNumber, provider: llmVisibilityRuns.provider, modelLabel: llmVisibilityRuns.modelLabel, observedAt: llmVisibilityRuns.observedAt, brandMentioned: llmVisibilityObservations.brandMentioned, exactMentionCount: llmVisibilityObservations.exactMentionCount, firstMentionPosition: llmVisibilityObservations.firstMentionPosition, citationUrls: llmVisibilityObservations.citationUrls, competitorMentions: llmVisibilityObservations.competitorMentions, citationFreshness: llmVisibilityObservations.citationFreshness }).from(llmVisibilityBenchmarkSamples).innerJoin(llmVisibilityObservations, eq(llmVisibilityObservations.id, llmVisibilityBenchmarkSamples.observationId)).innerJoin(llmVisibilityRuns, eq(llmVisibilityRuns.id, llmVisibilityBenchmarkSamples.runId)).leftJoin(llmVisibilityPromptVersions, eq(llmVisibilityPromptVersions.id, llmVisibilityObservations.promptVersionId)).where(and(eq(llmVisibilityBenchmarkSamples.ownerUserId, ownerUserId), eq(llmVisibilityBenchmarkSamples.benchmarkRunId, benchmarkId), eq(llmVisibilityBenchmarkSamples.status, 'succeeded')))
      return rows.map((row: any) => ({ ...row, citationUrls: Array.isArray(row.citationUrls) ? row.citationUrls : [], competitorMentions: row.competitorMentions && typeof row.competitorMentions === 'object' ? row.competitorMentions : {}, citationFreshness: Array.isArray(row.citationFreshness) ? row.citationFreshness : null }))
    },
  }
}

export type InMemoryBenchmarkSeed = { projects?: ProjectRecord[], queries?: QueryRecord[], competitors?: CompetitorRecord[], promptVersions?: PromptVersionRecord[], benchmarks?: BenchmarkRow[], samples?: BenchmarkSampleRow[], runs?: any[], observations?: any[] }

export function createInMemoryVisibilityBenchmarkRepository(seed: InMemoryBenchmarkSeed = {}): VisibilityBenchmarkRepository & { state: Required<InMemoryBenchmarkSeed> } {
  const state: Required<InMemoryBenchmarkSeed> = { projects: structuredClone(seed.projects || []), queries: structuredClone(seed.queries || []), competitors: structuredClone(seed.competitors || []), promptVersions: structuredClone(seed.promptVersions || []), benchmarks: structuredClone(seed.benchmarks || []), samples: structuredClone(seed.samples || []), runs: structuredClone(seed.runs || []), observations: structuredClone(seed.observations || []) }
  let competitorId = Math.max(0, ...state.competitors.map(row => row.id)) + 1
  let promptVersionId = Math.max(0, ...state.promptVersions.map(row => row.id)) + 1
  let benchmarkId = Math.max(0, ...state.benchmarks.map(row => row.id)) + 1
  let sampleId = Math.max(0, ...state.samples.map(row => row.id)) + 1
  let runId = Math.max(0, ...state.runs.map(row => row.id || 0)) + 1
  let observationId = Math.max(0, ...state.observations.map(row => row.id || 0)) + 1
  const registry: VisibilityRegistryRepository = {
    async transaction(work) { return work(registry) },
    async getProject(ownerUserId, projectId) { return state.projects.find(row => row.ownerUserId === ownerUserId && row.id === projectId) || null },
    async listProjectQueries(ownerUserId, projectId) { return state.queries.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
    async getQuery(ownerUserId, queryId) { return state.queries.find(row => row.ownerUserId === ownerUserId && row.id === queryId) || null },
    async findQueryByHash(ownerUserId, projectId, promptHash) { return state.queries.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId && row.promptHash === promptHash) || null },
    async updateQuery(ownerUserId, queryId, values) { const row = state.queries.find(item => item.ownerUserId === ownerUserId && item.id === queryId); if (!row) throw new VisibilityContractError(404, '找不到此 owner 的 tracking query。'); Object.assign(row, values); return structuredClone(row) },
    async getLatestPromptVersion(ownerUserId, queryId) { return [...state.promptVersions].filter(row => row.ownerUserId === ownerUserId && row.queryId === queryId).sort((a, b) => b.versionNumber - a.versionNumber)[0] || null },
    async insertPromptVersion(values) { const row = { ...values, id: promptVersionId++, createdAt: new Date() }; state.promptVersions.push(row); return structuredClone(row) },
    async listCompetitors(ownerUserId, projectId, options = {}) { return state.competitors.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId && (!options.activeOnly || row.active)).slice(0, options.limit || 500).map(row => structuredClone(row)) },
    async getCompetitor(ownerUserId, id) { return structuredClone(state.competitors.find(row => row.ownerUserId === ownerUserId && row.id === id) || null) },
    async findCompetitorByKey(ownerUserId, projectId, canonicalKey) { return structuredClone(state.competitors.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId && row.canonicalKey === canonicalKey) || null) },
    async insertCompetitor(values) { const row = { ...values, id: competitorId++, createdAt: new Date(), updatedAt: new Date() }; state.competitors.push(row); return structuredClone(row) },
    async updateCompetitor(ownerUserId, id, values) { const row = state.competitors.find(item => item.ownerUserId === ownerUserId && item.id === id); if (!row) throw new VisibilityContractError(404, '找不到此 owner 的 competitor。'); Object.assign(row, values); return structuredClone(row) },
  }
  const repository: VisibilityBenchmarkRepository & { state: Required<InMemoryBenchmarkSeed> } = {
    state,
    registry,
    async loadProjectContext(ownerUserId, projectId) { const project = await registry.getProject(ownerUserId, projectId); return project ? { project, queries: await registry.listProjectQueries(ownerUserId, projectId), competitors: await registry.listCompetitors(ownerUserId, projectId), promptVersions: state.promptVersions.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) } : null },
    async createBenchmark(values, buildSamples) { const now = new Date(); const benchmark = { ...values, id: benchmarkId++, createdAt: now, updatedAt: now }; state.benchmarks.push(benchmark); const samples = buildSamples(benchmark.id).map(values => ({ ...values, id: sampleId++, benchmarkRunId: benchmark.id, createdAt: now, updatedAt: now })); state.samples.push(...samples); return structuredClone({ benchmark, samples }) },
    async listBenchmarks(ownerUserId, projectId, limit = 50) { return state.benchmarks.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map(benchmark => structuredClone({ benchmark, samples: state.samples.filter(row => row.benchmarkRunId === benchmark.id) })) },
    async getBenchmark(ownerUserId, id) { const benchmark = state.benchmarks.find(row => row.ownerUserId === ownerUserId && row.id === id); return benchmark ? structuredClone({ benchmark, samples: state.samples.filter(row => row.benchmarkRunId === id).sort((a, b) => a.sampleIndex - b.sampleIndex || a.id - b.id) }) : null },
    async claimBenchmarkForExecution(ownerUserId, id, now, staleBefore) { const row = state.benchmarks.find(item => item.ownerUserId === ownerUserId && item.id === id); if (!row) return false; const last = row.lastProgressAt || row.startedAt || row.createdAt; if (row.status === 'completed' || row.status === 'running' && last > staleBefore) return false; row.status = 'running'; row.startedAt ||= now; row.lastProgressAt = now; row.updatedAt = now; return true },
    async updateSample(ownerUserId, id, values) { const row = state.samples.find(item => item.ownerUserId === ownerUserId && item.id === id); if (!row) throw new VisibilityContractError(404, '找不到 benchmark sample。'); Object.assign(row, values, { updatedAt: new Date() }) },
    async touchProgress(ownerUserId, id, now) { const benchmark = state.benchmarks.find(item => item.ownerUserId === ownerUserId && item.id === id); if (!benchmark) throw new VisibilityContractError(404, '找不到 benchmark。'); const samples = state.samples.filter(row => row.benchmarkRunId === id); benchmark.succeededSamples = samples.filter(row => row.status === 'succeeded').length; benchmark.failedSamples = samples.filter(row => row.status === 'failed').length; benchmark.lastProgressAt = now; return { succeeded: benchmark.succeededSamples, failed: benchmark.failedSamples } },
    async finalizeBenchmark(ownerUserId, id, input) { const row = state.benchmarks.find(item => item.ownerUserId === ownerUserId && item.id === id); if (!row) throw new VisibilityContractError(404, '找不到 benchmark。'); Object.assign(row, input, { updatedAt: input.completedAt }) },
    async findRunByFingerprint(ownerUserId, requestFingerprint) { const run = state.runs.find(row => row.ownerUserId === ownerUserId && row.requestFingerprint === requestFingerprint); if (!run) return null; const observation = state.observations.find(row => row.runId === run.id); return observation ? { runId: run.id, observationId: observation.id } : null },
    async persistSampleObservation(ownerUserId, candidate, input) {
      const workflow: VisibilityWorkflowRepository = {
        getProject: registry.getProject,
        getQuery: registry.getQuery,
        async getRun(scopedOwner, id) { return state.runs.find(row => row.ownerUserId === scopedOwner && row.id === id) || null },
        async findRunByFingerprint(scopedOwner, fingerprint) { return state.runs.find(row => row.ownerUserId === scopedOwner && row.requestFingerprint === fingerprint) || null },
        async hasObservation(scopedRunId, queryId) { return state.observations.some(row => row.runId === scopedRunId && row.queryId === queryId) },
        async ensurePromptVersion(query) { return (await registry.getLatestPromptVersion(query.ownerUserId, query.id)) || (await registry.insertPromptVersion({ ownerUserId: query.ownerUserId, projectId: query.projectId, queryId: query.id, versionNumber: 1, promptText: query.promptText, promptHash: query.promptHash })) },
        async commitObservation(values) {
          if (state.runs.some(row => row.ownerUserId === values.ownerUserId && row.requestFingerprint === values.requestFingerprint)) throw new VisibilityContractError(409, '重複的 run fingerprint 或 run/query observation。')
          const run = { id: runId++, ownerUserId: values.ownerUserId, projectId: values.projectId, provider: values.provider, modelLabel: values.modelLabel, observationMode: values.observationMode, status: values.status, observedAt: values.observedAtDate, requestFingerprint: values.requestFingerprint, limitationCode: values.limitationCode, promptVersionId: values.promptVersionId || null, benchmarkRunId: values.benchmarkRunId || null, sampleIndex: values.sampleIndex || null, createdAt: values.observedAtDate }
          state.runs.push(run)
          const observation = { id: observationId++, ...values, runId: run.id, promptVersionId: values.promptVersionId || null, citationFreshness: values.citationFreshness as CitationFreshnessRecord[] | undefined, createdAt: values.observedAtDate }
          state.observations.push(observation)
          return { runId: run.id, observationId: observation.id }
        },
      }
      return persistProviderObservationCandidate(workflow, ownerUserId, candidate, input.now, input)
    },
    async loadSucceededObservations(ownerUserId, id) { return state.samples.filter(sample => sample.ownerUserId === ownerUserId && sample.benchmarkRunId === id && sample.status === 'succeeded').flatMap(sample => { const observation = state.observations.find(row => row.id === sample.observationId); const run = state.runs.find(row => row.id === sample.runId); const version = state.promptVersions.find(row => row.id === sample.promptVersionId); return observation && run ? [{ id: observation.id, queryId: observation.queryId, promptVersionId: observation.promptVersionId, versionNumber: version?.versionNumber || null, provider: run.provider, modelLabel: run.modelLabel, observedAt: run.observedAt, brandMentioned: observation.brandMentioned, exactMentionCount: observation.exactMentionCount, firstMentionPosition: observation.firstMentionPosition, citationUrls: observation.citationUrls, competitorMentions: observation.competitorMentions, citationFreshness: observation.citationFreshness || null }] : [] }) },
  }
  return repository
}
