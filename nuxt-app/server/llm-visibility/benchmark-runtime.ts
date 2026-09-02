import {
  buildVisibilityProbePlan,
  createConfiguredVisibilityProviderAdapters,
  createEphemeralVisibilityProbeIdempotencyRegistry,
  executeVisibilityProbeBatch,
  type ProviderTarget,
  type VisibilityProbeAdapter,
  type VisibilityProbeIdempotencyRegistry,
  type VisibilityProbePlan,
} from '../llm-visibility-probes'
import { PROBE_ENGINE_VERSION } from '../llm-visibility-probes/types'
import { VisibilityContractError } from './contracts'
import { assertActiveCompetitorTermLimit, ensureCompetitorRegistry, ensurePromptVersion, type PromptVersionRecord } from './registry'
import { computeBenchmarkAggregate } from './benchmark-aggregate'
import { createDefaultCitationHeadFetch, type CitationHeadFetchOptions } from './citation-freshness'
import { createDrizzleVisibilityBenchmarkRepository, type BenchmarkContext, type BenchmarkRow, type BenchmarkSampleRow, type VisibilityBenchmarkRepository } from './benchmark-repository'
import { benchmarkCreateInputSchema, type BenchmarkCreateInput } from './benchmark-contracts'

export const BENCHMARK_DEFAULT_SAMPLE_SIZE = 5
export const BENCHMARK_DEFAULT_MAX_PROBES = 250
export const BENCHMARK_CONCURRENCY = 5
export const BENCHMARK_MAX_ATTEMPTS_PER_EXECUTION = 3
export const BENCHMARK_STALE_AFTER_MS = 10 * 60 * 1000

export type BenchmarkRuntimeDependencies = {
  repository?: VisibilityBenchmarkRepository
  adapters?: Record<string, VisibilityProbeAdapter>
  clock?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  headFetch?: CitationHeadFetchOptions
  environment?: Record<string, string | undefined>
  idempotencyRegistry?: VisibilityProbeIdempotencyRegistry
  logError?: (error: unknown) => void
}

const executions = new Map<number, Promise<void>>()

export function benchmarkMaximumProbes(environment: Record<string, string | undefined> = process.env): number {
  const parsed = Number(environment.LLM_VISIBILITY_BENCHMARK_MAX_PROBES)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : BENCHMARK_DEFAULT_MAX_PROBES
}

function queryVersion(context: BenchmarkContext, queryId: number, promptVersionId: number): PromptVersionRecord {
  const version = context.promptVersions.find(row => row.id === promptVersionId && row.queryId === queryId)
  if (!version) throw new VisibilityContractError(409, 'Benchmark 的 prompt version 已無法載入。')
  return version
}

type BenchmarkMeasuredIdentity = Pick<BenchmarkRow, 'brandName' | 'brandAliases' | 'measuredDomain'>

function oneProbePlan(input: { ownerUserId: number, benchmarkId: number, sampleIndex: number, context: BenchmarkContext, measuredIdentity: BenchmarkMeasuredIdentity, queryId: number, promptVersionId: number, target: ProviderTarget }): VisibilityProbePlan {
  const query = input.context.queries.find(row => row.id === input.queryId)
  if (!query) throw new VisibilityContractError(409, 'Benchmark 的 query snapshot 已無法載入。')
  const version = queryVersion(input.context, query.id, input.promptVersionId)
  const competitorBrands = assertActiveCompetitorTermLimit(input.context.competitors)
  const result = buildVisibilityProbePlan({
    ownerScopeKey: `visibility-owner:${input.ownerUserId}`,
    project: { projectId: String(input.context.project.id), canonicalWebsiteDomain: input.measuredIdentity.measuredDomain, brandName: input.measuredIdentity.brandName, brandAliases: input.measuredIdentity.brandAliases, competitorBrands, locale: input.context.project.locale },
    activeQuerySnapshots: [{ queryId: String(query.id), projectId: String(query.projectId), promptText: version.promptText, promptHash: version.promptHash, intent: query.intent, locale: query.locale, active: true }],
    providerTargets: [input.target],
    observationWindowKey: `benchmark:${input.benchmarkId}:sample:${input.sampleIndex}`,
    maximumProbes: 1,
    engineVersion: PROBE_ENGINE_VERSION,
  })
  if (result.status !== 'planned') throw new VisibilityContractError(422, `Benchmark probe plan 無法建立：${result.reasonCodes.join(', ')}`)
  return result.plan
}

