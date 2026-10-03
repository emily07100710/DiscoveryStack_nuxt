import { describe, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { createDrizzleVisibilityBenchmarkRepository, createInMemoryVisibilityBenchmarkRepository, type BenchmarkRow } from '../server/llm-visibility/benchmark-repository'
import { BENCHMARK_STALE_AFTER_MS, createBenchmark, executeBenchmark, executeScheduledBenchmark } from '../server/llm-visibility/benchmark-runtime'
import { benchmarkTickProbeBudget, runScheduledBenchmarkTick } from '../server/llm-visibility/benchmark-scheduler'
import { normalizedPromptHash } from '../server/llm-visibility/guards'
import type { VisibilityProbeAdapter } from '../server/llm-visibility-probes'

const now = new Date('2026-10-03T01:00:00.000Z')
const clock = () => new Date(now)
const environment = { LLM_VISIBILITY_BENCHMARK_AUTO_RESUME: 'true' }
const project = { id: 10, ownerUserId: 7, name: 'Monitor', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en' as const, brandName: 'Acme', brandAliases: ['Acme Inc'], competitorBrands: [], status: 'active' as const }
const query = { id: 20, ownerUserId: 7, projectId: 10, promptText: 'Which product is best?', promptHash: normalizedPromptHash('Which product is best?'), intent: 'comparison', locale: 'en' as const, active: true }
const target = { provider: 'chatgpt' as const, modelLabel: 'gpt-test', adapterKey: 'mock-openai', allowedLocales: ['en' as const], maximumResponseBytes: 120_000, timeoutMs: 120_000 }
const success = () => ({ ok: true as const, provider: target.provider, modelLabel: target.modelLabel, responseText: 'Acme is cited.', citationUrls: ['https://example.com/2025/01/02/report'], observedAt: now.toISOString() })
function fixture() {
  const repository = createInMemoryVisibilityBenchmarkRepository({ projects: [project], queries: [query] })
  const adapter: VisibilityProbeAdapter = { adapterKey: target.adapterKey, provider: target.provider, modelLabel: target.modelLabel, execute: vi.fn(async () => success()) }
  const deps = { repository, environment, clock, resolveOwnerUserId: vi.fn(async () => 7), adapters: { [target.adapterKey]: adapter }, sleep: vi.fn(async () => {}) }
  const create = (sampleSize = 1) => createBenchmark(7, { projectId: 10, queryIds: [20], providerTargets: [target], sampleSize }, { repository, environment: {}, clock })
  return { repository, adapter, deps, create }
}
function markStale(row: BenchmarkRow) { row.status = 'running'; row.startedAt = new Date(now.getTime() - BENCHMARK_STALE_AFTER_MS - 1); row.lastProgressAt = row.startedAt }

describe('opt-in bounded benchmark recovery', () => {
  it.each([undefined, 'false', 'TRUE', '1'])('performs zero I/O unless explicitly enabled (%s)', async flag => {
    const resolveOwnerUserId = vi.fn(async () => 7)
    const repositoryFactory = vi.fn(() => { throw new Error('must not construct database repository') })
    expect(await runScheduledBenchmarkTick({ environment: { LLM_VISIBILITY_BENCHMARK_AUTO_RESUME: flag }, resolveOwnerUserId, repositoryFactory })).toEqual({ status: 'disabled', started: 0 })
    expect(resolveOwnerUserId).not.toHaveBeenCalled(); expect(repositoryFactory).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', '1.2', 'invalid', ''])('fails closed before I/O for invalid tick budget %s', async value => {
    const resolveOwnerUserId = vi.fn(async () => 7); const repositoryFactory = vi.fn()
    expect(await runScheduledBenchmarkTick({ environment: { ...environment, LLM_VISIBILITY_BENCHMARK_TICK_MAX_PROBES: value }, resolveOwnerUserId, repositoryFactory })).toEqual({ status: 'invalid_budget', started: 0 })
    expect(resolveOwnerUserId).not.toHaveBeenCalled(); expect(repositoryFactory).not.toHaveBeenCalled()
  })

  it('requires the explicitly configured owner before constructing a repository', async () => {
    const repositoryFactory = vi.fn()
    expect(await runScheduledBenchmarkTick({ environment, repositoryFactory })).toEqual({ status: 'owner_not_configured', started: 0 })
    expect(await runScheduledBenchmarkTick({ environment, repositoryFactory, resolveOwnerUserId: async () => { throw new Error('missing owner') } })).toEqual({ status: 'owner_unavailable', started: 0 })
    expect(await runScheduledBenchmarkTick({ environment, repositoryFactory, resolveOwnerUserId: async () => 0 })).toEqual({ status: 'owner_unavailable', started: 0 })
    expect(repositoryFactory).not.toHaveBeenCalled()
  })

  it('caps the tick budget at five and executes one existing benchmark with one batch', async () => {
    const f = fixture(); const first = await f.create(5); const second = await f.create(1)
    const before = { benchmarks: f.repository.state.benchmarks.length, queries: f.repository.state.queries.length, versions: f.repository.state.promptVersions.length }
    vi.mocked(f.adapter.execute).mockImplementation(async () => {
      // Every outbound intent is durable before its provider call.
      expect(f.repository.state.samples.filter(sample => sample.status === 'running' && sample.attempts === 1).length).toBeGreaterThan(0)
      return success()
    })
    expect(benchmarkTickProbeBudget({})).toBe(5)
    expect(benchmarkTickProbeBudget({ LLM_VISIBILITY_BENCHMARK_TICK_MAX_PROBES: '1000' })).toBe(5)
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ status: 'executed', started: 1, benchmarkId: first.benchmarkId, benchmarkStatus: 'completed', maximumProbes: 5 })
    expect(f.adapter.execute).toHaveBeenCalledTimes(5)
    expect(f.repository.state.benchmarks.find(row => row.id === second.benchmarkId)?.status).toBe('queued')
    expect({ benchmarks: f.repository.state.benchmarks.length, queries: f.repository.state.queries.length, versions: f.repository.state.promptVersions.length }).toEqual(before)
  })

  it('skips an oversized batch without claiming or truncating it and can run the next small one', async () => {
    const f = fixture(); const big = await f.create(6); const small = await f.create(2)
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1, benchmarkId: small.benchmarkId, skipped: 1 })
    expect(f.repository.state.benchmarks.find(row => row.id === big.benchmarkId)?.status).toBe('queued')
    expect(f.repository.state.samples.filter(row => row.benchmarkRunId === big.benchmarkId).every(row => row.status === 'pending' && row.attempts === 0)).toBe(true)
    expect(f.adapter.execute).toHaveBeenCalledTimes(2)
  })

  it('honors a smaller budget and never widens a single explicit execution', async () => {
    const f = fixture(); const created = await f.create(2)
    const claim = vi.spyOn(f.repository, 'claimBenchmarkForAutomaticResume')
    expect(await runScheduledBenchmarkTick({ ...f.deps, environment: { ...environment, LLM_VISIBILITY_BENCHMARK_TICK_MAX_PROBES: '1' } })).toMatchObject({ started: 0, skipped: 1 })
    expect(await executeScheduledBenchmark(7, created.benchmarkId, 6, f.deps)).toEqual({ started: false })
    expect(claim).not.toHaveBeenCalled(); expect(f.adapter.execute).not.toHaveBeenCalled()
  })

  it('does not read or execute another owner’s queued benchmark', async () => {
    const f = fixture(); await f.create()
    const list = vi.spyOn(f.repository, 'listAutomaticResumeCandidates')
    expect(await runScheduledBenchmarkTick({ ...f.deps, resolveOwnerUserId: async () => 8 })).toMatchObject({ status: 'idle', started: 0 })
    expect(list).toHaveBeenCalledWith(8, new Date(now.getTime() - BENCHMARK_STALE_AFTER_MS))
    expect(f.repository.state.benchmarks[0]?.status).toBe('queued'); expect(f.adapter.execute).not.toHaveBeenCalled()
  })

  it.each(['partial', 'failed', 'completed'] as const)('never automatically retries %s even with pending samples', async status => {
    const f = fixture(); const created = await f.create(); f.repository.state.benchmarks[0]!.status = status
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ status: 'idle', started: 0 })
    expect(await executeScheduledBenchmark(7, created.benchmarkId, 5, f.deps)).toEqual({ started: false })
    expect(f.adapter.execute).not.toHaveBeenCalled()
  })

  it('accepts the exact stale boundary and ignores fresh progress with old start/create times', async () => {
    const f = fixture(); await f.create(); const row = f.repository.state.benchmarks[0]!
    markStale(row); row.lastProgressAt = new Date(now.getTime() - BENCHMARK_STALE_AFTER_MS + 1)
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 })
    row.lastProgressAt = new Date(now.getTime() - BENCHMARK_STALE_AFTER_MS)
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1, benchmarkStatus: 'completed' })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['startedAt', 'createdAt'] as const)('uses stale %s only when newer progress is absent', async anchor => {
    const f = fixture(); await f.create(); const row = f.repository.state.benchmarks[0]!
    markStale(row); row.lastProgressAt = null
    if (anchor === 'createdAt') { row.createdAt = row.startedAt!; row.startedAt = null }
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1 })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 'running' as const, attempts: 1, startedAt: now },
    { status: 'pending' as const, attempts: 1, startedAt: null },
    { status: 'running' as const, attempts: 0, startedAt: now },
    { status: 'failed' as const, attempts: 0, startedAt: null },
  ])('does not repeat an uncertain prior sample (%j)', async prior => {
    const f = fixture(); await f.create(2); markStale(f.repository.state.benchmarks[0]!)
    Object.assign(f.repository.state.samples[0]!, prior)
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1, benchmarkStatus: 'partial' })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1)
    expect(f.repository.state.samples[0]).toMatchObject({ status: 'failed', failureCode: 'AUTOMATIC_RESUME_PRIOR_ATTEMPT' })
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1)
  })

  it('reconciles a durable fingerprint after interruption without paying again', async () => {
    const f = fixture(); const created = await f.create()
    await executeBenchmark(7, created.benchmarkId, f.deps)
    vi.mocked(f.adapter.execute).mockClear()
    markStale(f.repository.state.benchmarks[0]!); Object.assign(f.repository.state.samples[0]!, { status: 'running', runId: null, observationId: null })
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1, benchmarkStatus: 'completed' })
    expect(f.adapter.execute).not.toHaveBeenCalled(); expect(f.repository.state.runs).toHaveLength(1)
    expect(f.repository.state.samples[0]).toMatchObject({ status: 'succeeded', runId: 1, observationId: 1 })
  })

  it('executes a retryable failure once, leaves manual retry required, and does not sleep/retry next tick', async () => {
    const f = fixture(); await f.create()
    vi.mocked(f.adapter.execute).mockResolvedValue({ ok: false, failureKind: 'network_unavailable', retryable: true, code: 'OFFLINE' })
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1, benchmarkStatus: 'failed' })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1); expect(f.deps.sleep).not.toHaveBeenCalled()
    expect(f.repository.state.samples[0]?.attempts).toBe(1)
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1)
  })

  it('atomically excludes duplicate simultaneous ticks', async () => {
    const f = fixture(); await f.create()
    const results = await Promise.all([runScheduledBenchmarkTick(f.deps), runScheduledBenchmarkTick(f.deps)])
    expect(results.reduce((sum, result) => sum + result.started, 0)).toBe(1)
    expect(f.adapter.execute).toHaveBeenCalledTimes(1); expect(f.repository.state.runs).toHaveLength(1)
  })

  it('atomically excludes a concurrent manual executor', async () => {
    const f = fixture(); const created = await f.create()
    const [scheduled, manual] = await Promise.all([runScheduledBenchmarkTick(f.deps), executeBenchmark(7, created.benchmarkId, f.deps)])
    expect(scheduled.started + Number(manual.started)).toBe(1)
    expect(f.adapter.execute).toHaveBeenCalledTimes(1); expect(f.repository.state.runs).toHaveLength(1)
  })

  it('does not retry a candidate changed to partial between discovery and claim', async () => {
    const f = fixture(); await f.create()
    const list = f.repository.listAutomaticResumeCandidates.bind(f.repository)
    vi.spyOn(f.repository, 'listAutomaticResumeCandidates').mockImplementation(async (...args) => { const rows = await list(...args); f.repository.state.benchmarks[0]!.status = 'partial'; return rows })
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 })
    expect(f.adapter.execute).not.toHaveBeenCalled(); expect(f.repository.state.benchmarks[0]?.status).toBe('partial')
  })

  it('rejects incomplete or cross-owner candidate samples before claiming', async () => {
    const f = fixture(); await f.create(2)
    const rows = await f.repository.listAutomaticResumeCandidates(7, now)
    rows[0]!.samples[0]!.ownerUserId = 8
    vi.spyOn(f.repository, 'listAutomaticResumeCandidates').mockResolvedValue(rows)
    const claim = vi.spyOn(f.repository, 'claimBenchmarkForAutomaticResume')
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 })
    rows[0]!.samples = []
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 })
    expect(claim).not.toHaveBeenCalled(); expect(f.adapter.execute).not.toHaveBeenCalled()
  })

  it('finalizes execution-level failure without a repeated automatic attempt', async () => {
    const f = fixture(); await f.create(); vi.spyOn(f.repository, 'loadProjectContext').mockRejectedValue(new Error('offline'))
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 1, benchmarkStatus: 'failed' })
    expect(f.repository.state.benchmarks[0]).toMatchObject({ status: 'failed', limitationCodes: ['automatic_resume_failed_manual_retry_required'] })
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ started: 0 }); expect(f.adapter.execute).not.toHaveBeenCalled()
  })

  it('requires an active project and keeps the frozen identity without enabling citation HEAD', async () => {
    const f = fixture(); await f.create()
    Object.assign(f.repository.state.projects[0]!, { brandName: 'Changed', canonicalDomain: 'changed.example.org' })
    const headFetch = { enabled: true, fetchImpl: vi.fn(), resolveDns: vi.fn(), budget: { maxRequests: 100 }, cache: new Map() }
    expect(await runScheduledBenchmarkTick({ ...f.deps, environment: { ...environment, LLM_VISIBILITY_CITATION_HEAD_FETCH: 'true' }, headFetch })).toMatchObject({ benchmarkStatus: 'completed' })
    expect(f.repository.state.observations[0]).toMatchObject({ brandMentioned: true, citedDomain: 'example.com' })
    expect(headFetch.fetchImpl).not.toHaveBeenCalled(); expect(headFetch.resolveDns).not.toHaveBeenCalled()
    await f.create(); f.repository.state.projects[0]!.status = 'archived'
    expect(await runScheduledBenchmarkTick(f.deps)).toMatchObject({ benchmarkStatus: 'failed' })
    expect(f.adapter.execute).toHaveBeenCalledTimes(1)
  })
})

