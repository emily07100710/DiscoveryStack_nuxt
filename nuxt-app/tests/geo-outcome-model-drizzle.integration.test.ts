import { beforeAll, describe, expect, it } from 'vitest'
import { withMutationIdempotency } from '../server/api/geo-outcome-model/_helpers'
import { executeObservationGovernanceMutation } from '../server/api/geo-outcome-model/observation-governance-mutation'
import { buildCitationSelectionDataset } from '../server/geo-outcome-model/dataset-builder'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import { bindAndVerifyObservationEvidence, createTrainingRun, executeTrainingRun, getWorkspace, reviewDataset } from '../server/geo-outcome-model/service'
import { normalizeManualObservation } from '../server/geo-outcome-model/normalization'
import { fingerprint, sha256Hex } from '../server/geo-outcome-model/canonical'
import { authoritativeLocatorFingerprint } from '../server/geo-outcome-model/evidence-resolver'
import { llmVisibilityObservations, llmVisibilityProjects, llmVisibilityQueries, llmVisibilityRuns } from '../server/database/schema'
import type { DatasetManifest, OutcomeObservation } from '../server/geo-outcome-model/types'
import { StrictGeoDrizzleHarness } from './support/strict-geo-drizzle-harness'

const ownerUserId = 42
const hash = (value: string) => sha256Hex(value)
function rawObservation(group: string, citationStatus: 'cited' | 'not_cited', overrides: Record<string, unknown> = {}) {
  const day = Number(overrides.day || Number(group.replace(/\D/gu, '')) || 1)
  const date = new Date(Date.UTC(2026, 0, day)).toISOString()
  const positive = citationStatus === 'cited'
  const sourceRecordId = Number(overrides.sourceRecordId || day)
  const queryHash = hash(String(overrides.query || `query-${group}`))
  const runIdentity = hash(String(overrides.runIdentity || `run-${group}`))
  const responseHash = hash(String(overrides.evidence || `evidence-${group}`))
  const evidenceLocator = `evidence://llm-visibility/${sourceRecordId}`
  const locatorHash = authoritativeLocatorFingerprint({ sourceRecordId, sourceProjectId: 1, sourceQueryId: sourceRecordId, sourceRunId: sourceRecordId, sourceResponseHash: responseHash, evidenceLocator, sourceObservedAt: date })
  return {
    schemaVersion: 'geo-outcome-observation-v1',
    projectId: 1,
    clientId: null,
    websiteIdentityHash: hash(String(overrides.website || `site-${group}`)),
    queryIdentityHash: queryHash,
    normalizedQueryHash: queryHash,
    candidatePageIdentityHash: hash(String(overrides.page || `page-${group}-${positive ? 'positive' : 'negative'}`)),
    canonicalPageHash: hash(String(overrides.canonical || `canonical-${group}-${positive ? 'positive' : 'negative'}`)),
    contentHash: hash(String(overrides.content || `content-${group}-${positive ? 'positive' : 'negative'}`)),
    evidenceSnapshotHash: responseHash,
    publicationReceiptFingerprint: hash(`receipt-${group}`),
    engine: overrides.engine || 'chatgpt',
    model: 'test-model',
    modelVersion: 'v1',
    interface: 'consumer_surface',
    locale: 'en',
    region: 'US',
    runIdentity,
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
    evidenceLocatorHashes: [locatorHash],
    appliedRuleHashes: [],
    contentFeatureVector: {
      contentType: 'article', locale: 'en', pageAgeBucket: '8_30d', contentLengthBucket: positive ? 'l' : 's', headingHierarchy: positive ? 'structured' : 'flat', directAnswerPresence: positive ? 'present' : 'absent', faqStructure: 'absent', structuredDataPresence: positive ? 'present' : 'absent', citationMarkerCount: positive ? 3 : 0, approvedAuthoritySourceCount: positive ? 2 : 0, evidenceUtilizationRatio: positive ? .8 : .1, entityCoverage: positive ? .8 : .1, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'valid', indexabilityFlag: 'indexable', internalLinkDepthBucket: '1', contentFreshnessBucket: 'fresh', queryPageLexicalOverlap: positive ? .8 : .1, topicClusterEqual: 'yes', verifiedPublicationAgeDays: 10, priorObservationCount: 1,
    },
  }
}
async function seedAuthority(harness: StrictGeoDrizzleHarness, observation: OutcomeObservation, sourceRecordId: number, overrides: { mode?: 'manual_verified' | 'provider_api_observation', verified?: boolean, ownerUserId?: number, active?: boolean } = {}) {
  const database = harness.asDatabase()
  const sourceOwner = overrides.ownerUserId || ownerUserId
  if (harness.count('llmVisibilityProjects') === 0) await database.insert(llmVisibilityProjects).values({ ownerUserId: sourceOwner, name: 'Evidence project', canonicalWebsiteUrl: 'https://example.test', canonicalDomain: 'example.test', locale: 'en', brandName: 'Example', brandAliases: [], competitorBrands: [], status: overrides.active === false ? 'archived' : 'active' })
  await database.insert(llmVisibilityQueries).values({ ownerUserId: sourceOwner, projectId: 1, promptText: `Prompt ${sourceRecordId}`, promptHash: observation.normalizedQueryHash, intent: 'evidence', locale: 'en', active: overrides.active !== false })
  await database.insert(llmVisibilityRuns).values({ ownerUserId: sourceOwner, projectId: 1, provider: observation.engine as 'chatgpt' | 'gemini', modelLabel: observation.model, observationMode: overrides.mode || 'manual_verified', status: 'completed', observedAt: new Date(observation.runTimestamp), requestFingerprint: observation.runIdentity, limitationCode: 'owner_manual_snapshot' })
  await database.insert(llmVisibilityObservations).values({ ownerUserId: sourceOwner, projectId: 1, runId: sourceRecordId, queryId: sourceRecordId, brandMentioned: true, exactMentionCount: 1, firstMentionPosition: 1, citedDomain: 'example.test', citationUrls: ['https://example.test/page'], competitorMentions: {}, boundedExcerpt: 'Bounded owner-reviewed evidence.', responseHash: observation.evidenceSnapshotHash, evidenceLocator: `evidence://llm-visibility/${sourceRecordId}`, reviewerNote: 'Owner reviewed.', verifiedByOwner: overrides.verified !== false })
}
async function govern(repository: DrizzleGeoOutcomeRepository, observation: OutcomeObservation, sourceRecordId: number) {
  await bindAndVerifyObservationEvidence(ownerUserId, observation.observationFingerprint, ownerUserId, sourceRecordId, 'Evidence lineage reviewed.', repository)
  await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_consent', 'Consent independently reviewed.')
  return repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_pii', 'PII independently reviewed.')
}

