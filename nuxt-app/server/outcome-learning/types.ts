export const OUTCOME_LEARNING_ENGINE_VERSION = 'outcome-learning-loop-engine-v1' as const

export const outcomeMeasurementSources = [
  'google_search_console',
  'llm_visibility',
  'first_party_analytics',
  'crm_aggregate',
] as const
export type OutcomeMeasurementSource = (typeof outcomeMeasurementSources)[number]

export const outcomeStatuses = ['ready', 'partial', 'insufficient_data', 'blocked'] as const
export type OutcomeStatus = (typeof outcomeStatuses)[number]

export const outcomeSignals = [
  'positive_signal',
  'negative_signal',
  'no_material_change',
  'mixed_signal',
  'insufficient_data',
] as const
export type OutcomeSignal = (typeof outcomeSignals)[number]

export const outcomeContentTypes = ['article', 'faq', 'service_page', 'landing_page', 'other'] as const
export type OutcomeContentType = (typeof outcomeContentTypes)[number]

export const outcomeLanguages = ['en', 'zh-hant'] as const
export type OutcomeLanguage = (typeof outcomeLanguages)[number]

export interface PublicationIdentity {
  deidentifiedSubjectKey: string
  scheduleEntryId: string
  scheduleKey: string
  productionPlanId: string
  jobId: string
  draftId: string
  draftVersion: string
  contentHash: string
  evidenceSnapshotHash: string
  publishedAt: string
  contentType: OutcomeContentType
  language: OutcomeLanguage
  appliedRuleIds: string[]
  topicClusterCode: string
}

export interface OutcomeMeasurement {
  source: OutcomeMeasurementSource
  deidentifiedSubjectKey: string
  scopeFingerprint: string
  phase: 'baseline' | 'follow_up'
  windowStart: string
  windowEnd: string
  capturedAt: string
  sourceHash: string
  metrics: Record<string, number>
}

export interface NormalizedOutcomeMeasurement extends OutcomeMeasurement {
  derivedMetrics: Record<string, number>
  durationDays: number
}

export interface OutcomeAssessmentRequest {
  publication: PublicationIdentity
  baselineMeasurements: unknown[]
  followUpMeasurements: unknown[]
  dataContractVersion: string
}

export interface OutcomeMetricComparison {
  source: OutcomeMeasurementSource
  baselineWindow: { start: string; end: string }
  followUpWindow: { start: string; end: string }
  baselineDailyMetrics: Record<string, number>
  followUpDailyMetrics: Record<string, number>
  baselineDerivedMetrics: Record<string, number>
  followUpDerivedMetrics: Record<string, number>
  signal: OutcomeSignal
  sourceHashes: string[]
}

export interface PublishedContentOutcomeAssessment {
  status: OutcomeStatus
  signal: OutcomeSignal
  publication: PublicationIdentity
  comparisons: OutcomeMetricComparison[]
  validPairCount: number
  validSourceCount: number
  reasonCodes: string[]
  limitations: string[]
  policyVersion: 'outcome-learning-loop-policy-v1'
  engineVersion: typeof OUTCOME_LEARNING_ENGINE_VERSION
  assessmentFingerprint: string
}

export interface ConsentLineage {
  consentStatus: 'granted' | 'not_granted' | 'unknown'
  consentVersion: string
  consentedAt: string | null
  consentAllowedUses: string[]
  consentRevokedAt: string | null
  rightsConfirmed: boolean
}

export interface BlockedOutcomeLearningCandidate {
  candidateStatus: 'blocked'
  reasonCodes: string[]
  limitations: string[]
  policyVersion: 'outcome-learning-loop-policy-v1'
  engineVersion: typeof OUTCOME_LEARNING_ENGINE_VERSION
  candidateFingerprint: string
}

export type OutcomeLearningCandidateResult = OutcomeLearningCandidate | BlockedOutcomeLearningCandidate

export interface OutcomeLearningCandidate {
  candidateStatus: 'eligible'
  deidentifiedSubjectKey: string
  publicationIdentityHashes: string[]
  contentType: OutcomeContentType
  language: OutcomeLanguage
  appliedRuleIds: string[]
  topicClusterCode: string
  aggregateNumericFeatures: Record<string, number>
  directionalLabels: Array<{ source: OutcomeMeasurementSource; signal: OutcomeSignal }>
  sourceHashes: string[]
  measurementSources: OutcomeMeasurementSource[]
  policyVersion: 'outcome-learning-loop-policy-v1'
  engineVersion: typeof OUTCOME_LEARNING_ENGINE_VERSION
  consentLineage: ConsentLineage
  dataContractVersion: string
  limitations: string[]
  candidateFingerprint: string
}

export interface OutcomeLearningInput {
  outcomeRequest: unknown
  assessment: unknown
  consent: unknown
  piiScanStatus: 'none_detected' | 'detected' | 'unknown'
  dataContractVersion: string
}

export interface OutcomeDatasetManifest {
  status: 'gate_blocked' | 'ready_for_dataset_review'
  eligibleCandidateCount: number
  trainCandidateFingerprints: string[]
  validationCandidateFingerprints: string[]
  testCandidateFingerprints: string[]
  candidateFingerprints: string[]
  sourceCombinationCount: number
  contentTypeCounts: Record<string, number>
  languageCounts: Record<string, number>
  policyVersion: 'outcome-learning-loop-policy-v1'
  engineVersion: typeof OUTCOME_LEARNING_ENGINE_VERSION
  reasonCodes: string[]
  limitations: string[]
  manifestFingerprint: string
}

export interface OutcomeDatasetManifestInput {
  candidates: unknown[]
}

export interface ModelEvaluationMetrics {
  factualErrorRate: number
  blockedContentEscapeRate: number
  citationReadiness: number
  taskQuality: number
}

export interface ModelReleaseGateRequest {
  baselineModelArtifactHash: string
  candidateModelArtifactHash: string
  datasetManifestHash: string
  evaluationContractVersion: string
  evaluationCaseCount: number
  baselineMetrics: ModelEvaluationMetrics
  candidateMetrics: ModelEvaluationMetrics
  shadowRunStatus: 'pending' | 'passed' | 'failed'
  canaryRunStatus: 'pending' | 'passed' | 'failed'
  rollbackArtifactAvailable: boolean
  safetyIncidents: number
  evaluatedAt: string
}

export interface ModelReleaseGateResult {
  decision: 'gate_blocked' | 'shadow_ready' | 'canary_ready' | 'promotion_ready'
  reasonCodes: string[]
  limitations: string[]
  policyVersion: 'outcome-learning-loop-policy-v1'
  engineVersion: typeof OUTCOME_LEARNING_ENGINE_VERSION
  releaseFingerprint: string
}