describe('Drizzle automatic benchmark claim contract without a database', () => {
  it('atomically records only one unstarted sample intent across competing automatic workers', async () => {
    const f = fixture(); const created = await f.create(); const sampleId = f.repository.state.samples[0]!.id
    const claims = await Promise.all([f.repository.claimSampleForAutomaticAttempt(7, created.benchmarkId, sampleId, now), f.repository.claimSampleForAutomaticAttempt(7, created.benchmarkId, sampleId, now)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await f.repository.claimSampleForAutomaticAttempt(8, created.benchmarkId, sampleId, now)).toBe(false)
    expect(f.repository.state.samples[0]).toMatchObject({ status: 'running', attempts: 1, startedAt: now })
  })

  it('uses an owner/benchmark-scoped zero-attempt/no-start CAS before any scheduled call', async () => {
    let condition: any
    const database = { update() { return { set(values: any) { expect(values).toMatchObject({ status: 'running', attempts: 1, startedAt: now }); return { where(value: any) { condition = value; return Promise.resolve([{ affectedRows: 1 }]) } } } } } }
    expect(await createDrizzleVisibilityBenchmarkRepository(database).claimSampleForAutomaticAttempt(7, 31, 42, now)).toBe(true)
    const query = new MySqlDialect().sqlToQuery(condition)
    expect(query.params).toEqual(expect.arrayContaining([42, 7, 31, 'pending', 'running', 0]))
    expect(query.sql).toContain('`ownerUserId` = ?'); expect(query.sql).toContain('`benchmarkRunId` = ?')
    expect(query.sql).toContain('`attempts` = ?'); expect(query.sql).toContain('`startedAt` is null')
    expect(query.params).not.toContain('failed')
  })

  it('claims with one owner-scoped queued/stale-running update and never partial/failed', async () => {
    let condition: any; let updates = 0
    const database = { update() { updates++; return { set(values: any) { expect(values).toMatchObject({ status: 'running', lastProgressAt: now }); return { where(value: any) { condition = value; return Promise.resolve([{ affectedRows: updates === 1 ? 1 : 0 }]) } } } } } }
    const repo = createDrizzleVisibilityBenchmarkRepository(database)
    const staleBefore = new Date(now.getTime() - BENCHMARK_STALE_AFTER_MS)
    expect(await repo.claimBenchmarkForAutomaticResume(7, 31, now, staleBefore)).toBe(true)
    expect(await repo.claimBenchmarkForAutomaticResume(7, 31, now, staleBefore)).toBe(false)
    const query = new MySqlDialect().sqlToQuery(condition)
    expect(query.params).toEqual(expect.arrayContaining([31, 7, 'queued', 'running']))
    expect(query.params).not.toContain('partial'); expect(query.params).not.toContain('failed')
    expect(query.sql).toContain('`ownerUserId` = ?'); expect(query.sql).toContain('`lastProgressAt` <= ?')
    expect(query.sql).toContain('`lastProgressAt` is null'); expect(query.sql).toContain('`startedAt` is null'); expect(query.sql).toContain('`createdAt` <= ?')
  })

  it('bounds discovery at ten owner-scoped candidates and performs no sample scan when empty', async () => {
    let condition: any; let scans = 0
    const database = { select() { scans++; const builder = { from() { return builder }, where(value: any) { condition = value; return builder }, orderBy() { return builder }, limit(value: number) { expect(value).toBe(10); return Promise.resolve([]) } }; return builder } }
    expect(await createDrizzleVisibilityBenchmarkRepository(database).listAutomaticResumeCandidates(7, now)).toEqual([])
    expect(scans).toBe(1)
    const query = new MySqlDialect().sqlToQuery(condition)
    expect(query.params).toContain(7); expect(query.params).not.toContain('partial'); expect(query.params).not.toContain('failed')
  })
})
