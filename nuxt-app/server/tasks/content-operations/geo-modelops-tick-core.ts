import { createModelOpsCycle, evaluateModelOpsShadow, executeModelOpsCycle } from '../../geo-outcome-model/modelops-service'
import type { ModelOpsCycleStatus, ModelOpsDependencies, ModelOpsPolicy } from '../../geo-outcome-model/modelops-types'

export const MAX_OWNERS_PER_TICK = 25
export const MAX_TRAINING_EXECUTIONS_PER_TICK = 5
const ACTIVE_CYCLE_STATUSES: readonly ModelOpsCycleStatus[] = ['planned', 'running', 'retry_wait']

type TickRecord = Record<string, unknown>

function cadenceBucket(date: Date, cadence: ModelOpsPolicy['cadence']): string {
  const day = Math.floor(date.getTime() / 86_400_000)
  const size = cadence === 'weekly' ? 7 : cadence === 'biweekly' ? 14 : 30
  return String(Math.floor(day / size))
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return /(timeout|deadlock|connection|temporarily unavailable|retryable)/u.test(message)
}

function enabledPolicy(policies: ModelOpsPolicy[], at: Date): { policy: ModelOpsPolicy | null, ambiguous: boolean } {
  const enabled = policies.filter(policy => policy.status === 'enabled' && (!policy.expiresAt || new Date(policy.expiresAt).getTime() > at.getTime())).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  return { policy: enabled.length === 1 ? enabled[0]! : null, ambiguous: enabled.length > 1 }
}

async function hasTrainingWork(ownerUserId: number, policy: ModelOpsPolicy, outcomeRepository: ModelOpsDependencies['outcomeRepository']): Promise<boolean> {
  const decisions = await outcomeRepository.listDatasetDecisions(ownerUserId)
  const datasets = (await outcomeRepository.listDatasets(ownerUserId)).filter(dataset => dataset.status === 'approved' && decisions.some(decision => decision.manifestId === dataset.manifestId && decision.manifestFingerprint === dataset.manifestFingerprint && decision.newStatus === 'approved')).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const dataset = datasets.at(-1)
  if (!dataset) return false
  const family = policy.allowedModelFamilies[0]
  const runs = await outcomeRepository.listTrainingRuns(ownerUserId)
  const run = runs.filter(item => item.datasetManifestId === dataset.manifestId && item.modelFamily === family).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  return !run || run.status === 'queued' || run.status === 'running'
}

function cooldownActive(cycle: { createdAt: string } | undefined, policy: ModelOpsPolicy, at: Date): boolean {
  return Boolean(cycle && policy.cooldownHours > 0 && new Date(cycle.createdAt).getTime() + policy.cooldownHours * 3_600_000 > at.getTime())
}

async function processOwner(ownerUserId: number, dependencies: ModelOpsDependencies, at: Date, leaseOwner: string, trainingExecutions: number): Promise<{ records: TickRecord[], trainingExecutionsDelta: number }> {
  const { outcomeRepository, modelOpsRepository } = dependencies
  const policies = await modelOpsRepository.listPolicies(ownerUserId)
  const selection = enabledPolicy(policies, at)
  if (selection.ambiguous) return { records: [{ ownerUserId, status: 'blocked', reason: 'multiple_enabled_policies' }], trainingExecutionsDelta: 0 }
  const policy = selection.policy
  if (!policy) return { records: [{ ownerUserId, status: 'blocked', reason: 'policy_expired_or_missing' }], trainingExecutionsDelta: 0 }
  const cycles = (await modelOpsRepository.listCycles(ownerUserId)).filter(cycle => ACTIVE_CYCLE_STATUSES.includes(cycle.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (cycles.length > 1) return { records: [{ ownerUserId, status: 'blocked', reason: 'multiple_active_cycles' }], trainingExecutionsDelta: 0 }
  const allCycles = await modelOpsRepository.listCycles(ownerUserId)
  const latestCycle = allCycles.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
  const needsTraining = await hasTrainingWork(ownerUserId, policy, outcomeRepository)
  if (!cycles.length && cooldownActive(latestCycle, policy, at)) return { records: [{ ownerUserId, status: 'deferred', reason: 'policy_cooldown_active' }], trainingExecutionsDelta: 0 }
  if (needsTraining && trainingExecutions >= MAX_TRAINING_EXECUTIONS_PER_TICK) return { records: [{ ownerUserId, status: 'deferred', reason: 'training_execution_budget_exhausted' }], trainingExecutionsDelta: 0 }
  const cycle = cycles[0] || await createModelOpsCycle(ownerUserId, 'scheduled', `scheduled-${ownerUserId}-${policy.policyId}-${cadenceBucket(at, policy.cadence)}`, outcomeRepository, modelOpsRepository, at)
  const result = await executeModelOpsCycle(ownerUserId, cycle.cycleId, outcomeRepository, modelOpsRepository, leaseOwner, at)
  const completedTraining = Boolean(result.trainingRun && ['completed', 'failed', 'blocked'].includes(result.trainingRun.status))
  const records: TickRecord[] = [{ ownerUserId, cycleId: result.cycle.cycleId, status: result.cycle.status, trainingRunId: result.trainingRun?.trainingRunId || null, trainingStatus: result.trainingRun?.status || null, artifactId: result.artifact?.artifactId || null }]
  if (policy.shadowEvaluationEnabled) {
    const artifacts = (await outcomeRepository.listArtifacts(ownerUserId)).filter(artifact => artifact.status === 'approved_for_shadow').sort((a, b) => a.artifactId.localeCompare(b.artifactId))
    const artifact = artifacts.at(-1)
    if (artifact) {
      const evaluation = await evaluateModelOpsShadow(ownerUserId, artifact.artifactId, outcomeRepository, modelOpsRepository, at)
      records.push({ ownerUserId, artifactId: artifact.artifactId, shadowEvaluationId: evaluation.evaluationId, shadowStatus: evaluation.status })
    }
  }
  return { records, trainingExecutionsDelta: completedTraining ? 1 : 0 }
}

export async function runGeoModelOpsTick(dependencies: ModelOpsDependencies, at = new Date(), leaseOwner = `geo-modelops-tick-${process.pid}`) {
  const { modelOpsRepository } = dependencies
  const ownerUserIds = await modelOpsRepository.listEnabledOwnerUserIds(MAX_OWNERS_PER_TICK)
  const processed: TickRecord[] = []
  let trainingExecutions = 0
  for (const ownerUserId of ownerUserIds) {
    try {
      const result = await processOwner(ownerUserId, dependencies, at, leaseOwner, trainingExecutions)
      processed.push(...result.records)
      trainingExecutions += result.trainingExecutionsDelta
    } catch (error) {
      processed.push({ ownerUserId, status: isRetryable(error) ? 'retry_wait' : 'blocked', reason: isRetryable(error) ? 'retryable_database_failure' : 'fail_closed_owner_error' })
    }
  }
  return { ownersConsidered: ownerUserIds.length, maxOwnersPerTick: MAX_OWNERS_PER_TICK, trainingExecutions, maxTrainingExecutionsPerTick: MAX_TRAINING_EXECUTIONS_PER_TICK, processed, durableAuthority: 'database_policies_cycles_events_leases', writes: true, productionActive: false }
}
