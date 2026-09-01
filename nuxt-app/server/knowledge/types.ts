export const KNOWLEDGE_ENTITY_TYPES = ['Person', 'Organization', 'Brand', 'Product', 'Service', 'Concept', 'Topic', 'Location', 'Author', 'Research', 'Dataset', 'Claim', 'Source', 'Article', 'Question', 'Event', 'Statistic'] as const
export type KnowledgeEntityType = typeof KNOWLEDGE_ENTITY_TYPES[number]

export const KNOWLEDGE_EDGE_PREDICATES = ['worksFor', 'about', 'authoredBy', 'supportedBy', 'offeredBy', 'supports', 'answeredBy', 'mentions', 'producedBy'] as const
export type KnowledgeEdgePredicate = typeof KNOWLEDGE_EDGE_PREDICATES[number]

export const KNOWLEDGE_CLAIM_TYPES = ['statistics', 'pricing', 'laws and regulations', 'medical / financial / legal claims', 'product capabilities', 'research findings', 'competitive comparisons', 'first-party measurements', 'time-sensitive facts'] as const
export type KnowledgeClaimType = typeof KNOWLEDGE_CLAIM_TYPES[number]

export const KNOWLEDGE_CLAIM_STATUSES = ['unverified', 'source_backed', 'independently_confirmed', 'first_party_measured', 'disputed', 'expired', 'retracted'] as const
export type KnowledgeClaimStatus = typeof KNOWLEDGE_CLAIM_STATUSES[number]

export const KNOWLEDGE_SOURCE_CLASSES = ['official documentation', 'government', 'academic / peer-reviewed', 'primary research', 'first-party company data', 'major publication', 'secondary media', 'expert publication', 'blog', 'forum', 'social', 'unknown'] as const
export type KnowledgeSourceClass = typeof KNOWLEDGE_SOURCE_CLASSES[number]

export type KnowledgeDecisionCode =
  | 'DUPLICATE_ENTITY'
  | 'INVALID_TRANSITION'
  | 'MERGE_CYCLE'
  | 'MERGE_NOT_ACTIVE'
  | 'UNDO_NOT_LATEST'
  | 'DISPUTE_ALREADY_OPEN'
  | 'ENTITY_NOT_FOUND'
  | 'CLAIM_NOT_FOUND'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_VERSION_NOT_FOUND'
  | 'DUPLICATE_SOURCE'
  | 'DUPLICATE_EVIDENCE'
  | 'MERGE_CANDIDATE_NOT_FOUND'
  | 'DISPUTE_NOT_FOUND'
  | 'PUBLISHER_ENTITY_INVALID'
  | 'CONTENT_ANCHOR_NOT_FOUND'
  | 'CONTENT_LINK_DUPLICATE'
  | 'CONTENT_LINK_NOT_FOUND'
  | 'OWNER_SCOPE_MISMATCH'
  | 'INVALID_INPUT'

export type ExactEntityMatch =
  | { readonly method: 'exact_external_id'; readonly idType: string; readonly idValue: string }
  | { readonly method: 'exact_canonical_uri'; readonly canonicalUri: string }

export interface KnowledgeRejectedResult {
  readonly status: 'rejected'
  readonly code: KnowledgeDecisionCode
  readonly reason: string
  readonly existingEntityId?: number
  readonly matchedOn?: ExactEntityMatch
}

export interface KnowledgeOkResult<T> {
  readonly status: 'ok'
  readonly value: T
}

export type KnowledgeResult<T> = KnowledgeOkResult<T> | KnowledgeRejectedResult