export function planBenchmarkSamples(input: { ownerUserId: number, benchmarkId: number, sampleSize: number, queryIds: number[], providerTargets: ProviderTarget[], promptVersionIds: Record<string, number>, context: BenchmarkContext, measuredIdentity: BenchmarkMeasuredIdentity }): Omit<BenchmarkSampleRow, 'id' | 'benchmarkRunId' | 'createdAt' | 'updatedAt'>[] {
  const rows: Omit<BenchmarkSampleRow, 'id' | 'benchmarkRunId' | 'createdAt' | 'updatedAt'>[] = []
  for (let sampleIndex = 1; sampleIndex <= input.sampleSize; sampleIndex += 1) {
    for (const queryId of [...input.queryIds].sort((left, right) => left - right)) {
      for (const target of [...input.providerTargets].sort((left, right) => left.provider.localeCompare(right.provider) || left.modelLabel.localeCompare(right.modelLabel) || left.adapterKey.localeCompare(right.adapterKey))) {
        const promptVersionId = input.promptVersionIds[String(queryId)]
        if (!promptVersionId) throw new VisibilityContractError(409, 'Benchmark 缺少 query prompt version。')
        const plan = oneProbePlan({ ownerUserId: input.ownerUserId, benchmarkId: input.benchmarkId, sampleIndex, context: input.context, measuredIdentity: input.measuredIdentity, queryId, promptVersionId, target })
        const probe = plan.probes[0]!
        rows.push({ ownerUserId: input.ownerUserId, projectId: input.context.project.id, queryId, promptVersionId, sampleIndex, provider: probe.provider, modelLabel: probe.modelLabel, adapterKey: probe.adapterKey, locale: probe.locale, observationWindowKey: probe.observationWindowKey, requestFingerprint: probe.requestFingerprint, status: 'pending', attempts: 0, failureKind: null, failureCode: null, runId: null, observationId: null, startedAt: null, completedAt: null })
      }
    }
  }
  return rows
}

export async function createBenchmark(ownerUserId: number, rawInput: BenchmarkCreateInput, deps: BenchmarkRuntimeDependencies = {}) {
  const repository = deps.repository || createDrizzleVisibilityBenchmarkRepository()
  const environment = deps.environment || process.env
  const parsedInput = benchmarkCreateInputSchema.safeParse(rawInput)
  if (!parsedInput.success) throw new VisibilityContractError(422, parsedInput.error.issues[0]?.message || 'Benchmark 輸入格式無效。')
  const input = parsedInput.data
  const providerTargets: ProviderTarget[] = input.providerTargets.map(target => ({ ...target, status: 'active' }))
  const requestedSamples = input.sampleSize * input.queryIds.length * input.providerTargets.length
  const maximumProbes = benchmarkMaximumProbes(environment)
  if (requestedSamples > maximumProbes) throw new VisibilityContractError(422, `Benchmark 共需 ${requestedSamples} 次探測，超過目前上限 ${maximumProbes}；請減少 sampleSize、query 或 provider target。`)
  let context = await repository.loadProjectContext(ownerUserId, input.projectId)
  if (!context || context.project.status !== 'active') throw new VisibilityContractError(404, '找不到此 owner 的 active LLM visibility project。')
  const selectedQueries = context.queries.filter(row => input.queryIds.includes(row.id))
  if (selectedQueries.length !== input.queryIds.length || selectedQueries.some(row => !row.active || row.projectId !== context!.project.id)) throw new VisibilityContractError(422, 'provider observation query scope 必須全部屬於此 active project。')
  const ensured = await repository.registry.transaction(async transaction => {
    const competitorResult = await ensureCompetitorRegistry(transaction, context!.project)
    const versions: Record<string, number> = {}
    for (const query of selectedQueries) versions[String(query.id)] = (await ensurePromptVersion(transaction, query)).version.id
    return { competitors: competitorResult.competitors, versions }
  })
  context = await repository.loadProjectContext(ownerUserId, input.projectId)
  if (!context) throw new VisibilityContractError(404, '找不到此 owner 的 active LLM visibility project。')
  context.competitors = ensured.competitors
  assertActiveCompetitorTermLimit(context.competitors)
  const now = (deps.clock || (() => new Date()))()
  const competitorSnapshot = context.competitors.filter(row => row.active).map(row => ({ id: row.id, name: row.name, canonicalKey: row.canonicalKey, aliases: [...row.aliases], active: row.active })).sort((left, right) => left.id - right.id)
  const measuredIdentity: BenchmarkMeasuredIdentity = { brandName: context.project.brandName, brandAliases: [...context.project.brandAliases], measuredDomain: context.project.canonicalDomain }
  const values: Omit<BenchmarkRow, 'id' | 'createdAt' | 'updatedAt'> = { ownerUserId, projectId: input.projectId, label: input.label || null, ...measuredIdentity, status: 'queued', sampleSize: input.sampleSize, requestedSamples, succeededSamples: 0, failedSamples: 0, queryIds: [...input.queryIds].sort((a, b) => a - b), providerTargets, promptVersionIds: ensured.versions, competitorSnapshot, engineVersion: PROBE_ENGINE_VERSION, maximumProbes, concurrency: BENCHMARK_CONCURRENCY, limitationCodes: [], aggregateSnapshot: null, aggregateComputedAt: null, startedAt: null, lastProgressAt: null, completedAt: null }
  const created = await repository.createBenchmark(values, benchmarkId => planBenchmarkSamples({ ownerUserId, benchmarkId, sampleSize: input.sampleSize, queryIds: input.queryIds, providerTargets, promptVersionIds: ensured.versions, context: context!, measuredIdentity }))
  return { benchmarkId: created.benchmark.id, status: 'queued' as const, requestedSamples, sampleSize: input.sampleSize, projectId: input.projectId }
}

