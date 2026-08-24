import {
  assessPublishedContentOutcome,
  buildOutcomeLearningCandidate,
  outcomeSha256,
  normalizeOutcomeTimestamp,
  type ModelReleaseGateRequest,
  type OutcomeContentType,
  type OutcomeLanguage,
  type OutcomeMeasurementSource,
  type PublicationIdentity,
} from '../../../server/outcome-learning'

export const SUBJECT_KEY = 'a'.repeat(64)
export const SCOPE_KEY = 'b'.repeat(64)
export const DATA_CONTRACT_VERSION = 'outcome-contract-v1'

export function makePublication(overrides: Partial<PublicationIdentity> = {}): PublicationIdentity {
  return {
    deidentifiedSubjectKey: SUBJECT_KEY,
    scheduleEntryId: 'schedule-entry-001',
    scheduleKey: 'schedule-key-001',
    productionPlanId: 'production-plan-001',
    jobId: 'job-001',
    draftId: 'draft-001',
    draftVersion: 'v1',
    contentHash: outcomeSha256({ content: 'synthetic content' }),
    evidenceSnapshotHash: outcomeSha256({ evidence: 'synthetic evidence' }),
    publishedAt: '2025-01-10T00:00:00.000Z',
    contentType: 'article',
    language: 'en',
    appliedRuleIds: ['rule-b', 'rule-a'],
    topicClusterCode: 'topic-cluster-001',
    ...overrides,
  }
}

const defaultMetrics: Record<OutcomeMeasurementSource, Record<string, number>> = {
  google_search_console: { impressions: 700, clicks: 70, averagePosition: 10 },
  llm_visibility: { queryCount: 100, mentionCount: 20, citationCount: 10 },
  first_party_analytics: { sessions: 100, engagedSessions: 60 },
  crm_aggregate: { qualifiedLeads: 20, conversions: 4 },
}

export function makeMeasurement(overrides: Partial<{
  source: OutcomeMeasurementSource
  phase: 'baseline' | 'follow_up'
  deidentifiedSubjectKey: string
  scopeFingerprint: string
  windowStart: string
  windowEnd: string
  capturedAt: string
  metrics: Record<string, number>
  sourceHash: string
}> = {}) {
  const source = overrides.source ?? 'google_search_console'
  const phase = overrides.phase ?? 'baseline'
  const base = phase === 'baseline'
    ? { windowStart: '2025-01-01T00:00:00.000Z', windowEnd: '2025-01-08T00:00:00.000Z', capturedAt: '2025-01-08T12:00:00.000Z' }
    : { windowStart: '2025-01-10T00:00:00.000Z', windowEnd: '2025-01-17T00:00:00.000Z', capturedAt: '2025-01-18T00:00:00.000Z' }
  const metrics = { ...defaultMetrics[source], ...(overrides.metrics ?? {}) }
  const payload = {
    source,
    deidentifiedSubjectKey: overrides.deidentifiedSubjectKey ?? SUBJECT_KEY,
    scopeFingerprint: overrides.scopeFingerprint ?? SCOPE_KEY,
    phase,
    windowStart: normalizeOutcomeTimestamp(overrides.windowStart ?? base.windowStart) ?? '',
    windowEnd: normalizeOutcomeTimestamp(overrides.windowEnd ?? base.windowEnd) ?? '',
    capturedAt: normalizeOutcomeTimestamp(overrides.capturedAt ?? base.capturedAt) ?? '',
    metrics,
  }
  return { ...payload, sourceHash: overrides.sourceHash ?? outcomeSha256(payload) }
}

export function makeOutcomeRequest(overrides: Partial<{
  publication: PublicationIdentity
  baselineMeasurements: unknown[]
  followUpMeasurements: unknown[]
  dataContractVersion: string
}> = {}) {
  return {
    publication: overrides.publication ?? makePublication(),
    baselineMeasurements: overrides.baselineMeasurements ?? [makeMeasurement()],
    followUpMeasurements: overrides.followUpMeasurements ?? [makeMeasurement({ phase: 'follow_up', metrics: { impressions: 1400, clicks: 210, averagePosition: 8 } })],
    dataContractVersion: overrides.dataContractVersion ?? DATA_CONTRACT_VERSION,
  }
}

export function makeGrantedConsent(overrides: Partial<{
  consentStatus: 'granted' | 'not_granted' | 'unknown'
  consentVersion: string
  consentedAt: string | null
  consentAllowedUses: string[]
  consentRevokedAt: string | null
  rightsConfirmed: boolean
}> = {}) {
  return {
    consentStatus: 'granted' as const,
    consentVersion: 'consent-v1',
    consentedAt: '2025-01-01T00:00:00.000Z',
    consentAllowedUses: ['model_improvement'],
    consentRevokedAt: null,
    rightsConfirmed: true,
    ...overrides,
  }
}

export function makeCandidateInput(overrides: Partial<{
  publication: PublicationIdentity
  outcomeRequest: unknown
  consent: unknown
  piiScanStatus: 'none_detected' | 'detected' | 'unknown'
  dataContractVersion: string
}> = {}) {
  const outcomeRequest = overrides.outcomeRequest ?? makeOutcomeRequest({ publication: overrides.publication })
  const assessment = assessPublishedContentOutcome(outcomeRequest)
  return {
    outcomeRequest,
    assessment,
    consent: overrides.consent ?? makeGrantedConsent(),
    piiScanStatus: overrides.piiScanStatus ?? 'none_detected',
    dataContractVersion: overrides.dataContractVersion ?? DATA_CONTRACT_VERSION,
  }
}

export function makeEligibleCandidate(index = 0, contentType: OutcomeContentType = 'article', language: OutcomeLanguage = 'en', sources: OutcomeMeasurementSource[] = ['google_search_console']) {
  const publication = makePublication({
    draftId: `draft-${String(index).padStart(3, '0')}`,
    jobId: `job-${String(index).padStart(3, '0')}`,
    contentType,
    language,
    topicClusterCode: `topic-${String(index).padStart(3, '0')}`,
  })
  const outcomeRequest = makeOutcomeRequest({
    publication,
    baselineMeasurements: sources.map((source) => makeMeasurement({ source })),
    followUpMeasurements: sources.map((source) => makeMeasurement({ source, phase: 'follow_up' })),
  })
  const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication, outcomeRequest }))
  if (result.candidateStatus !== 'eligible') throw new Error(`Synthetic candidate ${index} was not eligible`)
  return result
}

export function makePassingReleaseGate(overrides: Partial<ModelReleaseGateRequest> = {}): ModelReleaseGateRequest {
  return {
    baselineModelArtifactHash: outcomeSha256({ model: 'baseline' }),
    candidateModelArtifactHash: outcomeSha256({ model: 'candidate' }),
    datasetManifestHash: outcomeSha256({ manifest: 'synthetic' }),
    evaluationContractVersion: 'evaluation-contract-v1',
    evaluationCaseCount: 100,
    baselineMetrics: { factualErrorRate: 0.2, blockedContentEscapeRate: 0.05, citationReadiness: 0.7, taskQuality: 0.7 },
    candidateMetrics: { factualErrorRate: 0.1, blockedContentEscapeRate: 0.02, citationReadiness: 0.8, taskQuality: 0.72 },
    shadowRunStatus: 'passed',
    canaryRunStatus: 'passed',
    rollbackArtifactAvailable: true,
    safetyIncidents: 0,
    evaluatedAt: '2025-02-01T00:00:00.000Z',
    ...overrides,
  }
}
