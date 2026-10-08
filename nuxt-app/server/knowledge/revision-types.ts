import type { KnowledgeBaseRecord } from './types'

export const KNOWLEDGE_REVISION_SCHEMA = 'knowledge-subject-revision-v1' as const
export type KnowledgeRevisionSubjectKind = 'entity' | 'claim' | 'source'
export interface KnowledgeRevisionSubject { readonly kind: KnowledgeRevisionSubjectKind; readonly id: number }

/** Private immutable historical state. HTTP projections must never return canonicalSnapshot. */
export interface KnowledgeRevision extends KnowledgeBaseRecord {
  readonly subjectKind: KnowledgeRevisionSubjectKind
  readonly subjectId: number
  readonly schemaVersion: typeof KNOWLEDGE_REVISION_SCHEMA
  readonly revisionNumber: number
  readonly revisionKind: 'legacy_baseline' | 'mutation'
  readonly canonicalSnapshot: string
  readonly contentHash: string
  readonly previousRevisionFingerprint: string | null
  readonly revisionFingerprint: string
  readonly operations: readonly string[]
}

/** One immutable event per revision, committed in the same transaction. */
export interface KnowledgeMutationEvent extends KnowledgeBaseRecord {
  readonly subjectKind: KnowledgeRevisionSubjectKind
  readonly subjectId: number
  readonly revisionId: number
  readonly revisionNumber: number
  readonly previousRevisionFingerprint: string | null
  readonly newRevisionFingerprint: string
  readonly eventFingerprint: string
  readonly operations: readonly string[]
}

export type KnowledgeRevisionErrorCode = 'INVALID_INPUT' | 'SUBJECT_NOT_FOUND' | 'CORRUPT_STATE' | 'LIMIT_EXCEEDED' | 'REVISION_CONFLICT'
export class KnowledgeRevisionError extends Error {
  constructor(readonly code: KnowledgeRevisionErrorCode, message = 'Knowledge revision operation could not be completed.') {
    super(message)
    this.name = 'KnowledgeRevisionError'
  }
}

export interface KnowledgeRevisionHistoryItem {
  readonly revisionId: number
  readonly revisionNumber: number
  readonly revisionKind: KnowledgeRevision['revisionKind']
  readonly contentHash: string
  readonly previousRevisionFingerprint: string | null
  readonly revisionFingerprint: string
  readonly eventFingerprint: string
  readonly operations: readonly string[]
  readonly occurredAt: string
}

export interface KnowledgeRevisionHistory {
  readonly subject: KnowledgeRevisionSubject
  readonly items: readonly KnowledgeRevisionHistoryItem[]
  readonly nextCursor: string | null
  readonly historyScope: 'recorded_mutations_only'
  readonly rawSnapshotIncluded: false
  readonly automaticPublication: false
  readonly productionActivation: false
  readonly automaticTrainingAdmission: false
}
