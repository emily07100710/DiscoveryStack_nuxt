import { describe, expect, it, vi } from 'vitest'
import { createInMemoryKnowledgeRepository, createKnowledgeService } from '../server/knowledge'
import { KnowledgeRevisionError, type KnowledgeRevisionSubject } from '../server/knowledge/revision-types'
import type { InMemoryKnowledgeRepository, KnowledgeRepository, KnowledgeTransactionOptions } from '../server/knowledge/types'

const OWNER = 73
const HASH = 'a'.repeat(64)
const NOW = new Date('2026-09-10T12:00:00.000Z')

function fixture() {
  const repository = createInMemoryKnowledgeRepository([{ ownerUserId: OWNER, briefId: 10, jobId: 20, draftId: 30, title: 'A bounded draft', language: 'en', contentType: 'article', contentHash: HASH, draftCreatedAt: NOW }])
  const service = createKnowledgeService({ ownerUserId: OWNER, repository, now: () => NOW, entityUid: (() => { let id = 0; return () => `entity-${++id}` })() })
  return { repository, service }
}

async function createEntity(service: ReturnType<typeof createKnowledgeService>, name: string, overrides: Partial<Parameters<typeof service.createEntity>[0]> = {}) {
  const result = await service.createEntity({ entityType: 'Organization', canonicalName: name, ...overrides })
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.value.entity
}

async function history(repository: ReturnType<typeof createInMemoryKnowledgeRepository>, kind: KnowledgeRevisionSubject['kind'], id: number) {
  return repository.listRevisions(OWNER, { kind, id })
}

