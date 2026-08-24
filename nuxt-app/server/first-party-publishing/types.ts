export const FIRST_PARTY_PUBLISHING_RUNTIME_VERSION = 'first-party-site-publishing-runtime-v1' as const
export const FIRST_PARTY_COMMAND_VERSION = 'first-party-publish-command-v1' as const
export const FIRST_PARTY_EXECUTOR_VERSION = 'first-party-publish-executor-v1' as const
export const GITHUB_CONTENTS_ORIGIN = 'https://api.github.com' as const
export const SIGNED_API_COMMAND_VERSION = 'first-party-signed-api-v1' as const

export type FirstPartyFramework = 'astro' | 'nuxt'
export type FirstPartyTransport = 'first_party_git' | 'first_party_signed_api'
export type FirstPartyTargetStatus = 'active' | 'paused' | 'revoked'
export type FirstPartyExecutionMode = 'dry_run' | 'execute'
export type FirstPartyRemoteState = 'created' | 'updated' | 'idempotent_replay'

export type FirstPartyDecisionCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_FRAMEWORK'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_TARGET_ORIGIN'
  | 'INVALID_ENDPOINT_PATH'
  | 'INVALID_CONTENT_ROOT'
  | 'INVALID_REPOSITORY'
  | 'INVALID_BRANCH'
  | 'INVALID_CREDENTIAL_REFERENCE'
  | 'TARGET_NOT_ACTIVE'
  | 'OWNER_SCOPE_MISMATCH'
  | 'EXECUTION_DISABLED'
  | 'CREDENTIAL_MISSING'
  | 'EXECUTOR_NOT_CONFIGURED'
  | 'UNSUPPORTED_ROUTE'
  | 'PUBLICATION_NOT_APPROVED'
  | 'RISK_GATE_NOT_PASSED'
  | 'INVALID_SHA256'
  | 'INVALID_TIMESTAMP'
  | 'SCHEDULED_IN_FUTURE'
  | 'INVALID_SLUG'
  | 'CONTENT_HASH_MISMATCH'
  | 'ARTIFACT_PATH_INVALID'
  | 'ARTIFACT_FINGERPRINT_INVALID'
  | 'IDEMPOTENCY_INVALID'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'UNSUPPORTED_LANGUAGE'
  | 'CONTENT_TOO_LARGE'
  | 'MISSING_SECRET'
  | 'REQUEST_BLOCKED'
  | 'RESPONSE_INVALID'
  | 'REMOTE_IDENTITY_COLLISION'
  | 'REMOTE_NOT_FOUND'
  | 'REMOTE_CONFLICT'
  | 'REMOTE_UNAUTHORIZED'
  | 'REMOTE_RATE_LIMITED'
  | 'REMOTE_SERVER_ERROR'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'SIGNATURE_INVALID'
  | 'NONCE_INVALID'
  | 'REDIRECT_BLOCKED'

export interface FirstPartyPublishTarget {
  readonly targetId: string
  readonly ownerScopeKey: string
  readonly framework: FirstPartyFramework
  readonly transport: FirstPartyTransport
  readonly targetOrigin: string
  readonly contentRoot: string
  readonly defaultBranch: string
  readonly repositoryOwner: string | null
  readonly repositoryName: string | null
  readonly endpointPath: string | null
  readonly credentialReference: string
  readonly status: FirstPartyTargetStatus
  readonly allowedContentTypes: readonly string[]
  readonly allowedLanguages: readonly string[]
  readonly maximumPayloadBytes: number
  readonly executionEnabled: boolean
}

export interface ApprovedFirstPartyPublication {
  readonly ownerScopeKey: string
  readonly scheduleEntryId: string
  readonly productionPlanId: string
  readonly productionDeliverableId: string
  readonly jobId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly draftStage: 'optimized' | string
  readonly reviewId: string
  readonly reviewDecision: 'approved_for_delivery' | string
  readonly riskGateStatus: 'passed' | string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
  readonly title: string
  readonly body: string
  readonly slug: string
  readonly contentType: string
  readonly language: string
  readonly scheduledAt: string
  readonly scheduleKey: string
  readonly authoritySourceIds: readonly string[]
  readonly ruleIds: readonly string[]
}

