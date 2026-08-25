export const PUBLICATION_ROUTING_VERSION = 'publication-routing-v2' as const
export const GEOFlow_PINNED_SOURCE_SHA = '9d70db04ee9c5d308f5fa29b4c65834229af9eea' as const

export type PublicationRoutingVersion = typeof PUBLICATION_ROUTING_VERSION
export type Framework = 'astro' | 'nuxt' | 'wordpress' | 'php_agent' | 'generic_http' | 'geoflow_local' | 'static_site'
export type Transport = 'first_party_git' | 'first_party_signed_api' | 'wordpress_rest' | 'geoflow_agent' | 'generic_http' | 'geoflow_local'
export type Executor = 'first_party_git' | 'first_party_signed_api' | 'wordpress_rest' | 'geoflow_agent' | 'generic_http' | 'geoflow_local'
export type ExecutorAuthority = 'discoverystack_first_party' | 'geoflow_content_engine'
export type RouteStatus = 'planned' | 'delivered' | 'blocked' | 'failed' | 'retry_wait'
export type ReceiptStatus = Exclude<RouteStatus, 'planned'>
export type EventKind = RouteStatus
export type ProjectionKind = 'first_party' | 'geoflow'
export type OpaqueReference = string & { readonly __opaqueReference: unique symbol }

export interface Identity {
  readonly id: string
  readonly label?: string
}

export interface PublicationDraft {
  readonly ownerIdentity: Identity
  readonly clientIdentity: Identity
  readonly productionPlanId: string
  readonly deliverableId: string
  readonly draftId: string
  readonly reviewId: string
  readonly draftStage: 'optimized' | string
  readonly reviewDecision: 'approved_for_delivery' | string
  readonly riskGateStatus: 'passed' | 'blocked' | string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
  readonly content: string
  readonly contentType: string
  readonly language: string
  readonly sourcePublicationIdentity: string
  readonly geoflowSourceSha: string
}

export interface PublicationTargetInput {
  readonly targetId: string
  readonly siteIdentity: string
  readonly framework: Framework
  readonly transport: Transport
  readonly targetUrl: string | null
  readonly serviceReference: string | null
  readonly credentialReference: OpaqueReference | string
  readonly destinationPublicationIdentity: string
  readonly enabled: true
  readonly authority?: unknown
  readonly executor?: unknown
}

export interface CreateRoutingPlanInput {
  readonly draft: PublicationDraft
  readonly targets: readonly PublicationTargetInput[]
  readonly plannedAt: number
  readonly idempotencyKey?: string
}

export interface Capability {
  readonly framework: Framework
  readonly transport: Transport
  readonly executor: Executor
  readonly authority: ExecutorAuthority
  readonly projection: ProjectionKind
  readonly requiresPublicHttps: boolean
  readonly requiresServiceReference: boolean
}

export interface RouteLineage {
  readonly ownerIdentity: Identity
  readonly clientIdentity: Identity
  readonly productionPlanId: string
  readonly deliverableId: string
  readonly draftId: string
  readonly reviewId: string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
  readonly contentType: string
  readonly language: string
  readonly sourcePublicationIdentity: string
  readonly geoflowSourceSha: typeof GEOFlow_PINNED_SOURCE_SHA
}

export interface RouteIntent extends RouteLineage {
  readonly routeId: string
  readonly targetId: string
  readonly siteIdentity: string
  readonly framework: Framework
  readonly transport: Transport
  readonly executor: Executor
  readonly executorAuthority: ExecutorAuthority
  readonly targetUrl: string | null
  readonly serviceReference: string | null
  readonly credentialReference: OpaqueReference
  readonly destinationPublicationIdentity: string
  readonly status: 'planned'
}

export interface RoutingPlan {
  readonly version: PublicationRoutingVersion
  readonly status: 'planned'
  readonly plannedAt: number
  readonly metadata: RouteLineage
  readonly routes: readonly RouteIntent[]
  readonly planFingerprint: string
  readonly idempotencyKey: string
}

export type RoutingPlanValidationResult =
  | { readonly valid: true; readonly plan: RoutingPlan; readonly reasonCodes: readonly [] }
  | { readonly valid: false; readonly plan: null; readonly reasonCodes: readonly string[] }

export interface ProjectionLineage {
  readonly planFingerprint: string
  readonly routeId: string
  readonly targetId: string
  readonly siteIdentity: string
  readonly sourcePublicationIdentity: string
  readonly destinationPublicationIdentity: string
  readonly draftId: string
  readonly reviewId: string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
  readonly contentType: string
  readonly language: string
  readonly executor: Executor
  readonly executorAuthority: ExecutorAuthority
  readonly credentialReference: OpaqueReference
  readonly framework: Framework
  readonly transport: Transport
}

