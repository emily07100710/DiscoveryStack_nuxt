import { describe, expect, it } from 'vitest'
import { buildDatasetKnowledgeAuthority } from '../server/geo-outcome-model/knowledge-authority'
import { assignModelOpsAdvisory } from '../server/geo-outcome-model/modelops-advisory'
import { createMemoryModelOpsRepository } from '../server/geo-outcome-model/modelops-memory-repository'
import { createModelOpsCycle, createModelOpsPolicy, executeModelOpsCycle } from '../server/geo-outcome-model/modelops-service'
import { createMemoryGeoOutcomeRepository } from './support/geo-outcome-memory-repository'
import { normalizeTrustedObservation } from '../server/geo-outcome-model'
import { sha256Hex } from '../server/geo-outcome-model/canonical'
import type { GeoOutcomeRepositoryPort, ModelArtifact } from '../server/geo-outcome-model/types'
import type { ModelOpsCycle, ModelOpsPolicy, ModelOpsShadowEvaluation } from '../server/geo-outcome-model/modelops-types'

const hash = (value: string) => sha256Hex(value)
const OWNER = 72

function rawObservation(index: number, citationStatus: 'cited' | 'not_cited') {
  const group = `knowledge-modelops-group-${index}`
  const page = `${group}-${citationStatus}`
  const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString()
  const positive = citationStatus === 'cited'
  return {
    schemaVersion: 'geo-outcome-observation-v1', projectId: null, clientId: null,
    websiteIdentityHash: hash(`knowledge-modelops-site-${index}`), queryIdentityHash: hash(group), normalizedQueryHash: hash(group), candidatePageIdentityHash: hash(page), canonicalPageHash: hash(`canonical-${index}`), contentHash: hash(page), evidenceSnapshotHash: hash(group), publicationReceiptFingerprint: hash(`receipt-${page}`),
    engine: index % 3 === 0 ? 'chatgpt' : index % 3 === 1 ? 'gemini' : 'perplexity', model: 'fixture', modelVersion: 'v1', interface: 'consumer_surface', locale: 'en', region: 'US', runIdentity: `run-${group}`, runTimestamp: date, observationWindow: { start: date, end: new Date(Date.parse(date) + 60_000).toISOString() }, observableStatus: 'observable', retrievalStatus: 'retrieved', citationStatus, citationPosition: positive ? 1 : null, mentionStatus: positive ? 'mentioned' : 'not_mentioned', recommendationStatus: 'unknown', labelBasis: 'manual_verified_primary', verificationStatus: 'verified', evidenceLocatorHashes: [hash(`locator-${group}`)], appliedRuleHashes: [],
    contentFeatureVector: { contentType: 'article', locale: 'en', pageAgeBucket: '8_30d', contentLengthBucket: positive ? 'l' : 's', headingHierarchy: positive ? 'structured' : 'flat', directAnswerPresence: positive ? 'present' : 'absent', faqStructure: 'absent', structuredDataPresence: positive ? 'present' : 'absent', citationMarkerCount: positive ? 3 : 0, approvedAuthoritySourceCount: positive ? 2 : 0, evidenceUtilizationRatio: positive ? .8 : .1, entityCoverage: positive ? .8 : .1, selectedAutoGeoRuleHashes: [], appliedAutoGeoRuleHashes: [], canonicalFlag: 'valid', indexabilityFlag: 'indexable', internalLinkDepthBucket: '1', contentFreshnessBucket: 'fresh', queryPageLexicalOverlap: positive ? .8 : .1, topicClusterEqual: 'yes', verifiedPublicationAgeDays: 10, priorObservationCount: 1 },
  }
}

