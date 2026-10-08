import type { KnowledgeMutationEvent, KnowledgeRevision, KnowledgeRevisionSubject } from './revision-types'
import type { KnowledgeRepository } from './types'

export type KnowledgeConsumerKind = 'geo_dataset' | 'benchmark_prompt'
export interface KnowledgeConsumerAnchor {
  readonly ownerUserId: number
  readonly consumerKind: KnowledgeConsumerKind
  readonly consumerId: number
  readonly consumerVersion: string
  readonly consumerContentHash: string
}
export interface KnowledgeConsumerBinding extends KnowledgeConsumerAnchor {
  readonly id: number
  readonly subjectKind: KnowledgeRevisionSubject['kind']
  readonly subjectId: number
  readonly revisionId: number
  readonly revisionNumber: number
  readonly revisionContentHash: string
  readonly revisionFingerprint: string
  readonly operation: 'bind' | 'revoke'
  readonly sequenceNumber: number
  readonly previousBindingFingerprint: string | null
  readonly bindingFingerprint: string
  readonly requestFingerprint: string
  readonly idempotencyKey: string
  readonly createdAt: Date
}
export interface KnowledgeConsumerBindingInput {
  readonly consumerKind: KnowledgeConsumerKind
  readonly consumerId: number
  readonly subjectKind: KnowledgeRevisionSubject['kind']
  readonly subjectId: number
  readonly operation: 'bind' | 'revoke'
  /** Compare-only preconditions, never authority supplied by the browser. */
  readonly expectedRevisionFingerprint: string | null
  readonly expectedBindingFingerprint: string | null
  readonly idempotencyKey: string
}
export interface KnowledgeConsumerBindingRepository {
  readonly knowledge: KnowledgeRepository
  transaction<T>(work: (repository: KnowledgeConsumerBindingRepository) => Promise<T>): Promise<T>
  getNativeAnchor(ownerUserId: number, kind: KnowledgeConsumerKind, id: number, lock?: true): Promise<KnowledgeConsumerAnchor | null>
  getBindingHead(ownerUserId: number, input: Pick<KnowledgeConsumerBindingInput, 'consumerKind' | 'consumerId' | 'subjectKind' | 'subjectId'>): Promise<KnowledgeConsumerBinding | null>
  getCommand(ownerUserId: number, idempotencyKey: string): Promise<KnowledgeConsumerBinding | null>
  getBindingByFingerprint(ownerUserId: number, fingerprint: string): Promise<KnowledgeConsumerBinding | null>
  getBoundRevision(ownerUserId: number, id: number): Promise<KnowledgeRevision | null>
  appendBinding(record: Omit<KnowledgeConsumerBinding, 'id'>): Promise<KnowledgeConsumerBinding>
  listBindingHeads(ownerUserId: number, limit: number): Promise<KnowledgeConsumerBinding[]>
  /** Durable adapters batch these exact authorities; legacy test ports may resolve individually. */
  loadAuthorities?(ownerUserId: number, rows: readonly KnowledgeConsumerBinding[]): Promise<KnowledgeConsumerBindingAuthorities>
  /** Ordered, bounded native inventory; no arbitrary caller-owned hashes or prompt text. */
  listNativeAnchors?(ownerUserId: number, kind: KnowledgeConsumerKind, afterId: number, limit: number): Promise<KnowledgeConsumerAnchor[]>
}
export type KnowledgeConsumerBindingSummary = Pick<KnowledgeConsumerBinding,
  'id' | 'consumerKind' | 'consumerId' | 'consumerVersion' | 'consumerContentHash' |
  'subjectKind' | 'subjectId' | 'revisionId' | 'revisionNumber' | 'revisionContentHash' |
  'revisionFingerprint' | 'operation' | 'sequenceNumber' | 'bindingFingerprint' | 'previousBindingFingerprint'>
export interface KnowledgeConsumerBindingHeadSummary extends KnowledgeConsumerBindingSummary {
  readonly nativeAvailability: 'present' | 'missing'
}
export interface KnowledgeConsumerCatalog {
  readonly consumerKind: KnowledgeConsumerKind
  readonly items: ReadonlyArray<Omit<KnowledgeConsumerAnchor, 'ownerUserId'>>
  readonly nextAfterId: number | null
  readonly scope: 'owner_native_immutable_consumers_v1'
  readonly rawTextIncluded: false
  readonly automaticPublication: false
  readonly automaticTrainingAdmission: false
  readonly productionActivation: false
}
export interface KnowledgeConsumerBindingAuthorities {
  readonly predecessors: Map<string, KnowledgeConsumerBinding>
  readonly anchors: Map<string, KnowledgeConsumerAnchor>
  readonly revisions: Map<number, KnowledgeRevision>
  readonly events: Map<number, KnowledgeMutationEvent>
}
export type KnowledgeConsumerBindingErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'REVISION_REQUIRED' | 'CONFLICT' | 'CORRUPT_STATE' | 'LIMIT_EXCEEDED'
export class KnowledgeConsumerBindingError extends Error {
  constructor(readonly code: KnowledgeConsumerBindingErrorCode) {
    super('Knowledge consumer binding could not be verified.')
    this.name = 'KnowledgeConsumerBindingError'
  }
}
