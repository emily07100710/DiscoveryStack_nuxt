import { beforeAll, describe, expect, it, vi } from 'vitest'
import { approveBootstrapFallback, createBootstrapFallback, createTrainingRun, executeTrainingRun, getWorkspace, predict, resolveApprovedFallbackForArtifact, reviewDataset, reviewModel } from '../server/geo-outcome-model/service'
import { approvalReference, assertDatasetKnowledgeAuthorityCurrent } from '../server/geo-outcome-model/knowledge-authority'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import { verifyArtifactHash } from '../server/geo-outcome-model/release-gate'
import type { DatasetKnowledgeState } from '../server/geo-outcome-model/knowledge-authority-types'
import type { MemoryGeoOutcomeState } from '../server/geo-outcome-model/types'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import { trustedState } from './support/modelops-fixtures'

const OWNER = 42
let initial: MemoryGeoOutcomeState
beforeAll(async () => { initial = await trustedState() })
const repo = () => createMemoryGeoOutcomeRepository(initial)
const config = { epochs: 8, learningRate: 0.12, l2: 0.01, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' }
function pinned(state: DatasetKnowledgeState, revision = 1): DatasetKnowledgeState {
  return { ...state, heads: [{ subjectKind: 'claim', subjectId: 12, operation: 'bind', sequenceNumber: revision, bindingFingerprint: fingerprint(`binding-${revision}`), revisionNumber: revision, revisionContentHash: fingerprint(`content-${revision}`), revisionFingerprint: fingerprint(`revision-${revision}`), currentRevisionFingerprint: fingerprint(`revision-${revision}`) }] }
}
async function currentPinnedRepository() {
  const repository = repo(), dataset = initial.datasets[0]!
  const native = await repository.readDatasetKnowledgeState(OWNER, dataset.manifestId)
  repository.seedDatasetKnowledgeState(pinned(native))
  await reviewDataset(OWNER, dataset.manifestId, 'approve', OWNER, 'Synthetic owner explicitly reviewed the exact active pins.', repository, { knowledgeMode: 'pinned_v1' })
  return { repository, dataset, native }
}
async function shadowModel() {
  const f = await currentPinnedRepository()
  const fallback = await createBootstrapFallback(OWNER, f.dataset.manifestId, 'regularized_logistic_baseline_v1', f.repository)
  await approveBootstrapFallback(OWNER, fallback.artifactId, OWNER, 'Synthetic separate owner review of the current fallback.', f.repository)
  const reserved = await createTrainingRun(OWNER, { datasetManifestId: f.dataset.manifestId, modelFamily: 'regularized_logistic_baseline_v1', config }, f.repository)
  const run = await executeTrainingRun(OWNER, reserved.trainingRunId, f.repository)
  expect(run.status).toBe('completed')
  const artifact = (await f.repository.getArtifact(OWNER, run.artifactId!))!
  await reviewModel(OWNER, artifact.artifactId, 'approve_for_shadow', OWNER, 'Synthetic owner reviewed experimental candidate shadow.', f.repository)
  return { ...f, reserved, run, artifact, fallback }
}

describe('dependency authority connected to fitting and immutable artifacts', () => {
  it('does not allow implicit declarations, active pins declared none, or cross-owner review', async () => {
    const f = await currentPinnedRepository()
    await expect(reviewDataset(OWNER, f.dataset.manifestId, 'approve', OWNER, 'Missing declaration.', f.repository)).rejects.toThrow(/explicit Knowledge/)
    await expect(reviewDataset(OWNER, f.dataset.manifestId, 'approve', OWNER, 'Wrong no-dependency declaration.', f.repository, { knowledgeMode: 'declared_none_v1' })).rejects.toThrow(/active_dependencies/)
    await expect(reviewDataset(OWNER, f.dataset.manifestId, 'approve', 43, 'Wrong reviewer.', f.repository, { knowledgeMode: 'pinned_v1' })).rejects.toThrow(/server-derived owner/)
  })
  it('a new active binding invalidates an earlier declared-none approval before reservation', async () => {
    const repository = repo(), dataset = initial.datasets[0]!
    const native = await repository.readDatasetKnowledgeState(OWNER, dataset.manifestId)
    repository.seedDatasetKnowledgeState(pinned(native))
    await expect(createTrainingRun(OWNER, { datasetManifestId: dataset.manifestId, modelFamily: 'regularized_logistic_baseline_v1', config }, repository)).rejects.toThrow(/active_dependencies/)
    expect(await repository.listTrainingRuns(OWNER)).toEqual([])
  })
  it('a changed revision blocks an already queued run without fitting or saving an artifact', async () => {
    const f = await currentPinnedRepository()
    const run = await createTrainingRun(OWNER, { datasetManifestId: f.dataset.manifestId, modelFamily: 'regularized_logistic_baseline_v1', config }, f.repository)
    const stale = pinned(f.native)
    stale.heads[0]!.currentRevisionFingerprint = fingerprint('revision-2')
    f.repository.seedDatasetKnowledgeState(stale)
    expect(await executeTrainingRun(OWNER, run.trainingRunId, f.repository)).toMatchObject({ status: 'blocked', artifactHash: null, leaseOwner: null })
    expect(await f.repository.listArtifacts(OWNER)).toEqual([])
  })
  it('rechecks dependency authority after member reads and before persistence', async () => {
    const f = await currentPinnedRepository()
    const run = await createTrainingRun(OWNER, { datasetManifestId: f.dataset.manifestId, modelFamily: 'regularized_logistic_baseline_v1', config }, f.repository)
    const read = f.repository.getDatasetMembers.bind(f.repository)
    vi.spyOn(f.repository, 'getDatasetMembers').mockImplementationOnce(async (owner, manifest) => {
      const rows = await read(owner, manifest)
      const stale = pinned(f.native); stale.heads[0]!.currentRevisionFingerprint = fingerprint('changed-during-fitting')
      f.repository.seedDatasetKnowledgeState(stale)
      return rows
    })
    expect(await executeTrainingRun(OWNER, run.trainingRunId, f.repository)).toMatchObject({ status: 'failed', artifactHash: null })
    expect(await f.repository.listArtifacts(OWNER)).toEqual([])
  })
  it('includes exact approval references in run and artifact identity, and preserves them across restart', async () => {
    const f = await shadowModel()
    expect(approvalReference(f.artifact)).toEqual(approvalReference(f.reserved))
    expect(verifyArtifactHash(f.artifact)).toBe(true)
    expect(verifyArtifactHash({ ...f.artifact, knowledgeAuthorityFingerprint: fingerprint('forged-authority') })).toBe(false)
    const restarted = createMemoryGeoOutcomeRepository(f.repository.exportState())
    const persisted = (await restarted.getArtifact(OWNER, f.artifact.artifactId))!
    await expect(assertDatasetKnowledgeAuthorityCurrent(OWNER, (await restarted.getDataset(OWNER, f.dataset.manifestId))!, restarted, approvalReference(persisted))).resolves.toMatchObject({ reference: approvalReference(f.reserved) })
    const priorRunId = f.reserved.trainingRunId
    await reviewDataset(OWNER, f.dataset.manifestId, 'approve', OWNER, 'Synthetic owner renewed an unchanged explicit dependency approval.', f.repository, { knowledgeMode: 'pinned_v1' })
    const next = await createTrainingRun(OWNER, { datasetManifestId: f.dataset.manifestId, modelFamily: 'regularized_logistic_baseline_v1', config }, f.repository)
    expect(next.trainingRunId).not.toBe(priorRunId)
    expect(next.datasetDecisionId).not.toBe(f.reserved.datasetDecisionId)
    expect(next.rollbackArtifactHash).toBeNull()
    expect(await resolveApprovedFallbackForArtifact(OWNER, f.artifact, f.repository)).toBeNull()
  })
})

describe('dependency authority on model use and recovery', () => {
  it('stale Knowledge prevents review/prediction/fallback but never prevents owner revocation', async () => {
    const f = await shadowModel()
    const stale = pinned(f.native); stale.heads[0]!.currentRevisionFingerprint = fingerprint('new-head')
    f.repository.seedDatasetKnowledgeState(stale)
    await expect(reviewModel(OWNER, f.artifact.artifactId, 'approve_for_shadow', OWNER, 'Cannot approve old pins.', f.repository)).rejects.toThrow(/knowledge_revision_stale/)
    await expect(predict(OWNER, f.artifact.artifactId, {}, f.repository)).rejects.toThrow(/knowledge_revision_stale/)
    expect(await resolveApprovedFallbackForArtifact(OWNER, f.artifact, f.repository)).toBeNull()
    await expect(reviewModel(OWNER, f.artifact.artifactId, 'revoke', OWNER, 'Owner can always revoke stale experimental use.', f.repository)).resolves.toMatchObject({ artifact: { status: 'revoked' } })
    await expect(reviewDataset(OWNER, f.dataset.manifestId, 'revoke', OWNER, 'Owner can revoke stale dataset.', f.repository)).resolves.toMatchObject({ manifest: { status: 'revoked' } })
  })
  it('a dependency changed while scoring is rejected before the prediction response', async () => {
    const f = await shadowModel()
    const observation = initial.observations[0]!
    const { ownerUserId: _owner, observationFingerprint: _fp, intakeFingerprint: _intake, consentStatus: _consent, piiStatus: _pii, verificationAuthority: _verification, reviewFingerprint: _review, candidateAuthorityFingerprint: _candidate, candidateSetFingerprint: _set, ...input } = observation
    input.verificationStatus = 'unverified'; input.citationStatus = 'unknown'; input.citationPosition = null
    await expect(predict(OWNER, f.artifact.artifactId, input, f.repository)).resolves.toMatchObject({ predictionIsVerifiedOutcome: false })
    const read = f.repository.listObservations.bind(f.repository)
    vi.spyOn(f.repository, 'listObservations').mockImplementationOnce(async owner => {
      const observations = await read(owner)
      const stale = pinned(f.native); stale.heads[0]!.currentRevisionFingerprint = fingerprint('changed-during-score')
      f.repository.seedDatasetKnowledgeState(stale)
      return observations
    })
    await expect(predict(OWNER, f.artifact.artifactId, input, f.repository)).rejects.toThrow(/Prediction authority changed|knowledge_revision_stale/)
    expect(f.repository.listObservations).toHaveBeenCalledOnce()
  })
  it('workspace marks stale approvals rather than counting them as current shadow inputs', async () => {
    const f = await currentPinnedRepository()
    expect((await getWorkspace(OWNER, f.repository)).datasets[0]!.knowledgeAuthority?.status).toBe('current')
    const stale = pinned(f.native); stale.heads[0]!.currentRevisionFingerprint = fingerprint('new-workspace-head')
    f.repository.seedDatasetKnowledgeState(stale)
    const workspace = await getWorkspace(OWNER, f.repository)
    expect(workspace.datasets[0]!.knowledgeAuthority).toMatchObject({ status: 'stale', mode: 'pinned_v1', activePinCount: 1 })
    expect(workspace.readiness.shadow.ready).toBe(false)
    expect(workspace.inventory.positiveCount).toBe(0)
  })
})
