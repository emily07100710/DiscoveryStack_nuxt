import type {
  InMemoryKnowledgeRepository,
  KnowledgeBaseRecord,
  KnowledgeClaim,
  KnowledgeClaimDispute,
  KnowledgeClaimEntityLink,
  KnowledgeClaimEvidence,
  KnowledgeClaimStatus,
  KnowledgeClaimStatusEvent,
  KnowledgeContentAnchorSeed,
  KnowledgeContentEntityLink,
  KnowledgeContentEntityRole,
  KnowledgeEntity,
  KnowledgeEntityAlias,
  KnowledgeEntityExternalId,
  KnowledgeEntityMergeCandidate,
  KnowledgeEntityMergeEvent,
  KnowledgePublisherSetting,
  KnowledgeRepository,
  KnowledgeSource,
  KnowledgeSourceVersion,
  NewKnowledgeRecord,
} from './types'

interface MemoryTables {
  entities: KnowledgeEntity[]
  aliases: KnowledgeEntityAlias[]
  externalIds: KnowledgeEntityExternalId[]
  mergeCandidates: KnowledgeEntityMergeCandidate[]
  mergeEvents: KnowledgeEntityMergeEvent[]
  sources: KnowledgeSource[]
  sourceVersions: KnowledgeSourceVersion[]
  claims: KnowledgeClaim[]
  claimEntityLinks: KnowledgeClaimEntityLink[]
  evidence: KnowledgeClaimEvidence[]
  statusEvents: KnowledgeClaimStatusEvent[]
  disputes: KnowledgeClaimDispute[]
  publisherSettings: KnowledgePublisherSetting[]
  contentLinks: KnowledgeContentEntityLink[]
}

type MemoryTableName = keyof MemoryTables

function clone<T>(value: T): T {
  return structuredClone(value)
}

class MemoryKnowledgeRepository implements InMemoryKnowledgeRepository {
  private tables: MemoryTables = {
    entities: [],
    aliases: [],
    externalIds: [],
    mergeCandidates: [],
    mergeEvents: [],
    sources: [],
    sourceVersions: [],
    claims: [],
    claimEntityLinks: [],
    evidence: [],
    statusEvents: [],
    disputes: [],
    publisherSettings: [],
    contentLinks: [],
  }

  private anchors: KnowledgeContentAnchorSeed[] = []
  private counters = new Map<MemoryTableName, number>()

  async transaction<T>(work: (repository: KnowledgeRepository) => Promise<T>): Promise<T> {
    const tableSnapshot = clone(this.tables)
    const anchorSnapshot = clone(this.anchors)
    const counterSnapshot = new Map(this.counters)
    try {
      return await work(this)
    } catch (error) {
      this.tables = tableSnapshot
      this.anchors = anchorSnapshot
      this.counters = counterSnapshot
      throw error
    }
  }

  private insert<K extends MemoryTableName>(table: K, record: NewKnowledgeRecord<MemoryTables[K][number]>): MemoryTables[K][number] {
    const id = (this.counters.get(table) ?? 0) + 1
    this.counters.set(table, id)
    const saved = { ...clone(record), id } as MemoryTables[K][number]
    ;(this.tables[table] as Array<MemoryTables[K][number]>).push(saved)
    return clone(saved)
  }

  private update<T extends KnowledgeBaseRecord>(table: T[], ownerUserId: number, id: number, patch: Partial<T>): T | null {
    const index = table.findIndex(item => item.ownerUserId === ownerUserId && item.id === id)
    if (index < 0) return null
    const updated = { ...table[index], ...clone(patch) } as T
    table[index] = updated
    return clone(updated)
  }

  async listEntities(ownerUserId: number) { return clone(this.tables.entities.filter(item => item.ownerUserId === ownerUserId)) }
  async getEntity(ownerUserId: number, entityId: number) { return clone(this.tables.entities.find(item => item.ownerUserId === ownerUserId && item.id === entityId) ?? null) }
  async insertEntity(record: NewKnowledgeRecord<KnowledgeEntity>) { return this.insert('entities', record) }
  async updateEntity(ownerUserId: number, entityId: number, patch: Partial<Pick<KnowledgeEntity, 'status' | 'mergedIntoEntityId' | 'updatedAt'>>) { return this.update<KnowledgeEntity>(this.tables.entities, ownerUserId, entityId, patch) }

