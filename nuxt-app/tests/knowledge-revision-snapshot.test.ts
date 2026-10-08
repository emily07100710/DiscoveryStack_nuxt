import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createInMemoryKnowledgeRepository } from '../server/knowledge/repository'
import { buildKnowledgeRevisionSnapshot, KnowledgeRevisionSnapshotError } from '../server/knowledge/revision-snapshot'
import type { KnowledgeRepository } from '../server/knowledge/types'

const owner = 71
const otherOwner = 72
const now = new Date('2025-04-05T06:07:08.123Z')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const base = (ownerUserId = owner) => ({ ownerUserId, createdAt: new Date(now), updatedAt: new Date(now) })

async function addEntity(repository: ReturnType<typeof createInMemoryKnowledgeRepository>, ownerUserId = owner, overrides: Record<string, unknown> = {}) {
  return repository.insertEntity({
    ...base(ownerUserId), entityUid: `entity-${ownerUserId}`, entityType: 'Organization', canonicalName: 'Same name', slug: 'same-name',
    canonicalUri: 'https://example.test/org', canonicalUriHash: hash('https://example.test/org'), locale: 'en', summary: 'A short semantic summary',
    status: 'active', publicVisibility: 'private', mergedIntoEntityId: null, provenance: { authority: 'synthetic', notes: 'hidden entity provenance' },
    ...overrides,
  } as Parameters<typeof repository.insertEntity>[0])
}

async function addSource(repository: ReturnType<typeof createInMemoryKnowledgeRepository>, ownerUserId = owner, overrides: Record<string, unknown> = {}) {
  return repository.insertSource({
    ...base(ownerUserId), canonicalUrl: 'https://source.test/article?private=synthetic', urlHash: hash('source-url'), title: 'Synthetic source title',
    sourceClass: 'government', status: 'active', notes: 'private source review note', ...overrides,
  } as Parameters<typeof repository.insertSource>[0])
}

async function addClaim(repository: ReturnType<typeof createInMemoryKnowledgeRepository>, ownerUserId = owner, overrides: Record<string, unknown> = {}) {
  return repository.insertClaim({
    ...base(ownerUserId), statement: 'The synthetic claim is stable.', claimType: 'statistics', status: 'unverified',
    validFrom: null, validTo: null, ...overrides,
  } as Parameters<typeof repository.insertClaim>[0])
}

