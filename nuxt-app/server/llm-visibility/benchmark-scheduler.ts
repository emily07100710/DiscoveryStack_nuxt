import { getOwnerDatabaseUserId } from '../audit/repository'
import { createDrizzleVisibilityBenchmarkRepository, isAutomaticResumeCandidate, type VisibilityBenchmarkRepository } from './benchmark-repository'
import { BENCHMARK_SCHEDULED_MAX_PROBES, BENCHMARK_STALE_AFTER_MS, executeScheduledBenchmark, isBenchmarkExecuting, scheduledBenchmarkWithinBudget, type BenchmarkRuntimeDependencies } from './benchmark-runtime'

export type BenchmarkTickDependencies = BenchmarkRuntimeDependencies & {
  resolveOwnerUserId?: () => Promise<number>
  repositoryFactory?: () => VisibilityBenchmarkRepository
}

export function benchmarkTickProbeBudget(environment: Record<string, string | undefined>): number {
  const value = environment.LLM_VISIBILITY_BENCHMARK_TICK_MAX_PROBES
  if (value === undefined) return BENCHMARK_SCHEDULED_MAX_PROBES
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, BENCHMARK_SCHEDULED_MAX_PROBES) : 0
}

export async function runScheduledBenchmarkTick(deps: BenchmarkTickDependencies = {}) {
  const environment = deps.environment || process.env
  // This gate precedes owner resolution, repository construction and all I/O.
  if (environment.LLM_VISIBILITY_BENCHMARK_AUTO_RESUME !== 'true') return { status: 'disabled' as const, started: 0 }
  const maximumProbes = benchmarkTickProbeBudget(environment)
  if (!maximumProbes) return { status: 'invalid_budget' as const, started: 0 }
  if (!deps.resolveOwnerUserId && !environment.OWNER_OPEN_ID?.trim()) return { status: 'owner_not_configured' as const, started: 0 }
  let ownerUserId: number
  try { ownerUserId = await (deps.resolveOwnerUserId || (() => getOwnerDatabaseUserId(environment.OWNER_OPEN_ID!)))() } catch { return { status: 'owner_unavailable' as const, started: 0 } }
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) return { status: 'owner_unavailable' as const, started: 0 }
  const repository = deps.repository || (deps.repositoryFactory || createDrizzleVisibilityBenchmarkRepository)()
  const now = (deps.clock || (() => new Date()))()
  const staleBefore = new Date(now.getTime() - BENCHMARK_STALE_AFTER_MS)
  const candidates = await repository.listAutomaticResumeCandidates(ownerUserId, staleBefore)
  let skipped = 0
  for (const candidate of candidates.slice(0, 10)) {
    if (!isAutomaticResumeCandidate(candidate.benchmark, staleBefore) || isBenchmarkExecuting(candidate.benchmark.id) || !scheduledBenchmarkWithinBudget(ownerUserId, candidate, maximumProbes)) { skipped += 1; continue }
    // A compare-and-set claim is repeated in the runtime, closing both cron/cron
    // and cron/manual races without admitting newly partial/failed benchmarks.
    const result = await executeScheduledBenchmark(ownerUserId, candidate.benchmark.id, maximumProbes, { ...deps, repository })
    if (result.started) return { status: 'executed' as const, started: 1, benchmarkId: candidate.benchmark.id, benchmarkStatus: result.status, maximumProbes, skipped }
    skipped += 1
  }
  return { status: 'idle' as const, started: 0, maximumProbes, skipped }
}
