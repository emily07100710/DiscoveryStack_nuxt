import { beforeAll, describe, expect, it } from 'vitest'
import { geoOutcomeDatasetManifests, geoOutcomeModelArtifacts } from '../server/database/schema'
import { createModelArtifact } from '../server/geo-outcome-model/artifact'
import { evaluateModel } from '../server/geo-outcome-model/evaluator'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import type { GeoOutcomeDrizzleDatabase } from '../server/geo-outcome-model/repository-drizzle'
import type { DatasetManifest, ModelArtifact, TrainingConfig } from '../server/geo-outcome-model/types'
import { splitFingerprint } from '../server/geo-outcome-model/split-policy'
import { trainTrainOnlyPrevalencePrior } from '../server/geo-outcome-model/trainer'
import { trustedState } from './support/modelops-fixtures'

const OWNER = 42
const CONFIG: TrainingConfig = { epochs: 80, learningRate: 0.12, l2: 0.01, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' }
let dataset!: DatasetManifest
let members!: Awaited<ReturnType<typeof trustedState>>['datasetMembers'][string]

function durableDatasetRow(value: DatasetManifest) {
  return {
    id: 7, ownerUserId: value.ownerUserId, manifestId: value.manifestId, schemaVersion: value.schemaVersion,
    taskType: value.taskType, featureCatalogVersion: value.featureCatalogVersion, labelContractVersion: value.labelContractVersion,
    hardNegativePolicyVersion: value.hardNegativePolicyVersion, sourceObservationFingerprints: value.sourceObservationFingerprints,
    sourceBasisCounts: value.sourceBasisCounts, engineCounts: value.engineCounts, localeCounts: value.localeCounts,
    websiteCount: value.websiteCount, queryGroupCount: value.queryGroupCount, positiveCount: value.positiveCount,
    hardNegativeCount: value.hardNegativeCount, observationStart: value.observationStart ? new Date(value.observationStart) : null,
    observationEnd: value.observationEnd ? new Date(value.observationEnd) : null, splitPolicyVersion: value.splitPolicyVersion,
    splitFingerprints: { train: value.trainFingerprints, validation: value.validationFingerprints, test: value.testFingerprints, siteHoldout: value.siteHoldoutFingerprints, queryHoldout: value.queryHoldoutFingerprints, temporalHoldout: value.temporalHoldoutFingerprints },
    manifestFingerprint: value.manifestFingerprint, limitations: value.limitations, readiness: value.readiness, status: value.status, createdAt: new Date(value.createdAt),
  }
}

class DecimalArtifactDrizzleMock {
  private artifactRow: Record<string, unknown> | null = null
  private readonly datasetRow: ReturnType<typeof durableDatasetRow>
  constructor(value: DatasetManifest, private readonly tamperMirror = false) { this.datasetRow = durableDatasetRow(value) }

  select() {
    let table: unknown
    const query = {
      from: (value: unknown) => { table = value; return query },
      where: () => query,
      limit: async () => table === geoOutcomeDatasetManifests ? [this.datasetRow] : table === geoOutcomeModelArtifacts && this.artifactRow ? [this.artifactRow] : [],
    }
    return query
  }

  insert(table: unknown) {
    return {
      values: async (row: Record<string, unknown>) => {
        if (table !== geoOutcomeModelArtifacts) throw new Error('Unexpected mock insert table.')
        const rounded = Number(row.intercept).toFixed(12)
        const storedDecimal = /^-0\.0{12}$/u.test(rounded) ? '0.000000000000' : rounded
        this.artifactRow = structuredClone({ ...row, intercept: this.tamperMirror ? '0.125000000001' : storedDecimal })
      },
    }
  }

  seedLegacy(row: Record<string, unknown>) { this.artifactRow = structuredClone(row) }
  storedArtifact() { return this.artifactRow }
}

async function buildArtifact(intercept: number): Promise<ModelArtifact> {
  const split = { train: dataset.trainFingerprints, validation: dataset.validationFingerprints, test: dataset.testFingerprints, siteHoldout: dataset.siteHoldoutFingerprints, queryHoldout: dataset.queryHoldoutFingerprints, temporalHoldout: dataset.temporalHoldoutFingerprints }
  const trainRows = members.filter(member => member.splitAssignment === 'train')
  const prior = trainTrainOnlyPrevalencePrior(trainRows, CONFIG)
  const parameters = { ...prior, intercept }
  const evaluationMetrics = evaluateModel(parameters, members, split, dataset.taskType)
  return createModelArtifact({ ownerUserId: OWNER, taskType: dataset.taskType, modelFamily: 'regularized_logistic_baseline_v1', datasetManifestFingerprint: dataset.manifestFingerprint, splitManifestFingerprint: splitFingerprint(split), parameters, evaluationMetrics })
}

function repository(mock: DecimalArtifactDrizzleMock) { return new DrizzleGeoOutcomeRepository(mock as unknown as GeoOutcomeDrizzleDatabase) }

beforeAll(async () => {
  const state = await trustedState()
  dataset = state.datasets[0]!
  members = state.datasetMembers[dataset.manifestId]!
})

describe('durable artifact DECIMAL and exact intercept mapping', () => {
  it('round-trips full-precision and tiny positive/negative intercepts through the real repository save/get boundary', async () => {
    for (const intercept of [0.12345678901234566, 1e-14, -1e-14]) {
      const mock = new DecimalArtifactDrizzleMock(dataset)
      const artifact = await buildArtifact(intercept)
      const saved = await repository(mock).saveArtifactTransactional(OWNER, artifact)
      expect(saved.intercept).toBe(intercept)
      expect(saved.artifactHash).toBe(artifact.artifactHash)
      expect(mock.storedArtifact()?.intercept).toBe(intercept.toFixed(12).replace(/^-0\.0{12}$/u, '0.000000000000'))
      expect(mock.storedArtifact()?.trainingConfiguration).toMatchObject({ schemaVersion: 'geo-outcome-artifact-training-configuration-v2', config: CONFIG, exactIntercept: intercept })
    }
  })

  it('keeps legacy raw training configuration readable for an exactly DECIMAL-representable artifact', async () => {
    const mock = new DecimalArtifactDrizzleMock(dataset)
    const artifact = await buildArtifact(0.25)
    const saved = await repository(mock).saveArtifactTransactional(OWNER, artifact)
    const row = mock.storedArtifact()!
    mock.seedLegacy({ ...row, trainingConfiguration: artifact.trainingConfiguration, intercept: '0.250000000000' })
    const loaded = await repository(mock).getArtifact(OWNER, artifact.artifactId)
    expect(loaded?.intercept).toBe(0.25)
    expect(loaded?.artifactHash).toBe(saved.artifactHash)
  })

  it('fails closed on a tampered DECIMAL mirror or unknown envelope marker', async () => {
    const tamperedMock = new DecimalArtifactDrizzleMock(dataset, true)
    const artifact = await buildArtifact(0.125)
    await expect(repository(tamperedMock).saveArtifactTransactional(OWNER, artifact)).rejects.toThrow(/DECIMAL intercept mirror/i)

    const mock = new DecimalArtifactDrizzleMock(dataset)
    const valid = await buildArtifact(0.25)
    await repository(mock).saveArtifactTransactional(OWNER, valid)
    mock.seedLegacy({ ...mock.storedArtifact()!, trainingConfiguration: { schemaVersion: 'geo-outcome-artifact-training-configuration-v3', config: valid.trainingConfiguration, exactIntercept: valid.intercept } })
    await expect(repository(mock).getArtifact(OWNER, valid.artifactId)).rejects.toThrow(/configuration envelope/i)
  })
})
