import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildDataset, normalizeTrustedObservation, reviewDataset } from '../server/geo-outcome-model'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import type { MemoryGeoOutcomeState } from '../server/geo-outcome-model/types'
import { trainApprovedLearningDataset } from '../server/learning-loop/training'
import { getDraftLearningAdvice } from '../server/learning-loop/model-advice'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import { learningFixture } from './support/learning-loop-memory-repository'

// Entirely synthetic fixtures. Trusted normalization/seeded status here are NOT owner approval in production.
function syntheticObservation(index: number, cited: boolean) {
  const group = `synthetic-group-${index}`, page = `${group}-${cited ? 'positive' : 'negative'}`
  const timestamp = new Date(Date.UTC(2025, 0, index + 1)).toISOString()
  return normalizeTrustedObservation({
    schemaVersion: 'geo-outcome-observation-v1', projectId: null, clientId: null,
    websiteIdentityHash: fingerprint(`site-${index}`), queryIdentityHash: fingerprint(group), normalizedQueryHash: fingerprint(group),
    candidatePageIdentityHash: fingerprint(page), canonicalPageHash: fingerprint(`canonical-${index}`), contentHash: fingerprint(`content-${page}`), evidenceSnapshotHash: fingerprint(`evidence-${group}`), publicationReceiptFingerprint: fingerprint(`receipt-${page}`),
    engine: ['chatgpt', 'gemini', 'perplexity'][index % 3], model: 'synthetic-test-model', modelVersion: 'v1', interface: 'consumer_surface', locale: 'en', region: 'US', runIdentity: `run-${group}`, runTimestamp: timestamp,
    observationWindow: { start: timestamp, end: new Date(Date.UTC(2025, 0, index + 1, 1)).toISOString() }, observableStatus: 'observable', retrievalStatus: 'retrieved', citationStatus: cited ? 'cited' : 'not_cited', citationPosition: cited ? 1 : null, mentionStatus: cited ? 'mentioned' : 'not_mentioned', recommendationStatus: 'unknown', labelBasis: 'manual_verified_primary', verificationStatus: 'verified', evidenceLocatorHashes: [fingerprint(`locator-${page}`)], appliedRuleHashes: [],
    contentFeatureVector: { contentType: 'article', locale: 'en', pageAgeBucket: '8_30d', contentLengthBucket: cited ? 'l' : 's', headingHierarchy: cited ? 'structured' : 'flat', directAnswerPresence: cited ? 'present' : 'absent', faqStructure: 'absent', structuredDataPresence: cited ? 'present' : 'absent', citationMarkerCount: cited ? 3 : 0, approvedAuthoritySourceCount: cited ? 2 : 0, evidenceUtilizationRatio: cited ? .8 : .1, entityCoverage: cited ? .8 : .1, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'valid', indexabilityFlag: 'indexable', internalLinkDepthBucket: '1', contentFreshnessBucket: 'fresh', queryPageLexicalOverlap: cited ? .8 : .1, topicClusterEqual: 'yes', verifiedPublicationAgeDays: 10, priorObservationCount: 1 },
  }, 1)
}
let approvedState: MemoryGeoOutcomeState, trainedState: MemoryGeoOutcomeState, manifestId: string, artifactId: string
beforeAll(async () => {
  const repository = createMemoryGeoOutcomeRepository()
  for (let index = 0; index < 120; index++) for (const cited of [true, false]) await repository.saveObservationTransactional(1, syntheticObservation(index, cited))
  const built = await buildDataset(1, 'citation_selection', repository)
  expect(built.memberCount).toBe(240); expect(built.manifest.readiness.ready).toBe(true)
  manifestId = built.manifest.manifestId
  await reviewDataset(1, manifestId, 'approve', 1, 'Synthetic fixture only: exercise genuine fitting and holdout evaluation.', repository)
  approvedState = repository.exportState()
  const result = await trainApprovedLearningDataset(1, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, repository)
  expect(result.status).toBe('completed'); expect(result.currentLineageValid).toBe(true)
  artifactId = result.artifact!.artifactId; trainedState = repository.exportState()
})

async function adviceFixture() {
  const f = learningFixture()
  await createLearningAuthorization(1, f.input, { repository: f.repository, now: () => f.now })
  const state = structuredClone(trainedState)
  // Tests only: advice is independently gated by current model/dataset/grant state.
  state.artifacts[0]!.status = 'approved_for_shadow'
  const models = createMemoryGeoOutcomeRepository(state)
  const title = 'Synthetic current draft', body = '# Synthetic answer\n\nA bounded evidence-based response.\n\n## Sources\n\n[cite:fixture-source]'
  const hash = contentFingerprint(title, body)
  const lineage = { client: { id: 2, ownerUserId: 1, canonicalSiteOrigin: 'https://client.acme.taipei' }, entry: { id: 17, ownerUserId: 1, contentHash: hash, contentType: 'article', language: 'en', evidenceSnapshotHash: 'e'.repeat(64) }, draft: { id: 29, version: 1, title, body, contentHash: hash }, deliverable: { opportunityKey: 'synthetic-opportunity' } }
  const operations = { resolveWorkspaceEntry: vi.fn(async () => structuredClone(lineage)) } as any
  return { ...f, models, operations, lineage, input: { entryId: 17, artifactId } }
}

