import { and, eq, gt, inArray } from 'drizzle-orm'
import { getDatabase } from '../database'
import { geoOutcomeDatasetManifests, knowledgeConsumerBindings, knowledgeConsumerBindingHeads, knowledgeMutationEvents, knowledgeSubjectRevisions, llmVisibilityProjects, llmVisibilityPromptVersions, llmVisibilityQueries } from '../database/schema'
import { DrizzleGeoOutcomeRepository, type GeoOutcomeDrizzleDatabase } from '../geo-outcome-model/repository-drizzle'
import { normalizedPromptHash } from '../llm-visibility/guards'
import { DrizzleKnowledgeRepository, type KnowledgeDrizzleDatabase } from './repository-drizzle'
import { assertValidKnowledgeConsumerBinding } from './consumer-bindings'
import { KnowledgeConsumerBindingError, type KnowledgeConsumerAnchor, type KnowledgeConsumerBinding, type KnowledgeConsumerBindingInput, type KnowledgeConsumerBindingRepository, type KnowledgeConsumerKind, type KnowledgeConsumerBindingAuthorities } from './consumer-binding-types'
import { assertValidKnowledgeRevision, knowledgeRevisionSha256 } from './revision-records'
import { KNOWLEDGE_REVISION_SCHEMA, type KnowledgeRevision } from './revision-types'

type AppDatabase = Omit<NonNullable<ReturnType<typeof getDatabase>>, '$client'>
const ownerCheck = (ownerUserId: number) => { if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0 || ownerUserId > 2_147_483_647) throw new KnowledgeConsumerBindingError('INVALID_INPUT') }
const inputCheck = (id: number) => { if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new KnowledgeConsumerBindingError('INVALID_INPUT') }
function mapBinding(row: typeof knowledgeConsumerBindings.$inferSelect): KnowledgeConsumerBinding {
  const { idempotencyKeyHash, ...record } = row
  if (idempotencyKeyHash !== knowledgeRevisionSha256(record.idempotencyKey)) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
  assertValidKnowledgeConsumerBinding(record)
  return record
}
function mapRevision(row: typeof knowledgeSubjectRevisions.$inferSelect): KnowledgeRevision {
  if (row.schemaVersion !== KNOWLEDGE_REVISION_SCHEMA) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
  const record: KnowledgeRevision = { ...row, schemaVersion: KNOWLEDGE_REVISION_SCHEMA }
  assertValidKnowledgeRevision(record)
  return record
}
function chunks<T>(values: readonly T[]): T[][] { const result: T[][] = []; for (let offset = 0; offset < values.length; offset += 500) result.push(values.slice(offset, offset + 500)); return result }
function verifyPointer(head: typeof knowledgeConsumerBindingHeads.$inferSelect, binding: KnowledgeConsumerBinding | null): KnowledgeConsumerBinding {
  if (!binding || head.ownerUserId !== binding.ownerUserId || head.consumerKind !== binding.consumerKind || head.consumerId !== binding.consumerId || head.subjectKind !== binding.subjectKind || head.subjectId !== binding.subjectId || head.bindingId !== binding.id || head.sequenceNumber !== binding.sequenceNumber || head.bindingFingerprint !== binding.bindingFingerprint) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
  return binding
}