function retryDelay(category: 'none' | 'short' | 'medium' | 'long'): number {
  return category === 'short' ? 100 : category === 'medium' ? 500 : category === 'long' ? 1_000 : 0
}

function targetForSample(benchmark: BenchmarkRow, sample: BenchmarkSampleRow): ProviderTarget {
  const target = benchmark.providerTargets.find(row => row.provider === sample.provider && row.modelLabel === sample.modelLabel && row.adapterKey === sample.adapterKey)
  if (!target) throw new VisibilityContractError(409, 'Benchmark sample 的 provider target 已無法載入。')
  return target
}

async function runSample(input: { ownerUserId: number, benchmark: BenchmarkRow, sample: BenchmarkSampleRow, context: BenchmarkContext, repository: VisibilityBenchmarkRepository, adapters: Record<string, VisibilityProbeAdapter>, registry: VisibilityProbeIdempotencyRegistry, now: () => Date, sleep: (ms: number) => Promise<void>, headFetch: CitationHeadFetchOptions }) {
  const { sample, repository } = input
  const existing = await repository.findRunByFingerprint(input.ownerUserId, sample.requestFingerprint)
  if (existing) {
    const completedAt = input.now()
    await repository.updateSample(input.ownerUserId, sample.id, { status: 'succeeded', runId: existing.runId, observationId: existing.observationId, failureKind: null, failureCode: null, completedAt })
    await repository.touchProgress(input.ownerUserId, sample.benchmarkRunId, completedAt)
    return
  }
  await repository.updateSample(input.ownerUserId, sample.id, { status: 'running', startedAt: input.now(), completedAt: null })
  const plan = oneProbePlan({ ownerUserId: input.ownerUserId, benchmarkId: sample.benchmarkRunId, sampleIndex: sample.sampleIndex, context: input.context, measuredIdentity: input.benchmark, queryId: sample.queryId, promptVersionId: sample.promptVersionId, target: targetForSample(input.benchmark, sample) })
  let finalKind = 'failed'
  let finalCode = 'PROBE_EXECUTION_FAILURE'
  for (let attempt = 1; attempt <= BENCHMARK_MAX_ATTEMPTS_PER_EXECUTION; attempt += 1) {
    await repository.updateSample(input.ownerUserId, sample.id, { attempts: sample.attempts + attempt })
    const batch = await executeVisibilityProbeBatch({ plan, adapters: input.adapters, idempotencyRegistry: input.registry, concurrency: 1 })
    const result = batch.status === 'completed' ? batch.results[0] : undefined
    if (result?.status === 'completed' && result.candidate) {
      try {
        const persisted = await repository.persistSampleObservation(input.ownerUserId, result.candidate, { promptVersionId: sample.promptVersionId, benchmarkRunId: sample.benchmarkRunId, sampleIndex: sample.sampleIndex, now: input.now(), headFetch: input.headFetch })
        const completedAt = input.now()
        await repository.updateSample(input.ownerUserId, sample.id, { status: 'succeeded', runId: persisted.runId, observationId: persisted.observationId, failureKind: null, failureCode: null, completedAt })
        await repository.touchProgress(input.ownerUserId, sample.benchmarkRunId, completedAt)
        return
      } catch (error) {
        if (!(error instanceof VisibilityContractError && error.statusCode === 409)) throw error
        const reconciled = await repository.findRunByFingerprint(input.ownerUserId, sample.requestFingerprint)
        if (!reconciled) throw error
        const completedAt = input.now()
        await repository.updateSample(input.ownerUserId, sample.id, { status: 'succeeded', runId: reconciled.runId, observationId: reconciled.observationId, failureKind: null, failureCode: null, completedAt })
        await repository.touchProgress(input.ownerUserId, sample.benchmarkRunId, completedAt)
        return
      }
    }
    finalKind = result?.status || 'blocked'
    finalCode = result?.failure?.reasonCode || (batch.status === 'blocked' ? batch.reasonCodes[0] : undefined) || 'PROBE_EXECUTION_FAILURE'
    if (!result?.failure?.retryable || attempt === BENCHMARK_MAX_ATTEMPTS_PER_EXECUTION) break
    await input.sleep(retryDelay(result.failure.nextDelayCategory))
  }
  const completedAt = input.now()
  await repository.updateSample(input.ownerUserId, sample.id, { status: 'failed', failureKind: finalKind, failureCode: finalCode, completedAt })
  await repository.touchProgress(input.ownerUserId, sample.benchmarkRunId, completedAt)
}

