export const DELIVERY_AUTOMATION_ENGINE_VERSION = 'governed-delivery-automation-engine-v1' as const
export const DELIVERY_COMMAND_VERSION = 'delivery-command-v1' as const

export type DeliveryAdapter = 'wordpress_rest' | 'generic_http' | 'manual_export'
export type DeliveryTargetStatus = 'active' | 'paused' | 'revoked'
export type DeliveryState =
  | 'scheduled'
  | 'eligible'
  | 'dispatch_planned'
  | 'retry_wait'
  | 'delivered'
  | 'permanent_failed'
  | 'blocked'
  | 'cancelled'

export type DeliveryFailureCode =
  | 'timeout'
  | 'connection_reset'
  | 'http_400'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_408'
  | 'http_409'
  | 'http_429'
  | 'http_5xx'
  | 'malformed_response'
  | 'invalid_remote_identity'
  | 'policy_violation'
  | 'credential_missing'
  | 'revoked_target'
  | 'content_hash_mismatch'
  | 'evidence_hash_mismatch'
  | 'unknown_failure'

export type DeliveryDecisionCode =
  | 'ELIGIBLE'
  | 'INVALID_INPUT'
  | 'INVALID_TARGET'
  | 'TARGET_NOT_ACTIVE'
  | 'CREDENTIAL_NOT_CONFIGURED'
  | 'OWNER_SCOPE_MISMATCH'
  | 'UNSUPPORTED_ADAPTER'
  | 'MANUAL_EXPORT_REQUIRES_HUMAN'
  | 'CONTENT_TYPE_NOT_ALLOWED'
  | 'LANGUAGE_NOT_ALLOWED'
  | 'CONTENT_TOO_LARGE'
  | 'INVALID_SHA256'
  | 'INVALID_TIMESTAMP'
  | 'SCHEDULED_IN_FUTURE'
  | 'DUPLICATE_PUBLICATION'
  | 'IDEMPOTENCY_COLLISION'
  | 'ATTEMPT_HISTORY_INVALID'
  | 'ATTEMPT_CAP_REACHED'
  | 'INVALID_STATE_TRANSITION'
  | 'TERMINAL_STATE'
  | 'CONFIGURATION_BLOCKED'
  | 'REMOTE_IDENTITY_COLLISION'
  | 'REMOTE_RESULT_INVALID'
  | 'HTTP_SUCCESS_MISSING_REMOTE_ID'
  | 'INVALID_TARGET_ORIGIN'
  | 'INVALID_ENDPOINT_PATH'

export interface DeliveryTargetInput {
  readonly targetId: string
  readonly ownerScopeKey: string
  readonly adapter: DeliveryAdapter
  readonly targetOrigin: string
  readonly endpointPath: string
  readonly status: DeliveryTargetStatus
  readonly serverCredentialConfigured: boolean
  readonly allowedContentTypes: readonly string[]
  readonly allowedLanguages: readonly string[]
  readonly maximumPayloadBytes: number
  readonly policyVersion: string
}

export interface ApprovedPublicationInput {
  readonly ownerScopeKey: string
  readonly scheduleEntryId: string
  readonly productionPlanId: string
  readonly jobId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly draftStage: 'optimized' | string
  readonly reviewId: string
  readonly reviewDecision: 'approved_for_delivery' | string
  readonly riskGateStatus: 'passed' | string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
  readonly contentType: string
  readonly language: string
  readonly contentByteLength: number
  readonly scheduledAt: string
  readonly scheduleKey: string
}

export interface ValidatedDeliveryTarget extends DeliveryTargetInput {
  readonly normalizedOrigin: string
  readonly normalizedEndpointPath: string
}

export interface TargetValidationResult {
  readonly status: 'valid' | 'blocked'
  readonly target?: ValidatedDeliveryTarget
  readonly code?: DeliveryDecisionCode
  readonly reasons: readonly string[]
}

export interface DeliveryEligibilityResult {
  readonly status: 'eligible' | 'blocked'
  readonly eligible: boolean
  readonly code: DeliveryDecisionCode
  readonly reasons: readonly string[]
  readonly target?: ValidatedDeliveryTarget
  readonly publication?: ApprovedPublicationInput
  readonly now?: string
}

