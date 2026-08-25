import type { GeoFlowRequest, GeoFlowResponse, ReasonCode, ValidationResult } from '../geoflow-integration'

export type GeoFlowTransportErrorCode =
  | 'TARGET_INVALID'
  | 'TASK_ID_INVALID'
  | 'ATTEMPT_INVALID'
  | 'REQUEST_INVALID'
  | 'REQUEST_FINGERPRINT_STALE'
  | 'IDEMPOTENCY_COLLISION'
  | 'CREDENTIAL_REFERENCE_INVALID'
  | 'CREDENTIAL_RESOLUTION_FAILED'
  | 'CREDENTIAL_TARGET_MISMATCH'
  | 'FETCH_NOT_CONFIGURED'
  | 'REMOTE_REQUEST_ID_MISSING'
  | 'TASK_ID_MISSING'
  | 'JOB_ID_MISSING'
  | 'CLOCK_NOT_CONFIGURED'
  | 'REQUEST_TIME_INVALID'
  | 'SLEEP_NOT_CONFIGURED'
  | 'TRANSPORT_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'REMOTE_UNAUTHORIZED'
  | 'REMOTE_NOT_FOUND'
  | 'REMOTE_CONFLICT'
  | 'REMOTE_UNPROCESSABLE'
  | 'REMOTE_RATE_LIMITED'
  | 'REMOTE_SERVER_ERROR'
  | 'REMOTE_REJECTED'
  | 'REDIRECT_BLOCKED'
  | 'RESPONSE_TOO_LARGE'
  | 'RESPONSE_CONTENT_TYPE_INVALID'
  | 'RESPONSE_MALFORMED'
  | 'RESPONSE_ENVELOPE_INVALID'
  | 'REQUEST_ID_MISMATCH'
  | 'TASK_ID_MISMATCH'
  | 'JOB_ID_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'ARTICLE_ID_MISMATCH'
  | 'ARTICLE_ID_MISSING'
  | 'STATUS_INVALID'
  | 'ARTICLE_NOT_READY'
  | 'CONTENT_HASH_MISMATCH'
  | 'ATTEMPT_MISMATCH'
  | 'REQUEST_FINGERPRINT_MISMATCH'
  | 'PUBLICATION_STATE_REJECTED'
  | 'RETRY_AFTER_INVALID'
  | 'POLL_LIMIT_EXCEEDED'
  | 'RESULT_INVALID'

export type GeoFlowTransportError = {
  readonly code: GeoFlowTransportErrorCode
  readonly retryable: boolean
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
  readonly contractReason?: ReasonCode
}

export type GeoFlowTransportFailure<T = never> = {
  readonly ok: false
  readonly error: GeoFlowTransportError
  readonly value?: T
}

export type GeoFlowTransportSuccess<T> = {
  readonly ok: true
  readonly value: T
}

export type GeoFlowTransportResult<T> = GeoFlowTransportSuccess<T> | GeoFlowTransportFailure