async function pooled<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item !== undefined) await work(item)
    }
  }))
}

export async function executeBenchmark(ownerUserId: number, benchmarkId: number, deps: BenchmarkRuntimeDependencies = {}) {
  const repository = deps.repository || createDrizzleVisibilityBenchmarkRepository()
  const now = deps.clock || (() => new Date())
  const started = now()
  const claimed = await repository.claimBenchmarkForExecution(ownerUserId, benchmarkId, started, new Date(started.getTime() - BENCHMARK_STALE_AFTER_MS))
  if (!claimed) return { started: false as const }
  let loaded = await repository.getBenchmark(ownerUserId, benchmarkId)
  if (!loaded) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark。')
  const context = await repository.loadProjectContext(ownerUserId, loaded.benchmark.projectId)
  if (!context) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark project。')
  context.competitors = loaded.benchmark.competitorSnapshot.map(row => ({ ...row, ownerUserId, projectId: loaded!.benchmark.projectId, domain: null, active: true }))
  const adapters = deps.adapters || createConfiguredVisibilityProviderAdapters(loaded.benchmark.providerTargets.map(({ adapterKey, provider, modelLabel }) => ({ adapterKey, provider, modelLabel })), deps.environment)
  const registry = deps.idempotencyRegistry || createEphemeralVisibilityProbeIdempotencyRegistry()
  const sleep = deps.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const headFetch = deps.headFetch || createDefaultCitationHeadFetch(deps.environment)
  const eligible = loaded.samples.filter(row => row.status !== 'succeeded').sort((left, right) => left.sampleIndex - right.sampleIndex || left.id - right.id)
  for (const sampleIndex of [...new Set(eligible.map(row => row.sampleIndex))].sort((a, b) => a - b)) {
    await pooled(eligible.filter(row => row.sampleIndex === sampleIndex), BENCHMARK_CONCURRENCY, async sample => {
      try { await runSample({ ownerUserId, benchmark: loaded!.benchmark, sample, context, repository, adapters, registry, now, sleep, headFetch }) } catch {
        const completedAt = now()
        await repository.updateSample(ownerUserId, sample.id, { status: 'failed', failureKind: 'internal', failureCode: 'SAMPLE_EXECUTION_FAILURE', completedAt })
        await repository.touchProgress(ownerUserId, benchmarkId, completedAt)
      }
    })
  }
  loaded = await repository.getBenchmark(ownerUserId, benchmarkId)
  if (!loaded) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark。')
  await repository.touchProgress(ownerUserId, benchmarkId, now())
  loaded = await repository.getBenchmark(ownerUserId, benchmarkId)
  if (!loaded) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark。')
  const observations = await repository.loadSucceededObservations(ownerUserId, benchmarkId)
  const aggregate = computeBenchmarkAggregate({ benchmark: loaded.benchmark, samples: loaded.samples, observations, competitorSnapshot: loaded.benchmark.competitorSnapshot, brandName: loaded.benchmark.brandName, brandDomain: loaded.benchmark.measuredDomain })
  const status = aggregate.succeededSamples === 0 ? 'failed' : aggregate.succeededSamples < loaded.benchmark.requestedSamples ? 'partial' : 'completed'
  const completedAt = now()
  await repository.finalizeBenchmark(ownerUserId, benchmarkId, { status, limitationCodes: aggregate.limitations, aggregateSnapshot: aggregate, aggregateComputedAt: completedAt, completedAt })
  return { started: true as const, status, aggregate }
}