export interface PublicationIdentity {
  readonly ownerScopeKey: string
  readonly scheduleEntryId: string
  readonly productionPlanId: string
  readonly jobId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly reviewId: string
  readonly scheduleKey: string
}

export interface DeliveryCommandMetadata {
  readonly commandVersion: typeof DELIVERY_COMMAND_VERSION
  readonly targetId: string
  readonly adapter: Exclude<DeliveryAdapter, 'manual_export'>
  readonly targetOrigin: string
  readonly endpointPath: string
  readonly publicationIdentity: PublicationIdentity
  readonly contentHash: string
  readonly evidenceSnapshotHash: string
  readonly idempotencyKey: string
  readonly attemptNumber: number
  readonly eligibleAt: string
  readonly timeoutClass: 'standard'
  readonly limitations: readonly [
    'metadata_only',
    'not_delivered',
    'executor_must_revalidate',
  ]
}

export interface IdempotencyPayload {
  readonly engineVersion: typeof DELIVERY_AUTOMATION_ENGINE_VERSION
  readonly ownerScopeKey: string
  readonly targetId: string
  readonly adapter: DeliveryAdapter
  readonly scheduleEntryId: string
  readonly scheduleKey: string
  readonly jobId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly reviewId: string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
}

export type IdempotencyResult =
  | {
      readonly status: 'ok'
      readonly key: string
      readonly payload: IdempotencyPayload
    }
  | {
      readonly status: 'blocked'
      readonly code: 'INVALID_INPUT' | 'INVALID_SHA256'
      readonly reasons: readonly string[]
    }

export interface DeliveryAttemptRecord {
  readonly attemptNumber: number
  readonly state: DeliveryState
  readonly occurredAt: string
  readonly idempotencyKey: string
  readonly failureCode?: DeliveryFailureCode
  readonly httpStatus?: number
}

export interface DeliveryFailureInput {
  readonly attemptNumber: number
  readonly code?: DeliveryFailureCode | string
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  readonly confirmedSameIdempotentDelivery?: boolean
}

export interface DeliveryFailureClassification {
  readonly status: 'classified' | 'blocked'
  readonly code: DeliveryFailureCode | 'INVALID_INPUT'
  readonly retryable: boolean
  readonly nextState: DeliveryState
  readonly delaySeconds: number
  readonly reason: string
}

export interface DeliveryResultInput {
  readonly idempotencyKey: string
  readonly remoteContentId?: string
  readonly publishedAt?: string
  readonly remoteUrl?: string
  readonly noPublicUrl?: boolean
  readonly responseFingerprint?: string
}

export interface DeliveryTransitionEvent {
  readonly type: 'mark_eligible' | 'plan_dispatch' | 'retry_due' | 'failure' | 'success' | 'block' | 'cancel'
  readonly now?: string
  readonly attempts?: readonly DeliveryAttemptRecord[]
  readonly failure?: DeliveryFailureInput
  readonly expectedIdempotencyKey?: string
  readonly result?: DeliveryResultInput
  readonly targetOrigin?: string
  readonly priorRemoteContentId?: string
  readonly httpStatus?: number
}

export type DeliveryStateResult =
  | {
      readonly status: 'ok'
      readonly state: DeliveryState
      readonly previousState: DeliveryState
      readonly transition: `${DeliveryState}->${DeliveryState}`
      readonly classification?: DeliveryFailureClassification
      readonly remoteContentId?: string
    }
  | {
      readonly status: 'blocked'
      readonly state: 'blocked'
      readonly previousState?: DeliveryState
      readonly code: DeliveryDecisionCode
      readonly reasons: readonly string[]
    }

export interface DeliveryPlanInput {
  readonly target: unknown
  readonly publication: unknown
  readonly now: unknown
  readonly attempts?: unknown
  readonly priorDeliveries?: unknown
}

export type DeliveryPlanResult =
  | {
      readonly status: 'dispatch_planned'
      readonly command: DeliveryCommandMetadata
      readonly code?: never
    }
  | {
      readonly status: 'blocked'
      readonly code: DeliveryDecisionCode
      readonly reasons: readonly string[]
    }

export interface DeliveryFailureHistoryRecord {
  readonly idempotencyKey: string
  readonly targetId: string
  readonly ownerScopeKey: string
  readonly draftId: string
  readonly contentHash: string
  readonly reviewId: string
  readonly state: DeliveryState
}
