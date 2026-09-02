export const PROBE_ENGINE_VERSION = 'llm_visibility_probe_engine_v1' as const
export const PROBE_PROVIDERS = ['chatgpt', 'gemini', 'perplexity'] as const
export const PROBE_LOCALES = ['en', 'zh-hant'] as const
export const PROBE_TARGET_STATUSES = ['active', 'paused'] as const
export const PROBE_PLAN_STATUSES = ['planned', 'blocked'] as const
export const PROBE_RESULT_STATUSES = ['completed', 'blocked', 'failed', 'retryable'] as const
export const PROBE_LIMITATION_CODE = 'provider_api_not_consumer_surface' as const

export type ProbeProvider = typeof PROBE_PROVIDERS[number]
export type ProbeLocale = typeof PROBE_LOCALES[number]
export type ProviderTargetStatus = typeof PROBE_TARGET_STATUSES[number]
export type ProbePlanStatus = typeof PROBE_PLAN_STATUSES[number]
export type ProbeResultStatus = typeof PROBE_RESULT_STATUSES[number]

export type ProjectIdentity = {
  projectId: string
  canonicalWebsiteDomain: string
  brandName: string
  brandAliases: string[]
  competitorBrands: string[]
  locale: ProbeLocale
}

export type QuerySnapshot = {
  queryId: string
  projectId: string
  promptText: string
  promptHash: string
  intent: string
  locale: ProbeLocale
  active: boolean
}

export type ProviderTarget = {
  provider: ProbeProvider
  modelLabel: string
  adapterKey: string
  status: ProviderTargetStatus
  allowedLocales: ProbeLocale[]
  maximumResponseBytes: number
  timeoutMs: number
}

export type ProbePlanInput = {
  ownerScopeKey: string
  project: ProjectIdentity
  activeQuerySnapshots: QuerySnapshot[]
  providerTargets: ProviderTarget[]
  observationWindowKey: string
  maximumProbes: number
  engineVersion: string
}

export type VisibilityProbe = {
  probeId: string
  requestFingerprint: string
  identityKey: string
  ownerScopeKey: string
  projectId: string
  queryId: string
  provider: ProbeProvider
  modelLabel: string
  adapterKey: string
  locale: ProbeLocale
  normalizedPrompt: string
  observationWindowKey: string
  limitationCode: typeof PROBE_LIMITATION_CODE
  provenance: {
    engineVersion: typeof PROBE_ENGINE_VERSION
    observationMode: 'provider_api_observation'
    consumerSurfaceEquivalent: false
  }
  status: 'planned'
}

export type VisibilityProbePlan = {
  status: 'planned'
  engineVersion: typeof PROBE_ENGINE_VERSION
  ownerScopeKey: string
  project: ProjectIdentity
  observationWindowKey: string
  maximumProbes: number
  providerTargets: ProviderTarget[]
  probes: VisibilityProbe[]
  planFingerprint: string
  limitationCode: typeof PROBE_LIMITATION_CODE
}

export type ProbePlanResult =
  | { status: 'planned', plan: VisibilityProbePlan }
  | { status: 'blocked', reasonCodes: string[], limitationCode: 'probe_plan_invalid' }

export type AdapterInput = {
  probeIdentity: {
    probeId: string
    requestFingerprint: string
    ownerScopeKey: string
    projectId: string
    queryId: string
    provider: ProbeProvider
    modelLabel: string
  }
  normalizedPrompt: string
  locale: ProbeLocale
  timeoutMs: number
  abortSignal?: AbortSignal
}

