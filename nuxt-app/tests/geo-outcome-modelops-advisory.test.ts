import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { assignModelOpsAdvisory, rollbackModelOpsAdvisory } from '../server/geo-outcome-model/modelops-advisory'
import { createMemoryModelOpsRepository } from '../server/geo-outcome-model/modelops-memory-repository'
import type { MemoryModelOpsState, ModelOpsPolicy, ModelOpsShadowEvaluation } from '../server/geo-outcome-model/modelops-types'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const now = '2026-08-25T04:00:00.000Z'
const policy: ModelOpsPolicy = { policyId: 'policy-advisory', ownerUserId: 1, status: 'enabled', cadence: 'weekly', minimumNewVerifiedCandidates: 1, minimumNewQueryGroups: 1, minimumNewWebsites: 1, minimumObservationSpanDays: 1, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 1, shadowEvaluationEnabled: true, autonomousExecutionEnabled: true, authorizedByOwnerUserId: 1, authorizedAt: now, expiresAt: '2026-12-31T00:00:00.000Z', configurationFingerprint: hash('policy'), createdAt: now, updatedAt: now, revokedAt: null }
const evaluation = (status: ModelOpsShadowEvaluation['status'], reasonCodes: string[] = []): ModelOpsShadowEvaluation => ({ evaluationId: 'shadow-1', ownerUserId: 1, artifactId: 'candidate-1', artifactHash: hash('candidate'), evaluationWindowStart: now, evaluationWindowEnd: '2026-08-26T04:00:00.000Z', observationFingerprints: [hash('observation')], candidateCount: 1, positiveCount: 1, negativeCount: 1, queryGroupCount: 1, websiteCount: 1, engineCounts: { mock: 1 }, binaryMetrics: { testF1: 0.8 }, rankingMetrics: {}, calibrationDiagnostics: {}, driftDiagnostics: {}, status, reasonCodes, evaluationFingerprint: hash(`shadow:${status}:${reasonCodes.join(',')}`), createdAt: now })
const state = (shadow: ModelOpsShadowEvaluation): MemoryModelOpsState => ({ policies: [policy], cycles: [], events: [], shadowEvaluations: [shadow], rollbackDecisions: [], advisoryAssignments: [] })
const advisoryInput = () => ({ ownerUserId: 1, policyId: policy.policyId, cycleId: 'cycle-advisory-1', candidateArtifactId: 'candidate-1', currentArtifactHash: hash('current'), candidateArtifactHash: hash('candidate'), datasetFingerprint: hash('dataset'), splitFingerprint: hash('split'), metricsFingerprint: hash('metrics'), now: new Date(now) })

describe('ModelOps advisory assignment', () => {
  it('creates only an advisory assignment and preserves CAS rollback lineage', async () => {
    const repository = createMemoryModelOpsRepository(state(evaluation('completed')))
    const assigned = await assignModelOpsAdvisory(advisoryInput(), repository)
    expect(assigned.status).toBe('advisory')
    expect(assigned).toMatchObject({ productionActivation: false, cycleId: 'cycle-advisory-1', candidateArtifactId: 'candidate-1', datasetFingerprint: hash('dataset'), splitFingerprint: hash('split'), metricsFingerprint: hash('metrics') })
    const rolledBack = await rollbackModelOpsAdvisory({ ownerUserId: 1, assignmentId: assigned.assignmentId, expectedVersion: 1, now: new Date('2026-08-27T04:00:00.000Z') }, repository)
    expect(rolledBack).toMatchObject({ status: 'rolled_back', version: 2, rollbackFromAssignmentId: assigned.assignmentId, activeScopeKey: null })
    await expect(rollbackModelOpsAdvisory({ ownerUserId: 1, assignmentId: assigned.assignmentId, expectedVersion: 1 }, repository)).rejects.toThrow(/active advisory/i)
  })

  it('stops on shadow degradation and creates no assignment', async () => {
    const repository = createMemoryModelOpsRepository(state(evaluation('needs_owner_attention', ['metrics_regression_or_drift'])))
    await expect(assignModelOpsAdvisory(advisoryInput(), repository)).rejects.toThrow(/degraded/i)
    expect(await repository.listAdvisoryAssignments(1)).toEqual([])
  })
})
