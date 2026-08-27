import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createModelOpsCycle, createModelOpsPolicy, executeModelOpsCycle } from '../server/geo-outcome-model/modelops-service'
import { createMemoryModelOpsRepository } from '../server/geo-outcome-model/modelops-memory-repository'
import { MAX_OWNERS_PER_TICK, runGeoModelOpsTick } from '../server/tasks/content-operations/geo-modelops-tick-core'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import type { MemoryGeoOutcomeState } from '../server/geo-outcome-model/types'
import { trustedState } from './support/modelops-fixtures'

const POLICY = { cadence: 'weekly', minimumNewVerifiedCandidates: 200, minimumNewQueryGroups: 30, minimumNewWebsites: 5, minimumObservationSpanDays: 14, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 168, shadowEvaluationEnabled: false, expiresAt: null }

function remapOwner<T>(value: T, ownerUserId: number): T {
  const clone = structuredClone(value) as unknown
  const visit = (node: unknown): unknown => { if (Array.isArray(node)) return node.map(visit); if (!node || typeof node !== 'object') return node; const record = node as Record<string, unknown>; for (const [key, item] of Object.entries(record)) record[key] = key === 'ownerUserId' ? ownerUserId : visit(item); return record }
  return visit(clone) as T
}

function combinedState(source: MemoryGeoOutcomeState, ownerIds: number[]): MemoryGeoOutcomeState {
  const empty: MemoryGeoOutcomeState = { observations: [], datasets: [], datasetMembers: {}, trainingRuns: [], artifacts: [], datasetDecisions: [], decisions: [], verificationDecisions: [], evidenceBindings: [], authoritativeEvidenceSources: [], claims: [] }
  for (const ownerUserId of ownerIds) {
    const state = remapOwner(source, ownerUserId)
    empty.observations.push(...state.observations); empty.datasets.push(...state.datasets); empty.trainingRuns.push(...state.trainingRuns); empty.artifacts.push(...state.artifacts); empty.datasetDecisions.push(...state.datasetDecisions); empty.decisions.push(...state.decisions); empty.verificationDecisions.push(...state.verificationDecisions); empty.evidenceBindings.push(...state.evidenceBindings); empty.authoritativeEvidenceSources.push(...state.authoritativeEvidenceSources); empty.claims.push(...state.claims); Object.assign(empty.datasetMembers, state.datasetMembers)
  }
  return empty
}

describe('content-operations:geo-modelops-tick', () => {
  let sourceState: MemoryGeoOutcomeState
  beforeAll(async () => { sourceState = await trustedState() })

  it('has exact Nitro task identity and processes at most 25 owners in stable order', async () => {
    const modelOps = createMemoryModelOpsRepository()
    for (let ownerUserId = 1; ownerUserId <= 30; ownerUserId++) {
      const policy = await createModelOpsPolicy(ownerUserId, POLICY, `scheduler-policy-${ownerUserId}`, modelOps)
      await modelOps.updatePolicy(ownerUserId, policy.policyId, { status: 'enabled', authorizedByOwnerUserId: ownerUserId, authorizedAt: new Date('2026-08-28T00:00:00.000Z').toISOString() })
    }
    const outcome = createMemoryGeoOutcomeRepository()
    const result = await runGeoModelOpsTick({ outcomeRepository: outcome, modelOpsRepository: modelOps }, new Date('2026-08-28T00:00:00.000Z'), 'scheduler-test-worker')
    expect(result.ownersConsidered).toBe(25)
    expect(result.maxOwnersPerTick).toBe(25)
    expect(result.processed).toHaveLength(25)
    expect((result.processed[0] as { ownerUserId: number }).ownerUserId).toBe(1)
    expect((result.processed.at(-1) as { ownerUserId: number }).ownerUserId).toBe(25)
    const taskSource = readFileSync(new URL('../server/tasks/content-operations/geo-modelops-tick.ts', import.meta.url), 'utf8')
    expect(taskSource).toContain("name: 'content-operations:geo-modelops-tick'")
    expect(MAX_OWNERS_PER_TICK).toBe(25)
  })

  it('blocks malformed multiple active cycles per owner instead of choosing silently', async () => {
    const modelOps = createMemoryModelOpsRepository()
    const outcome = createMemoryGeoOutcomeRepository()
    const policy = await createModelOpsPolicy(42, { ...POLICY, cooldownHours: 0 }, 'active-cycle-policy', modelOps)
    await modelOps.updatePolicy(42, policy.policyId, { status: 'enabled', authorizedByOwnerUserId: 42, authorizedAt: new Date().toISOString() })
    await createModelOpsCycle(42, 'scheduled', 'active-cycle-a', outcome, modelOps)
    await createModelOpsCycle(42, 'scheduled', 'active-cycle-b', outcome, modelOps)
    const result = await runGeoModelOpsTick({ outcomeRepository: outcome, modelOpsRepository: modelOps }, new Date('2026-08-28T00:00:00.000Z'), 'scheduler-test-worker')
    expect(result.processed).toEqual([{ ownerUserId: 42, status: 'blocked', reason: 'multiple_active_cycles' }])
  })

  it('caps training executions at five and leaves the sixth owner deferred', async () => {
    const ownerIds = [42, 43, 44, 45, 46, 47]
    const outcome = createMemoryGeoOutcomeRepository(combinedState(sourceState, ownerIds))
    const modelOps = createMemoryModelOpsRepository()
    for (const ownerUserId of ownerIds) {
      const policy = await createModelOpsPolicy(ownerUserId, POLICY, `training-budget-policy-${ownerUserId}`, modelOps)
      await modelOps.updatePolicy(ownerUserId, policy.policyId, { status: 'enabled', authorizedByOwnerUserId: ownerUserId, authorizedAt: new Date().toISOString() })
    }
    const result = await runGeoModelOpsTick({ outcomeRepository: outcome, modelOpsRepository: modelOps }, new Date('2026-08-28T00:00:00.000Z'), 'scheduler-budget-worker')
    expect(result.maxTrainingExecutionsPerTick).toBe(5)
    expect(result.trainingExecutions).toBe(5)
    expect(result.processed.some(item => item.ownerUserId === 47 && item.reason === 'training_execution_budget_exhausted')).toBe(true)
  })
})
