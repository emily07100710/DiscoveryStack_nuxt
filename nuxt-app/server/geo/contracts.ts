export const GEO_WORKBENCH_VERSION = 'geo-workbench-v1'

export type GeoLanguage = 'en' | 'zh-hant'
export type GeoRuleCategory = 'answerability' | 'structure' | 'context' | 'evidence' | 'utility' | 'planning'
export type GeoProviderId = 'reference-rules-v1' | 'autogeo-api' | 'autogeo-bailian-qwen' | 'autogeo-openai-compatible' | 'custom'
export type GeoRequestedProvider = 'autogeo-api' | 'autogeo-bailian-qwen' | 'autogeo-openai-compatible'
export type GeoProviderExecution = 'official-autogeo-api' | 'autogeo-framework-bailian-qwen' | 'autogeo-framework-openai-compatible' | 'reference-fallback'
export type GeoFallbackReason =
  | 'bailian-not-configured'
  | 'bailian-invalid-configuration'
  | 'bailian-provider-unavailable'
  | 'provider-output-safety-rejected'
  | 'autogeo-not-configured'
  | 'autogeo-provider-unavailable'

export type GeoDocumentInput = {
  title: string
  content: string
  language: GeoLanguage
  /** Server-resolved evidence only; never accept this field directly from a client request. */
  approvedEvidenceContext?: string
  /** Server-resolved Diagnosis context only; never accept this field directly from a client request. */
  approvedDiagnosisContext?: string
  /** Server-resolved Strategy rule context only; never accept this field directly from a client request. */
  approvedStrategyContext?: string
  /** Server-resolved Brief instructions only; never accept these fields directly from a client request. */
  approvedBriefGoals?: readonly string[]
  approvedBriefConstraints?: readonly string[]
}

export type GeoRule = {
  id: string
  category: GeoRuleCategory
  title: string
  instruction: string
  rationale: string
  priority: 'high' | 'medium' | 'low'
}

export type GeoRewriteProvenance = {
  requestedProvider: GeoRequestedProvider
  execution: GeoProviderExecution
  upstreamRepository: 'cxcscmu/AutoGEO'
  upstreamRevision: string
  rewriteMethod: 'autogeo_api'
  ruleset: 'Researchy-GEO / Gemini default rules'
  model: 'gemini-2.5-pro' | 'qwen-plus' | (string & {})
  providerLabel?: 'bailian' | 'openai'
  providerRequestId?: string
  usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number }
  fallbackReason?: GeoFallbackReason
  ruleSource?: 'discoverystack-autogeo-compatible'
  providerExecution?: boolean
  workerProtocolVersion?: string
  workerSourceSha256?: string
}

export type GeoRewriteCandidate = {
  provider: GeoProviderId
  providerVersion: string
  optimizedTitle: string
  optimizedContent: string
  appliedRuleIds: string[]
  safetyNotes: string[]
  provenance: GeoRewriteProvenance
}

export type GeoRewriteAdapter = {
  id: GeoProviderId
  version: string
  rewrite: (document: GeoDocumentInput, rules: readonly GeoRule[]) => Promise<GeoRewriteCandidate>
}

export type GeoMetricId = 'answerability' | 'structure' | 'context' | 'evidence' | 'scannability' | 'sourcePreservation'

export type GeoMetric = { id: GeoMetricId, label: string, score: number, explanation: string }

export type GeoDocumentEvaluation = {
  totalScore: number
  metrics: GeoMetric[]
  method: 'deterministic-heuristic-v1'
  limitations: string[]
}

export type GeoMetricComparison = GeoMetric & { before: number, after: number, delta: number }

export type GeoOptimizationResult = {
  version: typeof GEO_WORKBENCH_VERSION
  rulesetVersion: string
  original: GeoDocumentInput
  candidate: GeoRewriteCandidate
  baseline: GeoDocumentEvaluation
  optimized: GeoDocumentEvaluation
  comparison: GeoMetricComparison[]
  summary: string
  interpretationLimit: string
}