type HarnessState = ReturnType<StrictGeoDrizzleHarness['exportState']>
let readyState: HarnessState
let readyManifestId: string

beforeAll(async () => {
  const harness = new StrictGeoDrizzleHarness()
  const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
  for (let index = 1; index <= 100; index += 1) {
    const storedRows: OutcomeObservation[] = []
    for (const status of ['cited', 'not_cited'] as const) storedRows.push(await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation(`g${index}`, status, { day: index, sourceRecordId: index, engine: index % 2 ? 'chatgpt' : 'gemini' }), ownerUserId)))
    await seedAuthority(harness, storedRows[0]!, index)
    for (const stored of storedRows) await govern(repository, stored, index)
  }
  const built = buildCitationSelectionDataset(await repository.listObservations(ownerUserId), ownerUserId)
  const saved = await repository.saveDatasetTransactional(ownerUserId, built.manifest, built.members)
  await reviewDataset(ownerUserId, saved.manifestId, 'approve', ownerUserId, 'Owner approved durable dataset.', repository)
  readyState = harness.exportState()
  readyManifestId = saved.manifestId
}, 30_000)

function readyRepository() {
  const harness = new StrictGeoDrizzleHarness(readyState)
  return { harness, repository: new DrizzleGeoOutcomeRepository(harness.asDatabase()) }
}

