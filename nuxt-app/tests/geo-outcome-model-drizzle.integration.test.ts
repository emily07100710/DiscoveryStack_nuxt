import { beforeAll, describe, expect, it } from 'vitest'
import { withMutationIdempotency } from '../server/api/geo-outcome-model/_helpers'
import { executeObservationGovernanceMutation } from '../server/api/geo-outcome-model/observation-governance-mutation'
import { executeCandidateSetReviewMutation } from '../server/api/geo-outcome-model/candidate-set-review-mutation'
import { buildCitationSelectionDataset } from '../server/geo-outcome-model/dataset-builder'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import { bindAndVerifyObservationEvidence, createTrainingRun, executeTrainingRun, getWorkspace, reviewDataset } from '../server/geo-outcome-model/service'
import { normalizeManualObservation } from '../server/geo-outcome-model/normalization'
import { fingerprint, sha256Hex } from '../server/geo-outcome-model/canonical'
import { authoritativeLocatorFingerprint } from '../server/geo-outcome-model/evidence-resolver'
import { canonicalCandidateIdentity, reviewCandidateSet } from '../server/geo-outcome-model/candidate-authority'
import { reviewVisibilityObservation } from '../server/llm-visibility/repository'
import { llmVisibilityObservations, llmVisibilityProjects, llmVisibilityQueries, llmVisibilityRuns } from '../server/database/schema'
import type { DatasetManifest, OutcomeObservation } from '../server/geo-outcome-model/types'
import { StrictGeoDrizzleHarness } from './support/strict-geo-drizzle-harness'