describe('real deterministic model stages through the closed-loop entrypoint', () => {
  it('fits only train rows and outputs separate holdout metrics with no production activation', async () => {
    const repository = createMemoryGeoOutcomeRepository(trainedState), artifact = await repository.getArtifact(1, artifactId), dataset = await repository.getDataset(1, manifestId)
    expect(artifact?.trainingRowCount).toBe(dataset?.trainRowCount)
    for (const scope of ['validation', 'test', 'siteHoldout', 'queryHoldout', 'temporalHoldout'] as const) expect(artifact?.evaluationMetrics[scope].status).toBe('ok')
    expect(artifact?.status).toBe('ready_for_owner_review')
    expect(artifact?.coefficients.some(value => Math.abs(value) > 1e-8)).toBe(true)
  })
  it('supports the genuine pairwise trainer without weakening the dataset gate', async () => {
    const result = await trainApprovedLearningDataset(1, { datasetManifestId: manifestId, modelFamily: 'pairwise_logistic_ranker_v1' }, createMemoryGeoOutcomeRepository(approvedState))
    expect(result).toMatchObject({ status: 'completed', currentLineageValid: true, productionActivation: false })
    expect(result.artifact?.modelFamily).toBe('pairwise_logistic_ranker_v1')
    expect(JSON.stringify(result)).not.toContain('coefficients')
  })
  it('blocks missing durable approval, revoked members and cross-owner training before fitting', async () => {
    const state = structuredClone(approvedState); state.datasetDecisions = []
    await expect(trainApprovedLearningDataset(1, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, createMemoryGeoOutcomeRepository(state))).rejects.toMatchObject({ data: { code: 'OWNER_APPROVED_READY_DATASET_REQUIRED' } })
    const revoked = structuredClone(approvedState); revoked.datasetMembers[manifestId]![0]!.observation.consentStatus = 'revoked'
    await expect(trainApprovedLearningDataset(1, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, createMemoryGeoOutcomeRepository(revoked))).rejects.toMatchObject({ data: { code: 'CURRENT_DATASET_GOVERNANCE_REQUIRED' } })
    await expect(trainApprovedLearningDataset(99, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1' }, createMemoryGeoOutcomeRepository(approvedState))).rejects.toMatchObject({ data: { code: 'OWNER_APPROVED_READY_DATASET_REQUIRED' } })
  })
  it('rejects caller-authored approvals, custom weights or unknown model families', async () => {
    for (const extra of [{ ownerApproved: true }, { modelFamily: 'unverified-transformer' }, { coefficients: [1] }]) await expect(trainApprovedLearningDataset(1, { datasetManifestId: manifestId, modelFamily: 'regularized_logistic_baseline_v1', ...extra }, createMemoryGeoOutcomeRepository(approvedState))).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('hash-bound draft advice never acts as publication or observed truth', () => {
  it('scores a server-read exact draft, reports missing features and changes no content/labels', async () => {
    const f = await adviceFixture(), before = await f.models.listObservations(1)
    const result = await getDraftLearningAdvice(1, f.input, { operations: f.operations, learning: f.repository, models: f.models, now: f.now })
    expect(result).toMatchObject({ entryId: 17, draftId: 29, contentHash: f.lineage.draft.contentHash, predictionIsVerifiedOutcome: false, publicationAuthorization: false, productionModelActivation: false })
    expect(result.experimentalScore).toBeGreaterThanOrEqual(0); expect(result.experimentalScore).toBeLessThanOrEqual(1)
    expect(result.missingFeatureList.length).toBeGreaterThan(0)
    expect(result.featureContributions.every(row => !result.missingFeatureList.includes(row.key))).toBe(true)
    expect(await f.models.listObservations(1)).toEqual(before)
    expect(JSON.stringify(result)).not.toContain(f.lineage.draft.title)
  })
  it.each(['revoked_grant', 'edited_draft', 'tampered_artifact', 'revoked_dataset'])('blocks %s', async kind => {
    const f = await adviceFixture(), state = f.models.exportState()
    if (kind === 'revoked_grant') await f.repository.revokeAuthorization(1, 1, f.now)
    if (kind === 'edited_draft') f.lineage.draft.body += '\nEdited without a new hash.'
    if (kind === 'tampered_artifact') { state.artifacts[0]!.coefficients[0] = 999; f.models = createMemoryGeoOutcomeRepository(state) }
    if (kind === 'revoked_dataset') { await reviewDataset(1, manifestId, 'revoke', 1, 'Synthetic revocation.', f.models) }
    await expect(getDraftLearningAdvice(1, f.input, { operations: f.operations, learning: f.repository, models: f.models, now: f.now })).rejects.toMatchObject({ statusCode: 409 })
  })
  it.each(['consent', 'source', 'dataset', 'draft', 'version', 'evidence', 'client', 'language'])('fails closed if %s changes during scoring', async kind => {
    const f = await adviceFixture(), original = f.models.listObservations.bind(f.models)
    vi.spyOn(f.models, 'listObservations').mockImplementationOnce(async owner => {
      if (kind === 'consent') await f.repository.revokeAuthorization(1, 1, f.now)
      if (kind === 'source') f.repository.sources[0]!.sourceFingerprint = 'f'.repeat(64)
      if (kind === 'dataset') await reviewDataset(1, manifestId, 'revoke', 1, 'Synthetic concurrent revoke.', f.models)
      if (kind === 'draft') f.lineage.draft.body += '\nChanged during scoring.'
      if (kind === 'version') f.lineage.draft.version += 1
      if (kind === 'evidence') f.lineage.entry.evidenceSnapshotHash = '9'.repeat(64)
      if (kind === 'client') f.lineage.client.id += 1
      if (kind === 'language') f.lineage.entry.language = 'zh-hant'
      return original(owner)
    })
    await expect(getDraftLearningAdvice(1, f.input, { operations: f.operations, learning: f.repository, models: f.models, now: f.now })).rejects.toMatchObject({ data: { code: 'ADVICE_LINEAGE_CHANGED' } })
  })
})