function variantManifest(manifest: DatasetManifest, suffix: string): DatasetManifest {
  const limitations = [...manifest.limitations, `test-variant-${suffix}`]
  const payload = { schemaVersion: manifest.schemaVersion, taskType: manifest.taskType, featureCatalogVersion: manifest.featureCatalogVersion, labelContractVersion: manifest.labelContractVersion, hardNegativePolicyVersion: manifest.hardNegativePolicyVersion, sourceObservationFingerprints: manifest.sourceObservationFingerprints, sourceBasisCounts: manifest.sourceBasisCounts, engineCounts: manifest.engineCounts, localeCounts: manifest.localeCounts, websiteCount: manifest.websiteCount, queryGroupCount: manifest.queryGroupCount, positiveCount: manifest.positiveCount, hardNegativeCount: manifest.hardNegativeCount, observationStart: manifest.observationStart, observationEnd: manifest.observationEnd, splitPolicyVersion: manifest.splitPolicyVersion, trainFingerprints: manifest.trainFingerprints, validationFingerprints: manifest.validationFingerprints, testFingerprints: manifest.testFingerprints, siteHoldoutFingerprints: manifest.siteHoldoutFingerprints, queryHoldoutFingerprints: manifest.queryHoldoutFingerprints, temporalHoldoutFingerprints: manifest.temporalHoldoutFingerprints, trainRowCount: manifest.trainRowCount, validationRowCount: manifest.validationRowCount, testRowCount: manifest.testRowCount, siteHoldoutRowCount: manifest.siteHoldoutRowCount, queryHoldoutRowCount: manifest.queryHoldoutRowCount, temporalHoldoutRowCount: manifest.temporalHoldoutRowCount, limitations }
  const manifestFingerprint = fingerprint(payload)
  return { ...manifest, ...payload, manifestFingerprint, manifestId: `geo-dataset-${manifestFingerprint.slice(0, 20)}`, status: 'ready_for_review', createdAt: new Date().toISOString() }
}

