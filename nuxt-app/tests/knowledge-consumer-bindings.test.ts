import { describe, expect, it } from 'vitest'
import { createInMemoryKnowledgeRepository } from '../server/knowledge/repository'
import { createKnowledgeService } from '../server/knowledge/service'
import { resolveKnowledgeImpact } from '../server/knowledge/impact-resolver'
import type { KnowledgeImpactSnapshot } from '../server/knowledge/impact-types'
import { createKnowledgeImpactPreview } from '../server/knowledge/impact-preview'
import {
  mutateKnowledgeConsumerBinding,
  parseKnowledgeConsumerBindingInput,
  readKnowledgeConsumerCoverage,
} from '../server/knowledge/consumer-bindings'
import type {
  KnowledgeConsumerAnchor,
  KnowledgeConsumerBinding,
  KnowledgeConsumerBindingInput,
  KnowledgeConsumerBindingRepository,
  KnowledgeConsumerKind,
} from '../server/knowledge/consumer-binding-types'
import type { KnowledgeRepository } from '../server/knowledge/types'

const OWNER = 73
const OTHER_OWNER = 74
const NOW = new Date('2026-10-08T12:00:00.000Z')
const HASH = 'a'.repeat(64)
const PROMPT_HASH = 'b'.repeat(64)
const PRIVATE_PROMPT = 'PRIVATE PROMPT BODY MUST NOT LEAK'

type BindingKey = Pick<KnowledgeConsumerBindingInput, 'consumerKind' | 'consumerId' | 'subjectKind' | 'subjectId'>

class BindingMemoryState {
  anchors = new Map<string, KnowledgeConsumerAnchor>()
  rows: KnowledgeConsumerBinding[] = []
  nextId = 1
  queue: Promise<void> = Promise.resolve()
  forceOverflow = false
}

function anchorKey(kind: KnowledgeConsumerKind, id: number) { return `${kind}:${id}` }
function bindingKey(row: BindingKey) { return `${row.consumerKind}:${row.consumerId}:${row.subjectKind}:${row.subjectId}` }

/** A transactional test adapter: Knowledge mutations use the real in-memory repository. */
class BindingMemoryRepository implements KnowledgeConsumerBindingRepository {
  private readonly state: BindingMemoryState

  constructor(readonly knowledge: KnowledgeRepository, state = new BindingMemoryState()) {
    this.state = state
  }

  addAnchor(anchor: KnowledgeConsumerAnchor) { this.state.anchors.set(anchorKey(anchor.consumerKind, anchor.consumerId), structuredClone(anchor)) }
  replaceAnchor(anchor: KnowledgeConsumerAnchor) { this.addAnchor(anchor) }
  removeAnchor(kind: KnowledgeConsumerKind, id: number) { this.state.anchors.delete(anchorKey(kind, id)) }
  allRows() { return structuredClone(this.state.rows) }
  removeBinding(fingerprint: string) { this.state.rows = this.state.rows.filter(row => row.bindingFingerprint !== fingerprint) }
  tamperBinding(id: number, patch: Partial<KnowledgeConsumerBinding>) {
    const index = this.state.rows.findIndex(row => row.id === id)
    if (index >= 0) this.state.rows[index] = { ...this.state.rows[index]!, ...patch }
  }
  overflowCoverage() { this.state.forceOverflow = true }

  async transaction<T>(work: (repository: KnowledgeConsumerBindingRepository) => Promise<T>): Promise<T> {
    const previous = this.state.queue
    let release!: () => void
    this.state.queue = new Promise<void>(resolve => { release = resolve })
    await previous
    const rowsBefore = structuredClone(this.state.rows)
    const nextIdBefore = this.state.nextId
    try {
      return await this.knowledge.transaction(
        knowledge => work(new BindingMemoryRepository(knowledge, this.state)),
        { auditedMutation: true },
      )
    } catch (error) {
      this.state.rows = rowsBefore
      this.state.nextId = nextIdBefore
      throw error
    } finally {
      release()
    }
  }

  async getNativeAnchor(ownerUserId: number, kind: KnowledgeConsumerKind, id: number): Promise<KnowledgeConsumerAnchor | null> {
    const row = this.state.anchors.get(anchorKey(kind, id))
    return row && row.ownerUserId === ownerUserId ? structuredClone(row) : row ? structuredClone(row) : null
  }