  async listEntityAliases(ownerUserId: number, entityId?: number) { return clone(this.tables.aliases.filter(item => item.ownerUserId === ownerUserId && (entityId === undefined || item.entityId === entityId))) }
  async insertEntityAlias(record: NewKnowledgeRecord<KnowledgeEntityAlias>) { return this.insert('aliases', record) }
  async listEntityExternalIds(ownerUserId: number, entityId?: number) { return clone(this.tables.externalIds.filter(item => item.ownerUserId === ownerUserId && (entityId === undefined || item.entityId === entityId))) }
  async insertEntityExternalId(record: NewKnowledgeRecord<KnowledgeEntityExternalId>) { return this.insert('externalIds', record) }

  async listMergeCandidates(ownerUserId: number, status?: KnowledgeEntityMergeCandidate['status']) { return clone(this.tables.mergeCandidates.filter(item => item.ownerUserId === ownerUserId && (status === undefined || item.status === status))) }
  async getMergeCandidate(ownerUserId: number, candidateId: number) { return clone(this.tables.mergeCandidates.find(item => item.ownerUserId === ownerUserId && item.id === candidateId) ?? null) }
  async insertMergeCandidate(record: NewKnowledgeRecord<KnowledgeEntityMergeCandidate>) { return this.insert('mergeCandidates', record) }
  async updateMergeCandidate(ownerUserId: number, candidateId: number, patch: Partial<Pick<KnowledgeEntityMergeCandidate, 'status' | 'decisionNote' | 'decidedAt' | 'updatedAt'>>) { return this.update<KnowledgeEntityMergeCandidate>(this.tables.mergeCandidates, ownerUserId, candidateId, patch) }
  async listMergeEvents(ownerUserId: number, sourceEntityId?: number) { return clone(this.tables.mergeEvents.filter(item => item.ownerUserId === ownerUserId && (sourceEntityId === undefined || item.sourceEntityId === sourceEntityId))) }
  async getMergeEvent(ownerUserId: number, mergeEventId: number) { return clone(this.tables.mergeEvents.find(item => item.ownerUserId === ownerUserId && item.id === mergeEventId) ?? null) }
  async insertMergeEvent(record: NewKnowledgeRecord<KnowledgeEntityMergeEvent>) { return this.insert('mergeEvents', record) }
  async updateMergeEvent(ownerUserId: number, mergeEventId: number, patch: Partial<Pick<KnowledgeEntityMergeEvent, 'undoneAt' | 'undoReason' | 'updatedAt'>>) { return this.update<KnowledgeEntityMergeEvent>(this.tables.mergeEvents, ownerUserId, mergeEventId, patch) }

  async listSources(ownerUserId: number) { return clone(this.tables.sources.filter(item => item.ownerUserId === ownerUserId)) }
  async getSource(ownerUserId: number, sourceId: number) { return clone(this.tables.sources.find(item => item.ownerUserId === ownerUserId && item.id === sourceId) ?? null) }
  async insertSource(record: NewKnowledgeRecord<KnowledgeSource>) { return this.insert('sources', record) }
  async listSourceVersions(ownerUserId: number, sourceId?: number) { return clone(this.tables.sourceVersions.filter(item => item.ownerUserId === ownerUserId && (sourceId === undefined || item.sourceId === sourceId))) }
  async getSourceVersion(ownerUserId: number, sourceVersionId: number) { return clone(this.tables.sourceVersions.find(item => item.ownerUserId === ownerUserId && item.id === sourceVersionId) ?? null) }
  async insertSourceVersion(record: NewKnowledgeRecord<KnowledgeSourceVersion>) { return this.insert('sourceVersions', record) }

  async listClaims(ownerUserId: number, status?: KnowledgeClaimStatus) { return clone(this.tables.claims.filter(item => item.ownerUserId === ownerUserId && (status === undefined || item.status === status))) }
  async getClaim(ownerUserId: number, claimId: number) { return clone(this.tables.claims.find(item => item.ownerUserId === ownerUserId && item.id === claimId) ?? null) }
  async insertClaim(record: NewKnowledgeRecord<KnowledgeClaim>) { return this.insert('claims', record) }
  async updateClaim(ownerUserId: number, claimId: number, patch: Partial<Pick<KnowledgeClaim, 'status' | 'updatedAt'>>) { return this.update<KnowledgeClaim>(this.tables.claims, ownerUserId, claimId, patch) }
  async listClaimEntityLinks(ownerUserId: number, claimId?: number) { return clone(this.tables.claimEntityLinks.filter(item => item.ownerUserId === ownerUserId && (claimId === undefined || item.claimId === claimId))) }
  async insertClaimEntityLink(record: NewKnowledgeRecord<KnowledgeClaimEntityLink>) { return this.insert('claimEntityLinks', record) }
  async listClaimEvidence(ownerUserId: number, claimId?: number) { return clone(this.tables.evidence.filter(item => item.ownerUserId === ownerUserId && (claimId === undefined || item.claimId === claimId))) }
  async insertClaimEvidence(record: NewKnowledgeRecord<KnowledgeClaimEvidence>) { return this.insert('evidence', record) }
  async listClaimStatusEvents(ownerUserId: number, claimId?: number) { return clone(this.tables.statusEvents.filter(item => item.ownerUserId === ownerUserId && (claimId === undefined || item.claimId === claimId))) }
  async insertClaimStatusEvent(record: NewKnowledgeRecord<KnowledgeClaimStatusEvent>) { return this.insert('statusEvents', record) }

