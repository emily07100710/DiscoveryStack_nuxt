import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { createInMemoryKnowledgeRepository } from '../server/knowledge/repository'
import { createKnowledgeService } from '../server/knowledge/service'
import { assertValidKnowledgeMutationEvent, assertValidKnowledgeRevision, knowledgeMutationEventFingerprint, knowledgeRevisionFingerprint } from '../server/knowledge/revision-records'
import { KNOWLEDGE_REVISION_SCHEMA, KnowledgeRevisionError, type KnowledgeRevision } from '../server/knowledge/revision-types'
import { DrizzleKnowledgeRepository, type KnowledgeDrizzleDatabase } from '../server/knowledge/repository-drizzle'

const owner = 83
const now = new Date('2026-10-08T00:00:00.000Z')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function validRevision(overrides: Record<string, unknown> = {}) {
  const canonicalSnapshot = `{"kind":"entity","ownerUserId":${owner},"schemaVersion":"${KNOWLEDGE_REVISION_SCHEMA}","subject":{"id":1}}`
  const base = { ownerUserId: owner, subjectKind: 'entity' as const, subjectId: 1, schemaVersion: KNOWLEDGE_REVISION_SCHEMA, revisionNumber: 1, revisionKind: 'mutation' as const, canonicalSnapshot, contentHash: sha(canonicalSnapshot), previousRevisionFingerprint: null, revisionFingerprint: '', operations: ['insertEntity'], createdAt: now, updatedAt: now }
  return { ...base, ...overrides, revisionFingerprint: '' } as Omit<KnowledgeRevision, 'id'>
}
function signedRevision(overrides: Record<string, unknown> = {}) {
  const base = validRevision(overrides)
  return { ...base, revisionFingerprint: knowledgeRevisionFingerprint(base) }
}
function signedEvent(revision: KnowledgeRevision) {
  const base = { ownerUserId: revision.ownerUserId, subjectKind: revision.subjectKind, subjectId: revision.subjectId, revisionId: revision.id, revisionNumber: revision.revisionNumber, previousRevisionFingerprint: revision.previousRevisionFingerprint, newRevisionFingerprint: revision.revisionFingerprint, eventFingerprint: '', operations: revision.operations, createdAt: now, updatedAt: now }
  return { ...base, eventFingerprint: knowledgeMutationEventFingerprint(base) }
}
function expectCode(action: () => unknown, code: string) { expect(action).toThrowError(expect.objectContaining({ code })) }

describe('knowledge revision persistence contracts', () => {
  it('validates snapshot, content hash, revision fingerprint, numeric IDs, dates, operations and previous chain', () => {
    const valid = signedRevision()
    expect(() => assertValidKnowledgeRevision(valid)).not.toThrow()
    expectCode(() => assertValidKnowledgeRevision({ ...valid, canonicalSnapshot: '{ "kind":"entity","subject":{"id":1}}' }), 'CORRUPT_STATE')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, contentHash: 'a'.repeat(64) }), 'CORRUPT_STATE')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, ownerUserId: 1.2 }), 'INVALID_INPUT')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, subjectId: Number.MAX_SAFE_INTEGER + 1 }), 'INVALID_INPUT')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, createdAt: new Date(Number.NaN) }), 'CORRUPT_STATE')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, operations: ['updateEntity', 'insertEntity'] }), 'CORRUPT_STATE')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, previousRevisionFingerprint: 'b'.repeat(64) }), 'CORRUPT_STATE')
    expectCode(() => assertValidKnowledgeRevision({ ...valid, canonicalSnapshot: JSON.stringify({ data: '字'.repeat(22_000) }) }), 'LIMIT_EXCEEDED')
  })

  it('checks event identities and event fingerprint', () => {
    const revision = { ...signedRevision(), id: 1 } as KnowledgeRevision
    const event = signedEvent(revision)
    expect(() => assertValidKnowledgeMutationEvent(event)).not.toThrow()
    expectCode(() => assertValidKnowledgeMutationEvent({ ...event, revisionId: 0 }), 'CORRUPT_STATE')
    expectCode(() => assertValidKnowledgeMutationEvent({ ...event, eventFingerprint: 'f'.repeat(64) }), 'CORRUPT_STATE')
  })

  it('requires audited writes, pairs event and revision, isolates owners and rolls back failures', async () => {
    const repo = createInMemoryKnowledgeRepository()
    const service = createKnowledgeService({ ownerUserId: owner, repository: repo, now: () => now, entityUid: () => 'persist-entity' })
    const result = await service.createEntity({ entityType: 'Organization', canonicalName: 'Persistence' })
    if (result.status !== 'ok') throw new Error(result.reason)
    const subject = { kind: 'entity' as const, id: result.value.entity.id }
    const revisions = await repo.listRevisions(owner, subject)
    expect(revisions).toHaveLength(1)
    expect(await repo.listMutationEvents(owner, subject)).toMatchObject([{ revisionId: revisions[0]!.id, newRevisionFingerprint: revisions[0]!.revisionFingerprint }])
    expect(await repo.listRevisions(owner + 1, subject)).toEqual([])
    await expect(repo.transaction(async tx => tx.appendRevision(signedRevision()))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(repo.transaction(async tx => tx.appendRevision(signedRevision({ ownerUserId: owner + 1 })), { auditedMutation: true })).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    const forged = new Proxy(repo, { get(target, key, receiver) { if (key === 'transaction') return (work: (tx: typeof repo) => Promise<unknown>, opts?: { auditedMutation?: true }) => target.transaction(tx => work(new Proxy(tx, { get(inner, prop, recv) { if (prop === 'appendMutationEvent') return async () => { throw new KnowledgeRevisionError('REVISION_CONFLICT') }; const value = Reflect.get(inner, prop, recv) as unknown; return typeof value === 'function' ? value.bind(inner) : value } }) as typeof repo), opts); const value = Reflect.get(target, key, receiver) as unknown; return typeof value === 'function' ? value.bind(target) : value } })
    const rollbackService = createKnowledgeService({ ownerUserId: owner, repository: forged, now: () => now, entityUid: () => 'rollback-entity' })
    await expect(rollbackService.createEntity({ entityType: 'Organization', canonicalName: 'Rollback' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await forged.listEntities(owner)).toHaveLength(1)
  })

  it('serializes concurrent service mutations and retains a contiguous revision chain', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const service = createKnowledgeService({ ownerUserId: owner, repository, now: () => now, entityUid: () => 'concurrent-entity' })
    const created = await service.createEntity({ entityType: 'Organization', canonicalName: 'Concurrent' })
    if (created.status !== 'ok') throw new Error(created.reason)
    const entityId = created.value.entity.id
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.addAlias({ entityId, alias: `Alias ${i}` })))
    const revisions = (await repository.listRevisions(owner, { kind: 'entity', id: entityId })).reverse()
    expect(revisions.map(row => row.revisionNumber)).toEqual(Array.from({ length: 9 }, (_, i) => i + 1))
    expect(revisions.slice(1).every((row, i) => row.previousRevisionFingerprint === revisions[i]!.revisionFingerprint)).toBe(true)
    expect(await repository.listMutationEvents(owner, { kind: 'entity', id: entityId })).toHaveLength(9)
  })
})

