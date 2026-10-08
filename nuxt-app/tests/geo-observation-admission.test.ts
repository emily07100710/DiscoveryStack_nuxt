import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindAndVerifyObservationEvidence } from '../server/geo-outcome-model'
import { admitGeoObservation, getGeoObservationAdmissionWorkspace, parseAdmissionIntake, parseAdmissionWorkspaceQuery, persistedFeatureOrigin } from '../server/geo-outcome-model/admission'
import * as admissionFeatureProjection from '../server/geo-outcome-model/admission-feature-projection'
import { unknownAdmissionFeatures } from '../server/geo-outcome-model/admission-feature-projection'
import * as candidateAuthorityModule from '../server/geo-outcome-model/candidate-authority'
import { reviewCandidateSet, canonicalCandidateIdentity } from '../server/geo-outcome-model/candidate-authority'
import { fingerprint, sha256Hex } from '../server/geo-outcome-model/canonical'
import { llmVisibilityObservations, llmVisibilityProjects, llmVisibilityQueries, llmVisibilityRuns } from '../server/database/schema'
import { DrizzleGeoOutcomeRepository } from '../server/geo-outcome-model/repository-drizzle'
import { authoritativeGeoRunIdentity, authoritativeLocatorFingerprint } from '../server/geo-outcome-model/evidence-resolver'
import { normalizeManualObservation } from '../server/geo-outcome-model/normalization'
import { reviewVisibilityObservation } from '../server/llm-visibility/repository'
import { StrictGeoDrizzleHarness } from './support/strict-geo-drizzle-harness'

const ownerUserId = 42
const observedAt = new Date('2026-09-20T10:30:00.000Z')
const responseHash = sha256Hex('synthetic response hash; not response content')
const promptHash = sha256Hex('synthetic reviewed query')
const secondPromptHash = sha256Hex('a different synthetic query')
const candidateUrl = 'https://synthetic-admission.acme.com/synthetic-answer'
const candidateContentHash = sha256Hex('synthetic published content hash')

async function seedSource(harness: StrictGeoDrizzleHarness, options: { secondQuery?: boolean; reviewSource?: boolean } = {}) {
  const db = harness.asDatabase()
  await db.insert(llmVisibilityProjects).values({ ownerUserId, name: 'Synthetic project', canonicalWebsiteUrl: 'https://acme.com', canonicalDomain: 'acme.com', locale: 'en', brandName: 'Synthetic', brandAliases: [], competitorBrands: [], status: 'active' })
  const query1Insert = await db.insert(llmVisibilityQueries).values({ ownerUserId, projectId: 1, promptText: 'private synthetic prompt', promptHash, intent: 'synthetic', locale: 'en', active: true })
  const query1Id = Number(query1Insert[0]!.insertId)
  let query2Id: number | undefined
  if (options.secondQuery) {
    const query2Insert = await db.insert(llmVisibilityQueries).values({ ownerUserId, projectId: 1, promptText: 'different private synthetic prompt', promptHash: secondPromptHash, intent: 'synthetic', locale: 'en', active: true })
    query2Id = Number(query2Insert[0]!.insertId)
  }
  const runInsert = await db.insert(llmVisibilityRuns).values({ ownerUserId, projectId: 1, provider: 'manual_other', modelLabel: 'synthetic-manual-label', observationMode: 'manual_verified', status: 'completed', observedAt, requestFingerprint: sha256Hex('synthetic-run-identity'), limitationCode: 'owner_manual_snapshot' })
  const runId = Number(runInsert[0]!.insertId)
  const observationInsert = await db.insert(llmVisibilityObservations).values({ ownerUserId, projectId: 1, runId, queryId: query1Id, brandMentioned: false, exactMentionCount: 0, firstMentionPosition: null, citedDomain: 'example.test', citationUrls: [candidateUrl], competitorMentions: {}, boundedExcerpt: 'private synthetic excerpt', responseHash, evidenceLocator: 'synthetic-private-locator://not-returned', reviewerNote: 'synthetic owner-reviewed fixture', verifiedByOwner: false })
  const sourceRecordId = Number(observationInsert[0]!.insertId)
  if (options.reviewSource !== false) await reviewVisibilityObservation(ownerUserId, ownerUserId, sourceRecordId, { idempotencyKey: 'admission-source-review-1', decision: 'approve', reason: 'Synthetic test fixture owner review.' }, db)
  const secondSourceRecordId = options.secondQuery
    ? Number((await db.insert(llmVisibilityObservations).values({ ownerUserId, projectId: 1, runId, queryId: query2Id!, brandMentioned: false, exactMentionCount: 0, firstMentionPosition: null, citedDomain: 'example.test', citationUrls: [candidateUrl], competitorMentions: {}, boundedExcerpt: 'private synthetic excerpt for second query', responseHash, evidenceLocator: 'synthetic-private-locator://second-source-not-returned', reviewerNote: 'synthetic second owner-reviewed fixture', verifiedByOwner: false }))[0]!.insertId)
    : undefined
  if (secondSourceRecordId) await reviewVisibilityObservation(ownerUserId, ownerUserId, secondSourceRecordId, { idempotencyKey: 'admission-source-review-2', decision: 'approve', reason: 'Synthetic test fixture owner review.' }, db)
  return { db, sourceRecordId, secondSourceRecordId, query1Id, query2Id, runId }
}

