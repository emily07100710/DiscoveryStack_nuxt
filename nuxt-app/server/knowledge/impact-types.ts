import type {
  KnowledgeClaim,
  KnowledgeClaimEntityLink,
  KnowledgeClaimEvidence,
  KnowledgeContentEntityLink,
  KnowledgeEntity,
  KnowledgeEntityAlias,
  KnowledgeEntityExternalId,
  KnowledgePublisherSetting,
  KnowledgeSource,
  KnowledgeSourceVersion,
} from './types'

export type KnowledgeImpactSubjectKind = 'entity' | 'claim' | 'source'
export type KnowledgeImpactCategory = 'content' | 'schema' | 'dataset' | 'public_api' | 'benchmark_prompt' | 'reviewer'

export interface KnowledgeImpactSubject {
  readonly kind: KnowledgeImpactSubjectKind
  readonly id: number
}

export interface KnowledgeImpactContentAnchor {
  readonly ownerUserId: number
  readonly briefId: number
  readonly jobId: number
  readonly draftId: number
  readonly title: string
  readonly language: string
  readonly contentType: string
  readonly contentHash: string
  readonly draftCreatedAt: Date
}

export type KnowledgeImpactDependencyKind = 'entity' | 'claim' | 'source' | 'source_version' | 'content'

export interface KnowledgeImpactDependencyRef {
  readonly kind: KnowledgeImpactDependencyKind
  readonly id: number
  readonly version: string | number | null
  readonly contentHash: string | null
  /** Private semantic revision identity; never a publication or training approval. */
  readonly revisionFingerprint?: string
}

/** Reduced current head only. Does not contain private canonical snapshot bytes. */
export interface KnowledgeImpactRevisionHead {
  readonly ownerUserId: number
  readonly subjectKind: KnowledgeImpactSubjectKind
  readonly subjectId: number
  readonly revisionNumber: number
  readonly contentHash: string
  readonly revisionFingerprint: string
}

export interface KnowledgeImpactConsumerRef {
  /** Typed adapter category. Consumer IDs are opaque exact identifiers, never names to search. */
  readonly category: Exclude<KnowledgeImpactCategory, 'content' | 'schema'>
  readonly ownerUserId: number
  readonly consumerId: string
  readonly version: string
  readonly contentHash: string
  readonly dependencies: readonly KnowledgeImpactDependencyRef[]
  /** Recorded native consumer was removed; preserve exact dependencies as stale. */
  readonly nativeAvailability?: 'missing'
}

export interface KnowledgeImpactAdapterCoverage {
  readonly category: KnowledgeImpactCategory
  readonly state: 'complete' | 'unconfigured'
  readonly scope: string
  readonly limitationCodes: readonly string[]
  readonly consumers: readonly KnowledgeImpactConsumerRef[]
}

export interface KnowledgeImpactSnapshot {
  readonly entities: readonly KnowledgeEntity[]
  readonly aliases: readonly KnowledgeEntityAlias[]
  readonly externalIds: readonly KnowledgeEntityExternalId[]
  readonly sources: readonly KnowledgeSource[]
  readonly sourceVersions: readonly KnowledgeSourceVersion[]
  readonly claims: readonly KnowledgeClaim[]
  readonly claimEntityLinks: readonly KnowledgeClaimEntityLink[]
  readonly evidence: readonly KnowledgeClaimEvidence[]
  readonly contentLinks: readonly KnowledgeContentEntityLink[]
  readonly publisher: KnowledgePublisherSetting | null
  readonly contentAnchors: readonly KnowledgeImpactContentAnchor[]
  readonly adapterCoverage: readonly KnowledgeImpactAdapterCoverage[]
  /** Omitted only by legacy pure adapters; pinned dependencies then remain stale. */
  readonly revisionHeads?: readonly KnowledgeImpactRevisionHead[]
}

export interface KnowledgeImpactLineageRef {
  readonly kind: KnowledgeImpactDependencyKind
  readonly id: number
  readonly relation: string
  readonly version: string | number | null
  readonly contentHash: string | null
}

export interface KnowledgeImpactItem {
  readonly kind: 'content' | 'schema' | 'consumer'
  readonly id: string
  readonly version: string
  /** Null when the projection output bytes are not materialized in this snapshot. */
  readonly contentHash: string | null
  readonly dependencyFingerprint: string
  readonly reasonCode: 'explicit_content_entity_binding' | 'projection_inputs_only' | 'exact_registered_dependency' | 'exact_registered_dependency_stale'
  readonly lineage: readonly KnowledgeImpactLineageRef[]
}

export interface KnowledgeImpactBucket {
  readonly category: KnowledgeImpactCategory
  readonly state: 'complete' | 'unconfigured'
  readonly scope: string
  readonly limitationCodes: readonly string[]
  readonly items: readonly KnowledgeImpactItem[]
}

export interface KnowledgeImpactReport {
  readonly ownerUserId: number
  readonly subject: KnowledgeImpactSubject
  readonly coverageScope: 'known_explicit_dependencies_only'
  readonly exhaustive: false
  readonly graphFingerprint: string
  readonly outputFingerprint: string
  readonly affectedKnowledge: readonly KnowledgeImpactLineageRef[]
  readonly buckets: readonly [
    KnowledgeImpactBucket,
    KnowledgeImpactBucket,
    KnowledgeImpactBucket,
    KnowledgeImpactBucket,
    KnowledgeImpactBucket,
    KnowledgeImpactBucket,
  ]
  readonly automaticPublication: false
  readonly productionActivation: false
  readonly automaticTrainingAdmission: false
}

export type KnowledgeImpactErrorCode = 'INVALID_INPUT' | 'SUBJECT_NOT_FOUND' | 'CORRUPT_GRAPH' | 'SNAPSHOT_LIMIT_EXCEEDED'

export class KnowledgeImpactError extends Error {
  readonly code: KnowledgeImpactErrorCode

  constructor(code: KnowledgeImpactErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgeImpactError'
    this.code = code
  }
}

export const KNOWLEDGE_IMPACT_BUCKET_ORDER: readonly KnowledgeImpactCategory[] = [
  'content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer',
]

export const KNOWLEDGE_IMPACT_MAX_ROWS_PER_COLLECTION = 2_000
export const KNOWLEDGE_IMPACT_MAX_CONSUMERS_PER_CATEGORY = 1_000
export const KNOWLEDGE_IMPACT_MAX_ITEMS = 1_000
export const KNOWLEDGE_IMPACT_MAX_REFERENCES = 10_000
