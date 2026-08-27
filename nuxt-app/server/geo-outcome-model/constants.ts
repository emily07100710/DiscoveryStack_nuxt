export const GEO_OUTCOME_SCHEMA_VERSION = 'geo-outcome-observation-v1'
export const GEO_OUTCOME_FEATURE_CATALOG_VERSION = 'geo-outcome-feature-catalog-v1'
export const GEO_OUTCOME_LABEL_CONTRACT_VERSION = 'geo-outcome-label-contract-v1'
export const GEO_OUTCOME_HARD_NEGATIVE_POLICY_VERSION = 'hard-negative-policy-v1'
export const GEO_OUTCOME_SPLIT_POLICY_VERSION = 'site-query-connected-component-temporal-v3'
export const GEO_OUTCOME_ARTIFACT_SCHEMA_VERSION = 'geo-outcome-model-artifact-v1'
export const GEO_OUTCOME_MODEL_VERSION = 'geo-outcome-model-v1'

export const DEVELOPMENT_GATE = {
  minCandidates: 200,
  minQueryGroups: 30,
  minWebsites: 5,
  minEngines: 2,
  minPositives: 20,
  minHardNegatives: 40,
  minObservationSpanDays: 14,
} as const

export const SHADOW_GATE = {
  minCandidates: 1000,
  minQueryGroups: 100,
  minWebsites: 20,
  minEngines: 3,
  minPositives: 100,
  minHardNegatives: 200,
  minObservationSpanDays: 60,
} as const

export const MAX_OBSERVATIONS = 10_000
export const MAX_FEATURES = 128
export const MAX_TRAINING_ROWS = 20_000
export const MAX_REQUEST_BYTES = 256_000

export const ALLOWED_ENGINES = ['chatgpt', 'gemini', 'claude', 'perplexity', 'google_ai_overview', 'other'] as const
export const ALLOWED_INTERFACES = ['consumer_surface', 'provider_api', 'search_surface', 'other'] as const
export const ALLOWED_LABEL_BASES = [
  'manual_verified_primary',
  'consumer_surface_observed',
  'provider_api_secondary_only',
  'search_console_aggregate_only',
  'first_party_analytics_aggregate_only',
  'heuristic_auxiliary_only',
] as const
export const ALLOWED_VERIFICATION = ['verified', 'unverified', 'stale', 'ambiguous', 'revoked'] as const
export const ALLOWED_OBSERVABLE = ['observable', 'not_observable', 'ambiguous', 'provider_error', 'robots_blocked', 'network_error', 'permission_blocked'] as const
export const ALLOWED_RETRIEVAL = ['retrieved', 'not_retrieved', 'unknown'] as const
export const ALLOWED_CITATION = ['cited', 'not_cited', 'unknown'] as const
export const ALLOWED_STATUS = ['draft', 'gate_blocked', 'ready_for_review', 'approved', 'revoked', 'archived'] as const
export const ALLOWED_MODEL_STATUS = ['development', 'evaluation_failed', 'ready_for_owner_review', 'approved_for_shadow', 'shadow_failed', 'revoked', 'archived'] as const

export type Engine = typeof ALLOWED_ENGINES[number]
export type InterfaceName = typeof ALLOWED_INTERFACES[number]
export type LabelBasis = typeof ALLOWED_LABEL_BASES[number]
export type VerificationStatus = typeof ALLOWED_VERIFICATION[number]
export type ObservableStatus = typeof ALLOWED_OBSERVABLE[number]
export type RetrievalStatus = typeof ALLOWED_RETRIEVAL[number]
export type CitationStatus = typeof ALLOWED_CITATION[number]
export type DatasetStatus = typeof ALLOWED_STATUS[number]
export type ModelStatus = typeof ALLOWED_MODEL_STATUS[number]
export type TaskType = 'citation_selection' | 'structural_readiness_auxiliary'
export type ModelFamily = 'regularized_logistic_baseline_v1' | 'pairwise_logistic_ranker_v1'