async function saveSourceObservation(harness: StrictGeoDrizzleHarness, sourceRecordId: number, queryIdentityHash: string) {
  const identity = canonicalCandidateIdentity(candidateUrl)
  const evidenceLocator = sourceRecordId === 1 ? 'synthetic-private-locator://not-returned' : 'synthetic-private-locator://second-source-not-returned'
  const locatorHash = authoritativeLocatorFingerprint({ sourceRecordId, sourceProjectId: 1, sourceQueryId: sourceRecordId, sourceRunId: 1, sourceResponseHash: responseHash, evidenceLocator, sourceObservedAt: observedAt.toISOString() })
  const raw = {
    schemaVersion: 'geo-outcome-observation-v1', projectId: 1, clientId: null, websiteIdentityHash: identity.websiteIdentityHash,
    queryIdentityHash, normalizedQueryHash: queryIdentityHash, candidatePageIdentityHash: identity.candidatePageIdentityHash,
    canonicalPageHash: identity.canonicalPageHash, contentHash: candidateContentHash, evidenceSnapshotHash: responseHash,
    publicationReceiptFingerprint: null, engine: 'other', model: 'synthetic-manual-label', modelVersion: null, interface: 'consumer_surface', locale: 'en', region: null,
    runIdentity: sha256Hex('synthetic-run-identity'), runTimestamp: observedAt.toISOString(), observationWindow: { start: observedAt.toISOString(), end: observedAt.toISOString() },
    observableStatus: 'observable', retrievalStatus: 'retrieved', citationStatus: 'cited', citationPosition: 1, mentionStatus: 'unknown', recommendationStatus: 'unknown',
    labelBasis: 'manual_verified_primary', verificationStatus: 'unverified', evidenceLocatorHashes: [locatorHash], appliedRuleHashes: [],
    contentFeatureVector: unknownAdmissionFeatures('en'),
  }
  const repository = new DrizzleGeoOutcomeRepository(harness.asDatabase())
  return repository.saveObservationTransactional(ownerUserId, normalizeManualObservation(raw, ownerUserId))
}

async function approveCandidateSet(db: ReturnType<StrictGeoDrizzleHarness['asDatabase']>, sourceRecordId: number, idempotencyKey: string) {
  return reviewCandidateSet(db, ownerUserId, ownerUserId, { idempotencyKey, sourceRecordId, decision: 'approve', reason: 'Synthetic owner candidate-set review.', candidates: [{ candidateUrl, contentHash: candidateContentHash }] })
}