export interface ValidatedFirstPartyTarget extends FirstPartyPublishTarget {
  readonly targetOrigin: string
  readonly contentRoot: string
  readonly defaultBranch: string
  readonly repositoryOwner: string | null
  readonly repositoryName: string | null
  readonly endpointPath: string | null
  readonly allowedContentTypes: readonly string[]
  readonly allowedLanguages: readonly string[]
}

export type FirstPartyTargetValidationResult =
  | { readonly status: 'valid'; readonly target: ValidatedFirstPartyTarget }
  | { readonly status: 'blocked'; readonly code: FirstPartyDecisionCode; readonly reasons: readonly string[] }

export interface FirstPartyPublicationIdentity {
  readonly publicationId: string
  readonly ownerScopeKey: string
  readonly scheduleEntryId: string
  readonly productionPlanId: string
  readonly productionDeliverableId: string
  readonly jobId: string
  readonly draftId: string
  readonly draftVersion: number
  readonly reviewId: string
  readonly scheduleKey: string
}

export interface FirstPartyArtifact {
  readonly path: string
  readonly frontmatter: string
  readonly body: string
  readonly bytes: number
  readonly contentHash: string
  readonly artifactFingerprint: string
  readonly publicationIdentity: FirstPartyPublicationIdentity
}

export type FirstPartyArtifactResult =
  | { readonly status: 'ok'; readonly artifact: FirstPartyArtifact }
  | { readonly status: 'blocked'; readonly code: FirstPartyDecisionCode; readonly reasons: readonly string[] }

export interface FirstPartyCommandProvenance {
  readonly adapter: FirstPartyTransport
  readonly framework: FirstPartyFramework
  readonly transport: FirstPartyTransport
  readonly artifactFingerprint: string
  readonly credentialReference: string
  readonly executorVersion: typeof FIRST_PARTY_EXECUTOR_VERSION
  readonly targetOrigin: string
  readonly path: string
  readonly idempotencyKey: string
}

export interface FirstPartyPublishCommand {
  readonly commandVersion: typeof FIRST_PARTY_COMMAND_VERSION
  readonly targetId: string
  readonly ownerScopeKey: string
  readonly framework: FirstPartyFramework
  readonly transport: FirstPartyTransport
  readonly targetOrigin: string
  readonly contentPath: string
  readonly publicationId: string
  readonly productionDeliverableId: string
  readonly contentHash: string
  readonly evidenceSnapshotHash: string
  readonly artifactFingerprint: string
  readonly idempotencyKey: string
  readonly attemptNumber: 1
  readonly commitMessage: string
  readonly branch: string
  readonly provenance: FirstPartyCommandProvenance
  readonly limitations: readonly [
    'metadata_only',
    'not_delivered',
    'executor_must_revalidate',
  ]
}

export type FirstPartyPlanResult =
  | {
      readonly status: 'planned'
      readonly command: FirstPartyPublishCommand
      readonly artifact: FirstPartyArtifact
    }
  | {
      readonly status: 'blocked'
      readonly code: FirstPartyDecisionCode
      readonly reasons: readonly string[]
    }

export interface FirstPartyRequestInit {
  readonly method: 'GET' | 'PUT' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly redirect: 'manual' | 'error'
  readonly timeoutMs: number
}

export interface FirstPartyFetchResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string | undefined>>
  readonly text: () => Promise<string>
}

export type FirstPartyFetch = (url: string, init: FirstPartyRequestInit) => Promise<FirstPartyFetchResponse>

export type ServerCredentialResolution =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'missing' | 'unavailable' }

export type ServerCredentialResolver = (credentialReference: string) => ServerCredentialResolution | Promise<ServerCredentialResolution>
export type NonceProvider = () => string