describe('Knowledge immutable revision audit', () => {
  it('records entity creation and alias/external-id writes in stable subject revisions with a paired event', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service, 'Northwind', {
      aliases: [{ alias: 'North Wind' }],
      externalIds: [{ idType: 'wikidata', idValue: 'Q12' }],
    })
    const first = await history(repository, 'entity', entity.id)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ revisionNumber: 1, revisionKind: 'mutation', operations: ['insertEntity', 'insertEntityAlias', 'insertEntityExternalId'] })
    expect(JSON.parse(first[0]!.canonicalSnapshot)).toMatchObject({ kind: 'entity', subject: { id: entity.id }, aliases: [{ alias: 'North Wind' }] })
    await expect(repository.listMutationEvents(OWNER, { kind: 'entity', id: entity.id })).resolves.toMatchObject([{ revisionId: first[0]!.id, newRevisionFingerprint: first[0]!.revisionFingerprint }])

    await service.addAlias({ entityId: entity.id, alias: 'Northwind Labs' })
    const revisions = await history(repository, 'entity', entity.id)
    expect(revisions).toHaveLength(2)
    expect(revisions[0]).toMatchObject({ revisionNumber: 2, previousRevisionFingerprint: revisions[1]!.revisionFingerprint, operations: ['insertEntityAlias'] })
  })

  it('captures claim/entity link and evidence/status changes while source versions remain source revisions', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service, 'Acme')
    const sourceResult = await service.registerSource({ canonicalUrl: 'https://example.com/research', sourceClass: 'academic / peer-reviewed' })
    expect(sourceResult.status).toBe('ok')
    if (sourceResult.status !== 'ok') return
    const versionResult = await service.addSourceVersion({ sourceId: sourceResult.value.id, contentHash: HASH, retrievedAt: NOW })
    expect(versionResult.status).toBe('ok')
    if (versionResult.status !== 'ok') return
    const claimResult = await service.createClaim({ statement: 'Acme measured a value.', claimType: 'first-party measurements', entityIds: [entity.id] })
    expect(claimResult.status).toBe('ok')
    if (claimResult.status !== 'ok') return
    const claimId = claimResult.value.id
    expect(await history(repository, 'claim', claimId)).toHaveLength(1)
    expect(await history(repository, 'entity', entity.id)).toHaveLength(2)

    const evidence = await service.addEvidence({ claimId, sourceVersionId: versionResult.value.id, relation: 'supports', locator: 'table 2', contentHash: HASH })
    expect(evidence.status).toBe('ok')
    const claimRevisions = await history(repository, 'claim', claimId)
    expect(claimRevisions).toHaveLength(2)
    expect(claimRevisions[0]!.operations).toEqual(['insertClaimEvidence', 'updateClaim'])
    expect(await history(repository, 'source', sourceResult.value.id)).toHaveLength(2)
  })

  it('records reversible merge and claim retraction transitions', async () => {
    const { repository, service } = fixture()
    const source = await createEntity(service, 'Merged Org')
    const target = await createEntity(service, 'Canonical Org')
    const merge = await service.mergeEntities({ sourceEntityId: source.id, targetEntityId: target.id, reason: 'Owner confirmed same entity.' })
    expect(merge.status).toBe('ok')
    const sourceAfterMerge = await history(repository, 'entity', source.id)
    expect(sourceAfterMerge[0]).toMatchObject({ operations: ['updateEntity'], revisionNumber: 2 })
    if (merge.status !== 'ok') return
    expect((await service.undoMerge({ mergeEventId: merge.value.id, reason: 'Owner reversed decision.' })).status).toBe('ok')
    expect((await history(repository, 'entity', source.id))[0]).toMatchObject({ revisionNumber: 3 })

    const claimResult = await service.createClaim({ statement: 'A material statement.', claimType: 'research findings', entityIds: [target.id] })
    expect(claimResult.status).toBe('ok')
    if (claimResult.status !== 'ok') return
    expect((await service.transitionClaim({ claimId: claimResult.value.id, toStatus: 'retracted', reason: 'No longer supported.' })).status).toBe('ok')
    expect((await history(repository, 'claim', claimResult.value.id))[0]).toMatchObject({ operations: ['updateClaim'] })
  })

  it('revises both old and new publisher entities and treats duplicate aliases as no-ops', async () => {
    const { repository, service } = fixture()
    const first = await createEntity(service, 'Publisher One')
    const second = await createEntity(service, 'Publisher Two')
    expect((await service.setPublisherEntity({ organizationEntityId: first.id })).status).toBe('ok')
    expect((await service.setPublisherEntity({ organizationEntityId: second.id })).status).toBe('ok')
    expect((await history(repository, 'entity', first.id))[0]).toMatchObject({ operations: ['upsertPublisherSetting'] })
    expect((await history(repository, 'entity', second.id))[0]).toMatchObject({ operations: ['upsertPublisherSetting'] })
    const before = await history(repository, 'entity', first.id)
    await service.addAlias({ entityId: first.id, alias: 'Friendly Alias' })
    const withAlias = await history(repository, 'entity', first.id)
    expect((await service.addAlias({ entityId: first.id, alias: 'Friendly Alias' })).status).toBe('ok')
    expect(await history(repository, 'entity', first.id)).toHaveLength(withAlias.length)
    expect(withAlias.length).toBe(before.length + 1)
  })

  it('records content-link add/remove by exact entity and preserves rejected external-id review candidates', async () => {
    const { repository, service } = fixture()
    const linked = await createEntity(service, 'Linked Entity')
    expect((await service.linkContentEntity({ briefId: 10, entityId: linked.id, role: 'about' })).status).toBe('ok')
    expect((await history(repository, 'entity', linked.id))[0]).toMatchObject({ operations: ['insertContentEntityLink'], revisionNumber: 2 })
    expect((await service.unlinkContentEntity({ briefId: 10, entityId: linked.id, role: 'about' })).status).toBe('ok')
    expect((await history(repository, 'entity', linked.id))[0]).toMatchObject({ operations: ['deleteContentEntityLink'], revisionNumber: 3 })

    const ownerOfExternalId = await createEntity(service, 'Existing External ID', { externalIds: [{ idType: 'wikidata', idValue: 'Q909' }] })
    const candidate = await createEntity(service, 'Review Candidate')
    const result = await service.addExternalId({ entityId: candidate.id, idType: 'wikidata', idValue: 'Q909' })
    expect(result).toMatchObject({ status: 'rejected', code: 'DUPLICATE_ENTITY', existingEntityId: ownerOfExternalId.id })
    expect(await history(repository, 'entity', candidate.id)).toHaveLength(1)
    expect(await repository.listMergeCandidates(OWNER, 'pending')).toHaveLength(1)
  })

  it('adds an explicit legacy baseline before the first changed revision', async () => {
    const { repository, service } = fixture()
    const legacy = await repository.transaction(async tx => tx.insertEntity({
      ownerUserId: OWNER, entityUid: 'legacy-entity', entityType: 'Organization', canonicalName: 'Legacy', slug: null,
      canonicalUri: null, canonicalUriHash: null, locale: null, summary: null, status: 'active', publicVisibility: 'private',
      mergedIntoEntityId: null, provenance: null, createdAt: NOW, updatedAt: NOW,
    }))
    expect((await service.addAlias({ entityId: legacy.id, alias: 'Previously known as Legacy' })).status).toBe('ok')
    const revisions = await history(repository, 'entity', legacy.id)
    expect([...revisions].reverse().map(item => [item.revisionNumber, item.revisionKind, item.operations])).toEqual([
      [1, 'legacy_baseline', ['legacy_baseline']], [2, 'mutation', ['insertEntityAlias']],
    ])
    expect(await repository.listMutationEvents(OWNER, { kind: 'entity', id: legacy.id })).toHaveLength(2)
  })

  it('rejects an out-of-band head drift instead of silently advancing the revision chain', async () => {
    const { repository, service } = fixture()
    const entity = await createEntity(service, 'Drift Check')
    await repository.transaction(async tx => { await tx.updateEntity(OWNER, entity.id, { status: 'retired' }) })
    await expect(service.addAlias({ entityId: entity.id, alias: 'Drifted' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await repository.listEntityAliases(OWNER, entity.id)).toHaveLength(0)
    expect(await history(repository, 'entity', entity.id)).toHaveLength(1)
  })

  it('rolls back a domain mutation if appending its paired event fails', async () => {
    const base = createInMemoryKnowledgeRepository()
    const repository = new Proxy(base, {
      get(target, property) {
        if (property === 'transaction') return <T>(work: (transaction: KnowledgeRepository) => Promise<T>, options?: KnowledgeTransactionOptions) => target.transaction(transaction => work(new Proxy(transaction, {
          get(tx, key) {
            if (key === 'appendMutationEvent') return vi.fn().mockRejectedValue(new KnowledgeRevisionError('REVISION_CONFLICT'))
            const value = Reflect.get(tx, key, tx) as unknown
            return typeof value === 'function' ? value.bind(tx) : value
          },
        }) as KnowledgeRepository), options)
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as InMemoryKnowledgeRepository
    const service = createKnowledgeService({ ownerUserId: OWNER, repository, now: () => NOW, entityUid: () => 'entity-rollback' })
    await expect(createEntity(service, 'Must Roll Back')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await repository.listEntities(OWNER)).toHaveLength(0)
    expect(await repository.listRevisions(OWNER, { kind: 'entity', id: 1 })).toHaveLength(0)
  })
})
