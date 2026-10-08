import { describe, expect, it } from 'vitest'
import { geoOutcomeDatasetDecisions, geoOutcomeDatasetManifests, geoOutcomeTrainingRuns } from '../server/database/schema'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import { buildDatasetKnowledgeAuthority, assertValidDatasetKnowledgeAuthority } from '../server/geo-outcome-model/knowledge-authority'
import { buildCitationSelectionDataset } from '../server/geo-outcome-model/dataset-builder'
import { encodeDurableJson } from '../server/geo-outcome-model/durable-json'
import type { DatasetKnowledgeState } from '../server/geo-outcome-model/knowledge-authority-types'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import type { DatasetManifest } from '../server/geo-outcome-model/types'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import { StrictGeoDrizzleHarness } from './support/strict-geo-drizzle-harness'

const OWNER = 73
const HASH = 'a'.repeat(64)
function dataset(status: DatasetManifest['status'] = 'ready_for_review'): DatasetManifest {
  return { ownerUserId: OWNER, manifestId: 'geo-dataset-persistence-test', manifestFingerprint: HASH, status } as DatasetManifest
}
function tombstoneState(manifest: DatasetManifest): DatasetKnowledgeState {
  return { ownerUserId: OWNER, manifestId: manifest.manifestId, manifestFingerprint: manifest.manifestFingerprint, nativeDatasetId: 1, heads: [{ subjectKind: 'entity', subjectId: 5, operation: 'revoke', sequenceNumber: 2, bindingFingerprint: 'b'.repeat(64), revisionNumber: 1, revisionContentHash: 'c'.repeat(64), revisionFingerprint: 'd'.repeat(64), currentRevisionFingerprint: null }] }
}
function seedKnowledgeState(repository: ReturnType<typeof createMemoryGeoOutcomeRepository>, state: DatasetKnowledgeState) {
  (repository as unknown as { seedDatasetKnowledgeState(value: DatasetKnowledgeState): void }).seedDatasetKnowledgeState(state)
}

