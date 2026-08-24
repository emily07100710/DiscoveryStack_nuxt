import type { OutcomeMeasurementSource } from './types'

export const OUTCOME_LEARNING_POLICY_VERSION = 'outcome-learning-loop-policy-v1' as const

export const OUTCOME_MAX_MEASUREMENTS = 100
export const OUTCOME_MAX_PUBLICATIONS = 20
export const OUTCOME_MAX_METRIC_FIELDS = 500
export const OUTCOME_MIN_FOLLOW_UP_DAYS = 7
export const OUTCOME_MAX_FOLLOW_UP_DAYS = 90
export const OUTCOME_MIN_READY_SOURCES = 2
export const OUTCOME_SIGNAL_DELTA_THRESHOLD = 0.05
export const OUTCOME_POSITION_DELTA_THRESHOLD = 0.5
export const OUTCOME_MIN_EVALUATION_CASES = 100
export const OUTCOME_MIN_TASK_QUALITY_IMPROVEMENT = 0.01
export const OUTCOME_MIN_DATASET_CANDIDATES = 150
export const OUTCOME_MIN_CONTENT_TYPE_COUNT = 20
export const OUTCOME_MIN_LANGUAGE_COUNT = 20
export const OUTCOME_SPLIT_TRAIN_RATIO = 0.8
export const OUTCOME_SPLIT_VALIDATION_RATIO = 0.1
export const OUTCOME_SPLIT_TEST_RATIO = 0.1

export const OUTCOME_SOURCE_ORDER: readonly OutcomeMeasurementSource[] = [
  'google_search_console',
  'llm_visibility',
  'first_party_analytics',
  'crm_aggregate',
]

export const OUTCOME_POLICY_LIMITATIONS = [
  'observational_not_causal',
  'platform_measurement_may_change',
  'attribution_not_established',
  'external_factors_not_controlled',
  'deidentified reference is pseudonymous and not fully anonymous',
  'This V1 does not call external APIs, submit training jobs, or change production models.',
] as const

export const OUTCOME_FORBIDDEN_REASON_CODES = [
  'INVALID_INPUT',
  'INVALID_PUBLICATION_IDENTITY',
  'INVALID_TIMESTAMP',
  'INVALID_HASH',
  'INVALID_METRIC',
  'SOURCE_MISMATCH',
  'SUBJECT_MISMATCH',
  'SCOPE_MISMATCH',
  'WINDOW_MISMATCH',
  'OVERLAPPING_WINDOWS',
  'DUPLICATE_MEASUREMENT',
  'DUPLICATE_SOURCE_HASH',
  'TOO_MANY_MEASUREMENTS',
  'TOO_MANY_PUBLICATIONS',
  'TOO_MANY_METRIC_FIELDS',
  'NO_VALID_PAIR',
  'CONSENT_REQUIRED',
  'CONSENT_REVOKED',
  'CONSENT_USE_NOT_ALLOWED',
  'RIGHTS_NOT_CONFIRMED',
  'PII_DETECTED',
  'DATA_CONTRACT_MISSING',
  'FORBIDDEN_PAYLOAD_KEY',
  'CANDIDATE_NOT_ELIGIBLE',
  'DUPLICATE_CANDIDATE',
  'DUPLICATE_PUBLICATION_LINEAGE',
  'DATASET_ADMISSION_GATE_BLOCKED',
  'INVALID_MODEL_EVIDENCE',
  'EVALUATION_CASES_INSUFFICIENT',
  'FACTUAL_ERROR_REGRESSION',
  'BLOCKED_CONTENT_ESCAPE_REGRESSION',
  'CITATION_READINESS_REGRESSION',
  'TASK_QUALITY_NOT_IMPROVED',
  'SAFETY_REGRESSION',
  'SHADOW_RUN_REQUIRED',
  'CANARY_RUN_REQUIRED',
  'ROLLBACK_ARTIFACT_REQUIRED',
] as const

export const OUTCOME_POLICY_LIMITATIONS_FOR_DATASET = [
  'Dataset admission is a governance gate, not proof of model quality or causal effectiveness.',
  'Deterministic train/validation/test assignment does not remove sampling or platform bias.',
  'Eligible candidates contain aggregate and deidentified references only; no raw content or visitor-level records are admitted.',
] as const

export const OUTCOME_POLICY_LIMITATIONS_FOR_RELEASE = [
  'promotion_ready is an evidence gate only; it is not deployed and does not change production configuration.',
  'Evaluation evidence is observational and bounded by the supplied aggregate contract.',
] as const