  async getBindingHead(ownerUserId: number, input: BindingKey): Promise<KnowledgeConsumerBinding | null> {
    const key = bindingKey(input)
    return structuredClone(this.state.rows.filter(row => row.ownerUserId === ownerUserId && bindingKey(row) === key).at(-1) ?? null)
  }

  async getCommand(ownerUserId: number, idempotencyKey: string): Promise<KnowledgeConsumerBinding | null> {
    return structuredClone(this.state.rows.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === idempotencyKey) ?? null)
  }

  async getBindingByFingerprint(ownerUserId: number, fingerprint: string): Promise<KnowledgeConsumerBinding | null> {
    return structuredClone(this.state.rows.find(row => row.ownerUserId === ownerUserId && row.bindingFingerprint === fingerprint) ?? null)
  }

  async loadAuthorities(ownerUserId: number, rows: readonly KnowledgeConsumerBinding[]) {
    const predecessors = new Map<string, KnowledgeConsumerBinding>()
    const anchors = new Map<string, KnowledgeConsumerAnchor>()
    const revisions = new Map<number, NonNullable<Awaited<ReturnType<KnowledgeRepository['getRevisionHead']>>>>()
    const events = new Map<number, NonNullable<Awaited<ReturnType<KnowledgeRepository['getMutationEventForRevision']>>>>()
    for (const row of rows) {
      if (row.previousBindingFingerprint) {
        const previous = this.state.rows.find(item => item.ownerUserId === ownerUserId && item.bindingFingerprint === row.previousBindingFingerprint)
        if (previous) predecessors.set(previous.bindingFingerprint, structuredClone(previous))
      }
      // The workspace also validates the historical pin preserved by a revoke head.
      const anchor = this.state.anchors.get(anchorKey(row.consumerKind, row.consumerId))
      if (anchor?.ownerUserId === ownerUserId) anchors.set(anchorKey(row.consumerKind, row.consumerId), structuredClone(anchor))
      const subject = { kind: row.subjectKind, id: row.subjectId }
      const revision = (await this.knowledge.listRevisions(ownerUserId, subject)).find(item => item.id === row.revisionId)
      if (revision) revisions.set(revision.id, revision)
      const event = await this.knowledge.getMutationEventForRevision(ownerUserId, row.revisionFingerprint)
      if (event) events.set(event.revisionId, event)
    }
    return { predecessors, anchors, revisions, events }
  }

  async getBoundRevision(ownerUserId: number, id: number) {
    for (const row of this.state.rows) {
      if (row.ownerUserId !== ownerUserId || row.revisionId !== id) continue
      const revisions = await this.knowledge.listRevisions(ownerUserId, { kind: row.subjectKind, id: row.subjectId })
      return structuredClone(revisions.find(revision => revision.id === id) ?? null)
    }
    return null
  }

  async appendBinding(record: Omit<KnowledgeConsumerBinding, 'id'>): Promise<KnowledgeConsumerBinding> {
    const saved = { ...structuredClone(record), id: this.state.nextId++ }
    this.state.rows.push(saved)
    return structuredClone(saved)
  }

  async listBindingHeads(ownerUserId: number, limit: number): Promise<KnowledgeConsumerBinding[]> {
    const heads = new Map<string, KnowledgeConsumerBinding>()
    for (const row of this.state.rows) {
      if (row.ownerUserId !== ownerUserId) continue
      const key = bindingKey(row)
      const current = heads.get(key)
      if (!current || current.sequenceNumber < row.sequenceNumber) heads.set(key, row)
    }
    const values = [...heads.values()].sort((left, right) => left.id - right.id).slice(0, limit)
    return this.state.forceOverflow && values[0] ? structuredClone(Array.from({ length: 2_001 }, () => values[0]!)) : structuredClone(values)
  }
}

function input(overrides: Partial<KnowledgeConsumerBindingInput> = {}): KnowledgeConsumerBindingInput {
  return {
    consumerKind: 'geo_dataset', consumerId: 501, subjectKind: 'entity', subjectId: 1,
    operation: 'bind', expectedRevisionFingerprint: null, expectedBindingFingerprint: null,
    idempotencyKey: 'bind-entity-0001', ...overrides,
  }
}