export type AdapterResponseMetadata = {
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AdapterSuccess = {
  ok: true
  provider: ProbeProvider
  modelLabel: string
  responseText: string
  citationUrls: string[]
  citationDates?: Record<string, string>
  observedAt: string
  providerRequestId?: string
  responseMetadata?: AdapterResponseMetadata
}

export type ProbeFailureKind =
  | 'invalid_input'
  | 'owner_project_query_mismatch'
  | 'unsupported_locale'
  | 'adapter_mismatch'
  | 'response_too_large'
  | 'malformed_response'
  | 'citation_validation_failure'
  | 'identity_collision'
  | 'timeout'
  | 'network_unavailable'
  | 'http_error'
  | 'redirect'
  | 'unknown'

export type AdapterFailure = {
  ok: false
  failureKind: ProbeFailureKind
  retryable: boolean
  code: string
  httpStatus?: number
}

export type AdapterResult = AdapterSuccess | AdapterFailure

export interface VisibilityProbeAdapter {
  readonly adapterKey: string
  readonly provider: ProbeProvider
  readonly modelLabel: string
  execute(input: AdapterInput): Promise<AdapterResult>
}

export type ObservationCandidate = {
  probeId: string
  requestFingerprint: string
  planFingerprint: string
  ownerScopeKey: string
  projectId: string
  queryId: string
  provider: ProbeProvider
  modelLabel: string
  observationWindowKey: string
  observationMode: 'provider_api_observation'
  verifiedByOwner: false
  status: 'completed'
  metricEligibility: 'secondary_only'
  consumerSurfaceEquivalent: false
  limitationCode: typeof PROBE_LIMITATION_CODE
  persistenceStatus: 'not_persisted_v1'
  responseHash: string
  boundedExcerpt: string
  brandMentioned: boolean
  exactMentionCount: number
  firstMentionPosition: number | null
  competitorMentions: Record<string, number>
  citationUrls: string[]
  citationDates?: Record<string, string>
  citedDomain: string | null
  providerRequestId?: string
  evidenceLocator: string
  observedAt: string
  provenance: {
    adapterKey: string
    engineVersion: typeof PROBE_ENGINE_VERSION
    responseMetadata?: AdapterResponseMetadata
  }
}

export type ProbeAnalysisInput = {
  plan: unknown
  probeId: unknown
  response: unknown
}

export type ProbeAnalysisResult =
  | { status: 'completed', candidate: ObservationCandidate }
  | { status: 'blocked', reasonCodes: string[], limitationCode: 'provider_observation_invalid' }

export type RetryDecision = {
  retryable: boolean
  nextDelayCategory: 'none' | 'short' | 'medium' | 'long'
  reasonCode: string
}

export type ProbeExecutionResult = {
  probeId: string
  requestFingerprint: string
  status: ProbeResultStatus
  replayed: boolean
  candidate?: ObservationCandidate
  failure?: RetryDecision
}

export type IdempotencyRecord = {
  requestFingerprint: string
  identityKey: string
  result: ProbeExecutionResult
}

export type IdempotencyClaimResult =
  | { status: 'acquired', claimToken: string }
  | { status: 'replay', record: IdempotencyRecord }
  | { status: 'in_progress' }
  | { status: 'collision' }

export interface VisibilityProbeIdempotencyRegistry {
  claim(input: { requestFingerprint: string, identityKey: string }): Promise<IdempotencyClaimResult>
  complete(input: { requestFingerprint: string, identityKey: string, claimToken: string, result: ProbeExecutionResult }): Promise<void>
  release(input: { requestFingerprint: string, identityKey: string, claimToken: string }): Promise<void>
}

export type ExecuteVisibilityProbeBatchInput = {
  plan: unknown
  adapters: unknown
  idempotencyRegistry: unknown
  concurrency?: unknown
  abortSignal?: unknown
}

export type ProbeBatchResult = {
  status: 'completed'
  results: ProbeExecutionResult[]
  counts: {
    completed: number
    blocked: number
    failed: number
    retryable: number
  }
}

export type ProbeBatchBlockedResult = {
  status: 'blocked'
  reasonCodes: string[]
  results: []
  counts: { completed: 0, blocked: 0, failed: 0, retryable: 0 }
}