export interface KnowledgeBaseRecord {
  readonly id: number
  readonly ownerUserId: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface KnowledgeEntity extends KnowledgeBaseRecord {
  readonly entityUid: string
  readonly entityType: KnowledgeEntityType
  readonly canonicalName: string
  readonly slug: string | null
  readonly canonicalUri: string | null
  readonly canonicalUriHash: string | null
  readonly locale: string | null
  readonly summary: string | null
  readonly status: 'active' | 'merged' | 'retired'
  readonly publicVisibility: 'private' | 'public_candidate'
  readonly mergedIntoEntityId: number | null
  readonly provenance: unknown | null
}

export interface KnowledgeEntityAlias extends KnowledgeBaseRecord {
  readonly entityId: number
  readonly alias: string
  readonly aliasNormalized: string
  readonly locale: string | null
}

export interface KnowledgeEntityExternalId extends KnowledgeBaseRecord {
  readonly entityId: number
  readonly idType: string
  readonly idValue: string
}

export interface KnowledgeSource extends KnowledgeBaseRecord {
  readonly canonicalUrl: string
  readonly urlHash: string
  readonly title: string | null
  readonly sourceClass: KnowledgeSourceClass
  readonly status: 'active' | 'archived'
  readonly notes: string | null
}

export interface KnowledgeSourceVersion extends KnowledgeBaseRecord {
  readonly sourceId: number
  readonly versionNumber: number
  readonly contentHash: string
  readonly retrievedAt: Date
  readonly excerpt: string | null
  readonly metadata: unknown | null
}

export interface KnowledgeClaim extends KnowledgeBaseRecord {
  readonly statement: string
  readonly claimType: KnowledgeClaimType
  readonly status: KnowledgeClaimStatus
  readonly validFrom: Date | null
  readonly validTo: Date | null
}

export interface KnowledgeClaimEntityLink extends KnowledgeBaseRecord {
  readonly claimId: number
  readonly entityId: number
}

export type KnowledgeEvidenceRelation = 'supports' | 'contradicts' | 'contextualizes' | 'supersedes'

export interface KnowledgeClaimEvidence extends KnowledgeBaseRecord {
  readonly claimId: number
  readonly sourceVersionId: number
  readonly relation: KnowledgeEvidenceRelation
  readonly locator: string
  readonly locatorHash: string
  readonly contentHash: string
  readonly reviewNotes: string | null
}

export interface KnowledgeClaimStatusEvent extends KnowledgeBaseRecord {
  readonly claimId: number
  readonly fromStatus: KnowledgeClaimStatus
  readonly toStatus: KnowledgeClaimStatus
  readonly reason: string
  readonly triggeredBy: 'system' | 'owner'
}

export interface KnowledgeClaimDispute extends KnowledgeBaseRecord {
  readonly claimAId: number
  readonly claimBId: number
  readonly detectionMethod: 'shared_source_conflict' | 'manual'
  readonly detectionReason: string
  readonly status: 'open' | 'resolved'
  readonly resolution: 'kept_a' | 'kept_b' | 'both_stand' | 'other' | null
  readonly resolutionNote: string | null
  readonly resolvedAt: Date | null
}

export interface KnowledgeEntityMergeCandidate extends KnowledgeBaseRecord {
  readonly sourceEntityId: number
  readonly targetEntityId: number
  readonly matchMethod: 'exact_external_id' | 'exact_canonical_uri' | 'normalized_name'
  readonly matchDetail: unknown
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly decisionNote: string | null
  readonly decidedAt: Date | null
}

export interface KnowledgeEntityMergeEvent extends KnowledgeBaseRecord {
  readonly sourceEntityId: number
  readonly targetEntityId: number
  readonly candidateId: number | null
  readonly reason: string
  readonly undoneAt: Date | null
  readonly undoReason: string | null
}

export type KnowledgeContentEntityRole = 'author' | 'about' | 'mentions'

export interface KnowledgeContentEntityLink extends KnowledgeBaseRecord {
  readonly briefId: number
  readonly entityId: number
  readonly role: KnowledgeContentEntityRole
}

export interface KnowledgePublisherSetting extends KnowledgeBaseRecord {
  readonly organizationEntityId: number
}

export interface KnowledgeContentAnchor {
  readonly briefId: number
  readonly jobId: number
  readonly draftId: number
  readonly title: string
  readonly language: string
  readonly contentType: string
  readonly contentHash: string
  readonly draftCreatedAt: Date
}

export interface KnowledgeContentAnchorSeed extends KnowledgeContentAnchor {
  readonly ownerUserId: number
}

export interface CreateKnowledgeEntityInput {
  readonly entityType: KnowledgeEntityType
  readonly canonicalName: string
  readonly slug?: string
  readonly canonicalUri?: string
  readonly locale?: string
  readonly summary?: string
  readonly publicVisibility?: 'private' | 'public_candidate'
  readonly provenance?: unknown
  readonly externalIds?: readonly { readonly idType: string; readonly idValue: string }[]
  readonly aliases?: readonly { readonly alias: string; readonly locale?: string }[]
}

export interface CreateKnowledgeClaimInput {
  readonly statement: string
  readonly claimType: KnowledgeClaimType
  readonly entityIds: readonly number[]
  readonly validFrom?: Date
  readonly validTo?: Date
}

export interface KnowledgeContentGap {
  readonly type: 'missing_author' | 'missing_publisher'
  readonly briefId?: number
}

export type NewKnowledgeRecord<T extends KnowledgeBaseRecord> = Omit<T, 'id'>

export interface KnowledgeRepository {
  transaction<T>(work: (repository: KnowledgeRepository) => Promise<T>): Promise<T>

  listEntities(ownerUserId: number): Promise<KnowledgeEntity[]>
  getEntity(ownerUserId: number, entityId: number): Promise<KnowledgeEntity | null>
  insertEntity(record: NewKnowledgeRecord<KnowledgeEntity>): Promise<KnowledgeEntity>
  updateEntity(ownerUserId: number, entityId: number, patch: Partial<Pick<KnowledgeEntity, 'status' | 'mergedIntoEntityId' | 'updatedAt'>>): Promise<KnowledgeEntity | null>

  listEntityAliases(ownerUserId: number, entityId?: number): Promise<KnowledgeEntityAlias[]>
  insertEntityAlias(record: NewKnowledgeRecord<KnowledgeEntityAlias>): Promise<KnowledgeEntityAlias>
  listEntityExternalIds(ownerUserId: number, entityId?: number): Promise<KnowledgeEntityExternalId[]>
  insertEntityExternalId(record: NewKnowledgeRecord<KnowledgeEntityExternalId>): Promise<KnowledgeEntityExternalId>