const ownerUserId = 42
const hash = (value: string) => sha256Hex(value)
const candidateUrl = (sourceRecordId: number, status: 'cited' | 'not_cited') => `https://site${sourceRecordId}.acme.com/geo/${status}`
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
  const identity = canonicalCandidateIdentity(candidateUrl(sourceRecordId, citationStatus))
  return {
    schemaVersion: 'geo-outcome-observation-v1',
    projectId: 1,
    clientId: null,
    websiteIdentityHash: overrides.website ? hash(String(overrides.website)) : identity.websiteIdentityHash,
    queryIdentityHash: queryHash,
    normalizedQueryHash: queryHash,
    candidatePageIdentityHash: overrides.page ? hash(String(overrides.page)) : identity.candidatePageIdentityHash,
    canonicalPageHash: overrides.canonical ? hash(String(overrides.canonical)) : identity.canonicalPageHash,
    contentHash: hash(String(overrides.content || `content-${sourceRecordId}-${citationStatus}`)),
    evidenceSnapshotHash: responseHash,
    publicationReceiptFingerprint: null,
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
  if (harness.count('llmVisibilityProjects') === 0) await database.insert(llmVisibilityProjects).values({ ownerUserId: sourceOwner, name: 'Evidence project', canonicalWebsiteUrl: 'https://www.acme.com', canonicalDomain: 'acme.com', locale: 'en', brandName: 'Acme', brandAliases: [], competitorBrands: [], status: overrides.active === false ? 'archived' : 'active' })
  await database.insert(llmVisibilityQueries).values({ ownerUserId: sourceOwner, projectId: 1, promptText: `Prompt ${sourceRecordId}`, promptHash: observation.normalizedQueryHash, intent: 'evidence', locale: 'en', active: overrides.active !== false })
  await database.insert(llmVisibilityRuns).values({ ownerUserId: sourceOwner, projectId: 1, provider: observation.engine as 'chatgpt' | 'gemini', modelLabel: observation.model, observationMode: overrides.mode || 'manual_verified', status: 'completed', observedAt: new Date(observation.runTimestamp), requestFingerprint: observation.runIdentity, limitationCode: 'owner_manual_snapshot' })
  await database.insert(llmVisibilityObservations).values({ ownerUserId: sourceOwner, projectId: 1, runId: sourceRecordId, queryId: sourceRecordId, brandMentioned: true, exactMentionCount: 1, firstMentionPosition: 1, citedDomain: `site${sourceRecordId}.acme.com`, citationUrls: [candidateUrl(sourceRecordId, 'cited')], competitorMentions: {}, boundedExcerpt: 'Bounded owner-reviewed evidence.', responseHash: observation.evidenceSnapshotHash, evidenceLocator: `evidence://llm-visibility/${sourceRecordId}`, reviewerNote: 'Pending snapshot.', verifiedByOwner: overrides.verified !== false })
  if ((overrides.mode || 'manual_verified') === 'manual_verified' && overrides.verified !== false && sourceOwner === ownerUserId && overrides.active !== false) {
    await reviewVisibilityObservation(ownerUserId, ownerUserId, sourceRecordId, { idempotencyKey: `llm-review-${sourceRecordId}`, decision: 'approve', reason: 'Independent owner review.' }, database)
    await reviewCandidateSet(database, ownerUserId, ownerUserId, { idempotencyKey: `candidate-review-${sourceRecordId}`, sourceRecordId, decision: 'approve', reason: 'Owner attested the complete observable candidate set.', candidates: [
      { candidateUrl: candidateUrl(sourceRecordId, 'cited'), contentHash: hash(`content-${sourceRecordId}-cited`) },
      { candidateUrl: candidateUrl(sourceRecordId, 'not_cited'), contentHash: hash(`content-${sourceRecordId}-not_cited`) },
    ] })
  }
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
  it('binds cited and uncited labels only to exact members of the same approved candidate set', async () => {
    const harness = new StrictGeoDrizzleHarness(); const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const cited = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('exact1', 'cited'), ownerUserId))
    const uncited = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('exact1', 'not_cited'), ownerUserId))
    await seedAuthority(harness, cited, 1)
    await expect(repository.bindAuthoritativeEvidenceTransactional(ownerUserId, cited.observationFingerprint, 1)).resolves.toMatchObject({ serverDerivedCitationStatus: 'cited', serverDerivedCitationPosition: 1 })
    await expect(repository.bindAuthoritativeEvidenceTransactional(ownerUserId, uncited.observationFingerprint, 1)).resolves.toMatchObject({ serverDerivedCitationStatus: 'not_cited', serverDerivedCitationPosition: null })

    const arbitraryHarness = new StrictGeoDrizzleHarness(); const arbitraryRepository = new DrizzleGeoOutcomeRepository(arbitraryHarness.asDatabase())
    const arbitrary = await arbitraryRepository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('arbitrary1', 'not_cited', { page: 'not-in-candidate-set', canonical: 'not-in-candidate-set', content: 'not-in-candidate-set' }), ownerUserId))
    await seedAuthority(arbitraryHarness, arbitrary, 1)
    await expect(arbitraryRepository.bindAuthoritativeEvidenceTransactional(ownerUserId, arbitrary.observationFingerprint, 1)).rejects.toThrow(/absent|candidate/i)
  })

  it('rejects caller label flips and candidate page, content, owner and source-lineage mismatches', async () => {
    const identity = canonicalCandidateIdentity(candidateUrl(1, 'cited'))
    const cases: Array<[string, Record<string, unknown>]> = [
      ['label-flip', { citationStatus: 'not_cited', citationPosition: null, candidatePageIdentityHash: identity.candidatePageIdentityHash, canonicalPageHash: identity.canonicalPageHash, websiteIdentityHash: identity.websiteIdentityHash, contentHash: hash('content-1-cited') }],
      ['page-hash', { canonicalPageHash: hash('wrong-page-hash') }],
      ['content-hash', { contentHash: hash('wrong-content-hash') }],
      ['website-hash', { websiteIdentityHash: hash('wrong-website-hash') }],
    ]
    for (const [name, overrides] of cases) {
      const harness = new StrictGeoDrizzleHarness(); const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
      const raw = { ...rawObservation(`${name}1`, 'cited'), ...overrides }
      const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(raw, ownerUserId))
      await seedAuthority(harness, observation, 1)
      await expect(repository.bindAuthoritativeEvidenceTransactional(ownerUserId, observation.observationFingerprint, 1)).rejects.toThrow(/match|absent|candidate/i)
    }
  })

  it('uses one deterministic exact URL policy for host, query, percent, fragment, port and Unicode forms', () => {
    const exact = canonicalCandidateIdentity('https://www.acme.com/a?x=1&y=2')
    expect(canonicalCandidateIdentity('https://www.acme.com:443/a?x=1&y=2#ignored').canonicalCandidateUrlHash).toBe(exact.canonicalCandidateUrlHash)
    expect(canonicalCandidateIdentity('https://www.acme.com/a?y=2&x=1').canonicalCandidateUrlHash).not.toBe(exact.canonicalCandidateUrlHash)
    expect(canonicalCandidateIdentity('https://www.acme.com/a/extra?x=1&y=2').canonicalCandidateUrlHash).not.toBe(exact.canonicalCandidateUrlHash)
    expect(canonicalCandidateIdentity('https://sub.www.acme.com/a?x=1&y=2').canonicalCandidateUrlHash).not.toBe(exact.canonicalCandidateUrlHash)
    expect(canonicalCandidateIdentity('https://www.acme.com/%7Eowner').canonicalCandidateUrlHash).toBe(canonicalCandidateIdentity('https://www.acme.com/%7Eowner#fragment').canonicalCandidateUrlHash)
    expect(canonicalCandidateIdentity('https://bücher.de/path').canonicalCandidateUrlHash).toBe(canonicalCandidateIdentity('https://xn--bcher-kva.de/path').canonicalCandidateUrlHash)
  })

  it('requires a durable manual review ledger and keeps provider or legacy booleans secondary-only', async () => {
    const legacy = new StrictGeoDrizzleHarness(); const legacyRepository = new DrizzleGeoOutcomeRepository(legacy.asDatabase())
    const observation = await legacyRepository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('legacy1', 'cited'), ownerUserId))
    await seedAuthority(legacy, observation, 1, { verified: false })
    legacy.corrupt('llmVisibilityObservations', row => row.id === 1, { verifiedByOwner: true })
    await expect(legacyRepository.bindAuthoritativeEvidenceTransactional(ownerUserId, observation.observationFingerprint, 1)).rejects.toThrow(/durable owner approval/i)

    const provider = new StrictGeoDrizzleHarness(); const providerRepository = new DrizzleGeoOutcomeRepository(provider.asDatabase())
    const providerObservation = await providerRepository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('provider1', 'cited'), ownerUserId))
    await seedAuthority(provider, providerObservation, 1, { mode: 'provider_api_observation', verified: false })
    await expect(providerRepository.bindAuthoritativeEvidenceTransactional(ownerUserId, providerObservation.observationFingerprint, 1)).rejects.toThrow(/provider|secondary/i)
  })

  it('makes manual review replay canonical, collision-safe, concurrent, durable and terminally revocable', async () => {
    const harness = new StrictGeoDrizzleHarness(); const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const observation = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('review1', 'cited'), ownerUserId))
    await seedAuthority(harness, observation, 1, { verified: false })
    const database = harness.asDatabase()
    const input = { idempotencyKey: 'manual-review-key-1', decision: 'approve' as const, reason: 'Independent owner review.' }
    const [first, replay] = await Promise.all([reviewVisibilityObservation(ownerUserId, ownerUserId, 1, input, database), reviewVisibilityObservation(ownerUserId, ownerUserId, 1, input, database)])
    expect(replay).toEqual(first)
    expect(harness.count('llmVisibilityObservationReviews')).toBe(1)
    await expect(executeCandidateSetReviewMutation({ ownerUserId, reviewerUserId: ownerUserId, database, body: { idempotencyKey: 'candidate-route-forged', sourceRecordId: 1, decision: 'approve', reason: 'Forged route body.', verifiedByOwner: true, candidates: [{ candidateUrl: candidateUrl(1, 'cited'), contentHash: hash('content-1-cited'), candidatePageIdentityHash: hash('caller-forged') }] } })).rejects.toThrow(/invalid/i)
    await expect(executeCandidateSetReviewMutation({ ownerUserId, reviewerUserId: ownerUserId, database, body: { idempotencyKey: 'candidate-route-fake-receipt', sourceRecordId: 1, decision: 'approve', reason: 'Receipt must resolve from publication ledger.', candidates: [{ candidateUrl: candidateUrl(1, 'cited'), contentHash: hash('content-1-cited'), publicationReceiptFingerprint: hash('missing-receipt') }] } })).rejects.toThrow(/publication receipt/i)
    const candidateReview = await executeCandidateSetReviewMutation({ ownerUserId, reviewerUserId: ownerUserId, database, body: { idempotencyKey: 'candidate-route-valid', sourceRecordId: 1, decision: 'approve', reason: 'Owner reviewed observable candidates.', candidates: [{ candidateUrl: candidateUrl(1, 'cited'), contentHash: hash('content-1-cited') }, { candidateUrl: candidateUrl(1, 'not_cited'), contentHash: hash('content-1-not_cited') }] } })
    expect(candidateReview.memberCount).toBe(2)
    await expect(reviewVisibilityObservation(ownerUserId, ownerUserId, 1, { ...input, reason: 'Collision.' }, database)).rejects.toThrow(/collision/i)
    const competing = await Promise.allSettled([
      reviewVisibilityObservation(ownerUserId, ownerUserId, 1, { idempotencyKey: 'manual-review-key-2', decision: 'approve', reason: 'Duplicate decision.' }, database),
      reviewVisibilityObservation(ownerUserId, ownerUserId, 1, { idempotencyKey: 'manual-review-key-3', decision: 'approve', reason: 'Duplicate decision.' }, database),
    ])
    expect(competing.every(item => item.status === 'rejected')).toBe(true)
    const revoked = await reviewVisibilityObservation(ownerUserId, ownerUserId, 1, { idempotencyKey: 'manual-review-revoke-1', decision: 'revoke', reason: 'Terminal source revoke.' }, database)
    expect(revoked.newStatus).toBe('revoked')
    const restarted = new StrictGeoDrizzleHarness(harness.exportState())
    await expect(reviewVisibilityObservation(ownerUserId, ownerUserId, 1, { idempotencyKey: 'manual-review-after-restart', decision: 'approve', reason: 'Cannot restore.' }, restarted.asDatabase())).rejects.toThrow(/terminal/i)
  })

  it('revalidates candidate-set revocation and blocks an already governed dataset source', async () => {
    const harness = new StrictGeoDrizzleHarness(); const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
    const cited = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('revoke1', 'cited'), ownerUserId))
    const uncited = await repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(rawObservation('revoke1', 'not_cited'), ownerUserId))
    await seedAuthority(harness, cited, 1); await govern(repository, cited, 1); await govern(repository, uncited, 1)
    expect(buildCitationSelectionDataset(await repository.listObservations(ownerUserId), ownerUserId).members).toHaveLength(2)
    const setRow = harness.exportState().tables.geoOutcomeCandidateSetDecisions?.find(row => row.decisionType === 'approve')
    await reviewCandidateSet(harness.asDatabase(), ownerUserId, ownerUserId, { idempotencyKey: 'candidate-revoke-1', sourceRecordId: 1, decision: 'revoke', reason: 'Candidate observability authority revoked.', candidateSetFingerprint: String(setRow?.candidateSetFingerprint) })
    await expect(repository.listObservations(ownerUserId)).rejects.toThrow(/revoked|stale/i)
  })

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
    harness.corrupt('llmVisibilityObservations', row => row.id === 1, { citationUrls: [candidateUrl(1, 'cited'), 'https://other.acme.com/drift'] })
    await expect(repository.listObservations(ownerUserId)).rejects.toThrow(/stale|lineage/i)
    harness.corrupt('llmVisibilityObservations', row => row.id === 1, { citationUrls: [candidateUrl(1, 'cited')] })
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