  async listDisputes(ownerUserId: number, status?: KnowledgeClaimDispute['status']) { return clone(this.tables.disputes.filter(item => item.ownerUserId === ownerUserId && (status === undefined || item.status === status))) }
  async getDispute(ownerUserId: number, disputeId: number) { return clone(this.tables.disputes.find(item => item.ownerUserId === ownerUserId && item.id === disputeId) ?? null) }
  async insertDispute(record: NewKnowledgeRecord<KnowledgeClaimDispute>) { return this.insert('disputes', record) }
  async updateDispute(ownerUserId: number, disputeId: number, patch: Partial<Pick<KnowledgeClaimDispute, 'status' | 'resolution' | 'resolutionNote' | 'resolvedAt' | 'updatedAt'>>) { return this.update<KnowledgeClaimDispute>(this.tables.disputes, ownerUserId, disputeId, patch) }

  async getPublisherSetting(ownerUserId: number) { return clone(this.tables.publisherSettings.find(item => item.ownerUserId === ownerUserId) ?? null) }
  async upsertPublisherSetting(record: NewKnowledgeRecord<KnowledgePublisherSetting>) {
    const existing = this.tables.publisherSettings.find(item => item.ownerUserId === record.ownerUserId)
    if (!existing) return this.insert('publisherSettings', record)
    return this.update(this.tables.publisherSettings, record.ownerUserId, existing.id, { ...record, id: existing.id, createdAt: existing.createdAt }) as KnowledgePublisherSetting
  }

  async listContentEntityLinks(ownerUserId: number, briefId?: number) { return clone(this.tables.contentLinks.filter(item => item.ownerUserId === ownerUserId && (briefId === undefined || item.briefId === briefId))) }
  async insertContentEntityLink(record: NewKnowledgeRecord<KnowledgeContentEntityLink>) { return this.insert('contentLinks', record) }
  async deleteContentEntityLink(ownerUserId: number, briefId: number, entityId: number, role: KnowledgeContentEntityRole) {
    const index = this.tables.contentLinks.findIndex(item => item.ownerUserId === ownerUserId && item.briefId === briefId && item.entityId === entityId && item.role === role)
    if (index < 0) return false
    this.tables.contentLinks.splice(index, 1)
    return true
  }

  seedContentAnchor(anchor: KnowledgeContentAnchorSeed): void {
    const existing = this.anchors.findIndex(item => item.ownerUserId === anchor.ownerUserId && item.draftId === anchor.draftId)
    if (existing >= 0) this.anchors[existing] = clone(anchor)
    else this.anchors.push(clone(anchor))
  }

  async getContentAnchor(input: { readonly ownerUserId: number; readonly draftId?: number; readonly briefId?: number }) {
    const matches = this.anchors.filter(item => item.ownerUserId === input.ownerUserId && (input.draftId !== undefined ? item.draftId === input.draftId : input.briefId !== undefined && item.briefId === input.briefId))
    const match = matches.sort((left, right) => right.draftCreatedAt.getTime() - left.draftCreatedAt.getTime() || right.draftId - left.draftId)[0]
    if (!match) return null
    const { ownerUserId: _ownerUserId, ...anchor } = clone(match)
    return anchor
  }

  async listContentAnchors(ownerUserId: number) {
    return this.anchors.filter(item => item.ownerUserId === ownerUserId).sort((left, right) => left.briefId - right.briefId || left.draftId - right.draftId).map(item => {
      const { ownerUserId: _ownerUserId, ...anchor } = clone(item)
      return anchor
    })
  }
}

export function createInMemoryKnowledgeRepository(initialAnchors: readonly KnowledgeContentAnchorSeed[] = []): InMemoryKnowledgeRepository {
  const repository = new MemoryKnowledgeRepository()
  for (const anchor of initialAnchors) repository.seedContentAnchor(anchor)
  return repository
}

export { DrizzleKnowledgeRepository } from './repository-drizzle'
export type { KnowledgeRepository } from './types'