describe('GEO observation admission', () => {
  let harness: StrictGeoDrizzleHarness

  beforeEach(() => { harness = new StrictGeoDrizzleHarness() })
  afterEach(() => { vi.restoreAllMocks() })

  it('strictly parses owner-private query and intake commands', () => {
    expect(parseAdmissionWorkspaceQuery({ sourceRecordId: '12' })).toEqual({ sourceRecordId: 12 })
    expect(() => parseAdmissionWorkspaceQuery({ sourceRecordId: ['12'] })).toThrow('Admission query is invalid.')
    expect(() => parseAdmissionWorkspaceQuery({ sourceRecordId: '12', ownerUserId: '99' })).toThrow('Admission query is invalid.')
    expect(() => parseAdmissionWorkspaceQuery({ cursor: 's_@@@' })).toThrow('Admission cursor is invalid.')
    expect(() => parseAdmissionIntake({ idempotencyKey: 'synthetic-key-1', sourceRecordId: 1, candidateUrl, evidenceLocator: 'caller-controlled' })).toThrow('unsupported field')
    expect(() => parseAdmissionIntake({ idempotencyKey: 'synthetic-key-1', sourceRecordId: 1, candidateUrl: 'http://example.test' })).toThrow('public HTTPS')
    expect(() => authoritativeGeoRunIdentity(0, sha256Hex('synthetic-request'))).toThrow('source run identity is invalid')
    expect(() => authoritativeGeoRunIdentity(1, 'not-a-hash')).toThrow('source run identity is invalid')
  })

  it('allows owner review of an approved source before any candidate set exists, then admits only a pending observation', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    const withoutSet = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db)
    expect(withoutSet.selectedSource).toMatchObject({ eligible: true, candidateSets: [], candidateAuthorities: [], intakeEnabled: false })
    expect(JSON.stringify(withoutSet)).not.toContain('private synthetic prompt')
    expect(JSON.stringify(withoutSet)).not.toContain('private synthetic excerpt')
    expect(JSON.stringify(withoutSet)).not.toContain('synthetic-private-locator')

    const set = await approveCandidateSet(db, sourceRecordId, 'admission-candidate-set-1')
    const ready = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db)
    expect(ready.selectedSource?.intakeEnabled).toBe(true)
    expect(ready.selectedSource?.candidateAuthorities).toHaveLength(1)
    expect(ready.selectedSource?.candidateAuthorities[0]?.citationStatus).toBe('cited')

    const input = { idempotencyKey: 'admission-intake-1', sourceRecordId, candidateUrl }
    const admitted = await admitGeoObservation(ownerUserId, input, db)
    expect(admitted).toMatchObject({ status: 'success', observation: { citationStatus: 'cited', verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown', featureOrigin: 'unknown_external', governanceIndependent: true, trainingAdmission: false, productionActivation: false, replayed: false } })
    const repository = new DrizzleGeoOutcomeRepository(db)
    const persisted = await repository.getObservation(ownerUserId, admitted.observation.observationFingerprint)
    expect(persisted).toMatchObject({ engine: 'other', model: 'synthetic-manual-label', queryIdentityHash: promptHash, evidenceSnapshotHash: responseHash, contentHash: candidateContentHash, verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown', mentionStatus: 'unknown', recommendationStatus: 'unknown' })
    await expect(admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-intake-new-key-same-source', sourceRecordId, candidateUrl }, db))
      .rejects.toMatchObject({ statusCode: 409, code: 'observation_already_exists', message: 'An observation already exists for this exact source and candidate.' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(1)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(1)

    // This same binding path is used by later owner verification; manual_other
    // must be normalized to GEO engine `other` without weakening exact lineage.
    await expect(bindAndVerifyObservationEvidence(ownerUserId, admitted.observation.observationFingerprint, ownerUserId, sourceRecordId, 'Synthetic exact-source verification.', repository)).resolves.toMatchObject({ evidenceBinding: { serverDerivedCitationStatus: 'cited', serverDerivedCitationPosition: 1 } })
    const replay = await admitGeoObservation(ownerUserId, input, db)
    expect(replay.observation).toMatchObject({ replayed: true, verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown', trainingAdmission: false, productionActivation: false })
    const refreshed = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db)
    expect(refreshed.selectedSource?.candidateAuthorities[0]?.observation).toMatchObject({ verificationStatus: 'unverified', consentStatus: 'unknown', piiStatus: 'unknown' })
    expect(set.memberCount).toBe(1)
  })

  it('ignores a same-run different-query/source observation and admits the same page independently', async () => {
    const { db, sourceRecordId, secondSourceRecordId } = await seedSource(harness, { secondQuery: true })
    await approveCandidateSet(db, sourceRecordId, 'admission-candidate-set-a')
    await approveCandidateSet(db, secondSourceRecordId!, 'admission-candidate-set-b')
    const firstObservation = await saveSourceObservation(harness, sourceRecordId, promptHash)
    const repository = new DrizzleGeoOutcomeRepository(db)
    await expect(bindAndVerifyObservationEvidence(ownerUserId, firstObservation.observationFingerprint, ownerUserId, secondSourceRecordId!, 'Synthetic cross-query binding must fail.', repository)).rejects.toThrow()
    const requestFingerprint = sha256Hex('synthetic-run-identity')
    expect(authoritativeGeoRunIdentity(sourceRecordId, requestFingerprint)).not.toBe(authoritativeGeoRunIdentity(secondSourceRecordId!, requestFingerprint))
    expect(authoritativeGeoRunIdentity(secondSourceRecordId!, requestFingerprint)).toBe(authoritativeGeoRunIdentity(secondSourceRecordId!, requestFingerprint))
    expect(authoritativeGeoRunIdentity(secondSourceRecordId!, requestFingerprint)).toBe(fingerprint({
      purpose: 'geo_outcome_source_run_identity', schemaVersion: 'geo-outcome-source-run-identity-v1',
      sourceRecordId: secondSourceRecordId, requestFingerprint,
    }))

    const second = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(secondSourceRecordId) }, db)
    expect(second.selectedSource?.eligible).toBe(true)
    expect(second.selectedSource?.intakeEnabled).toBe(true)
    expect(second.selectedSource?.candidateAuthorities[0]?.observation).toBeNull()
    const admitted = await admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-intake-query-b', sourceRecordId: secondSourceRecordId, candidateUrl }, db)
    expect(admitted.observation.candidatePageIdentityHash).toBe(firstObservation.candidatePageIdentityHash)
    expect(admitted.observation.observationFingerprint).not.toBe(firstObservation.observationFingerprint)
    expect(admitted.observation.verificationStatus).toBe('unverified')

    const secondAfter = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(secondSourceRecordId) }, db)
    expect(secondAfter.selectedSource?.candidateAuthorities[0]?.observation).toMatchObject({ verificationStatus: 'unverified', citationStatus: 'cited' })
  })

  it('marks a conflicting row with the exact source locator ambiguous', async () => {
    const { db, secondSourceRecordId } = await seedSource(harness, { secondQuery: true })
    await approveCandidateSet(db, secondSourceRecordId!, 'admission-candidate-set-conflict')
    await saveSourceObservation(harness, secondSourceRecordId!, promptHash)
    const workspace = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(secondSourceRecordId) }, db)
    expect(workspace.selectedSource?.candidateAuthorities[0]?.observation).toMatchObject({ verificationStatus: 'ambiguous', consentStatus: 'unknown', piiStatus: 'unknown' })
    expect(workspace.selectedSource?.intakeEnabled).toBe(false)
  })

  it('blocks new intake when an exact same-source legacy raw-run observation already exists', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-legacy-candidate-set')
    const legacy = await saveSourceObservation(harness, sourceRecordId, promptHash)
    const result = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db)
    expect(result.selectedSource?.candidateAuthorities[0]?.observation).toMatchObject({
      observationFingerprint: legacy.observationFingerprint, verificationStatus: 'unverified', citationStatus: 'cited',
    })
    await expect(admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-new-key-after-legacy', sourceRecordId, candidateUrl }, db))
      .rejects.toMatchObject({ statusCode: 409, code: 'observation_already_exists' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(1)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(1)
    expect(harness.count('geoOutcomeIdempotencyClaims')).toBe(0)
  })

  it('keeps an unreviewed source visible but ineligible for candidate review or intake', async () => {
    const { db, sourceRecordId } = await seedSource(harness, { reviewSource: false })
    const workspace = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db)
    expect(workspace.selectedSource).toMatchObject({ eligible: false, intakeEnabled: false })
    expect(workspace.selectedSource?.reasonCodes).toContain('source_review_required')
    await expect(approveCandidateSet(db, sourceRecordId, 'unreviewed-candidate-set')).rejects.toThrow()
    expect(harness.count('geoOutcomeCandidateSetDecisions')).toBe(0)
  })

  it('fails closed on revoked candidate authority and does not treat the old review as current permission', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    const approved = await approveCandidateSet(db, sourceRecordId, 'admission-candidate-set-to-revoke')
    const revoked = await reviewCandidateSet(db, ownerUserId, ownerUserId, {
      idempotencyKey: 'admission-candidate-set-revoke', sourceRecordId, decision: 'revoke',
      reason: 'Synthetic test authority revocation.', candidateSetFingerprint: approved.candidateSetFingerprint,
    })
    expect(revoked.decision).toBe('revoke')
    const workspace = await getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db)
    expect(workspace.selectedSource?.intakeEnabled).toBe(false)
    await expect(admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-after-revoke', sourceRecordId, candidateUrl }, db))
      .rejects.toMatchObject({ code: 'authority_not_eligible' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(0)
  })

  it('rolls back a failed claim for retry, reuses the key after authority is approved, and rejects a changed body', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    const input = { idempotencyKey: 'admission-retry-after-authority', sourceRecordId, candidateUrl }
    await expect(admitGeoObservation(ownerUserId, input, db)).rejects.toMatchObject({ code: 'authority_not_eligible' })
    expect(harness.count('geoOutcomeIdempotencyClaims')).toBe(0)
    await approveCandidateSet(db, sourceRecordId, 'admission-retry-candidate-set')
    const first = await admitGeoObservation(ownerUserId, input, db)
    expect(first.observation.replayed).toBe(false)
    await expect(admitGeoObservation(ownerUserId, { ...input, candidateUrl: 'https://synthetic-admission.acme.com/changed' }, db))
      .rejects.toMatchObject({ code: 'idempotency_collision' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(1)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(1)
  })

  it('rejects a durable replay projection whose exact source or page identity was corrupted', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-replay-candidate-set')
    const input = { idempotencyKey: 'admission-replay-corrupt', sourceRecordId, candidateUrl }
    const admitted = await admitGeoObservation(ownerUserId, input, db)
    const corruptProjection = { ...admitted.observation, sourceRecordId: sourceRecordId + 1 }
    harness.corrupt('geoOutcomeIdempotencyClaims', row => row.idempotencyKey === input.idempotencyKey, {
      responseProjection: corruptProjection,
      responseFingerprint: fingerprint(corruptProjection),
    })
    await expect(admitGeoObservation(ownerUserId, input, db)).rejects.toMatchObject({ code: 'invalid_replay' })
    const pageCorruption = { ...admitted.observation, candidatePageIdentityHash: 'a'.repeat(64) }
    harness.corrupt('geoOutcomeIdempotencyClaims', row => row.idempotencyKey === input.idempotencyKey, {
      responseProjection: pageCorruption,
      responseFingerprint: fingerprint(pageCorruption),
    })
    await expect(admitGeoObservation(ownerUserId, input, db)).rejects.toMatchObject({ code: 'invalid_replay' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(1)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(1)
  })

  it('maps feature-storage failures to a safe error and rolls back the claim and observation', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-storage-failure-candidate-set')
    vi.spyOn(admissionFeatureProjection, 'getAdmissionFeatureProjection').mockRejectedValue(new Error('synthetic storage detail must not escape'))
    await expect(admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-storage-failure', sourceRecordId, candidateUrl }, db))
      .rejects.toMatchObject({ statusCode: 503, code: 'storage_unavailable', message: 'GEO admission storage is unavailable.' })
    expect(harness.count('geoOutcomeIdempotencyClaims')).toBe(0)
    expect(harness.count('geoOutcomeObservationRuns')).toBe(0)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(0)
  })

  it('does not relabel a feature-storage failure as an ambiguous observation in GET', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-get-storage-candidate-set')
    await admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-get-storage-seed', sourceRecordId, candidateUrl }, db)
    vi.spyOn(admissionFeatureProjection, 'getAdmissionFeatureProjection').mockRejectedValue(new Error('private synthetic read failure'))
    await expect(getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db))
      .rejects.toMatchObject({ statusCode: 503, code: 'storage_unavailable', message: 'GEO admission storage is unavailable.' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(1)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(1)
  })

  it('returns safe 503 when checked source review storage is unavailable instead of showing a blocked source', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    vi.spyOn(candidateAuthorityModule, 'resolveReviewedManualSnapshot').mockRejectedValue(new Error('synthetic DB outage detail'))
    await expect(getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db))
      .rejects.toMatchObject({ statusCode: 503, code: 'storage_unavailable', message: 'GEO admission storage is unavailable.' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(0)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(0)
  })

  it('returns safe 503 for storage failure while resolving an existing observation authority', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-existing-authority-storage-set')
    await admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-existing-authority-storage-seed', sourceRecordId, candidateUrl }, db)
    vi.spyOn(candidateAuthorityModule, 'resolveCandidateAuthority').mockRejectedValue(new Error('synthetic DB outage detail'))
    await expect(getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db))
      .rejects.toMatchObject({ statusCode: 503, code: 'storage_unavailable', message: 'GEO admission storage is unavailable.' })
  })

  it('returns safe 503 for storage failure while resolving the selected candidate authority', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-selected-authority-storage-set')
    vi.spyOn(candidateAuthorityModule, 'resolveCandidateAuthority').mockRejectedValue(new Error('synthetic DB outage detail'))
    await expect(getGeoObservationAdmissionWorkspace(ownerUserId, { sourceRecordId: String(sourceRecordId) }, db))
      .rejects.toMatchObject({ statusCode: 503, code: 'storage_unavailable', message: 'GEO admission storage is unavailable.' })
    expect(harness.count('geoOutcomeObservationRuns')).toBe(0)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(0)
  })

  it('returns safe 503 and rolls back idempotency when intake authority storage reads fail', async () => {
    const { db, sourceRecordId } = await seedSource(harness)
    await approveCandidateSet(db, sourceRecordId, 'admission-intake-authority-storage-set')
    vi.spyOn(candidateAuthorityModule, 'resolveCandidateAuthority').mockRejectedValue(new Error('synthetic DB outage detail'))
    await expect(admitGeoObservation(ownerUserId, { idempotencyKey: 'admission-intake-authority-storage', sourceRecordId, candidateUrl }, db))
      .rejects.toMatchObject({ statusCode: 503, code: 'storage_unavailable', message: 'GEO admission storage is unavailable.' })
    expect(harness.count('geoOutcomeIdempotencyClaims')).toBe(0)
    expect(harness.count('geoOutcomeObservationRuns')).toBe(0)
    expect(harness.count('geoOutcomeObservationCandidates')).toBe(0)
  })

  it('reports exact feature origin only when the persisted vector exactly matches the current server projection', () => {
    const projection = { featureOrigin: 'exact_publication_draft' as const, features: { ...unknownAdmissionFeatures('en'), contentType: 'article' as const, headingHierarchy: 'structured' as const } }
    expect(persistedFeatureOrigin({ contentFeatureVector: projection.features }, projection)).toBe('exact_publication_draft')
    expect(persistedFeatureOrigin({ contentFeatureVector: { ...projection.features, headingHierarchy: 'flat' } }, projection)).toBe('unknown_external')
  })
})
