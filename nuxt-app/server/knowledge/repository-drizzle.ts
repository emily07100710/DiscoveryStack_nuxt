import { and, desc, eq, lt, max, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import { knowledgeReadLimit } from './read-bounds'
import { assertKnowledgeRevisionSubject, assertValidKnowledgeMutationEvent, assertValidKnowledgeRevision, assertValidKnowledgeRevisionMetadata } from './revision-records'
import { KNOWLEDGE_REVISION_SCHEMA } from './revision-types'
import { DrizzleKnowledgeConsumerBindingRepository } from './consumer-bindings-drizzle'
import { readKnowledgeConsumerCoverage } from './consumer-bindings'
import { KnowledgeRevisionError, type KnowledgeRevision, type KnowledgeMutationEvent, type KnowledgeRevisionSubject } from './revision-types'
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
  knowledgeSubjectRevisions,
  knowledgeMutationEvents,
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
  KnowledgeTransactionOptions,
  NewKnowledgeRecord,
} from './types'

// The repository uses Drizzle's database operations, not its transport-specific
// $client. Both mysql2's callback and promise pools implement this same contract.
type AppDatabase = Omit<NonNullable<ReturnType<typeof getDatabase>>, '$client'>
type AppTransaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
export type KnowledgeDrizzleDatabase = AppDatabase | AppTransaction

function domain<T>(value: unknown): T { return value as T }
function requireRow<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`${label} was not persisted.`)
  return value
}

export class DrizzleKnowledgeRepository implements KnowledgeRepository {
  private readonly db: KnowledgeDrizzleDatabase

  constructor(database: KnowledgeDrizzleDatabase | null = getDatabase(), private readonly auditedMutation = false) {
    if (!database) throw new Error('Knowledge database is not configured.')
    this.db = database
  }

  async listConsumerCoverage(ownerUserId: number) {
    return readKnowledgeConsumerCoverage(ownerUserId, new DrizzleKnowledgeConsumerBindingRepository(this.db))
  }

  async transaction<T>(work: (repository: KnowledgeRepository) => Promise<T>, options?: KnowledgeTransactionOptions): Promise<T> {
    if (options?.auditedMutation && options.consistentReadOnly) throw new KnowledgeRevisionError('INVALID_INPUT')
    // Drizzle 0.45.2 joins START characteristics without MySQL's required comma.
    // REPEATABLE READ + READ ONLY is valid SQL: the first nonlocking table read
    // establishes the snapshot, and all later reads in this transaction retain it.
    // Do not combine withConsistentSnapshot with accessMode in this driver.
    const config = options?.consistentReadOnly
      ? { isolationLevel: 'repeatable read' as const, accessMode: 'read only' as const }
      : options?.auditedMutation ? { isolationLevel: 'serializable' as const, accessMode: 'read write' as const } : undefined
    return (this.db as AppDatabase).transaction(transaction => work(new DrizzleKnowledgeRepository(transaction, options?.auditedMutation === true)), config)
  }

