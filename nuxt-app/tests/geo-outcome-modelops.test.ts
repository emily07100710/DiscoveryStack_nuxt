import { beforeAll, describe, expect, it } from 'vitest'
import { buildCitationSelectionDataset, createModelArtifact, normalizeTrustedObservation, reviewDataset, reviewModel, type ModelArtifact, type OutcomeObservation } from '../server/geo-outcome-model'
import { createModelOpsCycle, createModelOpsPolicy, dryRunModelOpsCycle, evaluateModelOpsShadow, executeModelOpsCycle, rollbackModelOpsArtifact } from '../server/geo-outcome-model/modelops-service'
import { createMemoryModelOpsRepository, InMemoryModelOpsRepository } from '../server/geo-outcome-model/modelops-memory-repository'
import { createMemoryGeoOutcomeRepository, InMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import { sha256Hex } from '../server/geo-outcome-model/canonical'
import type { MemoryGeoOutcomeRepository, MemoryGeoOutcomeState } from '../server/geo-outcome-model/types'

const OWNER = 42
const OTHER_OWNER = 43
const hash = (value: string) => sha256Hex(value)

function rawObservation(index: number, citationStatus: 'cited' | 'not_cited', overrides: Record<string, unknown> = {}) {
  const group = String(overrides.group || `group-${index}`)
  const website = String(overrides.website || `site-${index}`)
  const day = Number(overrides.day || index + 1)
  const date = new Date(Date.UTC(2025, 0, day)).toISOString()
  const engine = overrides.engine || (index % 3 === 0 ? 'chatgpt' : index % 3 === 1 ? 'gemini' : 'perplexity')
  const page = String(overrides.page || `${group}-${citationStatus}-${index}`)
  return {
    schemaVersion: 'geo-outcome-observation-v1', projectId: null, clientId: null,
    websiteIdentityHash: hash(website), queryIdentityHash: hash(group), normalizedQueryHash: hash(group),
    candidatePageIdentityHash: hash(page), canonicalPageHash: hash(`canonical-${website}`), contentHash: hash(`content-${page}`), evidenceSnapshotHash: hash(`evidence-${group}`), publicationReceiptFingerprint: hash(`receipt-${page}`),
    engine, model: 'test-model', modelVersion: 'v1', interface: overrides.interface || 'consumer_surface', locale: 'en', region: 'US', runIdentity: String(overrides.runIdentity || `run-${group}`), runTimestamp: date,
    observationWindow: { start: date, end: new Date(Date.UTC(2025, 0, day, 1)).toISOString() }, observableStatus: 'observable', retrievalStatus: 'retrieved', citationStatus,
    citationPosition: citationStatus === 'cited' ? 1 : null, mentionStatus: citationStatus === 'cited' ? 'mentioned' : 'not_mentioned', recommendationStatus: 'unknown',
    labelBasis: overrides.labelBasis || 'manual_verified_primary', verificationStatus: 'verified', evidenceLocatorHashes: [hash(`locator-${group}`)], appliedRuleHashes: [],
    contentFeatureVector: { contentType: 'article', locale: 'en', pageAgeBucket: '8_30d', contentLengthBucket: citationStatus === 'cited' ? 'l' : 's', headingHierarchy: citationStatus === 'cited' ? 'structured' : 'flat', directAnswerPresence: citationStatus === 'cited' ? 'present' : 'absent', faqStructure: 'absent', structuredDataPresence: citationStatus === 'cited' ? 'present' : 'absent', citationMarkerCount: citationStatus === 'cited' ? 3 : 0, approvedAuthoritySourceCount: citationStatus === 'cited' ? 2 : 0, evidenceUtilizationRatio: citationStatus === 'cited' ? .8 : .1, entityCoverage: citationStatus === 'cited' ? .8 : .1, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'valid', indexabilityFlag: 'indexable', internalLinkDepthBucket: '1', contentFreshnessBucket: 'fresh', queryPageLexicalOverlap: citationStatus === 'cited' ? .8 : .1, topicClusterEqual: 'yes', verifiedPublicationAgeDays: 10, priorObservationCount: 1 },
  }
}

function trustedObservation(index: number, citationStatus: 'cited' | 'not_cited', ownerUserId = OWNER, overrides: Record<string, unknown> = {}): OutcomeObservation {
  return normalizeTrustedObservation(rawObservation(index, citationStatus, overrides), ownerUserId)
}
function pair(index: number, ownerUserId = OWNER, overrides: Record<string, unknown> = {}): OutcomeObservation[] {
  return [trustedObservation(index, 'cited', ownerUserId, overrides), trustedObservation(index, 'not_cited', ownerUserId, { ...overrides, page: `${String(overrides.group || `group-${index}`)}-negative-${index}` })]
}
function invertedPair(index: number, ownerUserId = OWNER): OutcomeObservation[] {
  const group = `inverted-group-${index}`
  const positive = rawObservation(index, 'cited', { group, website: `inverted-site-${index}` })
  const negative = rawObservation(index, 'not_cited', { group, website: `inverted-site-${index}`, page: `${group}-negative` })
  const positiveFeatures = structuredClone(positive.contentFeatureVector)
  positive.contentFeatureVector = structuredClone(negative.contentFeatureVector)
  negative.contentFeatureVector = positiveFeatures
  return [normalizeTrustedObservation(positive, ownerUserId), normalizeTrustedObservation(negative, ownerUserId)]
}
async function seedObservations(repo: MemoryGeoOutcomeRepository, rows: OutcomeObservation[]) { for (const row of rows) await repo.saveObservationTransactional(row.ownerUserId, row) }
function policyInput(overrides: Record<string, unknown> = {}) { return { cadence: 'weekly', minimumNewVerifiedCandidates: 200, minimumNewQueryGroups: 30, minimumNewWebsites: 5, minimumObservationSpanDays: 14, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 168, shadowEvaluationEnabled: true, expiresAt: null, ...overrides } }

async function createCycleFor(ownerUserId: number, outcomeRepository: MemoryGeoOutcomeRepository, modelOpsRepository: InMemoryModelOpsRepository, idempotencyKey: string, trigger: 'owner_manual' | 'scheduled' = 'owner_manual') {
  return createModelOpsCycle(ownerUserId, trigger, idempotencyKey, outcomeRepository, modelOpsRepository, new Date('2026-08-28T00:00:00.000Z'))
}

let approvedState: MemoryGeoOutcomeState
let trainedState: MemoryGeoOutcomeState
let trainedArtifactId = ''

beforeAll(async () => {
  const outcome = createMemoryGeoOutcomeRepository()
  const modelOps = createMemoryModelOpsRepository()
  await seedObservations(outcome, Array.from({ length: 500 }, (_, index) => pair(index + 1)).flat())
  await createModelOpsPolicy(OWNER, policyInput(), 'approved-fixture-policy', modelOps)
  const firstCycle = await createCycleFor(OWNER, outcome, modelOps, 'approved-fixture-cycle')
  const firstResult = await executeModelOpsCycle(OWNER, firstCycle.cycleId, outcome, modelOps, 'fixture-worker', new Date('2026-08-28T00:00:00.000Z'))
  expect(firstResult.dataset?.status).toBe('ready_for_review')
  await reviewDataset(OWNER, firstResult.dataset!.manifestId, 'approve', OWNER, 'Owner approved fixture dataset for direct ModelOps behavior tests.', outcome)
  approvedState = outcome.exportState()
  const trainingCycle = await createCycleFor(OWNER, outcome, modelOps, 'approved-fixture-training-cycle')
  const trainingResult = await executeModelOpsCycle(OWNER, trainingCycle.cycleId, outcome, modelOps, 'fixture-worker-2', new Date('2026-08-28T00:00:00.000Z'))
  expect(trainingResult.trainingRun?.status).toBe('completed')
  expect(trainingResult.artifact?.status).toBe('ready_for_owner_review')
  trainedArtifactId = trainingResult.artifact!.artifactId
  trainedState = outcome.exportState()
  const trainedArtifact = trainingResult.artifact!
  const rollbackTarget = createModelArtifact({ ownerUserId: OWNER, taskType: trainedArtifact.taskType, modelFamily: trainedArtifact.modelFamily, datasetManifestFingerprint: hash('rollback-dataset'), splitManifestFingerprint: hash('rollback-split'), parameters: { coefficients: trainedArtifact.coefficients, intercept: trainedArtifact.intercept, normalizationStatistics: trainedArtifact.normalizationStatistics, trainingRowCount: trainedArtifact.trainingRowCount, featureKeys: trainedArtifact.coefficients.map((_, index) => `feature_${index}`), trainingConfiguration: trainedArtifact.trainingConfiguration }, evaluationMetrics: trainedArtifact.evaluationMetrics })
  rollbackTarget.status = 'approved_for_shadow'
  trainedState.artifacts.push(rollbackTarget)
})

describe('ModelOps policy and durable cycle behavior', () => {
  it('defaults paused, isolates owners, and requires owner-derived enable', async () => {
    const repo = createMemoryModelOpsRepository()
    const policy = await createModelOpsPolicy(OWNER, policyInput({ minimumNewVerifiedCandidates: 1 }), 'policy-paused-1', repo)
    expect(policy.status).toBe('paused')
    expect(await repo.getPolicy(OTHER_OWNER, policy.policyId)).toBeNull()
    await expect(repo.updatePolicy(OTHER_OWNER, policy.policyId, { status: 'enabled', authorizedByOwnerUserId: OTHER_OWNER, authorizedAt: new Date().toISOString() })).rejects.toThrow(/not found|scope/i)
    const enabled = await repo.updatePolicy(OWNER, policy.policyId, { status: 'enabled', authorizedByOwnerUserId: OWNER, authorizedAt: new Date().toISOString() })
    expect(enabled.status).toBe('enabled')
  })

  it('supports idempotent policy replay/collision and terminal revoke', async () => {
    const repo = createMemoryModelOpsRepository()
    const first = await createModelOpsPolicy(OWNER, policyInput(), 'policy-replay-1', repo)
    const replay = await createModelOpsPolicy(OWNER, policyInput(), 'policy-replay-1', repo)
    expect(replay.policyId).toBe(first.policyId)
    await expect(createModelOpsPolicy(OWNER, policyInput({ cooldownHours: 2 }), 'policy-replay-1', repo)).rejects.toThrow(/collision/i)
    await repo.updatePolicy(OWNER, first.policyId, { status: 'revoked', revokedAt: new Date().toISOString() })
    await expect(repo.updatePolicy(OWNER, first.policyId, { status: 'enabled', authorizedByOwnerUserId: OWNER, authorizedAt: new Date().toISOString() })).rejects.toThrow(/terminal/i)
    expect((await repo.listPolicies(OWNER)).find(item => item.policyId === first.policyId)?.status).toBe('revoked')
  })

  it('fails closed for expired policy and recovers one stale cycle lease winner', async () => {
    const outcome = createMemoryGeoOutcomeRepository()
    const repo = createMemoryModelOpsRepository()
    await expect(createModelOpsPolicy(OWNER, policyInput({ expiresAt: '2020-01-01T00:00:00.000Z' }), 'expired-policy-1', repo)).rejects.toThrow(/future/i)
    await createModelOpsPolicy(OWNER, policyInput({ minimumNewVerifiedCandidates: 1 }), 'lease-policy-1', repo)
    const cycle = await createCycleFor(OWNER, outcome, repo, 'lease-cycle-1')
    await repo.claimCycle(OWNER, cycle.cycleId, 'stale-worker', new Date(Date.now() - 1000).toISOString())
    const claims = await Promise.all([repo.claimCycle(OWNER, cycle.cycleId, 'winner-a', new Date(Date.now() + 60_000).toISOString()), repo.claimCycle(OWNER, cycle.cycleId, 'winner-b', new Date(Date.now() + 60_000).toISOString())])
    expect(claims.filter(item => item.outcome === 'stale_recovered')).toHaveLength(1)
    expect(claims.filter(item => item.outcome === 'in_progress')).toHaveLength(1)
  })

  it('records insufficient data without creating an empty dataset and dry-run writes nothing', async () => {
    const outcome = createMemoryGeoOutcomeRepository()
    const repo = createMemoryModelOpsRepository()
    await seedObservations(outcome, pair(1))
    await createModelOpsPolicy(OWNER, policyInput({ minimumNewVerifiedCandidates: 200 }), 'small-policy-1', repo)
    const beforeOutcome = outcome.exportState(); const beforeOps = repo.exportState()
    const plan = await dryRunModelOpsCycle(OWNER, 'dry_run', outcome, repo)
    expect(plan.wouldCreateDataset).toBe(false)
    expect(outcome.exportState()).toEqual(beforeOutcome)
    expect(repo.exportState()).toEqual(beforeOps)
    const cycle = await createCycleFor(OWNER, outcome, repo, 'small-cycle-1')
    const result = await executeModelOpsCycle(OWNER, cycle.cycleId, outcome, repo, 'small-worker')
    expect(result.cycle.status).toBe('insufficient_data')
    expect(await outcome.listDatasets(OWNER)).toHaveLength(0)
  })

  it('keeps provider-secondary and revoked governance facts out of primary dataset candidates', async () => {
    const positive = trustedObservation(1, 'cited')
    const negative = trustedObservation(1, 'not_cited', OWNER, { page: 'negative-1' })
    const provider = trustedObservation(2, 'cited', OWNER, { interface: 'provider_api', labelBasis: 'provider_api_secondary_only' })
    const revoked = trustedObservation(3, 'cited', OWNER, { verificationStatus: 'revoked' })
    const built = buildCitationSelectionDataset([positive, negative, provider, revoked], OWNER)
    expect(built.members.map(item => item.observation.observationFingerprint)).not.toContain(provider.observationFingerprint)
    expect(built.members.map(item => item.observation.observationFingerprint)).not.toContain(revoked.observationFingerprint)
    expect(built.manifest.sourceBasisCounts.provider_api_secondary_only).toBeUndefined()
  })
})

describe('approved dataset training and artifact boundary', () => {
  it('trains only after durable dataset approval, reuses one run, and never auto-approves artifact', async () => {
    const outcome = createMemoryGeoOutcomeRepository(approvedState)
    const repo = createMemoryModelOpsRepository()
    await createModelOpsPolicy(OWNER, policyInput(), 'train-policy-1', repo)
    const cycle = await createCycleFor(OWNER, outcome, repo, 'train-cycle-1')
    const result = await executeModelOpsCycle(OWNER, cycle.cycleId, outcome, repo, 'train-worker')
    expect(result.trainingRun?.status).toBe('completed')
    expect(result.artifact?.status).toBe('ready_for_owner_review')
    expect(result.artifact?.status).not.toBe('approved_for_shadow')
    expect(result.artifact?.trainingRowCount).toBe(result.dataset?.trainRowCount)
    const replayCycle = await createCycleFor(OWNER, outcome, repo, 'train-cycle-2')
    const replay = await executeModelOpsCycle(OWNER, replayCycle.cycleId, outcome, repo, 'train-worker-2')
    expect((await outcome.listTrainingRuns(OWNER)).filter(run => run.datasetManifestId === result.dataset!.manifestId)).toHaveLength(1)
    expect(replay.trainingRun?.trainingRunId).toBe(result.trainingRun?.trainingRunId)
  })

  it('does not leave an artifact when injected artifact persistence fails', async () => {
    class FailingArtifactRepository extends InMemoryGeoOutcomeRepository { override async saveArtifactTransactional(): Promise<never> { throw new Error('injected artifact persistence failure') } }
    const outcome = new FailingArtifactRepository(approvedState)
    const repo = createMemoryModelOpsRepository()
    await createModelOpsPolicy(OWNER, policyInput(), 'failure-policy-1', repo)
    const cycle = await createCycleFor(OWNER, outcome, repo, 'failure-cycle-1')
    const result = await executeModelOpsCycle(OWNER, cycle.cycleId, outcome, repo, 'failure-worker')
    expect(result.trainingRun?.status).toBe('failed')
    expect(await outcome.listArtifacts(OWNER)).toHaveLength(0)
    expect(result.cycle.errorClass).toBe('training_failed')
  })

  it('preserves train/holdout lineage and allows only explicit owner shadow approval', async () => {
    const outcome = createMemoryGeoOutcomeRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    await createModelOpsPolicy(OWNER, policyInput(), 'shadow-policy-1', repo)
    const artifact = await outcome.getArtifact(OWNER, trainedArtifactId)
    expect(artifact?.trainingRowCount).toBeGreaterThan(0)
    expect(artifact?.status).toBe('ready_for_owner_review')
    const reviewed = await reviewModel(OWNER, trainedArtifactId, 'approve_for_shadow', OWNER, 'Owner explicitly approved artifact for shadow evaluation.', outcome)
    expect(reviewed.artifact.status).toBe('approved_for_shadow')
  })
})

describe('shadow safety and owner rollback', () => {
  it('uses only new observations, returns null metrics for 0/0, and records insufficient_data', async () => {
    const outcome = createMemoryGeoOutcomeRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    const artifact = await reviewModel(OWNER, trainedArtifactId, 'approve_for_shadow', OWNER, 'Owner approved shadow test artifact.', outcome)
    const trainingDataset = (await outcome.listDatasets(OWNER)).find(item => item.manifestFingerprint === artifact.artifact.datasetManifestHash)
    await seedObservations(outcome, pair(700))
    const evaluation = await evaluateModelOpsShadow(OWNER, trainedArtifactId, outcome, repo, new Date('2026-08-28T00:00:00.000Z'))
    expect(evaluation.observationFingerprints.every(item => !trainingDataset!.sourceObservationFingerprints.includes(item))).toBe(true)
    expect(evaluation.status).toBe('insufficient_data')
    expect((evaluation.binaryMetrics.test as { f1: number | null }).f1).toBeNull()
    expect(evaluation.reasonCodes).toContain('insufficient_data')
  })

  it('flags zero prediction class as owner attention without automatic rollback', async () => {
    const outcome = createMemoryGeoOutcomeRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    const source = await outcome.getArtifact(OWNER, trainedArtifactId)
    const zeroArtifact = createModelArtifact({ ownerUserId: OWNER, taskType: source!.taskType, modelFamily: source!.modelFamily, datasetManifestFingerprint: source!.datasetManifestFingerprint, splitManifestFingerprint: source!.splitManifestFingerprint, parameters: { coefficients: source!.coefficients.map(() => 0), intercept: 0, normalizationStatistics: source!.normalizationStatistics, trainingRowCount: source!.trainingRowCount, featureKeys: source!.coefficients.map((_, index) => `feature_${index}`), trainingConfiguration: source!.trainingConfiguration }, evaluationMetrics: source!.evaluationMetrics })
    await outcome.saveArtifactTransactional(OWNER, zeroArtifact)
    await reviewModel(OWNER, zeroArtifact.artifactId, 'approve_for_shadow', OWNER, 'Owner approved zero-class shadow test.', outcome)
    await seedObservations(outcome, Array.from({ length: 20 }, (_, index) => pair(800 + index)).flat())
    const evaluation = await evaluateModelOpsShadow(OWNER, zeroArtifact.artifactId, outcome, repo, new Date('2026-08-28T00:00:00.000Z'))
    expect(evaluation.reasonCodes).toContain('zero_prediction_class')
    expect(evaluation.status).toBe('needs_owner_attention')
    expect((await outcome.getArtifact(OWNER, zeroArtifact.artifactId))?.status).toBe('shadow_failed')
    expect(await repo.listRollbackDecisions(OWNER)).toHaveLength(0)
  })

  it('recovers a severe shadow evaluation when the artifact status write fails once', async () => {
    class FailOnceShadowStatusRepository extends InMemoryGeoOutcomeRepository {
      private failed = false
      override async markArtifactShadowFailed(ownerUserId: number, artifactId: string) {
        if (!this.failed) { this.failed = true; throw new Error('injected shadow status persistence failure') }
        return super.markArtifactShadowFailed(ownerUserId, artifactId)
      }
    }
    const outcome = new FailOnceShadowStatusRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    const source = await outcome.getArtifact(OWNER, trainedArtifactId)
    const zeroArtifact = createModelArtifact({ ownerUserId: OWNER, taskType: source!.taskType, modelFamily: source!.modelFamily, datasetManifestFingerprint: source!.datasetManifestFingerprint, splitManifestFingerprint: source!.splitManifestFingerprint, parameters: { coefficients: source!.coefficients.map(() => 0), intercept: 0, normalizationStatistics: source!.normalizationStatistics, trainingRowCount: source!.trainingRowCount, featureKeys: source!.coefficients.map((_, index) => `feature_${index}`), trainingConfiguration: source!.trainingConfiguration }, evaluationMetrics: source!.evaluationMetrics })
    await outcome.saveArtifactTransactional(OWNER, zeroArtifact)
    await reviewModel(OWNER, zeroArtifact.artifactId, 'approve_for_shadow', OWNER, 'Owner approved retryable shadow status test.', outcome)
    await seedObservations(outcome, Array.from({ length: 20 }, (_, index) => pair(1_100 + index)).flat())
    const at = new Date('2030-01-01T00:00:00.000Z')

    await expect(evaluateModelOpsShadow(OWNER, zeroArtifact.artifactId, outcome, repo, at)).rejects.toThrow(/injected shadow status/i)
    expect(await repo.listShadowEvaluations(OWNER, zeroArtifact.artifactId)).toHaveLength(1)
    expect((await outcome.getArtifact(OWNER, zeroArtifact.artifactId))?.status).toBe('approved_for_shadow')

    const recovered = await evaluateModelOpsShadow(OWNER, zeroArtifact.artifactId, outcome, repo, at)
    expect(recovered.status).toBe('needs_owner_attention')
    expect(await repo.listShadowEvaluations(OWNER, zeroArtifact.artifactId)).toHaveLength(1)
    expect((await outcome.getArtifact(OWNER, zeroArtifact.artifactId))?.status).toBe('shadow_failed')
  })

  it('reads the prior nested test F1 and blocks a severe shadow regression', async () => {
    const outcome = createMemoryGeoOutcomeRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    const reviewed = await reviewModel(OWNER, trainedArtifactId, 'approve_for_shadow', OWNER, 'Owner approved regression detection shadow test.', outcome)
    const priorFingerprint = hash('prior-shadow-evaluation')
    await repo.saveShadowEvaluation(OWNER, {
      evaluationId: `geo-modelops-shadow-${priorFingerprint.slice(0, 24)}`,
      ownerUserId: OWNER,
      artifactId: trainedArtifactId,
      artifactHash: reviewed.artifact.artifactHash,
      evaluationWindowStart: '2027-01-01T00:00:00.000Z',
      evaluationWindowEnd: '2027-02-01T00:00:00.000Z',
      observationFingerprints: [],
      candidateCount: 500,
      positiveCount: 250,
      negativeCount: 250,
      queryGroupCount: 250,
      websiteCount: 250,
      engineCounts: { 'chatgpt:consumer_surface': 500 },
      binaryMetrics: { test: { f1: 1 } },
      rankingMetrics: {},
      calibrationDiagnostics: {},
      driftDiagnostics: {},
      status: 'completed',
      reasonCodes: [],
      evaluationFingerprint: priorFingerprint,
      createdAt: '2027-02-01T00:00:00.000Z',
    })
    await seedObservations(outcome, Array.from({ length: 250 }, (_, index) => invertedPair(1_500 + index)).flat())

    const evaluation = await evaluateModelOpsShadow(OWNER, trainedArtifactId, outcome, repo, new Date('2031-01-01T00:00:00.000Z'))

    expect(evaluation.reasonCodes).toContain('metrics_regression_or_drift')
    expect(evaluation.reasonCodes).not.toContain('zero_prediction_class')
    expect(evaluation.status).toBe('needs_owner_attention')
    expect((evaluation.driftDiagnostics as { previousTestF1: number }).previousTestF1).toBe(1)
    expect((await outcome.getArtifact(OWNER, trainedArtifactId))?.status).toBe('shadow_failed')
  })

  it('requires a compatible owner rollback decision and keeps decision append-only', async () => {
    const outcome = createMemoryGeoOutcomeRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    await reviewModel(OWNER, trainedArtifactId, 'approve_for_shadow', OWNER, 'Owner approved rollback source artifact.', outcome)
    const artifact = await outcome.getArtifact(OWNER, trainedArtifactId)
    await expect(rollbackModelOpsArtifact(OWNER, trainedArtifactId, hash('not-a-compatible-artifact'), 'Owner requested rollback after review.', outcome, repo)).rejects.toThrow(/rollback artifact/i)
    expect(await repo.listRollbackDecisions(OWNER)).toHaveLength(0)
    expect(artifact?.status).toBe('approved_for_shadow')
    const rollbackTarget = (await outcome.listArtifacts(OWNER)).find(item => item.status === 'approved_for_shadow' && item.artifactId !== trainedArtifactId)!
    const valid = await rollbackModelOpsArtifact(OWNER, trainedArtifactId, rollbackTarget.artifactHash, 'Owner explicitly confirmed compatible rollback after shadow review.', outcome, repo)
    expect(valid.decision.decisionStatus).toBe('approved')
    expect((await outcome.getArtifact(OWNER, trainedArtifactId))?.status).toBe('revoked')
    expect((await repo.listRollbackDecisions(OWNER))).toHaveLength(1)
  })

  it('recovers rollback after the model revoke write fails without duplicating its decision ledger', async () => {
    class FailOnceRollbackRepository extends InMemoryGeoOutcomeRepository {
      private failed = false
      override async transitionArtifactWithDecision(ownerUserId: number, artifactId: string, nextStatus: ModelArtifact['status'], reviewerUserId: number, reason: string, datasetManifestHash: string, rollbackArtifactHash: string | null = null) {
        if (nextStatus === 'revoked' && !this.failed) { this.failed = true; throw new Error('injected rollback persistence failure') }
        return super.transitionArtifactWithDecision(ownerUserId, artifactId, nextStatus, reviewerUserId, reason, datasetManifestHash, rollbackArtifactHash)
      }
    }
    const outcome = new FailOnceRollbackRepository(trainedState)
    const repo = createMemoryModelOpsRepository()
    await reviewModel(OWNER, trainedArtifactId, 'approve_for_shadow', OWNER, 'Owner approved retryable rollback source artifact.', outcome)
    const rollbackTarget = (await outcome.listArtifacts(OWNER)).find(item => item.status === 'approved_for_shadow' && item.artifactId !== trainedArtifactId)!
    const reason = 'Owner explicitly confirmed retryable rollback after shadow review.'

    await expect(rollbackModelOpsArtifact(OWNER, trainedArtifactId, rollbackTarget.artifactHash, reason, outcome, repo)).rejects.toThrow(/injected rollback persistence/i)
    expect(await repo.listRollbackDecisions(OWNER)).toHaveLength(1)
    expect((await outcome.getArtifact(OWNER, trainedArtifactId))?.status).toBe('approved_for_shadow')

    const recovered = await rollbackModelOpsArtifact(OWNER, trainedArtifactId, rollbackTarget.artifactHash, reason, outcome, repo)
    expect(recovered.revokedArtifact.status).toBe('revoked')
    expect(await repo.listRollbackDecisions(OWNER)).toHaveLength(1)
  })
})