// A SQL-recording fake: builders compile Drizzle SQL but never access a database.
class MockSqlDatabase {
  readonly dialect = new MySqlDialect()
  readonly selects: Array<{ sql: string; params: unknown[]; limit?: number; lock?: string }> = []
  readonly transactions: unknown[] = []
  select(_projection?: unknown) {
    const call = { sql: '', params: [] as unknown[], limit: undefined as number | undefined, lock: undefined as string | undefined }
    const builder: Record<string, (...args: any[]) => any> = {
      from: (_table: unknown) => builder,
      where: (condition: unknown) => { const query = this.dialect.sqlToQuery(condition as never); call.sql = query.sql; call.params = query.params; return builder },
      orderBy: () => builder,
      limit: (limit: number) => { call.limit = limit; return builder },
      for: (lock: string) => { call.lock = lock; return builder },
      then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => { this.selects.push(call); return Promise.resolve(call.lock ? [{ id: 9 }] : []).then(resolve, reject) },
    }
    return builder
  }
  async transaction<T>(work: (tx: MockSqlDatabase) => Promise<T>, config?: unknown) { this.transactions.push(config); return work(this) }
}

describe('Drizzle revision SQL shape', () => {
  it('uses owner and subject predicates, row locks, and bounded keyset history queries', async () => {
    const db = new MockSqlDatabase()
    const repo = new DrizzleKnowledgeRepository(db as unknown as KnowledgeDrizzleDatabase, true)
    await repo.lockRevisionSubject(owner, { kind: 'entity', id: 9 })
    await repo.listRevisions(owner, { kind: 'entity', id: 9 }, 100, 26)
    await repo.listMutationEvents(owner, { kind: 'entity', id: 9 }, 100, 26)
    expect(db.selects[0]).toMatchObject({ lock: 'update', params: [owner, 9] })
    expect(db.selects[0]!.sql).toContain('ownerUserId')
    expect(db.selects[1]).toMatchObject({ limit: 26, params: [owner, 'entity', 9, 100] })
    expect(db.selects[1]!.sql).toContain(' < ?')
    expect(db.selects[2]).toMatchObject({ limit: 26, params: [owner, 'entity', 9, 100] })
    expect(db.selects[1]!.sql).toContain('subjectId')
  })

  it('sets serializable read-write for audited mutations and consistent read-only for snapshots', async () => {
    const db = new MockSqlDatabase()
    const repo = new DrizzleKnowledgeRepository(db as unknown as KnowledgeDrizzleDatabase)
    await repo.transaction(async () => undefined, { auditedMutation: true })
    await repo.transaction(async () => undefined, { consistentReadOnly: true })
    expect(db.transactions).toEqual([
      { isolationLevel: 'serializable', accessMode: 'read write' },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ])
    await expect(repo.transaction(async () => undefined, { auditedMutation: true, consistentReadOnly: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
