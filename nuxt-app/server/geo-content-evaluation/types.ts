import type {
  ContentLanguage,
  ContentQualityInput,
  ContentType,
  CoverageMetric,
  ProviderOutput,
  ProviderProvenance,
  QualityGateResult,
} from '../geo-content-quality'

export const EVALUATION_SUITE_VERSION = 'geo-content-evaluation-harness-v1' as const
export const EVALUATION_STATUSES = ['review_ready', 'blocked', 'insufficient_data'] as const
export type EvaluationStatus = typeof EVALUATION_STATUSES[number]

export const EVALUATION_METRIC_NAMES = [
  'direct-answer-presence',
  'heading-hierarchy',
  'paragraph-bounds',
  'faq-binding',
  'selected-autogeo-rule-coverage',
  'citation-marker-coverage',
  'selected-evidence-utilization',
  'unused-citation-count',
  'unsupported-factual-claim-findings',
  'authority-source-binding',
  'title-h1-alignment',
  'topic-lexical-relevance',
  'content-bounds',
  'provider-provenance-integrity',
  'human-review-requirement',
] as const
export type EvaluationMetricName = typeof EVALUATION_METRIC_NAMES[number]

export type EvaluationReasonCode =
  | 'EVALUATION_INVALID_INPUT'
  | 'EVALUATION_CASE_HASH_MISMATCH'
  | 'EVALUATION_FINGERPRINT_MISMATCH'
  | 'EVALUATION_BASELINE_MISMATCH'
  | 'EVALUATION_CASE_BLOCKED'
  | 'EVALUATION_DATA_INSUFFICIENT'
  | 'EVALUATION_METRIC_NOT_COMPARABLE'
  | 'EVALUATION_UNKNOWN_FIELD'
  | 'METRIC_NOT_APPLICABLE'
  | string

export type EvaluationMetric = {
  metricName: EvaluationMetricName
  applicable: boolean
  numerator: number
  denominator: number
  ratio: number | null
  reasonCodes: EvaluationReasonCode[]
  evidenceLocator: string[]
}

export type GeoContentEvaluationCandidateInput = {
  caseId: string
  candidateId: string
  variantLabel: string
  qualityInput: unknown
  providerOutput: unknown
  markdown: unknown
}

export type GeoContentEvaluationCase = {
  suiteVersion: typeof EVALUATION_SUITE_VERSION
  status: EvaluationStatus
  caseId: string
  contentType: ContentType | null
  locale: ContentLanguage | null
  topic: string | null
  briefFingerprint: string | null
  promptPackFingerprint: string | null
  retrievalFingerprint: string | null
  evidenceSnapshotHash: string | null
  selectedRuleIds: string[] | null
  candidateId: string
  variantLabel: string
  exactMarkdown: string | null
  contentHash: string | null
  providerProvenance: ProviderProvenance | null
  qualityInput: ContentQualityInput | null
  providerOutput: ProviderOutput | null
  qualityGateResult: QualityGateResult | null
  metrics: EvaluationMetric[]
  reasonCodes: EvaluationReasonCode[]
}

export type EvaluationCaseResult = GeoContentEvaluationCase

export type EvaluationMetricComparison = {
  metricName: EvaluationMetricName
  direction: 'higher_is_better' | 'lower_is_better'
  left: EvaluationMetric
  right: EvaluationMetric
  winner: 'left' | 'right' | 'tie' | 'not_comparable'
}

export type GeoContentCandidateComparison = {
  status: EvaluationStatus
  baselineCompatible: boolean
  leftCandidateId: string
  rightCandidateId: string
  winnerCandidateId: string | null
  decision: 'left' | 'right' | 'tie' | 'blocked' | 'insufficient_data'
  metricComparisons: EvaluationMetricComparison[]
  reasonCodes: EvaluationReasonCode[]
  limitations: string[]
}

export type EvaluationMetricAggregate = {
  metricName: EvaluationMetricName
  applicableCases: number
  numerator: number
  denominator: number
  ratio: number | null
  reasonCodes: EvaluationReasonCode[]
  evidenceLocator: string[]
}

export type GeoContentRegressionReport = {
  suiteVersion: typeof EVALUATION_SUITE_VERSION
  status: EvaluationStatus
  caseCount: number
  reviewReadyCount: number
  blockedCount: number
  insufficientDataCount: number
  cases: Array<Pick<GeoContentEvaluationCase, 'caseId' | 'candidateId' | 'variantLabel' | 'status' | 'reasonCodes' | 'metrics'>>
  metricAggregates: EvaluationMetricAggregate[]
  regressionFingerprint: string | null
  reasonCodes: EvaluationReasonCode[]
  limitations: string[]
}

export type EvaluationFingerprintResult =
  | { status: 'valid', fingerprint: string, canonicalValue: string, reasonCodes: [] }
  | { status: 'invalid', fingerprint: null, canonicalValue: null, reasonCodes: EvaluationReasonCode[] }

export type QualityGateCoverageMetric = CoverageMetric
