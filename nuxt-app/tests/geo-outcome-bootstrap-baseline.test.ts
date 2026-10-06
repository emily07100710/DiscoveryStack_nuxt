import { beforeAll, describe, expect, it } from 'vitest'
import { approveBootstrapFallback, createBootstrapFallback, createModelArtifact, createTrainingRun, executeTrainingRun, isExactTrainOnlyPriorArtifact, isFallbackOnlyArtifact, predict, reviewModel, trainTrainOnlyPrevalencePrior, evaluatePromotionGate, getShadowReadiness, type DatasetManifest, type DatasetMember, type ModelArtifact } from '../server/geo-outcome-model'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import { trustedState } from './support/modelops-fixtures'

const OWNER = 42
let approvedState: Awaited<ReturnType<typeof trustedState>>
let manifestId = ''

beforeAll(async () => {
  approvedState = await trustedState()
  manifestId = approvedState.datasets[0]!.manifestId
})

function freshRepo() { return createMemoryGeoOutcomeRepository(approvedState) }

describe('citation bootstrap fallback', () => {
  it('creates and owner-approves a distinct train-only prior for either supported family', async () => {
    const repo = freshRepo()
    for (const modelFamily of ['regularized_logistic_baseline_v1', 'pairwise_logistic_ranker_v1'] as const) {
      const fallback = await createBootstrapFallback(OWNER, manifestId, modelFamily, repo)
      expect(fallback.modelVersion).toBe('geo-outcome-train-prior-v1')
      expect(fallback.role).toBe('fallback')
      expect(fallback.fallbackOnly).toBe(true)
      expect(fallback.productionActivation).toBe(false)
      expect(fallback.status).toBe('ready_for_owner_review')
      const reviewed = await approveBootstrapFallback(OWNER, fallback.artifactId, OWNER, 'Approve fixed train-only fallback.', repo)
      expect(reviewed.artifact.status).toBe('approved_for_shadow')
      expect(reviewed.ledger.reviewerUserId).toBe(OWNER)
      expect(reviewed.artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/u)
    }
  })

  it('only lets a candidate bind and use a fallback that was already durably approved', async () => {
    const repo = freshRepo()
    const beforeFallback = await createTrainingRun(OWNER, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, repo)
    const unbackedRun = await executeTrainingRun(OWNER, beforeFallback.trainingRunId, repo)
    expect(unbackedRun.status).toBe('completed')
    const unbackedArtifact = await repo.getArtifact(OWNER, unbackedRun.artifactId!)
    expect(unbackedArtifact?.rollbackArtifactHash).toBeNull()

    const fallback = await createBootstrapFallback(OWNER, manifestId, 'regularized_logistic_baseline_v1', repo)
    await approveBootstrapFallback(OWNER, fallback.artifactId, OWNER, 'Approve fixed train-only fallback.', repo)
    await expect(reviewModel(OWNER, unbackedArtifact!.artifactId, 'approve_for_shadow', OWNER, 'Approve candidate for shadow.', repo)).rejects.toThrow(/rollback_artifact_missing_or_invalid/i)

    const backedRun = await createTrainingRun(OWNER, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, repo)
    expect(backedRun.trainingRunId).not.toBe(beforeFallback.trainingRunId)
    const completed = await executeTrainingRun(OWNER, backedRun.trainingRunId, repo)
    const candidate = await repo.getArtifact(OWNER, completed.artifactId!)
    expect(candidate?.rollbackArtifactHash).toBe(fallback.artifactHash)
    expect(candidate?.artifactHash).not.toBe(fallback.artifactHash)
    const approved = await reviewModel(OWNER, candidate!.artifactId, 'approve_for_shadow', OWNER, 'Approve candidate for shadow.', repo)
    expect(approved.artifact.status).toBe('approved_for_shadow')
    expect(approved.artifact.role).toBe('candidate')
    await expect(predict(OWNER, fallback.artifactId, {}, repo)).rejects.toThrow(/fallback-only/i)
  })

  it('does not grant the bootstrap gate exception to a forged prior-version artifact with a valid new hash', async () => {
    const repo = freshRepo()
    const fallback = await createBootstrapFallback(OWNER, manifestId, 'regularized_logistic_baseline_v1', repo)
    const dataset = (await repo.listDatasets(OWNER)).find(item => item.manifestId === manifestId) as DatasetManifest
    const members = await repo.getDatasetMembers(OWNER, manifestId)
    const real = await repo.getArtifact(OWNER, fallback.artifactId) as ModelArtifact
    const trainRows = members.filter(member => member.splitAssignment === 'train')
    const prior = trainTrainOnlyPrevalencePrior(trainRows, { epochs: 1, learningRate: 0.1, l2: 0, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' })
    const forged = createModelArtifact({ ownerUserId: OWNER, taskType: dataset.taskType, modelFamily: real.modelFamily, modelVersion: 'geo-outcome-train-prior-v1', datasetManifestFingerprint: dataset.manifestFingerprint, splitManifestFingerprint: real.splitManifestFingerprint, parameters: { ...prior, coefficients: prior.coefficients.map((value, index) => value + (index === 0 ? 0.01 : 0)) }, evaluationMetrics: real.evaluationMetrics })
    expect(forged.artifactHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(isFallbackOnlyArtifact(forged)).toBe(true)
    expect(isExactTrainOnlyPriorArtifact(forged, dataset, members)).toBe(false)
    const span = dataset.observationStart && dataset.observationEnd ? Math.floor((Date.parse(dataset.observationEnd) - Date.parse(dataset.observationStart)) / 86_400_000) : null
    const gate = evaluatePromotionGate({ dataset, members: members as DatasetMember[], artifact: forged, ownerApproved: true, rollbackArtifact: null, target: 'shadow', shadowReadiness: getShadowReadiness({ candidates: dataset.sourceObservationFingerprints.length, queryGroups: dataset.queryGroupCount, websites: dataset.websiteCount, engines: Object.keys(dataset.engineCounts).length, positives: dataset.positiveCount, hardNegatives: dataset.hardNegativeCount, observationSpanDays: span, temporalHoldoutCount: dataset.temporalHoldoutRowCount, hasPrimaryEvidence: true }) })
    expect(gate.status).toBe('blocked')
    expect(gate.reasonCodes).toContain('rollback_artifact_missing_or_invalid')
  })
})
