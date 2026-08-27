import { describe, expect, it } from 'vitest'
import { withMutationIdempotency } from '../server/api/geo-outcome-model/_helpers'
import { buildCitationSelectionDataset } from '../server/geo-outcome-model/dataset-builder'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import { createTrainingRun, executeTrainingRun, getWorkspace } from '../server/geo-outcome-model/service'
import { normalizeManualObservation } from '../server/geo-outcome-model/normalization'
import { sha256Hex } from '../server/geo-outcome-model/canonical'
import type { EvidenceLocatorRecord, OutcomeObservation } from '../server/geo-outcome-model/types'
import { StrictGeoDrizzleHarness } from './support/strict-geo-drizzle-harness'

const ownerUserId = 42
const hash = (value: string) => sha256Hex(value)
function rawObservation(group: string, citationStatus: 'cited' | 'not_cited', overrides: Record<string, unknown> = {}) {
  const day = Number(overrides.day || Number(group.replace(/\D/gu, '')) || 1)
  const date = new Date(Date.UTC(2026, 0, day)).toISOString()
  const positive = citationStatus === 'cited'
  return {
    schemaVersion: 'geo-outcome-observation-v1',
    projectId: null,
    clientId: null,
    websiteIdentityHash: hash(String(overrides.website || `site-${group}`)),
    queryIdentityHash: hash(String(overrides.query || `query-${group}`)),
    normalizedQueryHash: hash(String(overrides.query || `query-${group}`)),
    candidatePageIdentityHash: hash(String(overrides.page || `page-${group}-${positive ? 'positive' : 'negative'}`)),
    canonicalPageHash: hash(String(overrides.canonical || `canonical-${group}-${positive ? 'positive' : 'negative'}`)),
    contentHash: hash(String(overrides.content || `content-${group}-${positive ? 'positive' : 'negative'}`)),
    evidenceSnapshotHash: hash(String(overrides.evidence || `evidence-${group}`)),
    publicationReceiptFingerprint: hash(`receipt-${group}`),
    engine: overrides.engine || 'chatgpt',
    model: 'test-model',
    modelVersion: 'v1',
    interface: 'consumer_surface',
    locale: 'en',
    region: 'US',
    runIdentity: String(overrides.runIdentity || `run-${group}`),
    runTimestamp: date,
    observationWindow: { start: date, end: new Date(Date.UTC(2026, 0, day, 1)).toISOString() },
    observableStatus: 'observable',
    retrievalStatus: 'retrieved',
    citationStatus,
    citationPosition: positive ? 1 : null,
    mentionStatus: positive ? 'mentioned' : 'not_mentioned',
    recommendationStatus: 'unknown',
    labelBasis: 'manual_verified_primary',
    verificationStatus: 'unverified',
    evidenceLocatorHashes: [hash(`locator-${group}-${positive ? 'positive' : 'negative'}`)],
    appliedRuleHashes: [],
    contentFeatureVector: {
      contentType: 'article', locale: 'en', pageAgeBucket: '8_30d', contentLengthBucket: positive ? 'l' : 's', headingHierarchy: positive ? 'structured' : 'flat', directAnswerPresence: positive ? 'present' : 'absent', faqStructure: 'absent', structuredDataPresence: positive ? 'present' : 'absent', citationMarkerCount: positive ? 3 : 0, approvedAuthoritySourceCount: positive ? 2 : 0, evidenceUtilizationRatio: positive ? .8 : .1, entityCoverage: positive ? .8 : .1, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'valid', indexabilityFlag: 'indexable', internalLinkDepthBucket: '1', contentFreshnessBucket: 'fresh', queryPageLexicalOverlap: positive ? .8 : .1, topicClusterEqual: 'yes', verifiedPublicationAgeDays: 10, priorObservationCount: 1,
    },
  }
}
function evidenceRecord(observation: OutcomeObservation): EvidenceLocatorRecord {
  return { ownerUserId: observation.ownerUserId, observationFingerprint: observation.observationFingerprint, evidenceLocatorHash: observation.evidenceLocatorHashes[0]!, purpose: 'geo_outcome_verification', artifactHash: observation.evidenceSnapshotHash, evidenceSnapshotHash: observation.evidenceSnapshotHash, createdAt: new Date().toISOString() }
}
async function govern(repository: DrizzleGeoOutcomeRepository, observation: OutcomeObservation) {
  await repository.registerEvidenceLocatorTransactional(evidenceRecord(observation))
  await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'verify_evidence', 'Evidence lineage reviewed.', observation.evidenceLocatorHashes[0])
  await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_consent', 'Consent independently reviewed.')
  return repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_pii', 'PII independently reviewed.')
}