export interface FirstPartyProjectionIntent extends ProjectionLineage {
  readonly projection: 'first_party'
  readonly framework: 'astro' | 'nuxt'
  readonly transport: 'first_party_git' | 'first_party_signed_api'
  readonly executor: 'first_party_git' | 'first_party_signed_api'
  readonly executorAuthority: 'discoverystack_first_party'
  readonly targetUrl: string
}

export interface GeoflowProjectionIntent extends ProjectionLineage {
  readonly projection: 'geoflow'
  readonly framework: 'wordpress' | 'php_agent' | 'generic_http' | 'geoflow_local' | 'static_site'
  readonly transport: 'wordpress_rest' | 'geoflow_agent' | 'generic_http' | 'geoflow_local'
  readonly executor: 'wordpress_rest' | 'geoflow_agent' | 'generic_http' | 'geoflow_local'
  readonly executorAuthority: 'geoflow_content_engine'
  readonly targetUrl: string | null
  readonly serviceReference: string | null
  readonly geoflowSourceSha: typeof GEOFlow_PINNED_SOURCE_SHA
}

export type ProjectionIntent = FirstPartyProjectionIntent | GeoflowProjectionIntent

export interface ProjectionSet {
  readonly firstParty: readonly FirstPartyProjectionIntent[]
  readonly geoflow: readonly GeoflowProjectionIntent[]
}

export type ProjectionValidationResult =
  | { readonly valid: true; readonly projection: ProjectionIntent; readonly reasonCodes: readonly [] }
  | { readonly valid: false; readonly projection: null; readonly reasonCodes: readonly string[] }

export interface ReceiptHistoryValidationResult {
  readonly valid: boolean
  readonly receipts: readonly DeliveryReceipt[]
  readonly reasonCodes: readonly string[]
  readonly reasons: readonly string[]
}

export interface DeliveryReceipt {
  readonly planFingerprint: string
  readonly routeId: string
  readonly targetId: string
  readonly siteIdentity: string
  readonly sourcePublicationIdentity: string
  readonly destinationPublicationIdentity: string
  readonly draftId: string
  readonly reviewId: string
  readonly evidenceSnapshotHash: string
  readonly contentHash: string
  readonly executor: Executor
  readonly executorAuthority: ExecutorAuthority
  readonly executorRunId: OpaqueReference
  readonly attempt: number
  readonly status: ReceiptStatus
  readonly plannedAt: number
  readonly completedAt: number
  readonly occurredAt: number
}

export type ReceiptValidationResult = {
  readonly valid: boolean
  readonly replay: boolean
  readonly collision: boolean
  readonly receiptFingerprint: string | null
  readonly reasonCodes: readonly string[]
  readonly reasons: readonly string[]
}

export interface RetryValidationResult {
  readonly valid: boolean
  readonly reasonCodes: readonly string[]
  readonly reasons: readonly string[]
}

export interface PlannedRouteEvent {
  readonly planFingerprint: string
  readonly routeId: string
  readonly sequence: number
  readonly kind: 'planned'
  readonly attempt: null
  readonly executorRunId: null
  readonly receiptFingerprint: null
  readonly occurredAt: number
  readonly detail?: string
}

export interface ResultRouteEvent {
  readonly planFingerprint: string
  readonly routeId: string
  readonly sequence: number
  readonly kind: 'delivered' | 'blocked' | 'failed' | 'retry_wait'
  readonly attempt: number
  readonly executorRunId: OpaqueReference
  readonly receiptFingerprint: string
  readonly occurredAt: number
  readonly detail?: string
}

export type RouteEvent = PlannedRouteEvent | ResultRouteEvent

export interface EventAppendResult {
  readonly accepted: boolean
  readonly replay: boolean
  readonly collision: boolean
  readonly events: readonly RouteEvent[]
  readonly reasonCodes: readonly string[]
  readonly reasons: readonly string[]
}

export interface RouteEventAggregate {
  readonly routeId: string
  readonly status: 'planned' | ReceiptStatus
  readonly delivered: number
  readonly blocked: number
  readonly failed: number
  readonly retryWait: number
  readonly eventCount: number
}

export interface PlanEventAggregate {
  readonly planFingerprint: string
  readonly overall: 'planned' | 'partial' | 'delivered' | 'blocked' | 'failed' | 'retry_wait'
  readonly routes: readonly RouteEventAggregate[]
}

export interface GuardResult {
  readonly valid: boolean
  readonly reasonCodes: readonly string[]
  readonly reasons: readonly string[]
  readonly normalizedUrl: string | null
  readonly normalizedServiceReference: string | null
}

export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue }
