import { and, desc, eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import {
  knowledgeClaimDisputes,
  knowledgeClaimEntityLinks,
  knowledgeClaimEvidence,
  knowledgeClaims,
  knowledgeClaimStatusEvents,
  knowledgeContentEntityLinks,
  knowledgeEntities,
  knowledgeEntityAliases,
  knowledgeEntityExternalIds,
  knowledgeEntityMergeCandidates,
  knowledgeEntityMergeEvents,
  knowledgePublisherSettings,
  knowledgeSources,
  knowledgeSourceVersions,
  seoGeoContentBriefs,
  seoGeoContentDrafts,
  seoGeoContentJobs,
} from '../database/schema'
import type {
  KnowledgeClaim,
  KnowledgeClaimDispute,
  KnowledgeClaimEntityLink,
  KnowledgeClaimEvidence,
  KnowledgeClaimStatus,
  KnowledgeClaimStatusEvent,
  KnowledgeContentAnchor,
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

type AppDatabase = NonNullable<ReturnType<typeof getDatabase>>
type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
export type KnowledgeDrizzleDatabase = AppDatabase | AppTransaction

function domain<T>(value: unknown): T { return value as T }
function requireRow<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`${label} was not persisted.`)
  return value
}

export class DrizzleKnowledgeRepository implements KnowledgeRepository {
  private readonly db: KnowledgeDrizzleDatabase

  constructor(database: KnowledgeDrizzleDatabase | null = getDatabase()) {
    if (!database) throw new Error('Knowledge database is not configured.')
    this.db = database
  }

  async transaction<T>(work: (repository: KnowledgeRepository) => Promise<T>): Promise<T> {
    return (this.db as AppDatabase).transaction(transaction => work(new DrizzleKnowledgeRepository(transaction)))
  }

  async listEntities(ownerUserId: number): Promise<KnowledgeEntity[]> { return domain(await this.db.select().from(knowledgeEntities).where(eq(knowledgeEntities.ownerUserId, ownerUserId))) }
  async getEntity(ownerUserId: number, entityId: number): Promise<KnowledgeEntity | null> { const [row] = await this.db.select().from(knowledgeEntities).where(and(eq(knowledgeEntities.ownerUserId, ownerUserId), eq(knowledgeEntities.id, entityId))).limit(1); return domain(row ?? null) }
  async insertEntity(record: NewKnowledgeRecord<KnowledgeEntity>): Promise<KnowledgeEntity> { const [inserted] = await this.db.insert(knowledgeEntities).values(record).$returningId(); return requireRow(await this.getEntity(record.ownerUserId, inserted!.id), 'Knowledge entity') }
  async updateEntity(ownerUserId: number, entityId: number, patch: Partial<Pick<KnowledgeEntity, 'status' | 'mergedIntoEntityId' | 'updatedAt'>>): Promise<KnowledgeEntity | null> { await this.db.update(knowledgeEntities).set(patch).where(and(eq(knowledgeEntities.ownerUserId, ownerUserId), eq(knowledgeEntities.id, entityId))); return this.getEntity(ownerUserId, entityId) }

  async listEntityAliases(ownerUserId: number, entityId?: number): Promise<KnowledgeEntityAlias[]> { return domain(await this.db.select().from(knowledgeEntityAliases).where(and(eq(knowledgeEntityAliases.ownerUserId, ownerUserId), entityId === undefined ? undefined : eq(knowledgeEntityAliases.entityId, entityId)))) }
  async insertEntityAlias(record: NewKnowledgeRecord<KnowledgeEntityAlias>): Promise<KnowledgeEntityAlias> { const [inserted] = await this.db.insert(knowledgeEntityAliases).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeEntityAliases).where(and(eq(knowledgeEntityAliases.ownerUserId, record.ownerUserId), eq(knowledgeEntityAliases.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge entity alias') }
  async listEntityExternalIds(ownerUserId: number, entityId?: number): Promise<KnowledgeEntityExternalId[]> { return domain(await this.db.select().from(knowledgeEntityExternalIds).where(and(eq(knowledgeEntityExternalIds.ownerUserId, ownerUserId), entityId === undefined ? undefined : eq(knowledgeEntityExternalIds.entityId, entityId)))) }
  async insertEntityExternalId(record: NewKnowledgeRecord<KnowledgeEntityExternalId>): Promise<KnowledgeEntityExternalId> { const [inserted] = await this.db.insert(knowledgeEntityExternalIds).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeEntityExternalIds).where(and(eq(knowledgeEntityExternalIds.ownerUserId, record.ownerUserId), eq(knowledgeEntityExternalIds.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge external identifier') }

  async listMergeCandidates(ownerUserId: number, status?: KnowledgeEntityMergeCandidate['status']): Promise<KnowledgeEntityMergeCandidate[]> { return domain(await this.db.select().from(knowledgeEntityMergeCandidates).where(and(eq(knowledgeEntityMergeCandidates.ownerUserId, ownerUserId), status === undefined ? undefined : eq(knowledgeEntityMergeCandidates.status, status))).orderBy(knowledgeEntityMergeCandidates.id)) }
  async getMergeCandidate(ownerUserId: number, candidateId: number): Promise<KnowledgeEntityMergeCandidate | null> { const [row] = await this.db.select().from(knowledgeEntityMergeCandidates).where(and(eq(knowledgeEntityMergeCandidates.ownerUserId, ownerUserId), eq(knowledgeEntityMergeCandidates.id, candidateId))).limit(1); return domain(row ?? null) }
  async insertMergeCandidate(record: NewKnowledgeRecord<KnowledgeEntityMergeCandidate>): Promise<KnowledgeEntityMergeCandidate> { const [inserted] = await this.db.insert(knowledgeEntityMergeCandidates).values(record).$returningId(); return requireRow(await this.getMergeCandidate(record.ownerUserId, inserted!.id), 'Knowledge merge candidate') }
  async updateMergeCandidate(ownerUserId: number, candidateId: number, patch: Partial<Pick<KnowledgeEntityMergeCandidate, 'status' | 'decisionNote' | 'decidedAt' | 'updatedAt'>>): Promise<KnowledgeEntityMergeCandidate | null> { await this.db.update(knowledgeEntityMergeCandidates).set(patch).where(and(eq(knowledgeEntityMergeCandidates.ownerUserId, ownerUserId), eq(knowledgeEntityMergeCandidates.id, candidateId))); return this.getMergeCandidate(ownerUserId, candidateId) }
  async listMergeEvents(ownerUserId: number, sourceEntityId?: number): Promise<KnowledgeEntityMergeEvent[]> { return domain(await this.db.select().from(knowledgeEntityMergeEvents).where(and(eq(knowledgeEntityMergeEvents.ownerUserId, ownerUserId), sourceEntityId === undefined ? undefined : eq(knowledgeEntityMergeEvents.sourceEntityId, sourceEntityId))).orderBy(knowledgeEntityMergeEvents.id)) }
  async getMergeEvent(ownerUserId: number, mergeEventId: number): Promise<KnowledgeEntityMergeEvent | null> { const [row] = await this.db.select().from(knowledgeEntityMergeEvents).where(and(eq(knowledgeEntityMergeEvents.ownerUserId, ownerUserId), eq(knowledgeEntityMergeEvents.id, mergeEventId))).limit(1); return domain(row ?? null) }
  async insertMergeEvent(record: NewKnowledgeRecord<KnowledgeEntityMergeEvent>): Promise<KnowledgeEntityMergeEvent> { const [inserted] = await this.db.insert(knowledgeEntityMergeEvents).values(record).$returningId(); return requireRow(await this.getMergeEvent(record.ownerUserId, inserted!.id), 'Knowledge merge event') }
  async updateMergeEvent(ownerUserId: number, mergeEventId: number, patch: Partial<Pick<KnowledgeEntityMergeEvent, 'undoneAt' | 'undoReason' | 'updatedAt'>>): Promise<KnowledgeEntityMergeEvent | null> { await this.db.update(knowledgeEntityMergeEvents).set(patch).where(and(eq(knowledgeEntityMergeEvents.ownerUserId, ownerUserId), eq(knowledgeEntityMergeEvents.id, mergeEventId))); return this.getMergeEvent(ownerUserId, mergeEventId) }

  async listSources(ownerUserId: number): Promise<KnowledgeSource[]> { return domain(await this.db.select().from(knowledgeSources).where(eq(knowledgeSources.ownerUserId, ownerUserId))) }
  async getSource(ownerUserId: number, sourceId: number): Promise<KnowledgeSource | null> { const [row] = await this.db.select().from(knowledgeSources).where(and(eq(knowledgeSources.ownerUserId, ownerUserId), eq(knowledgeSources.id, sourceId))).limit(1); return domain(row ?? null) }
  async insertSource(record: NewKnowledgeRecord<KnowledgeSource>): Promise<KnowledgeSource> { const [inserted] = await this.db.insert(knowledgeSources).values(record).$returningId(); return requireRow(await this.getSource(record.ownerUserId, inserted!.id), 'Knowledge source') }
  async listSourceVersions(ownerUserId: number, sourceId?: number): Promise<KnowledgeSourceVersion[]> { return domain(await this.db.select().from(knowledgeSourceVersions).where(and(eq(knowledgeSourceVersions.ownerUserId, ownerUserId), sourceId === undefined ? undefined : eq(knowledgeSourceVersions.sourceId, sourceId))).orderBy(knowledgeSourceVersions.versionNumber)) }
  async getSourceVersion(ownerUserId: number, sourceVersionId: number): Promise<KnowledgeSourceVersion | null> { const [row] = await this.db.select().from(knowledgeSourceVersions).where(and(eq(knowledgeSourceVersions.ownerUserId, ownerUserId), eq(knowledgeSourceVersions.id, sourceVersionId))).limit(1); return domain(row ?? null) }
  async insertSourceVersion(record: NewKnowledgeRecord<KnowledgeSourceVersion>): Promise<KnowledgeSourceVersion> { const [inserted] = await this.db.insert(knowledgeSourceVersions).values(record).$returningId(); return requireRow(await this.getSourceVersion(record.ownerUserId, inserted!.id), 'Knowledge source version') }

  async listClaims(ownerUserId: number, status?: KnowledgeClaimStatus): Promise<KnowledgeClaim[]> { return domain(await this.db.select().from(knowledgeClaims).where(and(eq(knowledgeClaims.ownerUserId, ownerUserId), status === undefined ? undefined : eq(knowledgeClaims.status, status))).orderBy(knowledgeClaims.id)) }
  async getClaim(ownerUserId: number, claimId: number): Promise<KnowledgeClaim | null> { const [row] = await this.db.select().from(knowledgeClaims).where(and(eq(knowledgeClaims.ownerUserId, ownerUserId), eq(knowledgeClaims.id, claimId))).limit(1); return domain(row ?? null) }
  async insertClaim(record: NewKnowledgeRecord<KnowledgeClaim>): Promise<KnowledgeClaim> { const [inserted] = await this.db.insert(knowledgeClaims).values(record).$returningId(); return requireRow(await this.getClaim(record.ownerUserId, inserted!.id), 'Knowledge claim') }
  async updateClaim(ownerUserId: number, claimId: number, patch: Partial<Pick<KnowledgeClaim, 'status' | 'updatedAt'>>): Promise<KnowledgeClaim | null> { await this.db.update(knowledgeClaims).set(patch).where(and(eq(knowledgeClaims.ownerUserId, ownerUserId), eq(knowledgeClaims.id, claimId))); return this.getClaim(ownerUserId, claimId) }
  async listClaimEntityLinks(ownerUserId: number, claimId?: number): Promise<KnowledgeClaimEntityLink[]> { return domain(await this.db.select().from(knowledgeClaimEntityLinks).where(and(eq(knowledgeClaimEntityLinks.ownerUserId, ownerUserId), claimId === undefined ? undefined : eq(knowledgeClaimEntityLinks.claimId, claimId)))) }
  async insertClaimEntityLink(record: NewKnowledgeRecord<KnowledgeClaimEntityLink>): Promise<KnowledgeClaimEntityLink> { const [inserted] = await this.db.insert(knowledgeClaimEntityLinks).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeClaimEntityLinks).where(and(eq(knowledgeClaimEntityLinks.ownerUserId, record.ownerUserId), eq(knowledgeClaimEntityLinks.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge claim entity link') }
  async listClaimEvidence(ownerUserId: number, claimId?: number): Promise<KnowledgeClaimEvidence[]> { return domain(await this.db.select().from(knowledgeClaimEvidence).where(and(eq(knowledgeClaimEvidence.ownerUserId, ownerUserId), claimId === undefined ? undefined : eq(knowledgeClaimEvidence.claimId, claimId))).orderBy(knowledgeClaimEvidence.id)) }
  async insertClaimEvidence(record: NewKnowledgeRecord<KnowledgeClaimEvidence>): Promise<KnowledgeClaimEvidence> { const [inserted] = await this.db.insert(knowledgeClaimEvidence).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeClaimEvidence).where(and(eq(knowledgeClaimEvidence.ownerUserId, record.ownerUserId), eq(knowledgeClaimEvidence.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge claim evidence') }
  async listClaimStatusEvents(ownerUserId: number, claimId?: number): Promise<KnowledgeClaimStatusEvent[]> { return domain(await this.db.select().from(knowledgeClaimStatusEvents).where(and(eq(knowledgeClaimStatusEvents.ownerUserId, ownerUserId), claimId === undefined ? undefined : eq(knowledgeClaimStatusEvents.claimId, claimId))).orderBy(knowledgeClaimStatusEvents.id)) }
  async insertClaimStatusEvent(record: NewKnowledgeRecord<KnowledgeClaimStatusEvent>): Promise<KnowledgeClaimStatusEvent> { const [inserted] = await this.db.insert(knowledgeClaimStatusEvents).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeClaimStatusEvents).where(and(eq(knowledgeClaimStatusEvents.ownerUserId, record.ownerUserId), eq(knowledgeClaimStatusEvents.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge claim status event') }

  async listDisputes(ownerUserId: number, status?: KnowledgeClaimDispute['status']): Promise<KnowledgeClaimDispute[]> { return domain(await this.db.select().from(knowledgeClaimDisputes).where(and(eq(knowledgeClaimDisputes.ownerUserId, ownerUserId), status === undefined ? undefined : eq(knowledgeClaimDisputes.status, status))).orderBy(knowledgeClaimDisputes.id)) }
  async getDispute(ownerUserId: number, disputeId: number): Promise<KnowledgeClaimDispute | null> { const [row] = await this.db.select().from(knowledgeClaimDisputes).where(and(eq(knowledgeClaimDisputes.ownerUserId, ownerUserId), eq(knowledgeClaimDisputes.id, disputeId))).limit(1); return domain(row ?? null) }
  async insertDispute(record: NewKnowledgeRecord<KnowledgeClaimDispute>): Promise<KnowledgeClaimDispute> { const [inserted] = await this.db.insert(knowledgeClaimDisputes).values(record).$returningId(); return requireRow(await this.getDispute(record.ownerUserId, inserted!.id), 'Knowledge claim dispute') }
  async updateDispute(ownerUserId: number, disputeId: number, patch: Partial<Pick<KnowledgeClaimDispute, 'status' | 'resolution' | 'resolutionNote' | 'resolvedAt' | 'updatedAt'>>): Promise<KnowledgeClaimDispute | null> { await this.db.update(knowledgeClaimDisputes).set(patch).where(and(eq(knowledgeClaimDisputes.ownerUserId, ownerUserId), eq(knowledgeClaimDisputes.id, disputeId))); return this.getDispute(ownerUserId, disputeId) }

  async getPublisherSetting(ownerUserId: number): Promise<KnowledgePublisherSetting | null> { const [row] = await this.db.select().from(knowledgePublisherSettings).where(eq(knowledgePublisherSettings.ownerUserId, ownerUserId)).limit(1); return domain(row ?? null) }
  async upsertPublisherSetting(record: NewKnowledgeRecord<KnowledgePublisherSetting>): Promise<KnowledgePublisherSetting> {
    const existing = await this.getPublisherSetting(record.ownerUserId)
    if (existing) {
      await this.db.update(knowledgePublisherSettings).set({ organizationEntityId: record.organizationEntityId, updatedAt: record.updatedAt }).where(eq(knowledgePublisherSettings.id, existing.id))
      return requireRow(await this.getPublisherSetting(record.ownerUserId), 'Knowledge publisher setting')
    }
    await this.db.insert(knowledgePublisherSettings).values(record)
    return requireRow(await this.getPublisherSetting(record.ownerUserId), 'Knowledge publisher setting')
  }

  async listContentEntityLinks(ownerUserId: number, briefId?: number): Promise<KnowledgeContentEntityLink[]> { return domain(await this.db.select().from(knowledgeContentEntityLinks).where(and(eq(knowledgeContentEntityLinks.ownerUserId, ownerUserId), briefId === undefined ? undefined : eq(knowledgeContentEntityLinks.briefId, briefId))).orderBy(knowledgeContentEntityLinks.id)) }
  async insertContentEntityLink(record: NewKnowledgeRecord<KnowledgeContentEntityLink>): Promise<KnowledgeContentEntityLink> { const [inserted] = await this.db.insert(knowledgeContentEntityLinks).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeContentEntityLinks).where(and(eq(knowledgeContentEntityLinks.ownerUserId, record.ownerUserId), eq(knowledgeContentEntityLinks.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge content entity link') }
  async deleteContentEntityLink(ownerUserId: number, briefId: number, entityId: number, role: KnowledgeContentEntityRole): Promise<boolean> {
    const [row] = await this.db.select({ id: knowledgeContentEntityLinks.id }).from(knowledgeContentEntityLinks).where(and(eq(knowledgeContentEntityLinks.ownerUserId, ownerUserId), eq(knowledgeContentEntityLinks.briefId, briefId), eq(knowledgeContentEntityLinks.entityId, entityId), eq(knowledgeContentEntityLinks.role, role))).limit(1)
    if (!row) return false
    await this.db.delete(knowledgeContentEntityLinks).where(eq(knowledgeContentEntityLinks.id, row.id))
    return true
  }

  private contentAnchorQuery(ownerUserId: number, draftId?: number, briefId?: number) {
    return this.db.select({
      briefId: seoGeoContentBriefs.id,
      jobId: seoGeoContentJobs.id,
      draftId: seoGeoContentDrafts.id,
      title: seoGeoContentDrafts.title,
      language: seoGeoContentBriefs.language,
      contentType: seoGeoContentBriefs.contentType,
      contentHash: seoGeoContentDrafts.contentHash,
      draftCreatedAt: seoGeoContentDrafts.createdAt,
    }).from(seoGeoContentDrafts)
      .innerJoin(seoGeoContentJobs, eq(seoGeoContentDrafts.jobId, seoGeoContentJobs.id))
      .innerJoin(seoGeoContentBriefs, eq(seoGeoContentJobs.briefId, seoGeoContentBriefs.id))
      .where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), eq(seoGeoContentBriefs.ownerUserId, ownerUserId), draftId === undefined ? undefined : eq(seoGeoContentDrafts.id, draftId), briefId === undefined ? undefined : eq(seoGeoContentBriefs.id, briefId)))
  }

  async getContentAnchor(input: { readonly ownerUserId: number; readonly draftId?: number; readonly briefId?: number }): Promise<KnowledgeContentAnchor | null> {
    if (input.draftId === undefined && input.briefId === undefined) return null
    const [row] = await this.contentAnchorQuery(input.ownerUserId, input.draftId, input.briefId).orderBy(desc(seoGeoContentDrafts.createdAt), desc(seoGeoContentDrafts.id)).limit(1)
    return domain(row ?? null)
  }

  async listContentAnchors(ownerUserId: number): Promise<KnowledgeContentAnchor[]> {
    return domain(await this.contentAnchorQuery(ownerUserId).orderBy(seoGeoContentBriefs.id, seoGeoContentDrafts.id))
  }
}