describe('Drizzle GEO outcome durable boundary', () => {
  it('preserves business IDs through observation, dataset, training, artifact, decision, workspace and restart', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    for (let index = 1; index <= 100; index += 1) {
      for (const status of ['cited', 'not_cited'] as const) {
        const intake = normalizeManualObservation(rawObservation(`g${index}`, status, { day: index, engine: index % 2 ? 'chatgpt' : 'gemini' }), ownerUserId)
        const stored = await repository.saveObservationTransactional(ownerUserId, intake)
        expect(stored.verificationStatus).toBe('unverified')
        const governed = await govern(repository, stored)
        expect(governed.observation.verificationStatus).toBe('verified')
      }
    }
    const observations = await repository.listObservations(ownerUserId)
    const built = buildCitationSelectionDataset(observations, ownerUserId)
    expect(built.manifest.readiness.ready).toBe(true)
    const savedManifest = await repository.saveDatasetTransactional(ownerUserId, built.manifest, built.members)
    expect(savedManifest.manifestId).toBe(built.manifest.manifestId)
    await repository.transitionDataset(ownerUserId, savedManifest.manifestId, 'approved')
    const queued = await createTrainingRun(ownerUserId, { datasetManifestId: savedManifest.manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, repository)
    const completed = await executeTrainingRun(ownerUserId, queued.trainingRunId, repository)
    expect(completed.status).toBe('completed')
    expect(completed.datasetManifestId).toBe(savedManifest.manifestId)
    expect(completed.artifactId).toMatch(/^geo-model-/u)
    const artifact = await repository.getArtifact(ownerUserId, completed.artifactId!)
    expect(artifact?.artifactId).toBe(completed.artifactId)
    const transitioned = await repository.transitionArtifactWithDecision(ownerUserId, artifact!.artifactId, 'approved_for_shadow', ownerUserId, 'Owner shadow decision.', savedManifest.manifestFingerprint)
    expect(transitioned.decision.modelArtifactId).toBe(artifact!.artifactId)
    const workspace = await getWorkspace(ownerUserId, repository)
    expect(workspace.trainingRuns[0]?.datasetManifestId).toBe(savedManifest.manifestId)
    expect(workspace.decisions[0]?.modelArtifactId).toBe(artifact!.artifactId)

    const restarted = new DrizzleGeoOutcomeRepository(new StrictGeoDrizzleHarness(harness.exportState()).asDatabase())
    expect((await restarted.getTrainingRun(ownerUserId, queued.trainingRunId))?.datasetManifestId).toBe(savedManifest.manifestId)
    expect((await restarted.listDecisions(ownerUserId))[0]?.modelArtifactId).toBe(artifact!.artifactId)
  })

  it('returns the canonical stored replay and rejects concurrent run-identity payload collisions', async () => {
    const repository = new DrizzleGeoOutcomeRepository(new StrictGeoDrizzleHarness().asDatabase())
    const intake = normalizeManualObservation(rawObservation('race1', 'cited'), ownerUserId)
    await repository.saveObservationTransactional(ownerUserId, intake)
    await govern(repository, intake)
    const replay = await repository.saveObservationTransactional(ownerUserId, intake)
    expect(replay.verificationStatus).toBe('verified')
    const collision = normalizeManualObservation(rawObservation('race1', 'not_cited', { page: 'another-page', evidence: 'different-evidence' }), ownerUserId)
    await expect(repository.saveObservationTransactional(ownerUserId, collision)).rejects.toThrow(/run identity collision/i)
  })

  it('requires three independent governance facts and makes revocation terminal', async () => {
    const repository = new DrizzleGeoOutcomeRepository(new StrictGeoDrizzleHarness().asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('gov1', 'cited'), ownerUserId))
    await expect(repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'verify_evidence', 'Caller assertion.', observation.evidenceLocatorHashes[0])).rejects.toThrow(/could not be resolved/i)
    await repository.registerEvidenceLocatorTransactional(evidenceRecord(observation))
    expect((await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'verify_evidence', 'Evidence.', observation.evidenceLocatorHashes[0])).observation.verificationStatus).toBe('unverified')
    expect((await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_consent', 'Consent.')).observation.verificationStatus).toBe('unverified')
    expect((await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_pii', 'PII.')).observation.verificationStatus).toBe('verified')
    await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'revoke', 'Terminal revoke.')
    await expect(repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'verify_evidence', 'Cannot restore.', observation.evidenceLocatorHashes[0])).rejects.toThrow(/terminally revoked/i)
  })

  it('fails closed for wrong-owner, wrong-purpose, wrong-artifact and hash-mismatch evidence', async () => {
    const repository = new DrizzleGeoOutcomeRepository(new StrictGeoDrizzleHarness().asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('gov2', 'cited'), ownerUserId))
    const record = evidenceRecord(observation)
    await expect(repository.registerEvidenceLocatorTransactional({ ...record, ownerUserId: ownerUserId + 1 })).rejects.toThrow(/not found/i)
    await expect(repository.registerEvidenceLocatorTransactional({ ...record, purpose: 'wrong' as never })).rejects.toThrow(/lineage mismatch/i)
    await expect(repository.registerEvidenceLocatorTransactional({ ...record, artifactHash: hash('wrong-artifact') })).rejects.toThrow(/lineage mismatch/i)
    await expect(repository.registerEvidenceLocatorTransactional({ ...record, evidenceSnapshotHash: hash('wrong-snapshot') })).rejects.toThrow(/lineage mismatch/i)
  })

  it('atomically rolls back a business mutation and claim after crash injection', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const intake = normalizeManualObservation(rawObservation('crash1', 'cited'), ownerUserId)
    await expect(withMutationIdempotency(ownerUserId, 'observations.manual', 'crash-key-001', intake, async transaction => {
      await transaction.saveObservationTransactional(ownerUserId, intake)
      throw new Error('injected crash after business write')
    }, repository)).rejects.toThrow(/injected crash/i)
    expect(await repository.getObservation(ownerUserId, intake.observationFingerprint)).toBeNull()
    expect(harness.count('geoOutcomeIdempotencyClaims')).toBe(0)
    const response = await withMutationIdempotency(ownerUserId, 'observations.manual', 'crash-key-001', intake, transaction => transaction.saveObservationTransactional(ownerUserId, intake), repository)
    expect(response.observationFingerprint).toBe(intake.observationFingerprint)
    expect((await withMutationIdempotency<OutcomeObservation>(ownerUserId, 'observations.manual', 'crash-key-001', intake, () => { throw new Error('must replay') }, repository)).observationFingerprint).toBe(intake.observationFingerprint)
    await expect(withMutationIdempotency(ownerUserId, 'observations.manual', 'crash-key-001', { different: true }, () => intake, repository)).rejects.toThrow(/collision/i)
  })

  it('allows one training claim winner and recovers a stale lease with CAS versioning', async () => {
    const repository = new DrizzleGeoOutcomeRepository(new StrictGeoDrizzleHarness().asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('claim1', 'cited'), ownerUserId))
    await govern(repository, observation)
    const built = buildCitationSelectionDataset(await repository.listObservations(ownerUserId), ownerUserId)
    const manifest = built.manifest
    await repository.saveDatasetTransactional(ownerUserId, manifest, built.members)
    const run = await createTrainingRun(ownerUserId, { datasetManifestId: manifest.manifestId, modelFamily: 'regularized_logistic_baseline_v1', config: { epochs: 2, learningRate: .1, l2: .01, seed: 0, featureCatalogVersion: 'geo-outcome-feature-catalog-v1' } }, repository)
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.claimTrainingRun(ownerUserId, run.trainingRunId, `worker-${index}`, new Date(Date.now() + 60_000).toISOString())))
    expect(claims.filter(item => item.outcome === 'claimed')).toHaveLength(1)
    expect(claims.filter(item => item.outcome === 'in_progress')).toHaveLength(7)
    const winner = await repository.getTrainingRun(ownerUserId, run.trainingRunId)
    await repository.transitionTrainingRun(ownerUserId, run.trainingRunId, { leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(), version: winner!.version })
    expect((await repository.claimTrainingRun(ownerUserId, run.trainingRunId, 'recovery-worker', new Date(Date.now() + 60_000).toISOString())).outcome).toBe('stale_recovered')
  })

  it('rolls back a strict Drizzle transaction and rejects corrupt durable JSON', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const observation = normalizeManualObservation(rawObservation('rollback1', 'cited'), ownerUserId)
    await expect(repository.transaction(async transaction => { await transaction.saveObservationTransactional(ownerUserId, observation); throw new Error('late failure') })).rejects.toThrow(/late failure/i)
    expect(await repository.listObservations(ownerUserId)).toEqual([])

    const stored = await repository.saveObservationTransactional(ownerUserId, observation)
    await govern(repository, stored)
    const built = buildCitationSelectionDataset(await repository.listObservations(ownerUserId), ownerUserId)
    await repository.saveDatasetTransactional(ownerUserId, built.manifest, built.members)
    harness.corrupt('geoOutcomeDatasetManifests', row => row.manifestId === built.manifest.manifestId, { splitFingerprints: { train: ['corrupt'] } })
    await expect(repository.getDataset(ownerUserId, built.manifest.manifestId)).rejects.toThrow(/corrupt durable/i)
  })
})