async function fixture() {
  const knowledge = createInMemoryKnowledgeRepository()
  let uid = 0
  const service = createKnowledgeService({ ownerUserId: OWNER, repository: knowledge, now: () => NOW, entityUid: () => `binding-entity-${++uid}` })
  const result = await service.createEntity({ entityType: 'Organization', canonicalName: 'Binding target' })
  if (result.status !== 'ok') throw new Error(result.reason)
  const entity = result.value.entity
  const head = await knowledge.getRevisionHead(OWNER, { kind: 'entity', id: entity.id })
  if (!head) throw new Error('Expected the entity creation revision.')
  const repository = new BindingMemoryRepository(knowledge)
  repository.addAnchor({ ownerUserId: OWNER, consumerKind: 'geo_dataset', consumerId: 501, consumerVersion: HASH, consumerContentHash: HASH })
  repository.addAnchor({ ownerUserId: OWNER, consumerKind: 'benchmark_prompt', consumerId: 601, consumerVersion: '3', consumerContentHash: PROMPT_HASH, promptText: PRIVATE_PROMPT } as KnowledgeConsumerAnchor)
  return { knowledge, repository, service, entity, firstHead: head }
}

async function impactSnapshot(knowledge: KnowledgeRepository, repository: KnowledgeConsumerBindingRepository): Promise<KnowledgeImpactSnapshot> {
  const [entities, coverage, revisionHeads] = await Promise.all([
    knowledge.listEntities(OWNER),
    readKnowledgeConsumerCoverage(OWNER, repository),
    knowledge.listRevisionHeads(OWNER),
  ])
  return {
    entities, aliases: [], externalIds: [], sources: [], sourceVersions: [], claims: [],
    claimEntityLinks: [], evidence: [], contentLinks: [], publisher: null, contentAnchors: [],
    adapterCoverage: coverage, revisionHeads,
  }
}

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ code })
}