function reverseRepository(repository: KnowledgeRepository, methods: readonly (keyof KnowledgeRepository)[]): KnowledgeRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (methods.includes(property as keyof KnowledgeRepository) && typeof value === 'function') {
        return async (...args: unknown[]) => {
          const rows = await Reflect.apply(value, target, args) as unknown[]
          return rows.reverse()
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function expectSnapshotError(action: Promise<unknown>, code: KnowledgeRevisionSnapshotError['code']) {
  return expect(action).rejects.toMatchObject({ name: 'KnowledgeRevisionSnapshotError', code })
}

describe('knowledge subject revision snapshot', () => {
  it('builds stable owner-scoped entity semantics independent of row order and audit timestamps', async () => {
    const repository = createInMemoryKnowledgeRepository([{
      ...base(), briefId: 810, jobId: 910, draftId: 1010, title: 'Draft title', language: 'en', contentType: 'article',
      contentHash: hash('draft-body'), draftCreatedAt: new Date('2025-04-01T00:00:00.000Z'),
    }])
    const entity = await addEntity(repository)
    const homonym = await addEntity(repository, owner, { entityUid: 'homonym-uid', canonicalName: 'Same name', slug: 'same-name-2' })
    const claim = await addClaim(repository)
    await repository.insertEntityAlias({ ...base(), entityId: entity.id, alias: 'First alias', aliasNormalized: 'first alias', locale: 'en' })
    await repository.insertEntityAlias({ ...base(), entityId: entity.id, alias: 'Second alias', aliasNormalized: 'second alias', locale: null })
    await repository.insertEntityExternalId({ ...base(), entityId: entity.id, idType: 'synthetic', idValue: 'identifier-1' })
    await repository.insertClaimEntityLink({ ...base(), claimId: claim.id, entityId: entity.id })
    await repository.insertClaimEntityLink({ ...base(), claimId: claim.id, entityId: homonym.id })
    await repository.insertContentEntityLink({ ...base(), briefId: 810, entityId: entity.id, role: 'author' })

    const original = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: entity.id })
    const reverse = reverseRepository(repository, ['listEntityAliases', 'listEntityExternalIds', 'listClaimEntityLinks', 'listContentEntityLinks', 'listContentAnchors'])
    const reordered = await buildKnowledgeRevisionSnapshot(reverse, owner, { kind: 'entity', id: entity.id })
    expect(reordered).toEqual(original)
    expect(original.contentHash).toBe(hash(original.canonicalSnapshot))
    expect(original.canonicalSnapshot).not.toContain('createdAt')
    expect(original.canonicalSnapshot).not.toContain('updatedAt')
    expect(original.canonicalSnapshot).not.toContain('private=synthetic')

    const parsed = JSON.parse(original.canonicalSnapshot) as { ownerUserId: number; claimEntityLinks: Array<{ entityId: number }>; contentEntityLinks: Array<Record<string, unknown>> }
    expect(parsed.ownerUserId).toBe(owner)
    expect(parsed.claimEntityLinks.map(row => row.entityId)).toEqual([entity.id])
    expect(parsed.contentEntityLinks).toHaveLength(1)
    expect(parsed.contentEntityLinks[0]).not.toHaveProperty('createdAt')
    expect(parsed.contentEntityLinks[0]).not.toHaveProperty('ownerUserId')

    repository.seedContentAnchor({
      ...base(), briefId: 810, jobId: 910, draftId: 1010, title: 'Revised draft title', language: 'en', contentType: 'article',
      contentHash: hash('revised-draft-body'), draftCreatedAt: new Date('2026-04-01T00:00:00.000Z'),
    })
    expect(await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: entity.id })).toEqual(original)
    await repository.updateEntity(owner, entity.id, { updatedAt: new Date('2030-01-01T00:00:00.000Z') })
    expect(await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: entity.id })).toEqual(original)
  })

  it('binds claims to their exact entities and source-version evidence without exposing review material', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const source = await addSource(repository)
    const version = await repository.insertSourceVersion({
      ...base(), sourceId: source.id, versionNumber: 1, contentHash: hash('version'), retrievedAt: new Date('2025-04-04T00:00:00.000Z'),
      excerpt: 'DO NOT EXPOSE THIS EXCERPT', metadata: { crawl: 'synthetic', privateToken: 'DO NOT EXPOSE METADATA' },
    })
    const entity = await addEntity(repository)
    const claim = await addClaim(repository, owner, { validFrom: new Date('2025-01-01T00:00:00.000Z') })
    await repository.insertClaimEntityLink({ ...base(), claimId: claim.id, entityId: entity.id })
    await repository.insertClaimEvidence({
      ...base(), claimId: claim.id, sourceVersionId: version.id, relation: 'supports', locator: 'private locator text',
      locatorHash: hash('locator'), contentHash: hash('version'), reviewNotes: 'DO NOT EXPOSE REVIEW NOTES',
    })
    const first = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'claim', id: claim.id })
    const reverse = reverseRepository(repository, ['listClaimEntityLinks', 'listClaimEvidence'])
    expect(await buildKnowledgeRevisionSnapshot(reverse, owner, { kind: 'claim', id: claim.id })).toEqual(first)
    for (const secret of ['DO NOT EXPOSE THIS EXCERPT', 'DO NOT EXPOSE METADATA', 'DO NOT EXPOSE REVIEW NOTES', 'private locator text', 'private=synthetic']) {
      expect(first.canonicalSnapshot).not.toContain(secret)
    }
    const changedSourceMetadata = new Proxy(repository as KnowledgeRepository, {
      get(target, property, receiver) {
        if (property === 'getSource') return async (_owner: number, sourceId: number) => {
          const row = await repository.getSource(owner, sourceId)
          return row ? { ...row, title: 'Mutable title changed', sourceClass: 'blog' as const, notes: 'Mutable notes changed' } : null
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect(await buildKnowledgeRevisionSnapshot(changedSourceMetadata, owner, { kind: 'claim', id: claim.id })).toEqual(first)
    await repository.updateClaim(owner, claim.id, { status: 'source_backed', updatedAt: new Date('2030-01-01T00:00:00.000Z') })
    const changed = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'claim', id: claim.id })
    expect(changed.contentHash).not.toBe(first.contentHash)
    await repository.updateClaim(owner, claim.id, { status: 'unverified', updatedAt: new Date('2040-01-01T00:00:00.000Z') })
    expect(await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'claim', id: claim.id })).toEqual(first)
  })

  it('hashes source version semantics and hidden metadata but omits source text and audit timestamps', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const source = await addSource(repository)
    await repository.insertSourceVersion({
      ...base(), sourceId: source.id, versionNumber: 2, contentHash: hash('v2'), retrievedAt: new Date('2025-04-04T00:00:00.000Z'),
      excerpt: 'EXCERPT MUST REMAIN HIDDEN', metadata: { extractor: 'synthetic-v2' },
    })
    await repository.insertSourceVersion({
      ...base(), sourceId: source.id, versionNumber: 1, contentHash: hash('v1'), retrievedAt: new Date('2025-04-03T00:00:00.000Z'),
      excerpt: 'OLDER EXCERPT MUST REMAIN HIDDEN', metadata: { extractor: 'synthetic-v1' },
    })
    const result = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'source', id: source.id })
    const reverse = reverseRepository(repository, ['listSourceVersions'])
    expect(await buildKnowledgeRevisionSnapshot(reverse, owner, { kind: 'source', id: source.id })).toEqual(result)
    expect(result.canonicalSnapshot).not.toContain('EXCERPT MUST REMAIN HIDDEN')
    expect(result.canonicalSnapshot).not.toContain('OLDER EXCERPT MUST REMAIN HIDDEN')
    expect(result.canonicalSnapshot).not.toContain('private=synthetic')
    expect(result.canonicalSnapshot).not.toContain('createdAt')
    const parsed = JSON.parse(result.canonicalSnapshot) as { sourceVersions: Array<{ versionNumber: number }> }
    expect(parsed.sourceVersions.map(version => version.versionNumber)).toEqual([1, 2])
  })

  it('includes explicit publisher settings and merge redirects without inferring identity from names', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const organization = await addEntity(repository, owner, { entityUid: 'publisher-org', canonicalName: 'Publisher' })
    const merged = await addEntity(repository, owner, {
      entityUid: 'merged-entity', canonicalName: 'Former label', status: 'merged', mergedIntoEntityId: organization.id,
    })
    await repository.upsertPublisherSetting({ ...base(), organizationEntityId: organization.id })
    const first = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: merged.id })
    const parsed = JSON.parse(first.canonicalSnapshot) as {
      mergeRedirect: { directTargetId: number | null }
      publisherSetting: { selected: boolean; settingId: number | null }
    }
    expect(parsed.mergeRedirect.directTargetId).toBe(organization.id)
    expect(parsed.publisherSetting).toEqual({ selected: false, settingId: null })

    const selectedSnapshot = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: organization.id })
    const selectedBody = JSON.parse(selectedSnapshot.canonicalSnapshot) as { publisherSetting: { selected: boolean; settingId: number | null } }
    expect(selectedBody.publisherSetting).toEqual({ selected: true, settingId: 1 })

    const changedTarget = new Proxy(repository as KnowledgeRepository, {
      get(target, property, receiver) {
        if (property === 'getEntity') return async (ownerUserId: number, entityId: number) => {
          const row = await repository.getEntity(ownerUserId, entityId)
          return row && entityId === organization.id ? { ...row, canonicalName: 'Changed target name', summary: 'Changed target summary' } : row
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect(await buildKnowledgeRevisionSnapshot(changedTarget, owner, { kind: 'entity', id: merged.id })).toEqual(first)

    const otherOrganization = await addEntity(repository, owner, { entityUid: 'other-publisher', canonicalName: 'Another org' })
    await repository.upsertPublisherSetting({ ...base(), organizationEntityId: otherOrganization.id })
    expect(await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: merged.id })).toEqual(first)
    expect((await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: organization.id })).contentHash).not.toBe(selectedSnapshot.contentHash)
  })

  it('requests each subject collection with the 2001-row overflow sentinel', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const entity = await addEntity(repository)
    const requestedLimits: number[] = []
    const observed = new Proxy(repository as KnowledgeRepository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown
        if (typeof property === 'string' && property.startsWith('list') && typeof value === 'function') {
          return (...args: unknown[]) => {
            requestedLimits.push(args[args.length - 1] as number)
            return Reflect.apply(value, target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await buildKnowledgeRevisionSnapshot(observed, owner, { kind: 'entity', id: entity.id })
    expect(requestedLimits.length).toBeGreaterThan(0)
    expect(requestedLimits.every(limit => limit === 2001)).toBe(true)
  })

  it('fails closed on missing subjects, cross-owner references, invalid dates, and merge cycles', async () => {
    const repository = createInMemoryKnowledgeRepository()
    await addEntity(repository, otherOwner)
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'entity', id: 1 }), 'SUBJECT_NOT_FOUND')
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(repository, 73, { kind: 'entity', id: 1 }), 'SUBJECT_NOT_FOUND')
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(repository, 0, { kind: 'entity', id: 1 }), 'CORRUPT_STATE')

    const claim = await addClaim(repository)
    await repository.insertClaimEntityLink({ ...base(), claimId: claim.id, entityId: 9999 })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'claim', id: claim.id }), 'CORRUPT_STATE')

    const badDateRepo = createInMemoryKnowledgeRepository()
    const bad = await addClaim(badDateRepo, owner, { validTo: new Date(Number.NaN) })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(badDateRepo, owner, { kind: 'claim', id: bad.id }), 'CORRUPT_STATE')

    const cycleRepo = createInMemoryKnowledgeRepository()
    const left = await addEntity(cycleRepo, owner, { status: 'merged', mergedIntoEntityId: 2 })
    const right = await addEntity(cycleRepo, owner, { entityUid: 'right', status: 'merged', mergedIntoEntityId: 1 })
    expect(left.id).toBe(1)
    expect(right.id).toBe(2)
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(cycleRepo, owner, { kind: 'entity', id: left.id }), 'CORRUPT_STATE')
  })

  it('fails on corrupt owner-scoped query rows, list overflow, and oversized UTF-8 snapshots', async () => {
    const mismatchRepo = createInMemoryKnowledgeRepository()
    const entity = await addEntity(mismatchRepo)
    await mismatchRepo.insertEntityAlias({ ...base(), entityId: entity.id, alias: 'valid', aliasNormalized: 'valid', locale: null })
    const mismatched = new Proxy(mismatchRepo as KnowledgeRepository, {
      get(target, property, receiver) {
        if (property === 'listEntityAliases') return async () => [{
          ...base(otherOwner), id: 77, entityId: entity.id, alias: 'foreign', aliasNormalized: 'foreign', locale: null,
        }]
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(mismatched, owner, { kind: 'entity', id: entity.id }), 'CORRUPT_STATE')

    const overflowRepo = createInMemoryKnowledgeRepository()
    const overflowEntity = await addEntity(overflowRepo)
    for (let index = 0; index <= 2000; index += 1) {
      await overflowRepo.insertEntityAlias({ ...base(), entityId: overflowEntity.id, alias: `a-${index}`, aliasNormalized: `a-${index}`, locale: null })
    }
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(overflowRepo, owner, { kind: 'entity', id: overflowEntity.id }), 'LIMIT_EXCEEDED')

    const largeRepo = createInMemoryKnowledgeRepository()
    const largeClaim = await addClaim(largeRepo, owner, { statement: '字'.repeat(30_000) })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(largeRepo, owner, { kind: 'claim', id: largeClaim.id }), 'LIMIT_EXCEEDED')

    const deepRepo = createInMemoryKnowledgeRepository()
    let deep: Record<string, unknown> = {}
    const provenance = deep
    for (let index = 0; index < 25; index += 1) {
      deep.child = {}
      deep = deep.child as Record<string, unknown>
    }
    const deepEntity = await addEntity(deepRepo, owner, { provenance })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(deepRepo, owner, { kind: 'entity', id: deepEntity.id }), 'LIMIT_EXCEEDED')

    const nodesRepo = createInMemoryKnowledgeRepository()
    const nodesEntity = await addEntity(nodesRepo, owner, { provenance: Array.from({ length: 20_001 }, () => null) })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(nodesRepo, owner, { kind: 'entity', id: nodesEntity.id }), 'LIMIT_EXCEEDED')

    const cyclicRepo = createInMemoryKnowledgeRepository()
    const cyclicProvenance: Record<string, unknown> = {}
    cyclicProvenance.self = cyclicProvenance
    const cyclicEntity = await addEntity(cyclicRepo, owner, { provenance: cyclicProvenance })
    await expectSnapshotError(buildKnowledgeRevisionSnapshot(cyclicRepo, owner, { kind: 'entity', id: cyclicEntity.id }), 'CORRUPT_STATE')
  })

  it('detects hidden semantic changes and propagates storage failures without disguising them', async () => {
    const repository = createInMemoryKnowledgeRepository()
    const source = await addSource(repository)
    const version = await repository.insertSourceVersion({
      ...base(), sourceId: source.id, versionNumber: 1, contentHash: hash('version'), retrievedAt: new Date('2025-04-04T00:00:00.000Z'),
      excerpt: 'same excerpt', metadata: { revision: 1 },
    })
    const first = await buildKnowledgeRevisionSnapshot(repository, owner, { kind: 'source', id: source.id })
    const modified = new Proxy(repository as KnowledgeRepository, {
      get(target, property, receiver) {
        if (property === 'listSourceVersions') return async (_owner: number, _sourceId?: number, limit?: number) => [{
          ...version, metadata: { revision: 2 }, createdAt: new Date('2030-01-01T00:00:00.000Z'), updatedAt: new Date('2030-01-02T00:00:00.000Z'),
        }].slice(0, limit)
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect((await buildKnowledgeRevisionSnapshot(modified, owner, { kind: 'source', id: source.id })).contentHash).not.toBe(first.contentHash)

    const storageFailure = new Error('synthetic repository transport failure')
    const failing = new Proxy(repository as KnowledgeRepository, {
      get(target, property, receiver) {
        if (property === 'listSourceVersions') return async () => { throw storageFailure }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(buildKnowledgeRevisionSnapshot(failing, owner, { kind: 'source', id: source.id })).rejects.toBe(storageFailure)
  })
})
