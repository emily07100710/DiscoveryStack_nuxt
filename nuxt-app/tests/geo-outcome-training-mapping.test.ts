import { describe, expect, it } from 'vitest'
import { geoOutcomeDatasetManifests, geoOutcomeTrainingRuns } from '../server/database/schema'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import type { GeoOutcomeDrizzleDatabase } from '../server/geo-outcome-model/repository-drizzle'
import type { TrainingConfig } from '../server/geo-outcome-model/types'

const config: TrainingConfig = { epochs: 80, learningRate: 0.12, l2: 0.01, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' }
const ownerUserId = 42
const datasetManifestId = 'geo-dataset-test'
const modelFamily = 'regularized_logistic_baseline_v1'

function mapperFor(configuration: unknown, trainingRunId: string) {
  const row = { ownerUserId, trainingRunId, datasetManifestId: 7, modelFamily, status: 'queued', startedAt: null, completedAt: null, leaseOwner: null, leaseExpiresAt: null, version: 0, configuration, artifactId: null, artifactHash: null, metrics: null, reason: null, createdAt: new Date('2026-10-01T00:00:00Z') }
  const db = {
    select() {
      let table: unknown
      const query = {
        from(value: unknown) { table = value; return query },
        where() { return query },
        async limit() { return table === geoOutcomeDatasetManifests ? [{ manifestId: datasetManifestId }] : table === geoOutcomeTrainingRuns ? [row] : [] },
      }
      return query
    },
  }
  return new DrizzleGeoOutcomeRepository(db as unknown as GeoOutcomeDrizzleDatabase)
}

describe('durable training reservation mapping', () => {
  it('round-trips v2 exact rollback snapshot while preserving legacy raw-configuration IDs', async () => {
    const rollbackArtifactHash = 'a'.repeat(64)
    const v2Id = `geo-training-${fingerprint({ ownerUserId, datasetManifestId, modelFamily, config, rollbackArtifactHash }).slice(0, 20)}`
    const v2 = await mapperFor({ schemaVersion: 'geo-outcome-training-configuration-v2', config, rollbackArtifactHash }, v2Id).getTrainingRun(ownerUserId, v2Id)
    expect(v2).toMatchObject({ config, rollbackArtifactHash })

    const legacyId = `geo-training-${fingerprint({ ownerUserId, datasetManifestId, modelFamily, config }).slice(0, 20)}`
    const legacy = await mapperFor(config, legacyId).getTrainingRun(ownerUserId, legacyId)
    expect(legacy?.config).toEqual(config)
    expect(legacy?.rollbackArtifactHash).toBeUndefined()
  })

  it('rejects a durable row whose business ID no longer matches its immutable fallback snapshot', async () => {
    const rollbackArtifactHash = 'b'.repeat(64)
    const wrongId = `geo-training-${fingerprint({ ownerUserId, datasetManifestId, modelFamily, config, rollbackArtifactHash: null }).slice(0, 20)}`
    await expect(mapperFor({ schemaVersion: 'geo-outcome-training-configuration-v2', config, rollbackArtifactHash }, wrongId).getTrainingRun(ownerUserId, wrongId)).rejects.toThrow(/business id/i)
  })
})