export function startBenchmarkInBackground(ownerUserId: number, benchmarkId: number, deps: BenchmarkRuntimeDependencies = {}): boolean {
  if (executions.has(benchmarkId)) return false
  const promise = executeBenchmark(ownerUserId, benchmarkId, deps).then(() => undefined)
  executions.set(benchmarkId, promise)
  void promise.catch(error => (deps.logError || console.error)(error)).finally(() => executions.delete(benchmarkId))
  return true
}

export function isBenchmarkExecuting(benchmarkId: number): boolean { return executions.has(benchmarkId) }

export function benchmarkProgress(samples: BenchmarkSampleRow[]) {
  return { requested: samples.length, succeeded: samples.filter(row => row.status === 'succeeded').length, failed: samples.filter(row => row.status === 'failed').length, pending: samples.filter(row => row.status === 'pending').length, running: samples.filter(row => row.status === 'running').length }
}

export function benchmarkResumeState(benchmark: BenchmarkRow, samples: BenchmarkSampleRow[], now = new Date()) {
  const anchor = benchmark.lastProgressAt || benchmark.startedAt || benchmark.createdAt
  const interrupted = benchmark.status === 'running' && now.getTime() - anchor.getTime() > BENCHMARK_STALE_AFTER_MS && !isBenchmarkExecuting(benchmark.id)
  const unsucceeded = samples.some(row => row.status !== 'succeeded')
  const resumable = unsucceeded && (['queued', 'partial', 'failed'].includes(benchmark.status) || interrupted)
  return { interrupted, resumable }
}

export async function resumeBenchmark(ownerUserId: number, benchmarkId: number, deps: BenchmarkRuntimeDependencies = {}) {
  const repository = deps.repository || createDrizzleVisibilityBenchmarkRepository()
  const loaded = await repository.getBenchmark(ownerUserId, benchmarkId)
  if (!loaded) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark。')
  const now = (deps.clock || (() => new Date()))()
  const state = benchmarkResumeState(loaded.benchmark, loaded.samples, now)
  if (loaded.benchmark.status === 'running' && !state.interrupted) throw new VisibilityContractError(409, 'benchmark_already_running')
  if (!state.resumable) throw new VisibilityContractError(409, '此 benchmark 沒有可續跑的樣本。')
  startBenchmarkInBackground(ownerUserId, benchmarkId, deps)
  return { benchmarkId, status: loaded.benchmark.status, resumed: true }
}

export async function listBenchmarks(ownerUserId: number, projectId: number, deps: BenchmarkRuntimeDependencies = {}) {
  const repository = deps.repository || createDrizzleVisibilityBenchmarkRepository()
  const context = await repository.loadProjectContext(ownerUserId, projectId)
  if (!context) throw new VisibilityContractError(404, '找不到此 owner 的 LLM visibility project。')
  return (await repository.listBenchmarks(ownerUserId, projectId, 50)).map(({ benchmark, samples }) => ({ ...benchmark, progress: benchmarkProgress(samples), ...benchmarkResumeState(benchmark, samples, (deps.clock || (() => new Date()))()) }))
}

