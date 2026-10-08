/** Server-read native dependency state. Never accepted as HTTP authority. */
export type DatasetKnowledgeMode = 'declared_none_v1' | 'pinned_v1'
export interface DatasetKnowledgeHead {
  subjectKind: 'entity' | 'claim' | 'source'
  subjectId: number
  operation: 'bind' | 'revoke'
  sequenceNumber: number
  bindingFingerprint: string
  revisionNumber: number
  revisionContentHash: string
  revisionFingerprint: string
  /** Active pins must match the verified canonical subject's current ledger head. */
  currentRevisionFingerprint: string | null
}
export interface DatasetKnowledgeState {
  ownerUserId: number
  manifestId: string
  manifestFingerprint: string
  nativeDatasetId: number
  /** Includes revoked tombstones, so an empty active set cannot erase history. */
  heads: DatasetKnowledgeHead[]
}
export interface DatasetKnowledgeAuthority extends DatasetKnowledgeState {
  schemaVersion: 'geo-dataset-knowledge-authority-v1'
  mode: DatasetKnowledgeMode
  authorityFingerprint: string
}
export interface DatasetKnowledgeApprovalReference {
  datasetDecisionId: string
  knowledgeAuthorityFingerprint: string
}
export interface DatasetKnowledgeAuthoritySummary {
  status: 'not_declared' | 'current' | 'stale' | 'unavailable'
  mode: DatasetKnowledgeMode | null
  authorityFingerprint: string | null
  activePinCount: number
  reasonCodes: string[]
}