describe('Knowledge consumer binding service', () => {
  it('binds exact dataset and prompt anchors to server-derived Knowledge revision pins', async () => {
    const { knowledge, repository, entity, firstHead } = await fixture()
    const dataset = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    const prompt = await mutateKnowledgeConsumerBinding(OWNER, input({ consumerKind: 'benchmark_prompt', consumerId: 601, idempotencyKey: 'bind-prompt-0001', expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)

    expect(dataset).toMatchObject({ replayed: false, binding: { consumerKind: 'geo_dataset', consumerId: 501, consumerVersion: HASH, consumerContentHash: HASH, subjectKind: 'entity', subjectId: entity.id, revisionId: firstHead.id, revisionNumber: firstHead.revisionNumber, revisionContentHash: firstHead.contentHash, revisionFingerprint: firstHead.revisionFingerprint, operation: 'bind', sequenceNumber: 1 } })
    expect(prompt).toMatchObject({ binding: { consumerKind: 'benchmark_prompt', consumerId: 601, consumerVersion: '3', consumerContentHash: PROMPT_HASH, revisionId: firstHead.id, revisionContentHash: firstHead.contentHash, revisionFingerprint: firstHead.revisionFingerprint } })
    expect(repository.allRows()).toHaveLength(2)
    expect(await knowledge.getRevisionHead(OWNER, { kind: 'entity', id: entity.id })).toMatchObject({ canonicalSnapshot: firstHead.canonicalSnapshot })
  })

  it('rejects client owner/hash/version authority and unknown fields before mutation', async () => {
    const { repository, firstHead } = await fixture()
    const valid = input({ expectedRevisionFingerprint: firstHead.revisionFingerprint })
    for (const forged of [
      { ...valid, ownerUserId: OWNER },
      { ...valid, consumerContentHash: HASH },
      { ...valid, revisionContentHash: HASH },
      { ...valid, consumerVersion: 'forged-version' },
      { ...valid, unexpected: true },
    ]) {
      expect(() => parseKnowledgeConsumerBindingInput(forged)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
      await expectCode(mutateKnowledgeConsumerBinding(OWNER, forged, repository, NOW), 'INVALID_INPUT')
    }
    expect(repository.allRows()).toEqual([])
  })

  it('replays the same idempotency command without a second row and rejects key collisions', async () => {
    const { repository, firstHead } = await fixture()
    const command = input({ expectedRevisionFingerprint: firstHead.revisionFingerprint })
    const first = await mutateKnowledgeConsumerBinding(OWNER, command, repository, NOW)
    const replay = await mutateKnowledgeConsumerBinding(OWNER, command, repository, NOW)
    expect(replay).toMatchObject({ replayed: true, binding: { id: first.binding.id, bindingFingerprint: first.binding.bindingFingerprint } })
    expect(repository.allRows()).toHaveLength(1)

    await expectCode(mutateKnowledgeConsumerBinding(OWNER, { ...command, consumerId: 601, consumerKind: 'benchmark_prompt' }, repository, NOW), 'CONFLICT')
    expect(repository.allRows()).toHaveLength(1)
  })

  it('treats idempotency keys as case-sensitive across distinct binding subjects', async () => {
    const { repository, service, entity, firstHead } = await fixture()
    const first = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint, idempotencyKey: 'Case-Key-0001' }), repository, NOW)
    const other = await service.createEntity({ entityType: 'Organization', canonicalName: 'Second binding target' })
    if (other.status !== 'ok') throw new Error(other.reason)
    const secondHead = await repository.knowledge.getRevisionHead(OWNER, { kind: 'entity', id: other.value.entity.id })
    if (!secondHead) throw new Error('Expected second entity revision.')
    const second = await mutateKnowledgeConsumerBinding(OWNER, input({ subjectId: other.value.entity.id, expectedRevisionFingerprint: secondHead.revisionFingerprint, idempotencyKey: 'case-key-0001' }), repository, NOW)

    expect(first.binding.subjectId).toBe(entity.id)
    expect(second.binding.subjectId).toBe(other.value.entity.id)
    expect(repository.allRows().map(row => row.idempotencyKey)).toEqual(['Case-Key-0001', 'case-key-0001'])
  })

  it('uses compare-and-swap so concurrent competing bindings have one winner', async () => {
    const { repository, firstHead } = await fixture()
    const commands = [
      input({ expectedRevisionFingerprint: firstHead.revisionFingerprint, idempotencyKey: 'concurrent-bind-01' }),
      input({ expectedRevisionFingerprint: firstHead.revisionFingerprint, idempotencyKey: 'concurrent-bind-02' }),
    ]
    const results = await Promise.allSettled(commands.map(command => mutateKnowledgeConsumerBinding(OWNER, command, repository, NOW)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
    expect(repository.allRows()).toHaveLength(1)
  })

  it('rejects stale revision preconditions and a no-op bind without appending history', async () => {
    const { repository, service, entity, firstHead } = await fixture()
    const alias = await service.addAlias({ entityId: entity.id, alias: 'A changed entity state' })
    expect(alias.status).toBe('ok')
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW), 'CONFLICT')
    expect(repository.allRows()).toEqual([])

    const currentHead = await repository.knowledge.getRevisionHead(OWNER, { kind: 'entity', id: entity.id })
    if (!currentHead) throw new Error('Expected updated revision head.')
    const bound = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: currentHead.revisionFingerprint }), repository, NOW)
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: currentHead.revisionFingerprint, expectedBindingFingerprint: bound.binding.bindingFingerprint, idempotencyKey: 'bind-noop-0001' }), repository, NOW), 'CONFLICT')
    expect(repository.allRows()).toHaveLength(1)
  })

  it('keeps old pin history, reports stale impact after an alias edit, then repins the exact new head', async () => {
    const { knowledge, repository, service, entity, firstHead } = await fixture()
    const first = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    const alias = await service.addAlias({ entityId: entity.id, alias: 'New alias revision' })
    expect(alias.status).toBe('ok')
    const editedHead = await knowledge.getRevisionHead(OWNER, { kind: 'entity', id: entity.id })
    if (!editedHead) throw new Error('Expected alias revision head.')

    const staleSnapshot = await impactSnapshot(knowledge, repository)
    const stale = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: entity.id }, staleSnapshot).buckets.find(bucket => bucket.category === 'dataset')!
    expect(stale.state).toBe('complete')
    expect(stale.items).toMatchObject([{ id: 'geo_dataset:501', reasonCode: 'exact_registered_dependency_stale' }])
    expect(stale.items[0]!.lineage).toContainEqual({ kind: 'entity', id: entity.id, relation: 'registered_consumer_revision_pin', version: firstHead.revisionFingerprint, contentHash: firstHead.contentHash })

    const repinned = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: editedHead.revisionFingerprint, expectedBindingFingerprint: first.binding.bindingFingerprint, idempotencyKey: 'repin-entity-0001' }), repository, NOW)
    const freshSnapshot = await impactSnapshot(knowledge, repository)
    const fresh = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: entity.id }, freshSnapshot).buckets.find(bucket => bucket.category === 'dataset')!
    expect(repinned.binding).toMatchObject({ sequenceNumber: 2, previousBindingFingerprint: first.binding.bindingFingerprint, revisionFingerprint: editedHead.revisionFingerprint })
    expect(fresh.items).toMatchObject([{ reasonCode: 'exact_registered_dependency' }])
    expect(repository.allRows()).toHaveLength(2)
    expect(repository.allRows().map(row => row.revisionFingerprint)).toEqual([firstHead.revisionFingerprint, editedHead.revisionFingerprint])
  })

  it('fails closed when a predecessor has been removed, including on idempotent replay', async () => {
    const { repository, firstHead } = await fixture()
    const first = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    const command = input({ expectedRevisionFingerprint: firstHead.revisionFingerprint, idempotencyKey: 'repin-after-remove' })
    const head = first.binding.bindingFingerprint
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, { ...command, expectedBindingFingerprint: head, idempotencyKey: 'second-bind-0001' }, repository, NOW), 'CONFLICT')
    // A second bind at the same revision is a no-op conflict, so revoke first to make a real next sequence.
    const revoked = await mutateKnowledgeConsumerBinding(OWNER, input({ operation: 'revoke', expectedRevisionFingerprint: null, expectedBindingFingerprint: head, idempotencyKey: 'remove-revoke-0001' }), repository, NOW)
    repository.removeBinding(head)
    await expectCode(readKnowledgeConsumerCoverage(OWNER, repository), 'CORRUPT_STATE')
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, { ...command, expectedBindingFingerprint: null }, repository, NOW), 'CORRUPT_STATE')
    expect(revoked.binding.sequenceNumber).toBe(2)
  })

  it.each([
    ['content hash', { consumerContentHash: 'd'.repeat(64) }],
    ['sequence number', { sequenceNumber: 7 }],
  ])('rejects a stored binding with a tampered %s', async (_label, patch) => {
    const { repository, firstHead } = await fixture()
    const result = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    repository.tamperBinding(result.binding.id, patch)
    await expectCode(readKnowledgeConsumerCoverage(OWNER, repository), 'CORRUPT_STATE')
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint, idempotencyKey: 'tamper-readback' }), repository, NOW), 'CORRUPT_STATE')
  })

  it('revokes append-only and permits a later rebind against the new head', async () => {
    const { repository, service, entity, firstHead } = await fixture()
    const first = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    const revoked = await mutateKnowledgeConsumerBinding(OWNER, input({ operation: 'revoke', expectedRevisionFingerprint: null, expectedBindingFingerprint: first.binding.bindingFingerprint, idempotencyKey: 'revoke-entity-0001' }), repository, NOW)
    expect(revoked.binding).toMatchObject({ operation: 'revoke', sequenceNumber: 2, previousBindingFingerprint: first.binding.bindingFingerprint })
    expect((await readKnowledgeConsumerCoverage(OWNER, repository)).find(row => row.category === 'dataset')).toMatchObject({ state: 'complete', consumers: [] })

    await service.addAlias({ entityId: entity.id, alias: 'After revoke' })
    const head = await repository.knowledge.getRevisionHead(OWNER, { kind: 'entity', id: entity.id })
    if (!head) throw new Error('Expected current revision head.')
    const rebound = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: head.revisionFingerprint, expectedBindingFingerprint: revoked.binding.bindingFingerprint, idempotencyKey: 'rebind-entity-0001' }), repository, NOW)
    expect(rebound.binding).toMatchObject({ operation: 'bind', sequenceNumber: 3, previousBindingFingerprint: revoked.binding.bindingFingerprint })
    expect(repository.allRows().map(row => row.operation)).toEqual(['bind', 'revoke', 'bind'])
    expect((await readKnowledgeConsumerCoverage(OWNER, repository)).find(row => row.category === 'dataset')!.consumers).toHaveLength(1)
  })

  it('fails closed for missing or cross-owner native anchors and changed native hashes', async () => {
    const { repository, firstHead } = await fixture()
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, input({ consumerId: 999, expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW), 'NOT_FOUND')

    repository.addAnchor({ ownerUserId: OTHER_OWNER, consumerKind: 'geo_dataset', consumerId: 502, consumerVersion: 'other-owner-version', consumerContentHash: HASH })
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, input({ consumerId: 502, expectedRevisionFingerprint: firstHead.revisionFingerprint, idempotencyKey: 'cross-owner-0001' }), repository, NOW), 'CORRUPT_STATE')

    await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    repository.replaceAnchor({ ownerUserId: OWNER, consumerKind: 'geo_dataset', consumerId: 501, consumerVersion: HASH, consumerContentHash: 'c'.repeat(64) })
    await expectCode(readKnowledgeConsumerCoverage(OWNER, repository), 'CORRUPT_STATE')
  })

  it('preserves a deleted native consumer as stale impact until its binding is revoked', async () => {
    const { knowledge, repository, entity, firstHead } = await fixture()
    const bound = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    repository.removeAnchor('geo_dataset', 501)

    const missingSnapshot = await impactSnapshot(knowledge, repository)
    const missingCoverage = missingSnapshot.adapterCoverage.find(row => row.category === 'dataset')!
    expect(missingCoverage).toMatchObject({ state: 'complete', limitationCodes: expect.arrayContaining(['native_consumer_missing']), consumers: [{ nativeAvailability: 'missing', consumerId: 'geo_dataset:501' }] })
    const missingReport = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: entity.id }, missingSnapshot)
    expect(missingReport.buckets.find(bucket => bucket.category === 'dataset')!.items).toMatchObject([{ id: 'geo_dataset:501', reasonCode: 'exact_registered_dependency_stale' }])

    const revoked = await mutateKnowledgeConsumerBinding(OWNER, input({ operation: 'revoke', expectedRevisionFingerprint: null, expectedBindingFingerprint: bound.binding.bindingFingerprint, idempotencyKey: 'revoke-missing-0001' }), repository, NOW)
    expect(revoked.binding.operation).toBe('revoke')
    const afterRevoke = await readKnowledgeConsumerCoverage(OWNER, repository)
    expect(afterRevoke.find(row => row.category === 'dataset')!.consumers).toEqual([])
    expect(repository.allRows().map(row => row.operation)).toEqual(['bind', 'revoke'])
  })

  it('validates read coverage from batched authority maps without per-row authority lookups', async () => {
    const { repository, service, entity, firstHead } = await fixture()
    const first = await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    await service.addAlias({ entityId: entity.id, alias: 'Second bound revision' })
    const next = await repository.knowledge.getRevisionHead(OWNER, { kind: 'entity', id: entity.id })
    if (!next) throw new Error('Expected repin head.')
    await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: next.revisionFingerprint, expectedBindingFingerprint: first.binding.bindingFingerprint, idempotencyKey: 'batch-repin-0001' }), repository, NOW)

    let loaded: Awaited<ReturnType<NonNullable<KnowledgeConsumerBindingRepository['loadAuthorities']>>> | undefined
    const guardedKnowledge = new Proxy(repository.knowledge, {
      get(target, property) {
        if (property === 'getMutationEventForRevision') return () => { throw new Error('Individual event lookup must not run in batched coverage.') }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const guarded = new Proxy(repository, {
      get(target, property) {
        if (property === 'knowledge') return guardedKnowledge
        if (property === 'getNativeAnchor' || property === 'getBoundRevision' || property === 'getBindingByFingerprint') return () => { throw new Error(`Individual ${String(property)} lookup must not run in batched coverage.`) }
        if (property === 'loadAuthorities') return async (ownerUserId: number, rows: readonly KnowledgeConsumerBinding[]) => {
          const authorities = await target.loadAuthorities!(ownerUserId, rows)
          loaded = authorities
          return authorities
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as KnowledgeConsumerBindingRepository

    const coverage = await readKnowledgeConsumerCoverage(OWNER, guarded)
    expect(loaded).toBeDefined()
    expect(loaded!.predecessors.get(first.binding.bindingFingerprint)).toMatchObject({ bindingFingerprint: first.binding.bindingFingerprint, sequenceNumber: 1 })
    expect(loaded!.anchors.get('geo_dataset:501')).toMatchObject({ consumerVersion: HASH, consumerContentHash: HASH })
    expect(loaded!.revisions.get(next.id)).toMatchObject({ id: next.id, revisionFingerprint: next.revisionFingerprint })
    expect(loaded!.events.get(next.id)).toMatchObject({ revisionId: next.id, newRevisionFingerprint: next.revisionFingerprint })
    expect(coverage.find(row => row.category === 'dataset')!.consumers).toMatchObject([{ consumerId: 'geo_dataset:501', dependencies: expect.arrayContaining([{ kind: 'entity', id: entity.id, version: next.revisionNumber, contentHash: next.contentHash, revisionFingerprint: next.revisionFingerprint }]) }])
  })

  it('fails closed when native binding coverage exceeds the bounded limit', async () => {
    const { repository, firstHead } = await fixture()
    await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    repository.overflowCoverage()
    await expectCode(readKnowledgeConsumerCoverage(OWNER, repository), 'LIMIT_EXCEEDED')
  })

  it('uses the transaction-provided consumer coverage hook in impact preview', async () => {
    const { knowledge, repository, entity, firstHead } = await fixture()
    await mutateKnowledgeConsumerBinding(OWNER, input({ expectedRevisionFingerprint: firstHead.revisionFingerprint }), repository, NOW)
    let coverageReads = 0
    let transactionOptions: unknown
    const integrated = new Proxy(knowledge, {
      get(target, property) {
        if (property === 'transaction') return <T>(work: (tx: KnowledgeRepository) => Promise<T>, options?: Parameters<KnowledgeRepository['transaction']>[1]) => {
          transactionOptions = options
          return target.transaction(tx => work(new Proxy(tx, {
            get(inner, key) {
              if (key === 'listConsumerCoverage') return async (ownerUserId: number) => { coverageReads += 1; return readKnowledgeConsumerCoverage(ownerUserId, repository) }
              const value = Reflect.get(inner, key, inner) as unknown
              return typeof value === 'function' ? value.bind(inner) : value
            },
          }) as KnowledgeRepository), options)
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as KnowledgeRepository

    const report = await createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: entity.id }, integrated)
    expect(coverageReads).toBe(1)
    expect(transactionOptions).toEqual({ consistentReadOnly: true })
    expect(report.buckets.find(bucket => bucket.category === 'dataset')).toMatchObject({ state: 'complete', items: [{ id: 'geo_dataset:501' }] })
  })

  it('requires a durable Knowledge revision before binding and keeps receipts/coverage free of raw snapshots and prompt text', async () => {
    const knowledge = createInMemoryKnowledgeRepository()
    const legacyEntity = await knowledge.transaction(tx => tx.insertEntity({
      ownerUserId: OWNER, entityUid: 'legacy-no-revision', entityType: 'Organization', canonicalName: 'Legacy', slug: null,
      canonicalUri: null, canonicalUriHash: null, locale: null, summary: null, status: 'active', publicVisibility: 'private',
      mergedIntoEntityId: null, provenance: null, createdAt: NOW, updatedAt: NOW,
    }))
    const repository = new BindingMemoryRepository(knowledge)
    repository.addAnchor({ ownerUserId: OWNER, consumerKind: 'benchmark_prompt', consumerId: 601, consumerVersion: '3', consumerContentHash: PROMPT_HASH })
    await expectCode(mutateKnowledgeConsumerBinding(OWNER, input({ consumerKind: 'benchmark_prompt', consumerId: 601, subjectId: legacyEntity.id, expectedRevisionFingerprint: HASH, idempotencyKey: 'legacy-bind-0001' }), repository, NOW), 'REVISION_REQUIRED')
    expect(repository.allRows()).toEqual([])

    const active = await fixture()
    const receipt = await mutateKnowledgeConsumerBinding(OWNER, input({ consumerKind: 'benchmark_prompt', consumerId: 601, expectedRevisionFingerprint: active.firstHead.revisionFingerprint }), active.repository, NOW)
    const coverage = await readKnowledgeConsumerCoverage(OWNER, active.repository)
    const serialized = JSON.stringify({ receipt, coverage })
    expect(serialized).not.toContain('canonicalSnapshot')
    expect(serialized).not.toContain(PRIVATE_PROMPT)
    expect(receipt).not.toHaveProperty('binding.canonicalSnapshot')
    expect(coverage.find(row => row.category === 'benchmark_prompt')!.consumers[0]).not.toHaveProperty('promptText')
  })
})
