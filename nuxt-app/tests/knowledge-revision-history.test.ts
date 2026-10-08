import { describe, expect, it, vi } from 'vitest'
import { getKnowledgeRevisionHistory } from '../server/knowledge/revision-history'
import { createInMemoryKnowledgeRepository, createKnowledgeService } from '../server/knowledge'
import { KnowledgeRevisionError, type KnowledgeRevisionSubject } from '../server/knowledge/revision-types'
import { knowledgeRevisionCanonicalJson, knowledgeRevisionSha256 } from '../server/knowledge/revision-records'
import type { InMemoryKnowledgeRepository, KnowledgeRepository } from '../server/knowledge/types'

const OWNER = 73
const OTHER_OWNER = 74
const NOW = new Date('2026-09-10T12:00:00.000Z')
const HASH = 'a'.repeat(64)
type RepositoryHook = (transaction: KnowledgeRepository) => KnowledgeRepository

function fixture(hook?: RepositoryHook) {
  const base = createInMemoryKnowledgeRepository()
  const repository = hook ? new Proxy(base, {
    get(target, property) {
      if (property === 'transaction') return <T>(work: (transaction: KnowledgeRepository) => Promise<T>, options?: Parameters<KnowledgeRepository['transaction']>[1]) => target.transaction(tx => work(hook(tx)), options)
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as InMemoryKnowledgeRepository : base
  const service = createKnowledgeService({ ownerUserId: OWNER, repository, now: () => NOW, entityUid: (() => { let id = 0; return () => `history-entity-${++id}` })() })
  return { base, repository, service }
}

async function createEntity(service: ReturnType<typeof createKnowledgeService>) {
  const result = await service.createEntity({ entityType: 'Organization', canonicalName: 'History subject' })
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.value.entity
}

async function aliasRevision(service: ReturnType<typeof createKnowledgeService>, entityId: number, index: number) {
  const result = await service.addAlias({ entityId, alias: `History alias ${index}` })
  if (result.status !== 'ok') throw new Error(result.reason)
}

function intercept(base: KnowledgeRepository, method: string, replacement: (...args: unknown[]) => unknown): KnowledgeRepository {
  return new Proxy(base, {
    get(target, property) {
      if (property === 'transaction' && method !== 'transaction') return <T>(work: (transaction: KnowledgeRepository) => Promise<T>, options?: Parameters<KnowledgeRepository['transaction']>[1]) => target.transaction(tx => work(intercept(tx, method, replacement)), options)
      if (property === method) return replacement
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function forgedCursor(cursor: string, alter: (payload: Record<string, unknown>) => void): string {
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { payload: Record<string, unknown>; checksum: string }
  alter(decoded.payload)
  decoded.checksum = knowledgeRevisionSha256(knowledgeRevisionCanonicalJson(decoded.payload))
  return Buffer.from(knowledgeRevisionCanonicalJson(decoded), 'utf8').toString('base64url')
}

describe('Knowledge revision history service', () => {
  it('returns newest first pages of 25 plus a cursor, and preserves an older page across a new revision', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service)
    for (let index = 1; index <= 32; index += 1) await aliasRevision(service, entity.id, index)

    const first = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, repository)
    expect(first.items).toHaveLength(25)
    expect(first.items.map(item => item.revisionNumber)).toEqual(Array.from({ length: 25 }, (_, index) => 33 - index))
    expect(first.nextCursor).toBeTruthy()

    await aliasRevision(service, entity.id, 33)
    const second = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: first.nextCursor }, repository)
    expect(second.items.map(item => item.revisionNumber)).toEqual(Array.from({ length: 8 }, (_, index) => 8 - index))
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(item => item.revisionId)).size).toBe(33)
  })

  it('returns an empty history for a legacy subject and makes the first changed state an explicit baseline', async () => {
    const { repository, service } = fixture()
    const legacy = await repository.transaction(tx => tx.insertEntity({
      ownerUserId: OWNER, entityUid: 'legacy-history', entityType: 'Organization', canonicalName: 'Legacy history', slug: null,
      canonicalUri: null, canonicalUriHash: null, locale: null, summary: null, status: 'active', publicVisibility: 'private',
      mergedIntoEntityId: null, provenance: null, createdAt: NOW, updatedAt: NOW,
    }))
    const empty = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(legacy.id) }, repository)
    expect(empty.items).toEqual([])
    expect(empty.nextCursor).toBeNull()
    expect((await service.addAlias({ entityId: legacy.id, alias: 'Old name' })).status).toBe('ok')
    const history = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(legacy.id) }, repository)
    expect(history.items.map(item => [item.revisionNumber, item.revisionKind])).toEqual([[2, 'mutation'], [1, 'legacy_baseline']])
  })

  it('serves claim and source histories with the same owner and subject binding', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service)
    const source = await service.registerSource({ canonicalUrl: 'https://example.test/source', sourceClass: 'official documentation' })
    expect(source.status).toBe('ok')
    if (source.status !== 'ok') return
    const version = await service.addSourceVersion({ sourceId: source.value.id, contentHash: HASH, retrievedAt: NOW })
    expect(version.status).toBe('ok')
    if (version.status !== 'ok') return
    const claim = await service.createClaim({ statement: 'Private claim statement', claimType: 'research findings', entityIds: [entity.id] })
    expect(claim.status).toBe('ok')
    if (claim.status !== 'ok') return
    await service.addEvidence({ claimId: claim.value.id, sourceVersionId: version.value.id, relation: 'supports', locator: 'section one', contentHash: HASH })
    expect((await getKnowledgeRevisionHistory(OWNER, { kind: 'claim', id: String(claim.value.id) }, repository)).items.map(item => item.revisionNumber)).toEqual([2, 1])
    expect((await getKnowledgeRevisionHistory(OWNER, { kind: 'source', id: String(source.value.id) }, repository)).items.map(item => item.revisionNumber)).toEqual([2, 1])
  })

  it('rejects forged owner/scope cursors and non-string input before repository access', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service)
    for (let index = 1; index <= 25; index += 1) await aliasRevision(service, entity.id, index)
    const first = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, repository)
    const transaction = vi.spyOn(repository, 'transaction')
    const ownerCursor = forgedCursor(first.nextCursor!, payload => { payload.ownerUserId = OTHER_OWNER })
    const scopeCursor = forgedCursor(first.nextCursor!, payload => { payload.kind = 'claim' })
    const changedChecksumCursor = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith('A') ? 'B' : 'A'}`
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: ownerCursor }, repository)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: scopeCursor }, repository)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: changedChecksumCursor }, repository)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: 42 }, repository)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
    transaction.mockClear()
    await expect(getKnowledgeRevisionHistory(OTHER_OWNER, { kind: 'entity', id: String(entity.id) }, repository)).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' })
    expect(transaction).toHaveBeenCalledOnce()
  })

  it('rejects a validly checksummed cursor whose next revision number or fingerprint does not match history', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service)
    for (let index = 1; index <= 25; index += 1) await aliasRevision(service, entity.id, index)
    const first = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, repository)
    const numberMismatch = forgedCursor(first.nextCursor!, payload => { payload.expectedRevisionNumber = Number(payload.expectedRevisionNumber) + 1 })
    const fingerprintMismatch = forgedCursor(first.nextCursor!, payload => { payload.expectedRevisionFingerprint = 'f'.repeat(64) })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: numberMismatch }, repository)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id), cursor: fingerprintMismatch }, repository)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('uses the consistent read-only transaction and projects no raw snapshots or active behavior flags', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service)
    const spy = vi.spyOn(repository, 'transaction')
    const result = await getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, repository)
    expect(spy).toHaveBeenCalledWith(expect.any(Function), { consistentReadOnly: true })
    expect(result).toMatchObject({ historyScope: 'recorded_mutations_only', rawSnapshotIncluded: false, automaticPublication: false, productionActivation: false, automaticTrainingAdmission: false })
    expect(JSON.stringify(result)).not.toContain('canonicalSnapshot')
    expect(JSON.stringify(result)).not.toContain('Private claim statement')
    expect(result.items[0]).not.toHaveProperty('canonicalSnapshot')
    expect(result.items[0]).not.toHaveProperty('statement')
  })

  it.each([
    ['non-canonical snapshot', (row: Record<string, unknown>) => { row.canonicalSnapshot = '{"tampered":true}' }],
    ['head fingerprint', (row: Record<string, unknown>) => { row.revisionFingerprint = 'b'.repeat(64) }],
  ])('rejects a corrupt %s', async (_label, corruptRow) => {
    const { base, service } = fixture()
    const entity = await createEntity(service)
    await aliasRevision(service, entity.id, 1)
    const damaged = intercept(base, 'listRevisions', async (...args) => {
      const rows = await base.listRevisions(args[0] as number, args[1] as KnowledgeRevisionSubject, args[2] as number | undefined, args[3] as number | undefined)
      const changed = structuredClone(rows) as unknown as Array<Record<string, unknown>>
      corruptRow(changed[0]!)
      return changed
    })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, damaged)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })

  it('rejects a missing or mismatched paired event', async () => {
    const { base, service } = fixture()
    const entity = await createEntity(service)
    const missing = intercept(base, 'getMutationEventForRevision', async () => null)
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, missing)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })

    const mismatched = intercept(base, 'getMutationEventForRevision', async (...args) => {
      const event = await base.getMutationEventForRevision(args[0] as number, args[1] as string)
      return event && { ...event, operations: ['updateClaim'] }
    })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, mismatched)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })

  it('rejects a missing intermediate revision, a missing revision one, and repository over-limit output', async () => {
    const { base, service } = fixture()
    const entity = await createEntity(service)
    await aliasRevision(service, entity.id, 1)
    await aliasRevision(service, entity.id, 2)
    const omitMiddle = intercept(base, 'listRevisions', async (...args) => (await base.listRevisions(args[0] as number, args[1] as KnowledgeRevisionSubject, args[2] as number | undefined, args[3] as number | undefined)).filter(row => row.revisionNumber !== 2))
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, omitMiddle)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })

    const omitBaseline = intercept(base, 'listRevisions', async (...args) => (await base.listRevisions(args[0] as number, args[1] as KnowledgeRevisionSubject, args[2] as number | undefined, args[3] as number | undefined)).filter(row => row.revisionNumber !== 1))
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, omitBaseline)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })

    const overLimit = intercept(base, 'listRevisions', async (...args) => {
      const rows = await base.listRevisions(args[0] as number, args[1] as KnowledgeRevisionSubject, args[2] as number | undefined, args[3] as number | undefined)
      return Array.from({ length: 27 }, (_, index) => rows[index % rows.length]!)
    })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, overLimit)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('propagates repository failures for the route layer to map to a fixed unavailable response', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service)
    const storageError = new Error('DATABASE SECRET')
    const failed = intercept(repository, 'transaction', async () => { throw storageError })
    await expect(getKnowledgeRevisionHistory(OWNER, { kind: 'entity', id: String(entity.id) }, failed)).rejects.toBe(storageError)
  })
})