export class DrizzleKnowledgeConsumerBindingRepository implements KnowledgeConsumerBindingRepository {
  readonly knowledge: DrizzleKnowledgeRepository
  private readonly db: KnowledgeDrizzleDatabase
  constructor(database: KnowledgeDrizzleDatabase | null = getDatabase(), private readonly writeTransaction = false) {
    if (!database) throw new Error('Knowledge binding database is not configured.')
    this.db = database
    this.knowledge = new DrizzleKnowledgeRepository(database, writeTransaction)
  }
  async transaction<T>(work: (repository: KnowledgeConsumerBindingRepository) => Promise<T>): Promise<T> {
    if (this.writeTransaction) throw new KnowledgeConsumerBindingError('CONFLICT')
    return (this.db as AppDatabase).transaction(tx => work(new DrizzleKnowledgeConsumerBindingRepository(tx, true)), { isolationLevel: 'serializable', accessMode: 'read write' })
  }
  async readOnly<T>(work: (repository: KnowledgeConsumerBindingRepository) => Promise<T>): Promise<T> {
    if (this.writeTransaction) throw new KnowledgeConsumerBindingError('CONFLICT')
    return (this.db as AppDatabase).transaction(tx => work(new DrizzleKnowledgeConsumerBindingRepository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' })
  }
  async getNativeAnchor(ownerUserId: number, kind: KnowledgeConsumerKind, id: number, lock?: true) {
    ownerCheck(ownerUserId); inputCheck(id)
    if (lock && !this.writeTransaction) throw new KnowledgeConsumerBindingError('CONFLICT')
    if (kind === 'geo_dataset') {
      const query = this.db.select({ id: geoOutcomeDatasetManifests.id, ownerUserId: geoOutcomeDatasetManifests.ownerUserId, manifestId: geoOutcomeDatasetManifests.manifestId }).from(geoOutcomeDatasetManifests).where(and(eq(geoOutcomeDatasetManifests.ownerUserId, ownerUserId), eq(geoOutcomeDatasetManifests.id, id))).limit(1)
      const [row] = await (lock ? query.for('update') : query)
      if (!row) return null
      // Reuse the native immutable-manifest validator, not a caller's claimed dataset hash.
      const manifest = await new DrizzleGeoOutcomeRepository(this.db as GeoOutcomeDrizzleDatabase, true).getDataset(ownerUserId, row.manifestId)
      if (!manifest || !/^[a-f0-9]{64}$/u.test(manifest.manifestFingerprint)) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
      return { ownerUserId, consumerKind: kind, consumerId: id, consumerVersion: manifest.manifestFingerprint, consumerContentHash: manifest.manifestFingerprint }
    }
    if (kind !== 'benchmark_prompt') throw new KnowledgeConsumerBindingError('INVALID_INPUT')
    const query = this.db.select({ ownerUserId: llmVisibilityPromptVersions.ownerUserId, versionNumber: llmVisibilityPromptVersions.versionNumber, promptHash: llmVisibilityPromptVersions.promptHash, promptText: llmVisibilityPromptVersions.promptText, verifiedQueryId: llmVisibilityQueries.id, verifiedProjectId: llmVisibilityProjects.id }).from(llmVisibilityPromptVersions)
      .leftJoin(llmVisibilityQueries, and(eq(llmVisibilityQueries.id, llmVisibilityPromptVersions.queryId), eq(llmVisibilityQueries.ownerUserId, ownerUserId), eq(llmVisibilityQueries.projectId, llmVisibilityPromptVersions.projectId)))
      .leftJoin(llmVisibilityProjects, and(eq(llmVisibilityProjects.id, llmVisibilityPromptVersions.projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId)))
      .where(and(eq(llmVisibilityPromptVersions.id, id), eq(llmVisibilityPromptVersions.ownerUserId, ownerUserId))).limit(1)
    const [row] = await (lock ? query.for('update') : query)
    if (!row) return null
    if (!row.verifiedQueryId || !row.verifiedProjectId || !Number.isSafeInteger(row.versionNumber) || row.versionNumber <= 0 || row.versionNumber > 2_147_483_647 || !/^[a-f0-9]{64}$/u.test(row.promptHash) || typeof row.promptText !== 'string' || row.promptText.length > 12_000 || normalizedPromptHash(row.promptText) !== row.promptHash) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
    return { ownerUserId, consumerKind: kind, consumerId: id, consumerVersion: String(row.versionNumber), consumerContentHash: row.promptHash }
  }
  async getBindingHead(ownerUserId: number, input: Pick<KnowledgeConsumerBindingInput, 'consumerKind' | 'consumerId' | 'subjectKind' | 'subjectId'>) {
    ownerCheck(ownerUserId)
    const table = knowledgeConsumerBindingHeads
    const [row] = await this.db.select({ head: table, binding: knowledgeConsumerBindings }).from(table).leftJoin(knowledgeConsumerBindings, and(eq(knowledgeConsumerBindings.id, table.bindingId), eq(knowledgeConsumerBindings.ownerUserId, ownerUserId))).where(and(eq(table.ownerUserId, ownerUserId), eq(table.consumerKind, input.consumerKind), eq(table.consumerId, input.consumerId), eq(table.subjectKind, input.subjectKind), eq(table.subjectId, input.subjectId))).limit(1)
    return row ? verifyPointer(row.head, row.binding ? mapBinding(row.binding) : null) : null
  }
  async getCommand(ownerUserId: number, idempotencyKey: string) {
    ownerCheck(ownerUserId)
    const [row] = await this.db.select().from(knowledgeConsumerBindings).where(and(eq(knowledgeConsumerBindings.ownerUserId, ownerUserId), eq(knowledgeConsumerBindings.idempotencyKeyHash, knowledgeRevisionSha256(idempotencyKey)))).limit(1)
    return row ? mapBinding(row) : null
  }
  async getBindingByFingerprint(ownerUserId: number, fingerprint: string) {
    ownerCheck(ownerUserId)
    const [row] = await this.db.select().from(knowledgeConsumerBindings).where(and(eq(knowledgeConsumerBindings.ownerUserId, ownerUserId), eq(knowledgeConsumerBindings.bindingFingerprint, fingerprint))).limit(1)
    return row ? mapBinding(row) : null
  }
  async getBoundRevision(ownerUserId: number, id: number): Promise<KnowledgeRevision | null> {
    ownerCheck(ownerUserId); inputCheck(id)
    const [row] = await this.db.select().from(knowledgeSubjectRevisions).where(and(eq(knowledgeSubjectRevisions.ownerUserId, ownerUserId), eq(knowledgeSubjectRevisions.id, id))).limit(1)
    return row ? mapRevision(row) : null
  }
  async appendBinding(record: Omit<KnowledgeConsumerBinding, 'id'>): Promise<KnowledgeConsumerBinding> {
    if (!this.writeTransaction) throw new KnowledgeConsumerBindingError('CONFLICT')
    assertValidKnowledgeConsumerBinding(record)
    const previous = await this.getBindingHead(record.ownerUserId, record)
    if ((previous?.bindingFingerprint ?? null) !== record.previousBindingFingerprint || record.sequenceNumber !== (previous?.sequenceNumber ?? 0) + 1) throw new KnowledgeConsumerBindingError('CONFLICT')
    const [inserted] = await this.db.insert(knowledgeConsumerBindings).values({ ...record, idempotencyKeyHash: knowledgeRevisionSha256(record.idempotencyKey) }).$returningId()
    if (!inserted) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
    const [row] = await this.db.select().from(knowledgeConsumerBindings).where(and(eq(knowledgeConsumerBindings.ownerUserId, record.ownerUserId), eq(knowledgeConsumerBindings.id, inserted.id))).limit(1)
    if (!row) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
    const table = knowledgeConsumerBindingHeads
    const pointer = { ownerUserId: record.ownerUserId, consumerKind: record.consumerKind, consumerId: record.consumerId, subjectKind: record.subjectKind, subjectId: record.subjectId, bindingId: inserted.id, sequenceNumber: record.sequenceNumber, bindingFingerprint: record.bindingFingerprint }
    if (!previous) await this.db.insert(table).values(pointer)
    else {
      const result = await this.db.update(table).set(pointer).where(and(eq(table.ownerUserId, record.ownerUserId), eq(table.consumerKind, record.consumerKind), eq(table.consumerId, record.consumerId), eq(table.subjectKind, record.subjectKind), eq(table.subjectId, record.subjectId), eq(table.bindingId, previous.id), eq(table.sequenceNumber, previous.sequenceNumber), eq(table.bindingFingerprint, previous.bindingFingerprint)))
      if (Number(result[0]?.affectedRows) !== 1) throw new KnowledgeConsumerBindingError('CONFLICT')
    }
    return mapBinding(row)
  }
  async listBindingHeads(ownerUserId: number, limit: number) {
    ownerCheck(ownerUserId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_001) throw new KnowledgeConsumerBindingError('INVALID_INPUT')
    const table = knowledgeConsumerBindingHeads
    const rows = await this.db.select({ head: table, binding: knowledgeConsumerBindings }).from(table).leftJoin(knowledgeConsumerBindings, and(eq(knowledgeConsumerBindings.id, table.bindingId), eq(knowledgeConsumerBindings.ownerUserId, ownerUserId))).where(eq(table.ownerUserId, ownerUserId)).orderBy(table.consumerKind, table.consumerId, table.subjectKind, table.subjectId).limit(limit)
    return rows.map(row => verifyPointer(row.head, row.binding ? mapBinding(row.binding) : null))
  }
  async loadAuthorities(ownerUserId: number, rows: readonly KnowledgeConsumerBinding[]): Promise<KnowledgeConsumerBindingAuthorities> {
    ownerCheck(ownerUserId)
    if (rows.length > 2_000) throw new KnowledgeConsumerBindingError('LIMIT_EXCEEDED')
    for (const row of rows) { assertValidKnowledgeConsumerBinding(row); if (row.ownerUserId !== ownerUserId) throw new KnowledgeConsumerBindingError('CORRUPT_STATE') }
    const result: KnowledgeConsumerBindingAuthorities = { predecessors: new Map(), anchors: new Map(), revisions: new Map(), events: new Map() }
    for (const ids of chunks([...new Set(rows.flatMap(row => row.previousBindingFingerprint ? [row.previousBindingFingerprint] : []))])) {
      const records = await this.db.select().from(knowledgeConsumerBindings).where(and(eq(knowledgeConsumerBindings.ownerUserId, ownerUserId), inArray(knowledgeConsumerBindings.bindingFingerprint, ids)))
      for (const row of records) result.predecessors.set(row.bindingFingerprint, mapBinding(row))
    }
    // Revoked heads remain visible in the owner workspace, so validate their historical pins too.
    const active = rows
    for (const ids of chunks([...new Set(active.map(row => row.revisionId))])) {
      const records = await this.db.select().from(knowledgeSubjectRevisions).where(and(eq(knowledgeSubjectRevisions.ownerUserId, ownerUserId), inArray(knowledgeSubjectRevisions.id, ids)))
      for (const row of records) result.revisions.set(row.id, mapRevision(row))
      const events = await this.db.select().from(knowledgeMutationEvents).where(and(eq(knowledgeMutationEvents.ownerUserId, ownerUserId), inArray(knowledgeMutationEvents.revisionId, ids)))
      for (const row of events) result.events.set(row.revisionId, row)
    }
    for (const ids of chunks([...new Set(active.filter(row => row.consumerKind === 'geo_dataset').map(row => row.consumerId))])) {
      const records = await new DrizzleGeoOutcomeRepository(this.db as GeoOutcomeDrizzleDatabase, true).getDatasetsByDatabaseIds(ownerUserId, ids)
      for (const row of records) {
        if (!/^[a-f0-9]{64}$/u.test(row.manifest.manifestFingerprint)) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
        result.anchors.set(`geo_dataset:${row.id}`, { ownerUserId, consumerKind: 'geo_dataset', consumerId: row.id, consumerVersion: row.manifest.manifestFingerprint, consumerContentHash: row.manifest.manifestFingerprint })
      }
    }
    for (const ids of chunks([...new Set(active.filter(row => row.consumerKind === 'benchmark_prompt').map(row => row.consumerId))])) {
      const table = llmVisibilityPromptVersions
      const records = await this.db.select({ id: table.id, versionNumber: table.versionNumber, promptHash: table.promptHash, promptText: table.promptText, verifiedQueryId: llmVisibilityQueries.id, verifiedProjectId: llmVisibilityProjects.id }).from(table)
        .leftJoin(llmVisibilityQueries, and(eq(llmVisibilityQueries.id, table.queryId), eq(llmVisibilityQueries.ownerUserId, ownerUserId), eq(llmVisibilityQueries.projectId, table.projectId)))
        .leftJoin(llmVisibilityProjects, and(eq(llmVisibilityProjects.id, table.projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId)))
        .where(and(eq(table.ownerUserId, ownerUserId), inArray(table.id, ids)))
      for (const row of records) {
        if (!row.verifiedQueryId || !row.verifiedProjectId || !Number.isSafeInteger(row.versionNumber) || row.versionNumber < 1 || row.versionNumber > 2_147_483_647 || !/^[a-f0-9]{64}$/u.test(row.promptHash) || typeof row.promptText !== 'string' || row.promptText.length > 12_000 || normalizedPromptHash(row.promptText) !== row.promptHash) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
        result.anchors.set(`benchmark_prompt:${row.id}`, { ownerUserId, consumerKind: 'benchmark_prompt', consumerId: row.id, consumerVersion: String(row.versionNumber), consumerContentHash: row.promptHash })
      }
    }
    return result
  }
  async listNativeAnchors(ownerUserId: number, kind: KnowledgeConsumerKind, afterId: number, limit: number): Promise<KnowledgeConsumerAnchor[]> {
    ownerCheck(ownerUserId)
    if (!Number.isSafeInteger(afterId) || afterId < 0 || afterId > 2_147_483_647 || !Number.isSafeInteger(limit) || limit < 1 || limit > 26 || !['geo_dataset', 'benchmark_prompt'].includes(kind)) throw new KnowledgeConsumerBindingError('INVALID_INPUT')
    const table = kind === 'geo_dataset' ? geoOutcomeDatasetManifests : llmVisibilityPromptVersions
    const ids = (await this.db.select({ id: table.id }).from(table).where(and(eq(table.ownerUserId, ownerUserId), gt(table.id, afterId))).orderBy(table.id).limit(limit)).map(row => row.id)
    if (!ids.length) return []
    if (kind === 'geo_dataset') {
      const rows = await new DrizzleGeoOutcomeRepository(this.db as GeoOutcomeDrizzleDatabase, true).getDatasetsByDatabaseIds(ownerUserId, ids)
      if (rows.length !== ids.length) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
      const byId = new Map(rows.map(row => [row.id, row.manifest]))
      return ids.map(id => {
        const manifest = byId.get(id)
        if (!manifest) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
        return { ownerUserId, consumerKind: kind, consumerId: id, consumerVersion: manifest.manifestFingerprint, consumerContentHash: manifest.manifestFingerprint }
      })
    }
    // One batch validates the exact selected native IDs, including broken project/query ownership.
    const prompts = llmVisibilityPromptVersions
    const rows = await this.db.select({ id: prompts.id, versionNumber: prompts.versionNumber, promptHash: prompts.promptHash, promptText: prompts.promptText, verifiedQueryId: llmVisibilityQueries.id, verifiedProjectId: llmVisibilityProjects.id }).from(prompts)
      .leftJoin(llmVisibilityQueries, and(eq(llmVisibilityQueries.id, prompts.queryId), eq(llmVisibilityQueries.ownerUserId, ownerUserId), eq(llmVisibilityQueries.projectId, prompts.projectId)))
      .leftJoin(llmVisibilityProjects, and(eq(llmVisibilityProjects.id, prompts.projectId), eq(llmVisibilityProjects.ownerUserId, ownerUserId)))
      .where(and(eq(prompts.ownerUserId, ownerUserId), inArray(prompts.id, ids)))
    if (rows.length !== ids.length) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
    const byId = new Map(rows.map(row => [row.id, row]))
    return ids.map(id => {
      const row = byId.get(id)
      if (!row || !row.verifiedQueryId || !row.verifiedProjectId || !Number.isSafeInteger(row.versionNumber) || row.versionNumber < 1 || row.versionNumber > 2_147_483_647 || !/^[a-f0-9]{64}$/u.test(row.promptHash) || typeof row.promptText !== 'string' || row.promptText.length > 12_000 || normalizedPromptHash(row.promptText) !== row.promptHash) throw new KnowledgeConsumerBindingError('CORRUPT_STATE')
      return { ownerUserId, consumerKind: kind, consumerId: id, consumerVersion: String(row.versionNumber), consumerContentHash: row.promptHash }
    })
  }
}