export type GeoFlowRequestInit = {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly redirect: 'manual'
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export type GeoFlowFetchResponse = {
  readonly status: number
  readonly headers?: Readonly<Record<string, string | undefined>>
  readonly text: () => Promise<string>
}

export type GeoFlowFetch = (url: string, init: GeoFlowRequestInit) => Promise<GeoFlowFetchResponse>
export type GeoFlowClock = { readonly now: () => string }
export type GeoFlowSleep = (milliseconds: number) => Promise<void>

export type GeoFlowCredentialResolution =
  | {
      readonly ok: true
      readonly value: {
        readonly token: string
        readonly allowedBaseUrl: string
      }
    }
  | { readonly ok: false }
export type GeoFlowCredentialResolver = (credentialReference: string) => GeoFlowCredentialResolution | Promise<GeoFlowCredentialResolution>

export type GeoFlowRuntimeTargetInput = {
  readonly baseUrl: unknown
  readonly taskId: unknown
  readonly credentialReference: unknown
  readonly attempt: unknown
  readonly timeoutMs?: unknown
  readonly maxResponseBodyBytes?: unknown
  readonly maxAttempts?: unknown
  readonly maxPolls?: unknown
  readonly pollIntervalMs?: unknown
  readonly maxRetryAfterSeconds?: unknown
}

export type GeoFlowRuntimeTarget = {
  readonly baseUrl: string
  readonly targetFingerprint: string
  readonly taskId: number
  readonly credentialReference: string
  readonly attempt: number
  readonly timeoutMs: number
  readonly maxResponseBodyBytes: number
  readonly maxAttempts: number
  readonly maxPolls: number
  readonly pollIntervalMs: number
  readonly maxRetryAfterSeconds: number
}

export type GeoFlowAdapterDependencies = {
  readonly fetch: GeoFlowFetch
  readonly credentialResolver: GeoFlowCredentialResolver
  readonly clock: GeoFlowClock
  readonly sleep?: GeoFlowSleep
}

export type GeoFlowEnqueuePlan = {
  readonly kind: 'enqueue_plan'
  readonly request: GeoFlowRequest
  readonly target: GeoFlowRuntimeTarget
  readonly method: 'POST'
  readonly path: string
  readonly url: string
  readonly body: string
  readonly bodyHash: string
  readonly headerNames: readonly string[]
}

export type GeoFlowEnqueueInput = {
  readonly request: unknown
  readonly target: unknown
}

export type GeoFlowEnqueueValue = {
  readonly kind: 'enqueued'
  readonly requestFingerprint: string
  readonly requestId: string
  readonly targetFingerprint: string
  readonly taskId: number
  readonly jobId: number
  readonly attempt: number
  readonly remoteRequestId: string
  readonly remoteStatus: string
}

export type GeoFlowEnqueueResult = GeoFlowTransportResult<GeoFlowEnqueueValue>

export type GeoFlowPollInput = {
  readonly plan: GeoFlowEnqueuePlan
  readonly enqueue: GeoFlowEnqueueValue
}

export type GeoFlowJobResultMetadata = {
  readonly requestId: string
  readonly requestFingerprint: string
  readonly briefFingerprint: string
  readonly evidenceSnapshotHash: string
  readonly externalArticleKey: string
  readonly attempt: number
  readonly contentHash: string
  readonly requestedRuleIds: readonly string[]
  readonly autogeoExecution: boolean
  readonly citationBindings: readonly {
    readonly marker: string
    readonly sourceId: string
    readonly artifactId: string
    readonly chunkId: string
    readonly chunkHash: string
  }[]
  readonly appliedRuleIds: readonly string[]
  readonly providerProvenance: {
    readonly provider: string
    readonly model: string
    readonly mode: 'provider' | 'deterministic_scaffold' | 'reference_fallback'
    readonly fallbackReason: string | null
  }
  readonly limitations: readonly string[]
  readonly completedAt: string
}

export type GeoFlowJobValue = {
  readonly kind: 'job_completed'
  readonly requestFingerprint: string
  readonly requestId: string
  readonly targetFingerprint: string
  readonly taskId: number
  readonly jobId: number
  readonly articleId: number
  readonly attempt: number
  readonly remoteRequestId: string
  readonly remoteStatus: string
  readonly resultMetadata: GeoFlowJobResultMetadata
}

export type GeoFlowJobPollResult = GeoFlowTransportResult<GeoFlowJobValue>

export type GeoFlowArticleInput = {
  readonly plan: GeoFlowEnqueuePlan
  readonly job: GeoFlowJobValue
}

export type GeoFlowArticleValue = {
  readonly kind: 'article_base_draft' | 'article_candidate'
  readonly requestFingerprint: string
  readonly requestId: string
  readonly targetFingerprint: string
  readonly taskId: number
  readonly jobId: number
  readonly articleId: number
  readonly attempt: number
  readonly response: GeoFlowResponse
}

export type GeoFlowArticleResult = GeoFlowTransportResult<GeoFlowArticleValue>

export type GeoFlowTransportValidationInput = {
  readonly request: unknown
  readonly plan?: unknown
  readonly result: unknown
}

export type GeoFlowTransportValidationResult = ValidationResult<GeoFlowResponse>

export type GeoFlowFailureClassificationInput = {
  readonly kind?: unknown
  readonly status?: unknown
  readonly retryAfter?: unknown
}

export type GeoFlowFailureClassification = GeoFlowTransportError
