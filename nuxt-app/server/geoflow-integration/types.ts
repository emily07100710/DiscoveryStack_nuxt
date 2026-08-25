export const GEOFLOW_PROTOCOL_VERSION = 'discoverystack-geoflow-v1' as const
export const CONTENT_ARTIFACT_SCHEMA_VERSION = 'geoflow-content-artifact-v1' as const
export const SIGNING_ALGORITHM = 'hmac-sha256' as const
export const SIGNING_METHOD = 'POST' as const
export const SIGNING_PATH = '/api/internal/discoverystack/v1/generation-jobs' as const
export const DETERMINISTIC_SCAFFOLD_LIMITATION = 'No external provider generation was executed.' as const

export type ProtocolVersion = typeof GEOFLOW_PROTOCOL_VERSION
export type ContentType = 'article' | 'faq' | 'service_page'
export type Language = 'zh-hant' | 'en'
export type GenerationMode = 'draft' | 'revision'
export type RequestedCapability = 'knowledge_rag' | 'prompt_pack' | 'qwen_generation' | 'autogeo_optimization' | 'human_review'

export type DiscoveryStackStatus = 'awaiting_generation' | 'awaiting_review' | 'ready_to_publish' | 'publishing' | 'delivered' | 'blocked' | 'failed' | 'retry_wait'
export type GeoFlowStatus = 'queued' | 'running' | 'draft_ready' | 'review_required' | 'blocked' | 'failed' | 'retry_wait'
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
  | 'EVIDENCE_CHUNK_HASH_MISMATCH'
  | 'DUPLICATE_EVIDENCE_IDENTITY'
  | 'REQUIRED_EVIDENCE_MISSING'
  | 'REQUIRED_RULE_MISSING'
  | 'CONTENT_HASH_MISMATCH'
  | 'RESPONSE_TIME_INVALID'
  | 'UNTRUSTED_DELIVERY_STATE'
  | 'SIGNATURE_CONTEXT_MISMATCH'
  | 'SIGNATURE_EXPIRED'
  | 'NONCE_REPLAYED'

export type ValidationIssue = { path: string; code: ReasonCode }
export type ValidationFailure = { ok: false; reason: ReasonCode; issues: ValidationIssue[] }
export type ValidationSuccess<T> = { ok: true; value: T }
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

export type ContentBrief = {
  title: string
  audience: string
  goals: string[]
  constraints: string[]
}

export type RevisionContext = {
  parentDraftId: number
  parentContentHash: string
  changeRequestReviewId: number
  instructions: string
}

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
  brief: ContentBrief
  contentType: ContentType
  language: Language
  generationMode: GenerationMode
  revisionContext: RevisionContext | null
  requestedCapabilities: RequestedCapability[]
  selectedRuleIds: string[]
  authoritySourceIds: string[]
  evidenceChunks: EvidenceChunk[]
  createdAt: string
}

export type GeoFlowRequest = GeoFlowRequestDraft & {
  briefFingerprint: string
  requestFingerprint: string
}

export type CitationBinding = { sourceId: string; artifactId: string; chunkId: string; chunkHash: string }
export type ProviderProvenance = {
  provider: string
  model: string
  mode: 'provider' | 'deterministic_scaffold' | 'reference_fallback'
  fallbackReason: string | null
}
export type DraftIdentity = { externalArticleKey: string; briefFingerprint: string }
export type ContentArtifact = {
  schemaVersion: typeof CONTENT_ARTIFACT_SCHEMA_VERSION
  contentType: ContentType
  language: Language
  title: string
  summary: string
  bodyMarkdown: string
  bodyHash: string
}

type ResponseIdentity = {
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
}

type ResponseCommon = ResponseIdentity & { limitations: string[] }
export type RetryMetadata = { attempt: number; retryAt: string }
export type ProgressResponse = ResponseCommon & {
  status: 'queued' | 'running'
  observedAt: string
  retry: null
}
export type RetryWaitResponse = ResponseCommon & {
  status: 'retry_wait'
  observedAt: string
  retry: RetryMetadata
}
export type FailureResponse = ResponseCommon & {
  status: 'blocked' | 'failed'
  observedAt: string
  failure: { code: ReasonCode; retryable: boolean }
}
export type DraftResultResponse = ResponseCommon & {
  status: 'draft_ready' | 'review_required'
  draftIdentity: DraftIdentity
  contentArtifact: ContentArtifact
  evidenceSnapshotHash: string
  citationBindings: CitationBinding[]
  appliedRuleIds: string[]
  providerProvenance: ProviderProvenance
  completedAt: string
}
export type GeoFlowResponse = ProgressResponse | RetryWaitResponse | FailureResponse | DraftResultResponse

export type IdempotencyResolution = 'new_request' | 'replay' | 'collision'

export type SigningEnvelope = {
  algorithm: typeof SIGNING_ALGORITHM
  method: typeof SIGNING_METHOD
  path: typeof SIGNING_PATH
  protocolVersion: ProtocolVersion
  requestId: string
  idempotencyKey: string
  requestFingerprint: string
  bodyHash: string
  timestamp: string
  nonce: string
  sender: string
  receiver: string
  keyId: string
  canonicalSigningInput: string
}

export type SigningPlannerInput = {
  request: unknown
  timestamp: unknown
  nonce: unknown
  sender: unknown
  receiver: unknown
  keyId: unknown
}

export type SignatureVerifier = (canonicalSigningInput: string, signature: string) => boolean
export type NonceFreshnessVerifier = (nonce: string) => boolean
export type SigningVerificationContext = {
  request: unknown
  verificationTime: unknown
  maxClockSkewSeconds: unknown
  expectedSender: unknown
  expectedReceiver: unknown
  expectedKeyId: unknown
  nonceFreshnessVerifier: unknown
  signatureVerifier: unknown
}

export type LineageVerification = { request: GeoFlowRequest; response: GeoFlowResponse }
export type AcceptedStatusEvent = { previousStatus: GeoFlowStatus | null; request: GeoFlowRequest; response: GeoFlowResponse }