export interface FirstPartyRequestPreview {
  readonly mode: 'dry_run'
  readonly method: 'GET' | 'PUT' | 'POST'
  readonly url: string
  readonly targetOrigin: string
  readonly path: string
  readonly branch: string
  readonly bodyBytes: number
  readonly bodyIncluded: false
  readonly headerNames: readonly string[]
  readonly includesAuthorization: false
  readonly includesSecret: false
  readonly redirect: 'manual'
}

export interface FirstPartyExecutionContext {
  readonly target: unknown
  readonly publication: unknown
  readonly now: unknown
  readonly serverNow?: unknown
  readonly mode: FirstPartyExecutionMode
  readonly fetchImpl?: FirstPartyFetch
  readonly serverCredentialResolver?: ServerCredentialResolver
  readonly nonceProvider?: NonceProvider
}

export interface FirstPartyRemoteIdentity {
  readonly publicationId: string
  readonly contentHash: string
  readonly remoteRevision: string
  readonly repositoryOwner?: string
  readonly repositoryName?: string
  readonly branch?: string
  readonly path?: string
  readonly blobSha?: string
  readonly commitSha?: string
}

export interface FirstPartyDeliveryResult {
  readonly status: 'delivered'
  readonly remoteState: FirstPartyRemoteState
  readonly publicationId: string
  readonly contentHash: string
  readonly remoteRevision: string
  readonly repositoryOwner?: string
  readonly repositoryName?: string
  readonly branch?: string
  readonly path?: string
  readonly artifactFingerprint: string
  readonly idempotencyKey: string
}

export interface FirstPartyBlockedResult {
  readonly status: 'blocked'
  readonly code: FirstPartyDecisionCode
  readonly reasons: readonly string[]
}

export interface FirstPartyFailureResult {
  readonly status: 'retryable_failure' | 'permanent_failure'
  readonly code: FirstPartyDecisionCode
  readonly reasons: readonly string[]
  readonly httpStatus?: number
}

export type FirstPartyExecutionResult = FirstPartyDeliveryResult | FirstPartyBlockedResult | FirstPartyFailureResult | { readonly status: 'dry_run'; readonly preview: FirstPartyRequestPreview }

export interface FirstPartyAdapterInput {
  readonly target: ValidatedFirstPartyTarget
  readonly publication: ApprovedFirstPartyPublication
  readonly artifact: FirstPartyArtifact
  readonly command: FirstPartyPublishCommand
  readonly now: string
  readonly fetchImpl: FirstPartyFetch
}

export interface GitContentsFileResponse {
  readonly type?: unknown
  readonly name?: unknown
  readonly path?: unknown
  readonly sha?: unknown
  readonly content?: unknown
  readonly encoding?: unknown
  readonly repository?: unknown
  readonly branch?: unknown
  readonly commit?: unknown
}

export interface GitContentsWriteResponse {
  readonly content?: {
    readonly path?: unknown
    readonly sha?: unknown
  }
  readonly commit?: {
    readonly sha?: unknown
  }
  readonly repository?: unknown
  readonly branch?: unknown
}

export interface SignedApiResponsePayload {
  readonly publicationId?: unknown
  readonly contentHash?: unknown
  readonly remoteRevision?: unknown
}

export type FirstPartyAdapterResult =
  | { readonly status: 'ok'; readonly remote: FirstPartyRemoteIdentity; readonly remoteState: FirstPartyRemoteState }
  | { readonly status: 'blocked'; readonly code: FirstPartyDecisionCode; readonly reasons: readonly string[] }
  | { readonly status: 'failure'; readonly code: FirstPartyDecisionCode; readonly reasons: readonly string[]; readonly httpStatus?: number }

export interface GitAdapterDependencies {
  readonly fetchImpl: FirstPartyFetch
  readonly serverCredentialResolver: ServerCredentialResolver
  readonly timeoutMs?: number
}

export interface SignedApiAdapterDependencies {
  readonly fetchImpl: FirstPartyFetch
  readonly serverCredentialResolver: ServerCredentialResolver
  readonly nonceProvider: NonceProvider
  readonly timeoutMs?: number
  readonly timestampToleranceSeconds?: number
  readonly serverNowProvider?: () => string
}
