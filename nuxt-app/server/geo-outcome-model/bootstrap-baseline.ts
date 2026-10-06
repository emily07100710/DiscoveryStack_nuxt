import { GEO_OUTCOME_FEATURE_CATALOG_VERSION, GEO_OUTCOME_LABEL_CONTRACT_VERSION, GEO_OUTCOME_TRAIN_PRIOR_VERSION, type ModelFamily } from './constants'
import { createModelArtifact } from './artifact'
import { evaluateModel } from './evaluator'
import { assertDisjointComplete, splitFingerprint } from './split-policy'
import { trainTrainOnlyPrevalencePrior } from './trainer'
import type { DatasetManifest, DatasetMember, ModelArtifact, TrainingConfig } from './types'

export const TRAIN_PRIOR_CONFIG: TrainingConfig = {
  epochs: 1,
  learningRate: 0.1,
  l2: 0,
  seed: 0,
  featureCatalogVersion: GEO_OUTCOME_FEATURE_CATALOG_VERSION,
}

export function buildTrainOnlyPriorArtifact(ownerUserId: number, dataset: DatasetManifest, members: DatasetMember[], modelFamily: ModelFamily): ModelArtifact {
  const split = { train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints }
  assertDisjointComplete(split, members)
  const trainRows = members.filter(member => member.splitAssignment === 'train')
  if (trainRows.length !== dataset.trainRowCount || trainRows.length !== dataset.trainFingerprints.length || !dataset.readiness.ready || dataset.taskType !== 'citation_selection') throw new Error('Approved citation dataset has incomplete train-only prior lineage.')
  const parameters = trainTrainOnlyPrevalencePrior(trainRows, TRAIN_PRIOR_CONFIG)
  const metrics = evaluateModel(parameters, members, split, dataset.taskType)
  return createModelArtifact({
    ownerUserId,
    taskType: dataset.taskType,
    modelFamily,
    modelVersion: GEO_OUTCOME_TRAIN_PRIOR_VERSION,
    datasetManifestFingerprint: dataset.manifestFingerprint,
    splitManifestFingerprint: splitFingerprint(split),
    parameters,
    evaluationMetrics: metrics,
    limitations: [
      'Fixed train-only prevalence prior; coefficients are zero and the intercept is a smoothed train-label log-odds.',
      'This artifact is fallback-only and cannot predict, shadow-evaluate, advise, or activate production.',
      'Evaluation metrics use validation and holdout rows only; no citation or business outcome claim is implied.',
    ],
  })
}

export function isExactTrainOnlyPriorArtifact(artifact: ModelArtifact, dataset: DatasetManifest, members: DatasetMember[]): boolean {
  if (artifact.ownerUserId !== dataset.ownerUserId || artifact.datasetManifestFingerprint !== dataset.manifestFingerprint || artifact.featureCatalogVersion !== GEO_OUTCOME_FEATURE_CATALOG_VERSION || artifact.labelContractVersion !== GEO_OUTCOME_LABEL_CONTRACT_VERSION || artifact.rollbackArtifactHash !== null) return false
  try {
    return buildTrainOnlyPriorArtifact(artifact.ownerUserId, dataset, members, artifact.modelFamily).artifactHash === artifact.artifactHash
  } catch {
    return false
  }
}
