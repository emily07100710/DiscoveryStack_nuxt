import { describe, expect, it, vi } from 'vitest'
import { normalizedPromptHash } from '../server/llm-visibility/guards'
import { createInMemoryVisibilityBenchmarkRepository, type BenchmarkRow, type BenchmarkSampleRow } from '../server/llm-visibility/benchmark-repository'
import { BENCHMARK_STALE_AFTER_MS, benchmarkResumeState, compareBenchmarks, createBenchmark, executeBenchmark, getBenchmarkDetail, listBenchmarks, resumeBenchmark } from '../server/llm-visibility/benchmark-runtime'
import type { VisibilityProbeAdapter } from '../server/llm-visibility-probes'

const project = { id: 10, ownerUserId: 7, name: 'Monitor', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en' as const, brandName: 'Acme', brandAliases: ['Acme Inc'], competitorBrands: ['Legacy Rival'], status: 'active' as const }
const query = { id: 20, ownerUserId: 7, projectId: 10, promptText: 'Which product is best?', promptHash: normalizedPromptHash('Which product is best?'), intent: 'comparison', locale: 'en' as const, active: true }
const target = { provider: 'chatgpt' as const, modelLabel: 'gpt-test', adapterKey: 'mock-openai', allowedLocales: ['en' as const], maximumResponseBytes: 120_000, timeoutMs: 120_000 }
const fixedClock = () => new Date('2026-09-02T00:01:00.000Z')

function repository() { return createInMemoryVisibilityBenchmarkRepository({ projects: [project], queries: [query] }) }
function adapter(result: (call: number, input: Parameters<VisibilityProbeAdapter['execute']>[0]) => Awaited<ReturnType<VisibilityProbeAdapter['execute']>>) {
  let calls = 0
  const value: VisibilityProbeAdapter = { adapterKey: target.adapterKey, provider: target.provider, modelLabel: target.modelLabel, execute: vi.fn(async input => result(++calls, input)) }
  return value
}
const success = () => ({ ok: true as const, provider: target.provider, modelLabel: target.modelLabel, responseText: 'Acme is cited. Legacy Rival is another choice.', citationUrls: ['https://example.com/2025/01/02/report'], observedAt: '2026-09-02T00:00:00.000Z' })
const create = (repo: ReturnType<typeof repository>, sampleSize = 5, environment: Record<string, string | undefined> = {}) => createBenchmark(7, { projectId: 10, queryIds: [20], providerTargets: [target], sampleSize }, { repository: repo, environment })

describe('LLM visibility benchmark runtime', () => {
  it('plans five distinct samples, persists five observations, and snapshots the live aggregate', async () => {
    const repo = repository(); const provider = adapter(() => success())
    const created = await create(repo)
    const pending = (await repo.getBenchmark(7, created.benchmarkId))!.samples
    expect(pending).toHaveLength(5)
    expect(new Set(pending.map(row => row.requestFingerprint)).size).toBe(5)
    const executed = await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: provider }, sleep: async () => {}, clock: fixedClock })
    expect(executed).toMatchObject({ status: 'completed', aggregate: { n: 5 } })
    expect(executed.aggregate?.estimates.brandMentionRate?.confidenceInterval).toMatchObject({ level: 0.95 })
    expect(repo.state.runs).toHaveLength(5)
    expect(repo.state.observations).toHaveLength(5)
    expect(repo.state.observations.every(row => row.promptVersionId)).toBe(true)
    expect(repo.state.benchmarks[0]?.aggregateSnapshot).toEqual(executed.aggregate)
    const storedSnapshot = structuredClone(repo.state.benchmarks[0]!.aggregateSnapshot)
    Object.assign(repo.state.projects[0]!, { canonicalDomain: 'changed.example.org', brandName: 'Changed Brand', brandAliases: ['Changed Alias'] })
    const detail = await getBenchmarkDetail(7, created.benchmarkId, { repository: repo, clock: fixedClock })
    expect(detail).toMatchObject({ brandName: 'Acme', measuredDomain: 'example.com' })
    expect(detail.aggregate).toEqual(storedSnapshot)
  })

  it.each([[3, 'partial', 'partial_sample'], [1, 'partial', 'single_sample_not_trend'], [0, 'failed', 'insufficient_sample']] as const)('finishes honestly with %i of five successes', async (succeed, status, limitation) => {
    const repo = repository(); const sampleOrder = new Map<string, number>()
    const provider = adapter((_call, input) => {
      if (!sampleOrder.has(input.probeIdentity.requestFingerprint)) sampleOrder.set(input.probeIdentity.requestFingerprint, sampleOrder.size + 1)
      return sampleOrder.get(input.probeIdentity.requestFingerprint)! <= succeed ? success() : { ok: false as const, failureKind: 'network_unavailable' as const, retryable: true, code: 'OFFLINE' }
    })
    const created = await create(repo)
    const result = await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: provider }, sleep: async () => {}, clock: fixedClock })
    expect(result.status).toBe(status)
    expect(result.aggregate?.n).toBe(succeed)
    expect(result.aggregate?.limitations).toContain(limitation)
    if (succeed < 5) expect(result.aggregate?.failureCodes).toContainEqual({ code: 'NETWORK_UNAVAILABLE_RETRYABLE', count: 5 - succeed })
  })

  it('never re-executes succeeded rows and reconciles an existing fingerprint', async () => {
    const repo = repository(); const first = adapter(() => success())
    const created = await create(repo, 2)
    await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: first }, sleep: async () => {}, clock: fixedClock })
    const loaded = (await repo.getBenchmark(7, created.benchmarkId))!
    const firstSample = loaded.samples[0]!; const secondSample = loaded.samples[1]!
    await repo.updateSample(7, secondSample.id, { status: 'failed', runId: null, observationId: null })
    loaded.benchmark.status = 'partial'; repo.state.benchmarks[0]!.status = 'partial'
    const resumeAdapter = adapter(() => success())
    await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: resumeAdapter }, sleep: async () => {}, clock: fixedClock })
    expect(resumeAdapter.execute).not.toHaveBeenCalled()
    const resumed = (await repo.getBenchmark(7, created.benchmarkId))!.samples
    expect(resumed.find(row => row.id === firstSample.id)?.status).toBe('succeeded')
    expect(resumed.find(row => row.id === secondSample.id)).toMatchObject({ status: 'succeeded', runId: secondSample.runId, observationId: secondSample.observationId })
  })

  it('resumes an old benchmark with its frozen brand and domain after the project changes', async () => {
    const repo = repository(); const sampleOrder = new Map<string, number>()
    const first = adapter((_call, input) => {
      if (!sampleOrder.has(input.probeIdentity.requestFingerprint)) sampleOrder.set(input.probeIdentity.requestFingerprint, sampleOrder.size + 1)
      return sampleOrder.get(input.probeIdentity.requestFingerprint) === 1 ? success() : { ok: false as const, failureKind: 'network_unavailable' as const, retryable: true, code: 'OFFLINE' }
    })
    const created = await create(repo, 2)
    await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: first }, sleep: async () => {}, clock: fixedClock })
    const failedSample = (await repo.getBenchmark(7, created.benchmarkId))!.samples.find(row => row.status === 'failed')!
    Object.assign(repo.state.projects[0]!, { canonicalDomain: 'new.example.org', brandName: 'New Brand', brandAliases: ['New Alias'] })
    const resumedProvider = adapter(() => success())
    await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: resumedProvider }, sleep: async () => {}, clock: fixedClock })
    expect(resumedProvider.execute).toHaveBeenCalledTimes(1)
    const resumedRun = repo.state.runs.find(row => row.sampleIndex === failedSample.sampleIndex)!
    const resumedObservation = repo.state.observations.find(row => row.runId === resumedRun.id)!
    expect(resumedRun.requestFingerprint).toBe(failedSample.requestFingerprint)
    expect(resumedObservation).toMatchObject({ brandMentioned: true, citedDomain: 'example.com' })
  })

  it('freezes the changed project identity into a newly created benchmark and list output', async () => {
    const repo = repository()
    Object.assign(repo.state.projects[0]!, { canonicalDomain: 'new.example.org', brandName: 'New Brand', brandAliases: ['New Alias'] })
    const created = await create(repo, 1)
    expect(repo.state.benchmarks.find(row => row.id === created.benchmarkId)).toMatchObject({ brandName: 'New Brand', brandAliases: ['New Alias'], measuredDomain: 'new.example.org' })
    expect(await listBenchmarks(7, 10, { repository: repo, clock: fixedClock })).toEqual([
      expect.objectContaining({ id: created.benchmarkId, brandName: 'New Brand', measuredDomain: 'new.example.org' }),
    ])
  })

  it('detects stale running benchmarks but keeps fresh ones non-resumable', () => {
    const base = new Date('2026-09-02T00:00:00Z')
    const benchmark = { id: 1, status: 'running', createdAt: base, startedAt: base, lastProgressAt: base } as BenchmarkRow
    const samples = [{ status: 'running' }] as BenchmarkSampleRow[]
    expect(benchmarkResumeState(benchmark, samples, new Date(base.getTime() + BENCHMARK_STALE_AFTER_MS + 60_000))).toMatchObject({ interrupted: true, resumable: true })
    expect(benchmarkResumeState(benchmark, samples, new Date(base.getTime() + 60_000))).toMatchObject({ interrupted: false, resumable: false })
  })

  it('returns benchmark_already_running for a fresh running benchmark', async () => {
    const repo = repository(); const created = await create(repo, 1)
    const row = repo.state.benchmarks[0]!
    row.status = 'running'; row.startedAt = fixedClock(); row.lastProgressAt = fixedClock()
    await expect(resumeBenchmark(7, created.benchmarkId, { repository: repo, clock: fixedClock })).rejects.toMatchObject({ statusCode: 409, message: 'benchmark_already_running' })
  })

  it('enforces the default and overridden total-probe caps without truncation', async () => {
    const repo = repository()
    const twelveTargets = Array.from({ length: 12 }, (_, index) => ({ ...target, modelLabel: `model-${index}`, adapterKey: `adapter-${index}` }))
    await expect(createBenchmark(7, { projectId: 10, queryIds: [20], providerTargets: twelveTargets, sampleSize: 10 }, { repository: repo, environment: { LLM_VISIBILITY_BENCHMARK_MAX_PROBES: '100' } })).rejects.toMatchObject({ statusCode: 422 })
    const created = await create(repository(), 5, { LLM_VISIBILITY_BENCHMARK_MAX_PROBES: 'invalid' })
    expect(created.requestedSamples).toBe(5)
  })

  it('rejects duplicate provider/model targets with 422 before persistence', async () => {
    const repo = repository()
    await expect(createBenchmark(7, { projectId: 10, queryIds: [20], providerTargets: [target, { ...target, adapterKey: 'second-adapter' }], sampleSize: 1 }, { repository: repo })).rejects.toMatchObject({ statusCode: 422, message: 'providerTargets 的 provider 與 modelLabel 組合不可重複。' })
    expect(repo.state.benchmarks).toHaveLength(0)
  })

  it('bounds retryable failures to three attempts per sample execution', async () => {
    const repo = repository(); const provider = adapter(() => ({ ok: false, failureKind: 'network_unavailable', retryable: true, code: 'OFFLINE' }))
    const created = await create(repo, 1)
    await executeBenchmark(7, created.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: provider }, sleep: async () => {}, clock: fixedClock })
    expect(provider.execute).toHaveBeenCalledTimes(3)
    expect((await repo.getBenchmark(7, created.benchmarkId))!.samples[0]).toMatchObject({ attempts: 3, status: 'failed' })
  })

  it('compares completed aggregates and marks prompt-version mismatches', async () => {
    const repo = repository(); const provider = adapter(() => success())
    const left = await create(repo, 2); await executeBenchmark(7, left.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: provider }, sleep: async () => {}, clock: fixedClock })
    const right = await create(repo, 2); await executeBenchmark(7, right.benchmarkId, { repository: repo, adapters: { [target.adapterKey]: provider }, sleep: async () => {}, clock: fixedClock })
    repo.state.benchmarks.find(row => row.id === right.benchmarkId)!.promptVersionIds['20'] = 999
    const result = await compareBenchmarks(7, left.benchmarkId, right.benchmarkId, { repository: repo })
    expect(result.metrics.brandMentionRate).toMatchObject({ comparable: true, delta: 0, intervalsOverlap: true })
    expect(result).toMatchObject({ left: { brandName: 'Acme', measuredDomain: 'example.com' }, right: { brandName: 'Acme', measuredDomain: 'example.com' } })
    expect(result.limitations).toContain('prompt_version_mismatch')
  })
})
