export const GEOFLOW_PROTOCOL_VERSION = 'discoverystack-geoflow-v1' as const

export type ProtocolVersion = typeof GEOFLOW_PROTOCOL_VERSION

export type ContentType = 'article' | 'faq' | 'service_page'
export type Language = 'zh-hant' | 'en'
export type GenerationMode = 'draft' | 'revision'
export type RequestedCapability = 'knowledge_rag' | 'prompt_pack' | 'qwen_generation' | 'autogeo_optimization' | 'human_review' | 'publication'

export type DiscoveryStackStatus = 'awaiting_generation' | 'awaiting_review' | 'ready_to_publish' | 'publishing' | 'delivered' | 'blocked' | 'failed' | 'retry_wait'
export type GeoFlowStatus = 'queued' | 'running' | 'draft_ready' | 'review_required' | 'approved' | 'publishing' | 'published' | 'blocked' | 'failed' | 'retry_wait'
export type StatusMachine = 'discovery_stack' | 'geoflow'

export type ReasonCode =
  | 'INVALID_PROTOCOL_VERSION'
  | 'INVALID_INPUT'
  | 'UNKNOWN_FIELD'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_HASH'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_PUBLIC_URL'
  | 'PRIVATE_OR_SPECIAL_TARGET'
  | 'INVALID_OPAQUE_IDENTIFIER'
  | 'UNKNOWN_STATE'
  | 'REQUEST_FINGERPRINT_MISMATCH'
  | 'IDEMPOTENCY_COLLISION'
  | 'IDENTITY_MISMATCH'
  | 'EVIDENCE_SNAPSHOT_MISMATCH'
  | 'BRIEF_FINGERPRINT_MISMATCH'
  | 'CITATION_OUTSIDE_APPROVED_EVIDENCE'
  | 'APPLIED_RULE_OUTSIDE_SELECTION'
  | 'PROVIDER_PROVENANCE_MISSING'
  | 'INVALID_STATUS_TRANSITION'
  | 'UNTRUSTED_PUBLISHED_RESULT'

export type ValidationIssue = {
  path: string
  code: ReasonCode
}

export type ValidationFailure = {
  ok: false
  reason: ReasonCode
  issues: ValidationIssue[]
}

export type ValidationSuccess<T> = {
  ok: true
  value: T
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

export type EvidenceChunk = {
  sourceId: string
  artifactId: string
  chunkId: string
  chunkHash: string
  reviewedText: string
  locator: string
}

export type GeoFlowRequestDraft = {
  protocolVersion: ProtocolVersion
  requestId: string
  idempotencyKey: string
  ownerUserId: number
  clientId: number
  calendarEntryId: number
  productionPlanId: number
  deliverableId: number
  briefId: number
  jobId: number
  evidenceSnapshotHash: string
  briefFingerprint: string
  contentType: ContentType
  language: Language
  generationMode: GenerationMode
  requestedCapabilities: RequestedCapability[]
  selectedRuleIds: string[]
  authoritySourceIds: string[]
  evidenceChunks: EvidenceChunk[]
  createdAt: string
}

export type GeoFlowRequest = GeoFlowRequestDraft & {
  requestFingerprint: string
}

export type CitationBinding = {
  sourceId: string
  artifactId: string
  chunkId: string
  chunkHash: string
}

export type ProviderProvenance = {
  provider: string
  model: string
  mode: 'provider' | 'deterministic_scaffold' | 'reference_fallback'
  fallbackReason: string | null
}

export type DraftIdentity = {
  externalArticleKey: string
  briefFingerprint: string
}

export type GeoFlowResponse = {
  protocolVersion: ProtocolVersion
  requestId: string
  idempotencyKey: string
  requestFingerprint: string
  ownerUserId: number
  clientId: number
  jobId: number
  externalProjectKey: string
  externalTaskKey: string
  externalJobKey: string
  externalArticleKey: string
  status: GeoFlowStatus
  draftIdentity: DraftIdentity
  title: string
  summary: string
  contentHash: string
  evidenceSnapshotHash: string
  citationBindings: CitationBinding[]
  appliedRuleIds: string[]
  providerProvenance: ProviderProvenance
  limitations: string[]
  completedAt: string
}

export type IdempotencyResolution = 'new_request' | 'replay' | 'collision'

export type SigningEnvelope = {
  protocolVersion: ProtocolVersion
  requestId: string
  idempotencyKey: string
  requestFingerprint: string
  bodyHash: string
  timestamp: string
  nonce: string
  sender: string
  receiver: string
  canonicalSigningInput: string
}

export type EnvelopeVerifier = (canonicalSigningInput: string, signature: string) => boolean

export type LineageVerification = {
  request: GeoFlowRequest
  response: GeoFlowResponse
}