  private requireAuditedMutation() { if (!this.auditedMutation) throw new KnowledgeRevisionError('REVISION_CONFLICT') }
  async lockRevisionSubject(ownerUserId: number, subject: KnowledgeRevisionSubject): Promise<void> {
    this.requireAuditedMutation()
    assertKnowledgeRevisionSubject(ownerUserId, subject)
    const table = subject.kind === 'entity' ? knowledgeEntities : subject.kind === 'claim' ? knowledgeClaims : knowledgeSources
    const [row] = await this.db.select({ id: table.id }).from(table).where(and(eq(table.ownerUserId, ownerUserId), eq(table.id, subject.id))).limit(1).for('update')
    if (!row) throw new KnowledgeRevisionError('SUBJECT_NOT_FOUND')
  }
  async getRevisionHead(ownerUserId: number, subject: KnowledgeRevisionSubject): Promise<KnowledgeRevision | null> {
    assertKnowledgeRevisionSubject(ownerUserId, subject)
    const query = this.db.select().from(knowledgeSubjectRevisions).where(and(eq(knowledgeSubjectRevisions.ownerUserId, ownerUserId), eq(knowledgeSubjectRevisions.subjectKind, subject.kind), eq(knowledgeSubjectRevisions.subjectId, subject.id))).orderBy(desc(knowledgeSubjectRevisions.revisionNumber)).limit(1)
    const [row] = await (this.auditedMutation ? query.for('update') : query)
    return domain(row ?? null)
  }
  async appendRevision(record: NewKnowledgeRecord<KnowledgeRevision>): Promise<KnowledgeRevision> {
    this.requireAuditedMutation()
    assertValidKnowledgeRevision(record)
    await this.lockRevisionSubject(record.ownerUserId, { kind: record.subjectKind, id: record.subjectId })
    const head = await this.getRevisionHead(record.ownerUserId, { kind: record.subjectKind, id: record.subjectId })
    if (record.revisionNumber !== (head?.revisionNumber ?? 0) + 1 || record.previousRevisionFingerprint !== (head?.revisionFingerprint ?? null)) throw new KnowledgeRevisionError('REVISION_CONFLICT')
    const [inserted] = await this.db.insert(knowledgeSubjectRevisions).values({ ...record, operations: [...record.operations] }).$returningId()
    const [saved] = await this.db.select().from(knowledgeSubjectRevisions).where(and(eq(knowledgeSubjectRevisions.ownerUserId, record.ownerUserId), eq(knowledgeSubjectRevisions.id, inserted!.id))).limit(1)
    return requireRow(domain<KnowledgeRevision | null>(saved ?? null), 'Knowledge revision')
  }
  async appendMutationEvent(record: NewKnowledgeRecord<KnowledgeMutationEvent>): Promise<KnowledgeMutationEvent> {
    this.requireAuditedMutation()
    assertValidKnowledgeMutationEvent(record)
    const [rawRevision] = await this.db.select().from(knowledgeSubjectRevisions).where(and(eq(knowledgeSubjectRevisions.ownerUserId, record.ownerUserId), eq(knowledgeSubjectRevisions.id, record.revisionId))).limit(1).for('update')
    const revision = domain<KnowledgeRevision | null>(rawRevision ?? null)
    if (!revision || revision.subjectKind !== record.subjectKind || revision.subjectId !== record.subjectId || revision.revisionNumber !== record.revisionNumber || revision.previousRevisionFingerprint !== record.previousRevisionFingerprint || revision.revisionFingerprint !== record.newRevisionFingerprint || revision.operations.join(',') !== record.operations.join(',')) throw new KnowledgeRevisionError('REVISION_CONFLICT')
    const [inserted] = await this.db.insert(knowledgeMutationEvents).values({ ...record, operations: [...record.operations] }).$returningId()
    const [saved] = await this.db.select().from(knowledgeMutationEvents).where(and(eq(knowledgeMutationEvents.ownerUserId, record.ownerUserId), eq(knowledgeMutationEvents.id, inserted!.id))).limit(1)
    return requireRow(domain<KnowledgeMutationEvent | null>(saved ?? null), 'Knowledge mutation event')
  }
  async listRevisions(ownerUserId: number, subject: KnowledgeRevisionSubject, beforeId?: number, limit = 26): Promise<KnowledgeRevision[]> {
    this.assertHistoryRead(ownerUserId, subject, beforeId, limit)
    return domain(await this.db.select().from(knowledgeSubjectRevisions).where(and(eq(knowledgeSubjectRevisions.ownerUserId, ownerUserId), eq(knowledgeSubjectRevisions.subjectKind, subject.kind), eq(knowledgeSubjectRevisions.subjectId, subject.id), beforeId === undefined ? undefined : lt(knowledgeSubjectRevisions.id, beforeId))).orderBy(desc(knowledgeSubjectRevisions.id)).limit(limit))
  }
  async listMutationEvents(ownerUserId: number, subject: KnowledgeRevisionSubject, beforeId?: number, limit = 26): Promise<KnowledgeMutationEvent[]> {
    this.assertHistoryRead(ownerUserId, subject, beforeId, limit)
    return domain(await this.db.select().from(knowledgeMutationEvents).where(and(eq(knowledgeMutationEvents.ownerUserId, ownerUserId), eq(knowledgeMutationEvents.subjectKind, subject.kind), eq(knowledgeMutationEvents.subjectId, subject.id), beforeId === undefined ? undefined : lt(knowledgeMutationEvents.id, beforeId))).orderBy(desc(knowledgeMutationEvents.id)).limit(limit))
  }
  private assertHistoryRead(ownerUserId: number, subject: KnowledgeRevisionSubject, beforeId: number | undefined, limit: number) {
    assertKnowledgeRevisionSubject(ownerUserId, subject)
    if ((beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId <= 0)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 26) throw new KnowledgeRevisionError('INVALID_INPUT')
  }
  async getMutationEventForRevision(ownerUserId: number, revisionFingerprint: string): Promise<KnowledgeMutationEvent | null> {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || !/^[a-f0-9]{64}$/u.test(revisionFingerprint)) throw new KnowledgeRevisionError('INVALID_INPUT')
    const rows = await this.db.select().from(knowledgeMutationEvents).where(and(eq(knowledgeMutationEvents.ownerUserId, ownerUserId), eq(knowledgeMutationEvents.newRevisionFingerprint, revisionFingerprint))).limit(2)
    if (rows.length > 1) throw new KnowledgeRevisionError('CORRUPT_STATE')
    return domain(rows[0] ?? null)
  }

  async listRevisionHeads(ownerUserId: number, limit?: number): Promise<import('./impact-types').KnowledgeImpactRevisionHead[]> {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1) throw new KnowledgeRevisionError('INVALID_INPUT')
    const bounded = knowledgeReadLimit(limit)
    const t = knowledgeSubjectRevisions
    const latest = this.db.select({
      subjectKind: t.subjectKind, subjectId: t.subjectId,
      revisionNumber: max(t.revisionNumber).as('headRevisionNumber'),
    }).from(t).where(eq(t.ownerUserId, ownerUserId)).groupBy(t.subjectKind, t.subjectId).as('knowledgeRevisionHeads')
    const query = this.db.select({
      revision: {
        id: t.id, ownerUserId: t.ownerUserId, subjectKind: t.subjectKind, subjectId: t.subjectId,
        schemaVersion: t.schemaVersion, revisionNumber: t.revisionNumber, revisionKind: t.revisionKind,
        contentHash: t.contentHash, previousRevisionFingerprint: t.previousRevisionFingerprint,
        revisionFingerprint: t.revisionFingerprint, operations: t.operations, createdAt: t.createdAt, updatedAt: t.updatedAt,
      },
      // Validate stored snapshot bytes and subject binding without transferring private text.
      snapshotHash: sql<string>`sha2(${t.canonicalSnapshot}, 256)`,
      snapshotBytes: sql<number>`octet_length(${t.canonicalSnapshot})`,
      snapshotSchema: sql<string>`json_unquote(json_extract(${t.canonicalSnapshot}, '$.schemaVersion'))`,
      snapshotOwner: sql<string>`json_unquote(json_extract(${t.canonicalSnapshot}, '$.ownerUserId'))`,
      snapshotKind: sql<string>`json_unquote(json_extract(${t.canonicalSnapshot}, '$.kind'))`,
      snapshotSubject: sql<string>`json_unquote(json_extract(${t.canonicalSnapshot}, '$.subject.id'))`,
      event: knowledgeMutationEvents,
    }).from(t).innerJoin(latest, and(
      eq(t.subjectKind, latest.subjectKind), eq(t.subjectId, latest.subjectId), eq(t.revisionNumber, latest.revisionNumber),
    )).leftJoin(knowledgeMutationEvents, and(eq(knowledgeMutationEvents.ownerUserId, t.ownerUserId), eq(knowledgeMutationEvents.revisionId, t.id)))
      .where(eq(t.ownerUserId, ownerUserId)).orderBy(t.subjectKind, t.subjectId)
    const rows = await (bounded === undefined ? query : query.limit(bounded))
    return rows.map(row => {
      const revision = domain<Omit<KnowledgeRevision, 'canonicalSnapshot'>>(row.revision)
      assertValidKnowledgeRevisionMetadata(revision)
      const event = domain<KnowledgeMutationEvent | null>(row.event)
      if (!event) throw new KnowledgeRevisionError('CORRUPT_STATE')
      assertValidKnowledgeMutationEvent(event)
      if (revision.ownerUserId !== ownerUserId || row.snapshotHash !== revision.contentHash || !Number.isSafeInteger(Number(row.snapshotBytes)) || Number(row.snapshotBytes) < 1 || Number(row.snapshotBytes) > 65_536
        || row.snapshotSchema !== KNOWLEDGE_REVISION_SCHEMA || row.snapshotOwner !== String(ownerUserId) || row.snapshotKind !== revision.subjectKind || row.snapshotSubject !== String(revision.subjectId)
        || event.ownerUserId !== ownerUserId || event.revisionId !== revision.id || event.subjectKind !== revision.subjectKind || event.subjectId !== revision.subjectId
        || event.revisionNumber !== revision.revisionNumber || event.newRevisionFingerprint !== revision.revisionFingerprint || event.previousRevisionFingerprint !== revision.previousRevisionFingerprint || event.operations.join(',') !== revision.operations.join(',')) throw new KnowledgeRevisionError('CORRUPT_STATE')
      return { ownerUserId, subjectKind: revision.subjectKind, subjectId: revision.subjectId, revisionNumber: revision.revisionNumber, contentHash: revision.contentHash, revisionFingerprint: revision.revisionFingerprint }
    })
  }

  async listEntities(ownerUserId: number, limit?: number): Promise<KnowledgeEntity[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeEntities).where(eq(knowledgeEntities.ownerUserId, ownerUserId)).orderBy(knowledgeEntities.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async getEntity(ownerUserId: number, entityId: number): Promise<KnowledgeEntity | null> { const query = this.db.select().from(knowledgeEntities).where(and(eq(knowledgeEntities.ownerUserId, ownerUserId), eq(knowledgeEntities.id, entityId))).limit(1); const [row] = await (this.auditedMutation ? query.for('update') : query); return domain(row ?? null) }
  async insertEntity(record: NewKnowledgeRecord<KnowledgeEntity>): Promise<KnowledgeEntity> { const [inserted] = await this.db.insert(knowledgeEntities).values(record).$returningId(); return requireRow(await this.getEntity(record.ownerUserId, inserted!.id), 'Knowledge entity') }
  async updateEntity(ownerUserId: number, entityId: number, patch: Partial<Pick<KnowledgeEntity, 'status' | 'mergedIntoEntityId' | 'updatedAt'>>): Promise<KnowledgeEntity | null> { await this.db.update(knowledgeEntities).set(patch).where(and(eq(knowledgeEntities.ownerUserId, ownerUserId), eq(knowledgeEntities.id, entityId))); return this.getEntity(ownerUserId, entityId) }

  async listEntityAliases(ownerUserId: number, entityId?: number, limit?: number): Promise<KnowledgeEntityAlias[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeEntityAliases).where(and(eq(knowledgeEntityAliases.ownerUserId, ownerUserId), entityId === undefined ? undefined : eq(knowledgeEntityAliases.entityId, entityId))).orderBy(knowledgeEntityAliases.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async insertEntityAlias(record: NewKnowledgeRecord<KnowledgeEntityAlias>): Promise<KnowledgeEntityAlias> { const [inserted] = await this.db.insert(knowledgeEntityAliases).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeEntityAliases).where(and(eq(knowledgeEntityAliases.ownerUserId, record.ownerUserId), eq(knowledgeEntityAliases.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge entity alias') }
  async listEntityExternalIds(ownerUserId: number, entityId?: number, limit?: number): Promise<KnowledgeEntityExternalId[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeEntityExternalIds).where(and(eq(knowledgeEntityExternalIds.ownerUserId, ownerUserId), entityId === undefined ? undefined : eq(knowledgeEntityExternalIds.entityId, entityId))).orderBy(knowledgeEntityExternalIds.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async insertEntityExternalId(record: NewKnowledgeRecord<KnowledgeEntityExternalId>): Promise<KnowledgeEntityExternalId> { const [inserted] = await this.db.insert(knowledgeEntityExternalIds).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeEntityExternalIds).where(and(eq(knowledgeEntityExternalIds.ownerUserId, record.ownerUserId), eq(knowledgeEntityExternalIds.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge external identifier') }

  async listMergeCandidates(ownerUserId: number, status?: KnowledgeEntityMergeCandidate['status']): Promise<KnowledgeEntityMergeCandidate[]> { return domain(await this.db.select().from(knowledgeEntityMergeCandidates).where(and(eq(knowledgeEntityMergeCandidates.ownerUserId, ownerUserId), status === undefined ? undefined : eq(knowledgeEntityMergeCandidates.status, status))).orderBy(knowledgeEntityMergeCandidates.id)) }
  async getMergeCandidate(ownerUserId: number, candidateId: number): Promise<KnowledgeEntityMergeCandidate | null> { const [row] = await this.db.select().from(knowledgeEntityMergeCandidates).where(and(eq(knowledgeEntityMergeCandidates.ownerUserId, ownerUserId), eq(knowledgeEntityMergeCandidates.id, candidateId))).limit(1); return domain(row ?? null) }
  async insertMergeCandidate(record: NewKnowledgeRecord<KnowledgeEntityMergeCandidate>): Promise<KnowledgeEntityMergeCandidate> { const [inserted] = await this.db.insert(knowledgeEntityMergeCandidates).values(record).$returningId(); return requireRow(await this.getMergeCandidate(record.ownerUserId, inserted!.id), 'Knowledge merge candidate') }
  async updateMergeCandidate(ownerUserId: number, candidateId: number, patch: Partial<Pick<KnowledgeEntityMergeCandidate, 'status' | 'decisionNote' | 'decidedAt' | 'updatedAt'>>): Promise<KnowledgeEntityMergeCandidate | null> { await this.db.update(knowledgeEntityMergeCandidates).set(patch).where(and(eq(knowledgeEntityMergeCandidates.ownerUserId, ownerUserId), eq(knowledgeEntityMergeCandidates.id, candidateId))); return this.getMergeCandidate(ownerUserId, candidateId) }
  async listMergeEvents(ownerUserId: number, sourceEntityId?: number): Promise<KnowledgeEntityMergeEvent[]> { return domain(await this.db.select().from(knowledgeEntityMergeEvents).where(and(eq(knowledgeEntityMergeEvents.ownerUserId, ownerUserId), sourceEntityId === undefined ? undefined : eq(knowledgeEntityMergeEvents.sourceEntityId, sourceEntityId))).orderBy(knowledgeEntityMergeEvents.id)) }
  async getMergeEvent(ownerUserId: number, mergeEventId: number): Promise<KnowledgeEntityMergeEvent | null> { const [row] = await this.db.select().from(knowledgeEntityMergeEvents).where(and(eq(knowledgeEntityMergeEvents.ownerUserId, ownerUserId), eq(knowledgeEntityMergeEvents.id, mergeEventId))).limit(1); return domain(row ?? null) }
  async insertMergeEvent(record: NewKnowledgeRecord<KnowledgeEntityMergeEvent>): Promise<KnowledgeEntityMergeEvent> { const [inserted] = await this.db.insert(knowledgeEntityMergeEvents).values(record).$returningId(); return requireRow(await this.getMergeEvent(record.ownerUserId, inserted!.id), 'Knowledge merge event') }
  async updateMergeEvent(ownerUserId: number, mergeEventId: number, patch: Partial<Pick<KnowledgeEntityMergeEvent, 'undoneAt' | 'undoReason' | 'updatedAt'>>): Promise<KnowledgeEntityMergeEvent | null> { await this.db.update(knowledgeEntityMergeEvents).set(patch).where(and(eq(knowledgeEntityMergeEvents.ownerUserId, ownerUserId), eq(knowledgeEntityMergeEvents.id, mergeEventId))); return this.getMergeEvent(ownerUserId, mergeEventId) }

  async listSources(ownerUserId: number, limit?: number): Promise<KnowledgeSource[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeSources).where(eq(knowledgeSources.ownerUserId, ownerUserId)).orderBy(knowledgeSources.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async getSource(ownerUserId: number, sourceId: number): Promise<KnowledgeSource | null> { const query = this.db.select().from(knowledgeSources).where(and(eq(knowledgeSources.ownerUserId, ownerUserId), eq(knowledgeSources.id, sourceId))).limit(1); const [row] = await (this.auditedMutation ? query.for('update') : query); return domain(row ?? null) }
  async insertSource(record: NewKnowledgeRecord<KnowledgeSource>): Promise<KnowledgeSource> { const [inserted] = await this.db.insert(knowledgeSources).values(record).$returningId(); return requireRow(await this.getSource(record.ownerUserId, inserted!.id), 'Knowledge source') }
  async listSourceVersions(ownerUserId: number, sourceId?: number, limit?: number): Promise<KnowledgeSourceVersion[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeSourceVersions).where(and(eq(knowledgeSourceVersions.ownerUserId, ownerUserId), sourceId === undefined ? undefined : eq(knowledgeSourceVersions.sourceId, sourceId))).orderBy(knowledgeSourceVersions.versionNumber, knowledgeSourceVersions.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async getSourceVersion(ownerUserId: number, sourceVersionId: number): Promise<KnowledgeSourceVersion | null> { const [row] = await this.db.select().from(knowledgeSourceVersions).where(and(eq(knowledgeSourceVersions.ownerUserId, ownerUserId), eq(knowledgeSourceVersions.id, sourceVersionId))).limit(1); return domain(row ?? null) }
  async insertSourceVersion(record: NewKnowledgeRecord<KnowledgeSourceVersion>): Promise<KnowledgeSourceVersion> { const [inserted] = await this.db.insert(knowledgeSourceVersions).values(record).$returningId(); return requireRow(await this.getSourceVersion(record.ownerUserId, inserted!.id), 'Knowledge source version') }

  async listClaims(ownerUserId: number, status?: KnowledgeClaimStatus, limit?: number): Promise<KnowledgeClaim[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeClaims).where(and(eq(knowledgeClaims.ownerUserId, ownerUserId), status === undefined ? undefined : eq(knowledgeClaims.status, status))).orderBy(knowledgeClaims.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async getClaim(ownerUserId: number, claimId: number): Promise<KnowledgeClaim | null> { const query = this.db.select().from(knowledgeClaims).where(and(eq(knowledgeClaims.ownerUserId, ownerUserId), eq(knowledgeClaims.id, claimId))).limit(1); const [row] = await (this.auditedMutation ? query.for('update') : query); return domain(row ?? null) }
  async insertClaim(record: NewKnowledgeRecord<KnowledgeClaim>): Promise<KnowledgeClaim> { const [inserted] = await this.db.insert(knowledgeClaims).values(record).$returningId(); return requireRow(await this.getClaim(record.ownerUserId, inserted!.id), 'Knowledge claim') }
  async updateClaim(ownerUserId: number, claimId: number, patch: Partial<Pick<KnowledgeClaim, 'status' | 'updatedAt'>>): Promise<KnowledgeClaim | null> { await this.db.update(knowledgeClaims).set(patch).where(and(eq(knowledgeClaims.ownerUserId, ownerUserId), eq(knowledgeClaims.id, claimId))); return this.getClaim(ownerUserId, claimId) }
  async listClaimEntityLinks(ownerUserId: number, claimId?: number, limit?: number): Promise<KnowledgeClaimEntityLink[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeClaimEntityLinks).where(and(eq(knowledgeClaimEntityLinks.ownerUserId, ownerUserId), claimId === undefined ? undefined : eq(knowledgeClaimEntityLinks.claimId, claimId))).orderBy(knowledgeClaimEntityLinks.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
  async insertClaimEntityLink(record: NewKnowledgeRecord<KnowledgeClaimEntityLink>): Promise<KnowledgeClaimEntityLink> { const [inserted] = await this.db.insert(knowledgeClaimEntityLinks).values(record).$returningId(); const [row] = await this.db.select().from(knowledgeClaimEntityLinks).where(and(eq(knowledgeClaimEntityLinks.ownerUserId, record.ownerUserId), eq(knowledgeClaimEntityLinks.id, inserted!.id))).limit(1); return requireRow(domain(row ?? null), 'Knowledge claim entity link') }
  async listClaimEvidence(ownerUserId: number, claimId?: number, limit?: number): Promise<KnowledgeClaimEvidence[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeClaimEvidence).where(and(eq(knowledgeClaimEvidence.ownerUserId, ownerUserId), claimId === undefined ? undefined : eq(knowledgeClaimEvidence.claimId, claimId))).orderBy(knowledgeClaimEvidence.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
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

  async listContentEntityLinks(ownerUserId: number, briefId?: number, limit?: number): Promise<KnowledgeContentEntityLink[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.db.select().from(knowledgeContentEntityLinks).where(and(eq(knowledgeContentEntityLinks.ownerUserId, ownerUserId), briefId === undefined ? undefined : eq(knowledgeContentEntityLinks.briefId, briefId))).orderBy(knowledgeContentEntityLinks.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
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

  async listContentAnchors(ownerUserId: number, limit?: number): Promise<KnowledgeContentAnchor[]> {
    const bounded = knowledgeReadLimit(limit)
    const query = this.contentAnchorQuery(ownerUserId).orderBy(seoGeoContentBriefs.id, seoGeoContentDrafts.id)
    return domain(await (bounded === undefined ? query : query.limit(bounded)))
  }
}