describe('Knowledge authority in ModelOps', () => {
  it('stops a newly built dataset at owner review instead of silently declaring no dependencies', async () => {
    const outcome = createMemoryGeoOutcomeRepository()
    const modelOps = createMemoryModelOpsRepository(undefined, () => new Date('2026-01-01T00:00:00.000Z'))
    for (let index = 1; index <= 500; index++) {
      await outcome.saveObservationTransactional(OWNER, normalizeTrustedObservation(rawObservation(index, 'cited'), OWNER))
      await outcome.saveObservationTransactional(OWNER, normalizeTrustedObservation(rawObservation(index, 'not_cited'), OWNER))
    }
    const policy = await createModelOpsPolicy(OWNER, { cadence: 'weekly', minimumNewVerifiedCandidates: 200, minimumNewQueryGroups: 30, minimumNewWebsites: 5, minimumObservationSpanDays: 14, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 0, shadowEvaluationEnabled: true, autonomousExecutionEnabled: true, expiresAt: null }, 'knowledge-authority-modelops-policy', modelOps)
    await modelOps.updatePolicy(OWNER, policy.policyId, { status: 'enabled', authorizedByOwnerUserId: OWNER, authorizedAt: '2026-01-01T00:00:00.000Z' })
    const cycle = await createModelOpsCycle(OWNER, 'scheduled', 'knowledge-authority-modelops-cycle', outcome, modelOps, new Date('2026-01-01T00:00:00.000Z'))
    const result = await executeModelOpsCycle(OWNER, cycle.cycleId, outcome, modelOps, 'knowledge-authority-modelops-worker', new Date('2026-01-01T00:00:00.000Z'))
    expect(result.dataset?.status).toBe('ready_for_review')
    expect(result.trainingRun).toBeNull()
    expect(result.cycle).toMatchObject({ status: 'blocked', reasonCodes: ['needs_owner_review'], errorClass: 'dataset_authority_review' })
    expect((await outcome.listDatasetDecisions(OWNER))).toEqual([])
  }, 15000)

  it('rechecks candidate and current dataset authority after the shadow-ledger await', async () => {
    const manifestId = 'knowledge-modelops-dataset'
    const manifestFingerprint = hash('knowledge-modelops-manifest')
    const state = { ownerUserId: OWNER, manifestId, manifestFingerprint, nativeDatasetId: 9, heads: [] }
    const authority = buildDatasetKnowledgeAuthority(state, 'declared_none_v1')
    const decision = { decisionId: 'knowledge-modelops-dataset-decision', ownerUserId: OWNER, manifestId, manifestFingerprint, previousStatus: 'ready_for_review', newStatus: 'approved', reviewerUserId: OWNER, reason: 'Owner approved no native Knowledge dependencies for this dataset.', createdAt: '2026-01-01T00:00:00.000Z', knowledgeAuthority: authority }
    const dataset = { manifestId, manifestFingerprint, ownerUserId: OWNER, status: 'approved', trainFingerprints: [hash('train')], validationFingerprints: [], testFingerprints: [], siteHoldoutFingerprints: [], queryHoldoutFingerprints: [], temporalHoldoutFingerprints: [], trainRowCount: 1, validationRowCount: 0, testRowCount: 0, siteHoldoutRowCount: 0, queryHoldoutRowCount: 0, temporalHoldoutRowCount: 0 } as never
    const reference = { datasetDecisionId: decision.decisionId, knowledgeAuthorityFingerprint: authority.authorityFingerprint }
    const artifact = (artifactId: string, artifactHash: string): ModelArtifact => ({ artifactId, artifactHash, status: 'approved_for_shadow', datasetManifestFingerprint: manifestFingerprint, datasetDecisionId: reference.datasetDecisionId, knowledgeAuthorityFingerprint: reference.knowledgeAuthorityFingerprint, taskType: 'citation_selection', modelFamily: 'regularized_logistic_baseline_v1', featureCatalogVersion: 'geo-outcome-feature-catalog-v1', labelContractVersion: 'geo-outcome-label-contract-v1' } as unknown as ModelArtifact)
    const candidate = artifact('candidate', hash('candidate'))
    const current = artifact('current', hash('current'))
    const shadow: ModelOpsShadowEvaluation = { evaluationId: 'knowledge-modelops-shadow', ownerUserId: OWNER, artifactId: candidate.artifactId, artifactHash: candidate.artifactHash, evaluationWindowStart: '2026-01-01T00:00:00.000Z', evaluationWindowEnd: '2026-01-02T00:00:00.000Z', observationFingerprints: [hash('observation')], candidateCount: 1, positiveCount: 1, negativeCount: 1, queryGroupCount: 1, websiteCount: 1, engineCounts: {}, binaryMetrics: {}, rankingMetrics: {}, calibrationDiagnostics: {}, driftDiagnostics: {}, status: 'completed', reasonCodes: [], evaluationFingerprint: hash('shadow'), createdAt: '2026-01-03T00:00:00.000Z' }
    const policy: ModelOpsPolicy = { policyId: 'knowledge-modelops-policy', ownerUserId: OWNER, status: 'enabled', cadence: 'weekly', minimumNewVerifiedCandidates: 1, minimumNewQueryGroups: 1, minimumNewWebsites: 1, minimumObservationSpanDays: 1, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 0, shadowEvaluationEnabled: true, autonomousExecutionEnabled: true, authorizedByOwnerUserId: OWNER, authorizedAt: '2026-01-01T00:00:00.000Z', expiresAt: null, configurationFingerprint: hash('policy'), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revokedAt: null }
    const cycle: ModelOpsCycle = { cycleId: 'knowledge-modelops-cycle', ownerUserId: OWNER, policyId: policy.policyId, policyFingerprint: policy.configurationFingerprint, trigger: 'scheduled', status: 'running', readinessSnapshotFingerprint: hash('readiness'), eligibleObservationFingerprints: [], previousApprovedDatasetFingerprint: null, generatedDatasetFingerprint: manifestFingerprint, trainingRunId: 'training', modelArtifactId: candidate.artifactId, artifactHash: candidate.artifactHash, shadowEvaluationFingerprint: shadow.evaluationFingerprint, reasonCodes: [], limitations: [], errorClass: null, startedAt: '2026-01-01T00:00:00.000Z', completedAt: null, attempt: 1, leaseOwner: 'worker', leaseExpiresAt: '2026-01-04T00:00:00.000Z', leaseVersion: 1, idempotencyKey: 'knowledge-cycle-key', inputFingerprint: hash('cycle'), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    let stale = false
    const outcome = {
      getArtifact: async (_owner: number, id: string) => structuredClone(id === candidate.artifactId ? candidate : current),
      listArtifacts: async () => [structuredClone(current), structuredClone(candidate)],
      listDatasets: async () => [structuredClone(dataset)],
      getDataset: async () => structuredClone(dataset),
      listDatasetDecisions: async () => [structuredClone(decision)],
      readDatasetKnowledgeState: async () => stale ? { ...state, heads: [{ subjectKind: 'entity', subjectId: 3, operation: 'bind', sequenceNumber: 1, bindingFingerprint: hash('binding'), revisionNumber: 1, revisionContentHash: hash('revision-content'), revisionFingerprint: hash('revision'), currentRevisionFingerprint: hash('revision') }] } : structuredClone(state),
      getDatasetMembers: async () => [{ memberFingerprint: hash('member') }],
    } as unknown as GeoOutcomeRepositoryPort
    const modelOps = createMemoryModelOpsRepository({ policies: [policy], cycles: [cycle], events: [], shadowEvaluations: [shadow], rollbackDecisions: [], advisoryAssignments: [] })
    const delayedModelOps = new Proxy(modelOps, { get(target, property) {
      if (property === 'listShadowEvaluations') return async (...args: Parameters<typeof target.listShadowEvaluations>) => { const result = await target.listShadowEvaluations(...args); stale = true; return result }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    await expect(assignModelOpsAdvisory({ ownerUserId: OWNER, policyId: policy.policyId, cycleId: cycle.cycleId, candidateArtifactId: candidate.artifactId, currentArtifactHash: current.artifactHash }, outcome, delayedModelOps)).rejects.toThrow(/dependency_approval_stale|dependencies_require|authority rejected/i)
    expect(await modelOps.listAdvisoryAssignments(OWNER)).toEqual([])
  })
})