export async function getBenchmarkDetail(ownerUserId: number, benchmarkId: number, deps: BenchmarkRuntimeDependencies = {}) {
  const repository = deps.repository || createDrizzleVisibilityBenchmarkRepository()
  const loaded = await repository.getBenchmark(ownerUserId, benchmarkId)
  if (!loaded) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark。')
  const context = await repository.loadProjectContext(ownerUserId, loaded.benchmark.projectId)
  if (!context) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark project。')
  let aggregate = null
  if (['completed', 'partial', 'failed'].includes(loaded.benchmark.status)) {
    aggregate = computeBenchmarkAggregate({ benchmark: loaded.benchmark, samples: loaded.samples, observations: await repository.loadSucceededObservations(ownerUserId, benchmarkId), competitorSnapshot: loaded.benchmark.competitorSnapshot, brandName: loaded.benchmark.brandName, brandDomain: loaded.benchmark.measuredDomain })
  }
  return { ...loaded.benchmark, samples: loaded.samples, progress: benchmarkProgress(loaded.samples), ...benchmarkResumeState(loaded.benchmark, loaded.samples, (deps.clock || (() => new Date()))()), aggregateSnapshot: loaded.benchmark.aggregateSnapshot, aggregate }
}

type RateEstimate = { rate: number, n: number, confidenceInterval: { lower: number, upper: number } } | null
function comparison(left: RateEstimate, right: RateEstimate, leftN: number, rightN: number) {
  const comparable = leftN >= 2 && rightN >= 2 && left !== null && right !== null
  return {
    left,
    right,
    delta: comparable ? right!.rate - left!.rate : null,
    intervalsOverlap: comparable ? left!.confidenceInterval.lower <= right!.confidenceInterval.upper && right!.confidenceInterval.lower <= left!.confidenceInterval.upper : null,
    comparable,
    limitations: comparable ? [] : [...(leftN === 0 || rightN === 0 ? ['insufficient_sample'] : []), 'single_sample_not_trend'],
  }
}

export async function compareBenchmarks(ownerUserId: number, leftId: number, rightId: number, deps: BenchmarkRuntimeDependencies = {}) {
  const repository = deps.repository || createDrizzleVisibilityBenchmarkRepository()
  const [leftLoaded, rightLoaded] = await Promise.all([repository.getBenchmark(ownerUserId, leftId), repository.getBenchmark(ownerUserId, rightId)])
  if (!leftLoaded || !rightLoaded) throw new VisibilityContractError(404, '找不到此 owner 的 benchmark。')
  if (leftLoaded.benchmark.projectId !== rightLoaded.benchmark.projectId) throw new VisibilityContractError(422, '比較的 benchmark 必須屬於同一個 project。')
  const left = leftLoaded.benchmark.aggregateSnapshot as any
  const right = rightLoaded.benchmark.aggregateSnapshot as any
  if (!left || !right) throw new VisibilityContractError(409, '兩個 benchmark 都必須先完成 aggregate。')
  const sharedQueries = Object.keys(leftLoaded.benchmark.promptVersionIds).filter(queryId => rightLoaded.benchmark.promptVersionIds[queryId] !== undefined)
  const promptMismatch = sharedQueries.some(queryId => leftLoaded.benchmark.promptVersionIds[queryId] !== rightLoaded.benchmark.promptVersionIds[queryId])
  const limitations = [...(left.n === 0 || right.n === 0 ? ['insufficient_sample'] : []), ...(left.n < 2 || right.n < 2 ? ['single_sample_not_trend'] : []), ...(promptMismatch ? ['prompt_version_mismatch'] : [])]
  return {
    projectId: leftLoaded.benchmark.projectId,
    leftBenchmarkId: leftId,
    rightBenchmarkId: rightId,
    left: { benchmarkId: leftId, brandName: leftLoaded.benchmark.brandName, measuredDomain: leftLoaded.benchmark.measuredDomain },
    right: { benchmarkId: rightId, brandName: rightLoaded.benchmark.brandName, measuredDomain: rightLoaded.benchmark.measuredDomain },
    n: { left: left.n, right: right.n },
    metrics: {
      brandMentionRate: comparison(left.estimates.brandMentionRate, right.estimates.brandMentionRate, left.n, right.n),
      citationRate: comparison(left.estimates.citationRate, right.estimates.citationRate, left.n, right.n),
      exactCitationRate: comparison(left.estimates.exactCitationRate, right.estimates.exactCitationRate, left.n, right.n),
    },
    limitations,
  }
}