describe('Drizzle GEO outcome durable boundary', () => {
  it('preserves business IDs through observation, dataset, training, artifact, decision, workspace and restart', async () => {
    const { harness, repository } = readyRepository()
    const savedManifest = (await repository.getDataset(ownerUserId, readyManifestId))!
    expect(savedManifest.status).toBe('approved')
    expect((await repository.listDatasetDecisions(ownerUserId))[0]?.manifestId).toBe(savedManifest.manifestId)
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

  it('recovers an expired running lease through executeTrainingRun and finishes the claimed work', async () => {
    const { harness, repository } = readyRepository()
    const run = await createTrainingRun(ownerUserId, { datasetManifestId: readyManifestId, modelFamily: 'regularized_logistic_baseline_v1' }, repository)
    const claimed = await repository.claimTrainingRun(ownerUserId, run.trainingRunId, 'crashed-worker', new Date(Date.now() + 60_000).toISOString())
    await repository.transitionTrainingRun(ownerUserId, run.trainingRunId, { leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(), version: claimed.run.version })
    const recovered = await executeTrainingRun(ownerUserId, run.trainingRunId, repository)
    expect(recovered.status).toBe('completed')
    expect(recovered.version).toBeGreaterThan(claimed.run.version)
    expect(harness.count('geoOutcomeModelArtifacts')).toBe(1)
  })

  it('does not rerun a live lease and concurrent execute calls persist only one artifact', async () => {
    const live = readyRepository(); const liveRun = await createTrainingRun(ownerUserId, { datasetManifestId: readyManifestId, modelFamily: 'regularized_logistic_baseline_v1' }, live.repository)
    await live.repository.claimTrainingRun(ownerUserId, liveRun.trainingRunId, 'live-worker', new Date(Date.now() + 60_000).toISOString())
    expect((await executeTrainingRun(ownerUserId, liveRun.trainingRunId, live.repository)).status).toBe('running')
    expect(live.harness.count('geoOutcomeModelArtifacts')).toBe(0)

    const concurrent = readyRepository(); const run = await createTrainingRun(ownerUserId, { datasetManifestId: readyManifestId, modelFamily: 'regularized_logistic_baseline_v1' }, concurrent.repository)
    await Promise.all([executeTrainingRun(ownerUserId, run.trainingRunId, concurrent.repository), executeTrainingRun(ownerUserId, run.trainingRunId, concurrent.repository)])
    expect((await concurrent.repository.getTrainingRun(ownerUserId, run.trainingRunId))?.status).toBe('completed')
    expect(concurrent.harness.count('geoOutcomeModelArtifacts')).toBe(1)
  })

  it('deduplicates workspace readiness across replayed and overlapping manifests and ignores revoked datasets', async () => {
    const { repository } = readyRepository(); const manifest = (await repository.getDataset(ownerUserId, readyManifestId))!; const members = await repository.getDatasetMembers(ownerUserId, readyManifestId)
    const before = await getWorkspace(ownerUserId, repository)
    await repository.saveDatasetTransactional(ownerUserId, manifest, members)
    const duplicate = variantManifest(manifest, 'overlap')
    await repository.saveDatasetTransactional(ownerUserId, duplicate, members)
    await reviewDataset(ownerUserId, duplicate.manifestId, 'approve', ownerUserId, 'Approve overlapping manifest for dedupe test.', repository)
    const afterApproval = await getWorkspace(ownerUserId, repository)
    expect(afterApproval.inventory.positiveCount).toBe(before.inventory.positiveCount)
    expect(afterApproval.inventory.hardNegativeCount).toBe(before.inventory.hardNegativeCount)
    expect(afterApproval.readiness.shadow).toEqual(before.readiness.shadow)
    await reviewDataset(ownerUserId, duplicate.manifestId, 'revoke', ownerUserId, 'Terminal revoke for readiness test.', repository)
    expect((await getWorkspace(ownerUserId, repository)).readiness.shadow).toEqual(before.readiness.shadow)
  })

  it('persists dataset decision business lineage, rejects concurrent decisions and makes revoke terminal', async () => {
    const { harness, repository } = readyRepository(); const manifest = (await repository.getDataset(ownerUserId, readyManifestId))!; const members = await repository.getDatasetMembers(ownerUserId, readyManifestId)
    const duplicate = variantManifest(manifest, 'ledger'); await repository.saveDatasetTransactional(ownerUserId, duplicate, members)
    const attempts = await Promise.allSettled([reviewDataset(ownerUserId, duplicate.manifestId, 'approve', ownerUserId, 'Concurrent owner approval.', repository), reviewDataset(ownerUserId, duplicate.manifestId, 'approve', ownerUserId, 'Concurrent owner approval.', repository)])
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const decisions = await repository.listDatasetDecisions(ownerUserId); const projected = decisions.find(item => item.manifestId === duplicate.manifestId)
    expect(projected?.manifestFingerprint).toBe(duplicate.manifestFingerprint)
    const restarted = new DrizzleGeoOutcomeRepository(new StrictGeoDrizzleHarness(harness.exportState()).asDatabase())
    expect((await restarted.listDatasetDecisions(ownerUserId)).find(item => item.manifestId === duplicate.manifestId)?.decisionId).toBe(projected?.decisionId)
    await reviewDataset(ownerUserId, duplicate.manifestId, 'revoke', ownerUserId, 'Terminal dataset revoke.', repository)
    await expect(reviewDataset(ownerUserId, duplicate.manifestId, 'approve', ownerUserId, 'Cannot restore.', repository)).rejects.toThrow(/terminal/i)
    const corruptHarness = new StrictGeoDrizzleHarness(harness.exportState()); corruptHarness.corrupt('geoOutcomeDatasetDecisions', row => row.manifestFingerprint === duplicate.manifestFingerprint, { datasetManifestId: 999999 })
    await expect(new DrizzleGeoOutcomeRepository(corruptHarness.asDatabase()).listDatasetDecisions(ownerUserId)).rejects.toThrow(/dangling|corrupt/i)
  })

  it('returns the canonical stored replay and rejects concurrent run-identity payload collisions', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const intake = normalizeManualObservation(rawObservation('race1', 'cited'), ownerUserId)
    await repository.saveObservationTransactional(ownerUserId, intake)
    await seedAuthority(harness, intake, 1)
    await govern(repository, intake, 1)
    const replay = await repository.saveObservationTransactional(ownerUserId, intake)
    expect(replay.verificationStatus).toBe('verified')
    const collision = normalizeManualObservation(rawObservation('race1', 'not_cited', { page: 'another-page', evidence: 'different-evidence' }), ownerUserId)
    await expect(repository.saveObservationTransactional(ownerUserId, collision)).rejects.toThrow(/run identity collision/i)
  })

  it('requires three independent governance facts and makes revocation terminal', async () => {
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('gov1', 'cited'), ownerUserId))
    expect('registerEvidenceLocatorTransactional' in repository).toBe(false)
    await expect(repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'verify_evidence', 'Caller assertion.', observation.evidenceLocatorHashes[0])).rejects.toThrow(/not been bound/i)
    await seedAuthority(harness, observation, 1)
    expect((await executeObservationGovernanceMutation({ ownerUserId, observationFingerprint: observation.observationFingerprint, action: 'verify_evidence', reason: 'Evidence.', sourceRecordId: 1, repository })).observation.verificationStatus).toBe('unverified')
    expect((await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_consent', 'Consent.')).observation.verificationStatus).toBe('unverified')
    expect((await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'approve_pii', 'PII.')).observation.verificationStatus).toBe('verified')
    await repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'revoke', 'Terminal revoke.')
    await expect(repository.verifyObservationTransactional(ownerUserId, observation.observationFingerprint, ownerUserId, 'verify_evidence', 'Cannot restore.', observation.evidenceLocatorHashes[0])).rejects.toThrow(/terminally revoked/i)
  })

  it('binds only owner-verified manual authority and rejects provider, unverified, wrong-owner and hash mismatch sources', async () => {
    async function rejected(overrides: Parameters<typeof seedAuthority>[3], corrupt?: { table: string, patch: Record<string, unknown> }) {
      const harness = new StrictGeoDrizzleHarness(); const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
      const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('gov2', 'cited'), ownerUserId))
      await seedAuthority(harness, observation, 1, overrides)
      if (corrupt) harness.corrupt(corrupt.table, row => row.id === 1, corrupt.patch)
      await expect(repository.bindAuthoritativeEvidenceTransactional(ownerUserId, observation.observationFingerprint, 1)).rejects.toThrow()
    }
    await rejected({ mode: 'provider_api_observation', verified: false })
    await rejected({ verified: false })
    await rejected({ ownerUserId: ownerUserId + 1 })
    await rejected({ active: false })
    await rejected({}, { table: 'llmVisibilityObservations', patch: { responseHash: hash('mismatched-response') } })
    await rejected({}, { table: 'llmVisibilityObservations', patch: { evidenceLocator: 'evidence://wrong-locator' } })
    await rejected({}, { table: 'llmVisibilityQueries', patch: { promptHash: hash('wrong-query') } })
    await rejected({}, { table: 'llmVisibilityRuns', patch: { requestFingerprint: hash('wrong-run') } })
  })

  it('revalidates durable evidence against the authoritative source before release reads', async () => {
    const harness = new StrictGeoDrizzleHarness(); const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('revalidate1', 'cited'), ownerUserId))
    await seedAuthority(harness, observation, 1); await govern(repository, observation, 1)
    expect((await repository.listObservations(ownerUserId))[0]?.verificationStatus).toBe('verified')
    harness.corrupt('llmVisibilityProjects', row => row.id === 1, { status: 'archived' })
    await expect(repository.listObservations(ownerUserId)).rejects.toThrow(/stale/i)
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
    const harness = new StrictGeoDrizzleHarness()
    const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('claim1', 'cited'), ownerUserId))
    await seedAuthority(harness, observation, 1)
    await govern(repository, observation, 1)
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
    await seedAuthority(harness, stored, 1)
    await govern(repository, stored, 1)
    const built = buildCitationSelectionDataset(await repository.listObservations(ownerUserId), ownerUserId)
    await repository.saveDatasetTransactional(ownerUserId, built.manifest, built.members)
    harness.corrupt('geoOutcomeDatasetManifests', row => row.manifestId === built.manifest.manifestId, { splitFingerprints: { train: ['corrupt'] } })
    await expect(repository.getDataset(ownerUserId, built.manifest.manifestId)).rejects.toThrow(/corrupt durable/i)
  })
})
