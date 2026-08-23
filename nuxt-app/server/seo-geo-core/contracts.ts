export const SEO_GEO_CORE_VERSION = 'seo-geo-core-v1'
export const DIAGNOSIS_BASELINE_VERSION = 'deterministic-diagnosis-v1'
export const CONTENT_RISK_GATE_VERSION = 'content-risk-gate-v1'
export const AUTOGEO_STRATEGY_VERSION = 'autogeo-strategy-v1'

export type EvidenceRef = {
  sourceId?: number
  artifactId?: number
  locator?: string
  artifactHash?: string
  reason: string
}

export type DiagnosisPriority = 'high' | 'medium' | 'low'
export type DiagnosisSeverity = 'critical' | 'high' | 'medium' | 'low'
export type DiagnosisArea = 'technical_seo' | 'answer_content' | 'trust_evidence' | 'journey' | 'geo_structure'
export type DiagnosisFinding = {
  id: string
  issueCode: string
  area: DiagnosisArea
  severity: DiagnosisSeverity
  priority: DiagnosisPriority
  title: string
  explanation: string
  affectedUrls: string[]
  evidence: EvidenceRef[]
  recommendationKey: string
  engine: typeof DIAGNOSIS_BASELINE_VERSION
  limitations: string[]
}

export type DiagnosisResult = {
  engine: 'deterministic-diagnosis-v1' | 'approved-model-not-ready'
  status: 'completed' | 'not_ready' | 'needs_human_review' | 'blocked'
  inputFingerprint: string
  findings: DiagnosisFinding[]
  summary: string
  limitations: string[]
  measurementNotice: string
}

export type StrategyDeliverableType = 'article' | 'faq' | 'service_page'
export type AutoGeoStrategyRule = {
  id: string
  title: string
  instruction: string
  rationale: string
  priority: 'high' | 'medium' | 'low'
}

export type StrategyContentOpportunity = {
  key: string
  deliverableType: StrategyDeliverableType
  title: string
  audience: string
  goals: string[]
  constraints: string[]
}

export type AutoGeoStrategyRecommendation = {
  id?: number
  diagnosisId: number
  issueCode: string
  recommendationKey: string
  ruleSetVersion: string
  ruleIds: string[]
  rules: AutoGeoStrategyRule[]
  priority: DiagnosisPriority
  rationale: string
  recommendedActions: string[]
  deliverableTypes: StrategyDeliverableType[]
  contentOpportunities: StrategyContentOpportunity[]
  evidenceRefs: EvidenceRef[]
  evidenceSnapshotHash: string
  status: 'proposed' | 'selected' | 'rejected' | 'superseded'
  limitations: string[]
  version: number
  provenance: Record<string, unknown>
}

export type ProductionPlanStatus = 'draft' | 'ready' | 'generating' | 'in_progress' | 'completed' | 'blocked' | 'archived'
export type ProductionDeliverableStatus = 'planned' | 'brief_ready' | 'job_queued' | 'candidate_ready' | 'needs_human_review' | 'approved' | 'blocked' | 'exported'

export type ContentBriefInput = {
  title: string
  audience: string
  contentType: 'article' | 'service_page' | 'faq' | 'landing_page' | 'brief'
  language: 'en' | 'zh-hant'
  goals: string[]
  constraints: string[]
  evidenceRefs: EvidenceRef[]
  diagnosisId?: number
  strategyRecommendationId?: number
  productionPlanId?: number
  productionDeliverableId?: number
  ruleIds?: string[]
  provenance?: Record<string, unknown>
}

export type RiskFinding = {
  id: string
  severity: 'blocking' | 'review' | 'notice'
  message: string
  evidenceRequired?: boolean
}

export type ContentRiskGateResult = {
  gateVersion: typeof CONTENT_RISK_GATE_VERSION
  status: 'passed' | 'needs_human_review' | 'blocked'
  findings: RiskFinding[]
  publicationNotice: string
}

export type DeliveryPreview = {
  mode: 'preview'
  target: { id: number, adapter: 'manual_export' | 'wordpress_rest' | 'generic_http', targetOrigin: string }
  canPublish: false
  contentHash: string
  requiredNextStep: 'explicit_owner_approval_and_server_side_adapter_configuration'
  limitations: string[]
}

export const CONTENT_JOB_TRANSITIONS = {
  queued: ['processing', 'blocked', 'failed'],
  processing: ['candidate_ready', 'needs_human_review', 'blocked', 'failed'],
  candidate_ready: ['needs_human_review', 'approved', 'blocked'],
  needs_human_review: ['approved', 'blocked', 'failed'],
  approved: ['delivered', 'blocked'],
  delivered: [],
  blocked: [],
  failed: [],
} as const

export type ContentJobStatus = keyof typeof CONTENT_JOB_TRANSITIONS

export function canTransitionContentJob(from: ContentJobStatus, to: ContentJobStatus): boolean {
  return (CONTENT_JOB_TRANSITIONS[from] as readonly ContentJobStatus[]).includes(to)
}