describe('durable dataset Knowledge approval authority', () => {
  it('requires explicit owner authority, persists reapproval envelopes, and leaves revocation authority empty', async () => {
    const manifest = dataset()
    const repository = createMemoryGeoOutcomeRepository()
    await repository.saveDatasetTransactional(OWNER, manifest, [])
    const initial = await repository.readDatasetKnowledgeState(OWNER, manifest.manifestId)
    expect(initial.heads).toEqual([])
    expect(initial.nativeDatasetId).toBeGreaterThan(0)
    await expect(repository.transitionDatasetWithDecision(OWNER, manifest.manifestId, 'approved', OWNER, 'No implicit declaration.')).rejects.toThrow(/explicit owner-reviewed/i)

    const firstAuthority = buildDatasetKnowledgeAuthority(initial, 'declared_none_v1')
    const first = await repository.transitionDatasetWithDecision(OWNER, manifest.manifestId, 'approved', OWNER, 'Declared no current Knowledge pins.', firstAuthority)
    expect(first.decision.knowledgeAuthority).toEqual(firstAuthority)

    const nextState = tombstoneState(manifest)
    seedKnowledgeState(repository, nextState)
    const secondAuthority = buildDatasetKnowledgeAuthority(nextState, 'declared_none_v1')
    const second = await repository.transitionDatasetWithDecision(OWNER, manifest.manifestId, 'approved', OWNER, 'Rechecked tombstone history.', secondAuthority)
    expect(second.decision.previousStatus).toBe('approved')
    expect(second.decision.knowledgeAuthority?.authorityFingerprint).toBe(secondAuthority.authorityFingerprint)
    expect(second.decision.decisionId).not.toBe(first.decision.decisionId)

    const revoked = await repository.transitionDatasetWithDecision(OWNER, manifest.manifestId, 'revoked', OWNER, 'Owner revoked dataset approval.')
    expect(revoked.decision.knowledgeAuthority).toBeUndefined()
    expect((await repository.listDatasetDecisions(OWNER)).map(item => item.newStatus)).toEqual(['approved', 'approved', 'revoked'])
  })

  it('rejects pinned approval when the active pin is stale', async () => {
    const manifest = dataset()
    const repository = createMemoryGeoOutcomeRepository()
    await repository.saveDatasetTransactional(OWNER, manifest, [])
    const state: DatasetKnowledgeState = { ownerUserId: OWNER, manifestId: manifest.manifestId, manifestFingerprint: manifest.manifestFingerprint, nativeDatasetId: 1, heads: [{ subjectKind: 'claim', subjectId: 8, operation: 'bind', sequenceNumber: 1, bindingFingerprint: 'b'.repeat(64), revisionNumber: 2, revisionContentHash: 'c'.repeat(64), revisionFingerprint: 'd'.repeat(64), currentRevisionFingerprint: 'e'.repeat(64) }] }
    seedKnowledgeState(repository, state)
    expect(() => buildDatasetKnowledgeAuthority(state, 'pinned_v1')).toThrow(/stale/i)
    await expect(repository.transitionDatasetWithDecision(OWNER, manifest.manifestId, 'approved', OWNER, 'Stale pin cannot be approved.', { ...state, schemaVersion: 'geo-dataset-knowledge-authority-v1', mode: 'pinned_v1', authorityFingerprint: HASH } as never)).rejects.toThrow()
  })

  it('reads a persisted authority envelope only when its strict schema and owner/native lineage reproduce', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const native = { id: 1, ownerUserId: OWNER, manifestId: 'geo-dataset-persisted-envelope', manifestFingerprint: HASH }
    await harness.insert(geoOutcomeDatasetManifests).values(native)
    const state: DatasetKnowledgeState = { ownerUserId: OWNER, manifestId: native.manifestId, manifestFingerprint: HASH, nativeDatasetId: native.id, heads: [] }
    const authority = buildDatasetKnowledgeAuthority(state, 'declared_none_v1')
    const decisionData = { ownerUserId: OWNER, manifestId: native.manifestId, previousStatus: 'ready_for_review', newStatus: 'approved', reviewerUserId: OWNER, reason: 'Reviewed durable authority.', manifestFingerprint: HASH, knowledgeAuthority: authority }
    const decisionFingerprint = fingerprint(decisionData)
    await harness.insert(geoOutcomeDatasetDecisions).values({ ...decisionData, decisionId: `geo-dataset-decision-${decisionFingerprint.slice(0, 20)}`, datasetManifestId: native.id, knowledgeAuthority: authority, createdAt: new Date('2026-10-08T00:00:00Z') })
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const [saved] = await repository.listDatasetDecisions(OWNER)
    expect(saved?.knowledgeAuthority).toEqual(authority)
    expect(() => assertValidDatasetKnowledgeAuthority(saved?.knowledgeAuthority)).not.toThrow()

    harness.corrupt('geoOutcomeDatasetDecisions', () => true, { knowledgeAuthority: { ...authority, ownerUserId: OWNER + 1 } })
    await expect(repository.listDatasetDecisions(OWNER)).rejects.toThrow(/authority|corrupt/i)
  })

  it('reads an empty native binding set under the dataset row lock in one transaction', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const built = buildCitationSelectionDataset([], OWNER)
    const saved = await repository.saveDatasetTransactional(OWNER, built.manifest, [])
    const consistent = await repository.readDatasetKnowledgeState(OWNER, saved.manifestId)
    const state = await repository.transaction(tx => tx.readDatasetKnowledgeState(OWNER, saved.manifestId, true))
    expect(consistent).toMatchObject({ ownerUserId: OWNER, manifestId: saved.manifestId, manifestFingerprint: saved.manifestFingerprint, nativeDatasetId: 1, heads: [] })
    expect(state).toMatchObject({ ownerUserId: OWNER, manifestId: saved.manifestId, manifestFingerprint: saved.manifestFingerprint, nativeDatasetId: 1, heads: [] })
  })

  it('round-trips v4 exact training configuration and both immutable approval references', async () => {
    const config = { epochs: 80, learningRate: 0.12, l2: 0.01, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' as const }
    const reference = { datasetDecisionId: 'geo-dataset-decision-approval-73', knowledgeAuthorityFingerprint: 'f'.repeat(64) }
    const datasetManifestId = 'geo-dataset-training-v4'
    const modelFamily = 'regularized_logistic_baseline_v1'
    const trainingRunId = `geo-training-${fingerprint({ ownerUserId: OWNER, datasetManifestId, modelFamily, config, rollbackArtifactHash: null, ...reference }).slice(0, 20)}`
    const row = { ownerUserId: OWNER, trainingRunId, datasetManifestId: 7, modelFamily, status: 'queued', startedAt: null, completedAt: null, leaseOwner: null, leaseExpiresAt: null, version: 0, configuration: { schemaVersion: 'geo-outcome-training-configuration-v4', config: encodeDurableJson(config), rollbackArtifactHash: null, ...reference }, artifactId: null, artifactHash: null, metrics: null, reason: null, createdAt: new Date('2026-10-08T00:00:00Z') }
    const db = { select() { let table: unknown; const query = { from(value: unknown) { table = value; return query }, where() { return query }, async limit() { return table === geoOutcomeDatasetManifests ? [{ manifestId: datasetManifestId, manifestFingerprint: HASH }] : table === geoOutcomeTrainingRuns ? [row] : [] } }; return query } }
    const mapped = await new DrizzleGeoOutcomeRepository(db as never).getTrainingRun(OWNER, trainingRunId)
    expect(mapped).toMatchObject({ trainingRunId, config, rollbackArtifactHash: null, ...reference })
  })
})
