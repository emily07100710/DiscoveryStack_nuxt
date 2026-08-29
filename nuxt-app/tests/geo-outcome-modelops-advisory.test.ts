import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { assignModelOpsAdvisory, rollbackModelOpsAdvisory } from '../server/geo-outcome-model/modelops-advisory'
import { createMemoryModelOpsRepository } from '../server/geo-outcome-model/modelops-memory-repository'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import type { GeoOutcomeRepositoryPort, ModelArtifact } from '../server/geo-outcome-model/types'
import type { MemoryModelOpsState, ModelOpsCycle, ModelOpsPolicy, ModelOpsShadowEvaluation } from '../server/geo-outcome-model/modelops-types'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const now = '2026-08-25T04:00:00.000Z'
const dataset = { manifestId: 'dataset-1', manifestFingerprint: hash('dataset'), trainRowCount: 1, validationRowCount: 0, testRowCount: 0, siteHoldoutRowCount: 0, queryHoldoutRowCount: 0, temporalHoldoutRowCount: 0, trainFingerprints: [hash('train')], validationFingerprints: [], testFingerprints: [], siteHoldoutFingerprints: [], queryHoldoutFingerprints: [], temporalHoldoutFingerprints: [] }
const candidate = { artifactId: 'candidate-1', artifactHash: hash('candidate'), status: 'approved_for_shadow', datasetManifestFingerprint: dataset.manifestFingerprint, taskType: 'citation_selection', modelFamily: 'regularized_logistic_baseline_v1', featureCatalogVersion: 'geo-outcome-feature-catalog-v1', labelContractVersion: 'geo-outcome-label-contract-v1' } as unknown as ModelArtifact
const current = { ...candidate, artifactId: 'current-1', artifactHash: hash('current') } as ModelArtifact
const policy: ModelOpsPolicy = { policyId: 'policy-advisory', ownerUserId: 1, status: 'enabled', cadence: 'weekly', minimumNewVerifiedCandidates: 1, minimumNewQueryGroups: 1, minimumNewWebsites: 1, minimumObservationSpanDays: 1, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 1, shadowEvaluationEnabled: true, autonomousExecutionEnabled: true, authorizedByOwnerUserId: 1, authorizedAt: now, expiresAt: '2026-12-31T00:00:00.000Z', configurationFingerprint: hash('policy'), createdAt: now, updatedAt: now, revokedAt: null }
const evaluation = (status: ModelOpsShadowEvaluation['status'], reasonCodes: string[] = []): ModelOpsShadowEvaluation => ({ evaluationId: 'shadow-1', ownerUserId: 1, artifactId: candidate.artifactId, artifactHash: candidate.artifactHash, evaluationWindowStart: now, evaluationWindowEnd: '2026-08-26T04:00:00.000Z', observationFingerprints: [hash('observation')], candidateCount: 1, positiveCount: 1, negativeCount: 1, queryGroupCount: 1, websiteCount: 1, engineCounts: { mock: 1 }, binaryMetrics: { testF1: 0.8 }, rankingMetrics: {}, calibrationDiagnostics: {}, driftDiagnostics: {}, status, reasonCodes, evaluationFingerprint: hash(`shadow:${status}:${reasonCodes.join(',')}`), createdAt: now })
const cycle = (shadow: ModelOpsShadowEvaluation): ModelOpsCycle => ({ cycleId: 'cycle-advisory-1', ownerUserId: 1, policyId: policy.policyId, policyFingerprint: policy.configurationFingerprint, trigger: 'scheduled', status: 'running', readinessSnapshotFingerprint: hash('readiness'), eligibleObservationFingerprints: [], previousApprovedDatasetFingerprint: null, generatedDatasetFingerprint: dataset.manifestFingerprint, trainingRunId: 'training-1', modelArtifactId: candidate.artifactId, artifactHash: candidate.artifactHash, shadowEvaluationFingerprint: shadow.evaluationFingerprint, reasonCodes: [], limitations: [], errorClass: null, startedAt: now, completedAt: null, attempt: 1, leaseOwner: 'worker-1', leaseExpiresAt: '2026-08-25T05:00:00.000Z', leaseVersion: 1, idempotencyKey: 'advisory-cycle-key', inputFingerprint: hash('cycle-input'), createdAt: now, updatedAt: now })
const state = (shadow: ModelOpsShadowEvaluation): MemoryModelOpsState => ({ policies: [policy], cycles: [cycle(shadow)], events: [], shadowEvaluations: [shadow], rollbackDecisions: [], advisoryAssignments: [] })
const advisoryInput = () => ({ ownerUserId: 1, policyId: policy.policyId, cycleId: 'cycle-advisory-1', candidateArtifactId: candidate.artifactId, currentArtifactHash: current.artifactHash, now: new Date(now) })
const outcomeRepository = () => ({
  getArtifact: async (_ownerUserId: number, artifactId: string) => artifactId === candidate.artifactId ? structuredClone(candidate) : null,
  listArtifacts: async () => [structuredClone(current), structuredClone(candidate)],
  listDatasets: async () => [structuredClone(dataset)],
  getDatasetMembers: async () => [{ memberFingerprint: hash('member') }],
} as unknown as GeoOutcomeRepositoryPort)

describe('ModelOps advisory assignment', () => {
  it('rebuilds durable dataset, split, and metrics fingerprints and preserves CAS rollback lineage', async () => {
    const shadow = evaluation('completed')
    const repository = createMemoryModelOpsRepository(state(shadow))
    const forged = { ...advisoryInput(), datasetFingerprint: hash('forged-dataset'), splitFingerprint: hash('forged-split'), metricsFingerprint: hash('forged-metrics') }
    const assigned = await assignModelOpsAdvisory(forged, outcomeRepository(), repository)
    const expectedSplit = fingerprint({ train: dataset.trainFingerprints, validation: [], test: [], siteHoldout: [], queryHoldout: [], temporalHoldout: [] })
    const expectedMetrics = fingerprint({ binaryMetrics: shadow.binaryMetrics, rankingMetrics: shadow.rankingMetrics, calibrationDiagnostics: shadow.calibrationDiagnostics, driftDiagnostics: shadow.driftDiagnostics })
    expect(assigned.status).toBe('advisory')
    expect(assigned).toMatchObject({ productionActivation: false, cycleId: cycle(shadow).cycleId, candidateArtifactId: candidate.artifactId, datasetFingerprint: dataset.manifestFingerprint, splitFingerprint: expectedSplit, metricsFingerprint: expectedMetrics })
    expect(assigned.datasetFingerprint).not.toBe(forged.datasetFingerprint)
    const rolledBack = await rollbackModelOpsAdvisory({ ownerUserId: 1, assignmentId: assigned.assignmentId, expectedVersion: 1, now: new Date('2026-08-27T04:00:00.000Z') }, repository)
    expect(rolledBack).toMatchObject({ status: 'rolled_back', version: 2, rollbackFromAssignmentId: assigned.assignmentId, activeScopeKey: null })
    await expect(rollbackModelOpsAdvisory({ ownerUserId: 1, assignmentId: assigned.assignmentId, expectedVersion: 1 }, repository)).rejects.toThrow(/active advisory/i)
  })

  it('stops on shadow degradation and creates no assignment', async () => {
    const shadow = evaluation('needs_owner_attention', ['metrics_regression_or_drift'])
    const repository = createMemoryModelOpsRepository(state(shadow))
    await expect(assignModelOpsAdvisory(advisoryInput(), outcomeRepository(), repository)).rejects.toThrow(/degraded/i)
    expect(await repository.listAdvisoryAssignments(1)).toEqual([])
  })
})