  listMergeCandidates(ownerUserId: number, status?: KnowledgeEntityMergeCandidate['status']): Promise<KnowledgeEntityMergeCandidate[]>
  getMergeCandidate(ownerUserId: number, candidateId: number): Promise<KnowledgeEntityMergeCandidate | null>
  insertMergeCandidate(record: NewKnowledgeRecord<KnowledgeEntityMergeCandidate>): Promise<KnowledgeEntityMergeCandidate>
  updateMergeCandidate(ownerUserId: number, candidateId: number, patch: Partial<Pick<KnowledgeEntityMergeCandidate, 'status' | 'decisionNote' | 'decidedAt' | 'updatedAt'>>): Promise<KnowledgeEntityMergeCandidate | null>
  listMergeEvents(ownerUserId: number, sourceEntityId?: number): Promise<KnowledgeEntityMergeEvent[]>
  getMergeEvent(ownerUserId: number, mergeEventId: number): Promise<KnowledgeEntityMergeEvent | null>
  insertMergeEvent(record: NewKnowledgeRecord<KnowledgeEntityMergeEvent>): Promise<KnowledgeEntityMergeEvent>
  updateMergeEvent(ownerUserId: number, mergeEventId: number, patch: Partial<Pick<KnowledgeEntityMergeEvent, 'undoneAt' | 'undoReason' | 'updatedAt'>>): Promise<KnowledgeEntityMergeEvent | null>

  listSources(ownerUserId: number): Promise<KnowledgeSource[]>
  getSource(ownerUserId: number, sourceId: number): Promise<KnowledgeSource | null>
  insertSource(record: NewKnowledgeRecord<KnowledgeSource>): Promise<KnowledgeSource>
  listSourceVersions(ownerUserId: number, sourceId?: number): Promise<KnowledgeSourceVersion[]>
  getSourceVersion(ownerUserId: number, sourceVersionId: number): Promise<KnowledgeSourceVersion | null>
  insertSourceVersion(record: NewKnowledgeRecord<KnowledgeSourceVersion>): Promise<KnowledgeSourceVersion>

  listClaims(ownerUserId: number, status?: KnowledgeClaimStatus): Promise<KnowledgeClaim[]>
  getClaim(ownerUserId: number, claimId: number): Promise<KnowledgeClaim | null>
  insertClaim(record: NewKnowledgeRecord<KnowledgeClaim>): Promise<KnowledgeClaim>
  updateClaim(ownerUserId: number, claimId: number, patch: Partial<Pick<KnowledgeClaim, 'status' | 'updatedAt'>>): Promise<KnowledgeClaim | null>
  listClaimEntityLinks(ownerUserId: number, claimId?: number): Promise<KnowledgeClaimEntityLink[]>
  insertClaimEntityLink(record: NewKnowledgeRecord<KnowledgeClaimEntityLink>): Promise<KnowledgeClaimEntityLink>
  listClaimEvidence(ownerUserId: number, claimId?: number): Promise<KnowledgeClaimEvidence[]>
  insertClaimEvidence(record: NewKnowledgeRecord<KnowledgeClaimEvidence>): Promise<KnowledgeClaimEvidence>
  listClaimStatusEvents(ownerUserId: number, claimId?: number): Promise<KnowledgeClaimStatusEvent[]>
  insertClaimStatusEvent(record: NewKnowledgeRecord<KnowledgeClaimStatusEvent>): Promise<KnowledgeClaimStatusEvent>

  listDisputes(ownerUserId: number, status?: KnowledgeClaimDispute['status']): Promise<KnowledgeClaimDispute[]>
  getDispute(ownerUserId: number, disputeId: number): Promise<KnowledgeClaimDispute | null>
  insertDispute(record: NewKnowledgeRecord<KnowledgeClaimDispute>): Promise<KnowledgeClaimDispute>
  updateDispute(ownerUserId: number, disputeId: number, patch: Partial<Pick<KnowledgeClaimDispute, 'status' | 'resolution' | 'resolutionNote' | 'resolvedAt' | 'updatedAt'>>): Promise<KnowledgeClaimDispute | null>

  getPublisherSetting(ownerUserId: number): Promise<KnowledgePublisherSetting | null>
  upsertPublisherSetting(record: NewKnowledgeRecord<KnowledgePublisherSetting>): Promise<KnowledgePublisherSetting>
  listContentEntityLinks(ownerUserId: number, briefId?: number): Promise<KnowledgeContentEntityLink[]>
  insertContentEntityLink(record: NewKnowledgeRecord<KnowledgeContentEntityLink>): Promise<KnowledgeContentEntityLink>
  deleteContentEntityLink(ownerUserId: number, briefId: number, entityId: number, role: KnowledgeContentEntityRole): Promise<boolean>
  getContentAnchor(input: { readonly ownerUserId: number; readonly draftId?: number; readonly briefId?: number }): Promise<KnowledgeContentAnchor | null>
  listContentAnchors(ownerUserId: number): Promise<KnowledgeContentAnchor[]>
}

export interface InMemoryKnowledgeRepository extends KnowledgeRepository {
  seedContentAnchor(anchor: KnowledgeContentAnchorSeed): void
}
