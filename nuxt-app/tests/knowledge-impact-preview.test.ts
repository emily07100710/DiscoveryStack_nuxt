import { createEvent } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeRepository } from '../server/knowledge/types'
import {
  createKnowledgeImpactPreview,
  parseKnowledgeImpactSubject,
} from '../server/knowledge/impact-preview'
import { createNativeKnowledgeImpactCoverage, resolveKnowledgeImpact } from '../server/knowledge/impact-resolver'
import { KnowledgeImpactError, type KnowledgeImpactSnapshot } from '../server/knowledge/impact-types'

const helperMocks = vi.hoisted(() => ({
  requireKnowledgeOwner: vi.fn(),
  setKnowledgePrivateApiHeaders: vi.fn(),
  createPreview: vi.fn(),
}))
vi.mock('../server/api/knowledge/_helpers', () => helperMocks)

const OWNER = 17
const OTHER_OWNER = 29
const now = new Date('2026-10-08T02:00:00.000Z')
function eventWithUrl(url: string) { return createEvent({ url } as never, {} as never) }

function entity(id: number, ownerUserId = OWNER) {
  return { id, ownerUserId, entityUid: `uid-${id}`, entityType: 'Organization', canonicalName: 'PRIVATE ENTITY NAME', slug: null, canonicalUri: 'https://private.invalid/entity', canonicalUriHash: 'a'.repeat(64), locale: 'en', summary: 'PRIVATE SUMMARY', status: 'active', publicVisibility: 'private', mergedIntoEntityId: null, provenance: null, createdAt: now, updatedAt: now } as const
}
function source(id: number, ownerUserId = OWNER) {
  return { id, ownerUserId, canonicalUrl: 'https://private.invalid/source', urlHash: 'f'.repeat(64), title: 'PRIVATE SOURCE TITLE', sourceClass: 'official documentation', status: 'active', notes: 'PRIVATE NOTES', createdAt: now, updatedAt: now } as const
}
type MutableSnapshot = { -readonly [Key in keyof KnowledgeImpactSnapshot]: KnowledgeImpactSnapshot[Key] }
function emptySnapshot(): MutableSnapshot {
  return {
    entities: [], aliases: [], externalIds: [], sources: [], sourceVersions: [], claims: [], claimEntityLinks: [], evidence: [], contentLinks: [], publisher: null,
    contentAnchors: [], adapterCoverage: createNativeKnowledgeImpactCoverage(),
  }
}

function mockRepository(snapshot: KnowledgeImpactSnapshot, options: { overflow?: keyof KnowledgeImpactSnapshot; foreignIn?: keyof KnowledgeImpactSnapshot } = {}) {
  let active = false
  let transactionCount = 0
  const reads: string[] = []
  const writes: string[] = []
  const rows = (key: keyof KnowledgeImpactSnapshot) => {
    if (!active) throw new Error('read escaped transaction')
    reads.push(key)
    const value = snapshot[key]
    if (!Array.isArray(value)) return []
    if (options.overflow === key) return [...value, ...Array.from({ length: 2_001 - value.length }, (_, index) => ({ ...((value[0] ?? { id: 1, ownerUserId: OWNER }) as object), id: index + 1 }))]
    if (options.foreignIn === key && value.length) return [{ ...value[0], ownerUserId: OTHER_OWNER }, ...value.slice(1)]
    return value
  }
  const repo = {
    async transaction<T>(work: (tx: KnowledgeRepository) => Promise<T>, options?: { consistentReadOnly?: boolean }): Promise<T> {
      transactionCount += 1
      expect(options).toEqual({ consistentReadOnly: true })
      active = true
      try { return await work(repo as unknown as KnowledgeRepository) } finally { active = false }
    },
    async listEntities(_owner: number, limit?: number) { expect(limit).toBe(2_001); return rows('entities') },
    async listEntityAliases(_owner: number, _entityId?: number, limit?: number) { expect(limit).toBe(2_001); return rows('aliases') },
    async listEntityExternalIds(_owner: number, _entityId?: number, limit?: number) { expect(limit).toBe(2_001); return rows('externalIds') },
    async listSources(_owner: number, limit?: number) { expect(limit).toBe(2_001); return rows('sources') },
    async listSourceVersions(_owner: number, _sourceId?: number, limit?: number) { expect(limit).toBe(2_001); return rows('sourceVersions') },
    async listClaims(_owner: number, _status?: never, limit?: number) { expect(limit).toBe(2_001); return rows('claims') },
    async listClaimEntityLinks(_owner: number, _claimId?: number, limit?: number) { expect(limit).toBe(2_001); return rows('claimEntityLinks') },
    async listClaimEvidence(_owner: number, _claimId?: number, limit?: number) { expect(limit).toBe(2_001); return rows('evidence') },
    async listContentEntityLinks(_owner: number, _briefId?: number, limit?: number) { expect(limit).toBe(2_001); return rows('contentLinks') },
    async getPublisherSetting() { if (!active) throw new Error('read escaped transaction'); reads.push('publisher'); return snapshot.publisher },
    async listContentAnchors(_owner: number, limit?: number) { expect(limit).toBe(2_001); return rows('contentAnchors') },
    async listRevisionHeads(_owner: number, limit?: number) { expect(limit).toBe(2_001); return rows('revisionHeads') },
    async insertEntity() { writes.push('insert'); throw new Error('unexpected write') },
  }
  return { repo: repo as unknown as KnowledgeRepository, reads, writes, get transactionCount() { return transactionCount } }
}

describe('Knowledge Impact Preview runtime', () => {
  it('accepts only a strict typed subject and positive safe identifier', () => {
    expect(parseKnowledgeImpactSubject({ kind: 'source', id: '12' })).toEqual({ kind: 'source', id: 12 })
    for (const input of [null, [], { kind: 'source', id: '01' }, { kind: 'source', id: '1e2' }, { kind: 'source', id: '9007199254740992' }, { kind: 'entity', id: '1', ownerUserId: OWNER }, { kind: 'consumer', id: '1' }]) {
      expect(() => parseKnowledgeImpactSubject(input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    }
  })

  it('resolves only explicit owner content links and exact adapter dependencies without exposing private text', () => {
    const snapshot = emptySnapshot()
    snapshot.entities = [entity(3)] as never
    snapshot.sources = [source(8)] as never
    snapshot.contentLinks = [
      { id: 21, ownerUserId: OWNER, briefId: 5, entityId: 3, role: 'about', createdAt: now, updatedAt: now },
      { id: 22, ownerUserId: OWNER, briefId: 5, entityId: 3, role: 'mentions', createdAt: now, updatedAt: now },
    ] as never
    snapshot.contentAnchors = [{ ownerUserId: OWNER, briefId: 5, jobId: 7, draftId: 11, title: 'PRIVATE DRAFT TITLE', language: 'en', contentType: 'article', contentHash: 'b'.repeat(64), draftCreatedAt: now }]
    snapshot.adapterCoverage = createNativeKnowledgeImpactCoverage().map(coverage => coverage.category === 'dataset' ? { category: 'dataset', state: 'complete', scope: 'exact_registered_dependencies', limitationCodes: [], consumers: [
      { category: 'dataset', ownerUserId: OWNER, consumerId: 'opaque-consumer-1', version: 'v4', contentHash: 'c'.repeat(64), dependencies: [{ kind: 'entity', id: 3, version: null, contentHash: null }] },
      { category: 'dataset', ownerUserId: OWNER, consumerId: 'opaque-consumer-2', version: 'v1', contentHash: 'e'.repeat(64), dependencies: [{ kind: 'source', id: 8, version: 'v1', contentHash: 'f'.repeat(64) }] },
    ] } : coverage)
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 3 }, snapshot)
    expect(report.coverageScope).toBe('known_explicit_dependencies_only')
    expect(report.exhaustive).toBe(false)
    expect(report.automaticPublication).toBe(false)
    expect(report.productionActivation).toBe(false)
    expect(report.automaticTrainingAdmission).toBe(false)
    expect(report.buckets.map(bucket => bucket.category)).toEqual(['content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer'])
    expect(report.buckets[0]?.items.map(entry => entry.id)).toEqual(['11'])
    expect(report.buckets[0]?.items[0]?.lineage.map(entry => entry.relation)).toContain('content_entity_about')
    expect(report.buckets[0]?.items[0]?.lineage.map(entry => entry.relation)).toContain('content_entity_mentions')
    expect(report.buckets[1]?.items).toEqual([])
    expect(report.buckets[2]?.items.map(entry => entry.id)).toEqual(['opaque-consumer-1'])
    expect(report.buckets[2]?.items[0]?.reasonCode).toBe('exact_registered_dependency')
    expect(report.buckets[3]?.state).toBe('unconfigured')
    const output = JSON.stringify(report)
    expect(output).not.toContain('PRIVATE ENTITY NAME')
    expect(output).not.toContain('PRIVATE SUMMARY')
    expect(output).not.toContain('PRIVATE DRAFT TITLE')
    expect(output).not.toContain('PRIVATE SOURCE TITLE')
    expect(output).not.toContain('private.invalid')

    snapshot.contentLinks = [{ id: 23, ownerUserId: OWNER, briefId: 5, entityId: 3, role: 'author', createdAt: now, updatedAt: now }] as never
    const authorReport = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 3 }, snapshot)
    expect(authorReport.buckets[1]?.items).toHaveLength(1)
    expect(authorReport.buckets[1]?.items[0]?.id).toBe('11')
    expect(authorReport.buckets[1]?.items[0]?.contentHash).toBeNull()
    expect(authorReport.buckets[1]?.items[0]?.lineage.map(entry => entry.relation)).toContain('schema_author_input')
    snapshot.publisher = { id: 1, ownerUserId: OWNER, organizationEntityId: 3, createdAt: now, updatedAt: now }
    const publisherReport = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 3 }, snapshot)
    expect(publisherReport.buckets[1]?.items).toHaveLength(1)
    expect(publisherReport.buckets[1]?.items[0]?.lineage.map(entry => entry.relation)).toContain('schema_publisher_input')
  })

  it('reads all owner collections once inside one transaction and attaches anchor owner from that scope', async () => {
    const snapshot = emptySnapshot()
    snapshot.entities = [entity(2)] as never
    const fixture = mockRepository(snapshot)
    const report = await createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: 2 }, fixture.repo)
    expect(report.ownerUserId).toBe(OWNER)
    expect(fixture.transactionCount).toBe(1)
    expect(fixture.reads).toHaveLength(12)
    expect(new Set(fixture.reads).size).toBe(12)
    expect(fixture.writes).toEqual([])
  })

  it('does not disclose another owner subject and rejects corrupt foreign rows', async () => {
    const hiddenFixture = mockRepository(emptySnapshot())
    await expect(createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: 99 }, hiddenFixture.repo)).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' })
    await expect(createKnowledgeImpactPreview(OWNER, { kind: 'source', id: 99 }, hiddenFixture.repo)).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' })
    const hidden = emptySnapshot()
    hidden.entities = [entity(99, OTHER_OWNER)] as never
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, hidden)).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
    const foreignFixture = mockRepository({ ...emptySnapshot(), entities: [entity(1)] as never }, { foreignIn: 'entities' })
    await expect(createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: 1 }, foreignFixture.repo)).rejects.toMatchObject({ code: 'CORRUPT_GRAPH' })
  })

  it('fails closed at the 2001-row sentinel instead of returning a truncated preview', async () => {
    const fixture = mockRepository({ ...emptySnapshot(), entities: [entity(1)] as never }, { overflow: 'entities' })
    await expect(createKnowledgeImpactPreview(OWNER, { kind: 'entity', id: 1 }, fixture.repo)).rejects.toMatchObject({ code: 'SNAPSHOT_LIMIT_EXCEEDED' })
    expect(fixture.transactionCount).toBe(1)
  })

  it('treats claimed content bindings to a missing anchor as corrupt, never as no impact', () => {
    const snapshot = emptySnapshot()
    snapshot.entities = [entity(1)] as never
    snapshot.contentLinks = [{ id: 1, ownerUserId: OWNER, briefId: 44, entityId: 1, role: 'about', createdAt: now, updatedAt: now }] as never
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot)).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })
})

describe('Knowledge Impact Preview owner-private GET route', () => {
  beforeEach(() => {
    helperMocks.requireKnowledgeOwner.mockReset()
    helperMocks.setKnowledgePrivateApiHeaders.mockReset()
    helperMocks.createPreview.mockReset()
  })

  async function loadHandler() {
    vi.doMock('../server/knowledge/impact-preview', () => ({ parseKnowledgeImpactSubject, createKnowledgeImpactPreview: helperMocks.createPreview }))
    return (await import('../server/api/knowledge/impact-preview.get')).default
  }

  it('checks owner authority before rejecting caller-controlled owner or coverage query', async () => {
    helperMocks.requireKnowledgeOwner.mockRejectedValueOnce(Object.assign(new Error('Owner required.'), { statusCode: 401, statusMessage: 'Owner required.' }))
    const handler = await loadHandler()
    const event = eventWithUrl('/api/knowledge/impact-preview?kind=entity&id=1&ownerUserId=88')
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(helperMocks.requireKnowledgeOwner).toHaveBeenCalledOnce()
    expect(helperMocks.setKnowledgePrivateApiHeaders).toHaveBeenCalledWith(event)
  })

  it('rejects unknown and repeated query values after auth without creating storage', async () => {
    helperMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: OWNER, openId: 'opaque' })
    const handler = await loadHandler()
    const unknown = eventWithUrl('/api/knowledge/impact-preview?kind=entity&id=1&consumer=x')
    await expect(handler(unknown)).rejects.toMatchObject({ statusCode: 422 })
    const repeated = eventWithUrl('/api/knowledge/impact-preview?kind=entity&id=1&id=2')
    await expect(handler(repeated)).rejects.toMatchObject({ statusCode: 422 })
    expect(helperMocks.requireKnowledgeOwner).toHaveBeenCalledTimes(2)
    expect(helperMocks.createPreview).not.toHaveBeenCalled()
  })

  it('returns only the owner-bound report and maps not-found and bounded-snapshot errors', async () => {
    helperMocks.requireKnowledgeOwner.mockResolvedValue({ ownerUserId: OWNER, openId: 'opaque' })
    const report = { ownerUserId: OWNER, coverageScope: 'known_explicit_dependencies_only' }
    helperMocks.createPreview.mockResolvedValueOnce(report)
    const handler = await loadHandler()
    const event = eventWithUrl('/api/knowledge/impact-preview?kind=source&id=8')
    await expect(handler(event)).resolves.toEqual({ status: 'ok', value: report })
    expect(helperMocks.createPreview).toHaveBeenCalledWith(OWNER, { kind: 'source', id: 8 })

    helperMocks.createPreview.mockRejectedValueOnce(new KnowledgeImpactError('SUBJECT_NOT_FOUND', 'Impact subject was not found.'))
    await expect(handler(eventWithUrl('/api/knowledge/impact-preview?kind=source&id=9'))).rejects.toMatchObject({ statusCode: 404 })
    helperMocks.createPreview.mockRejectedValueOnce(new KnowledgeImpactError('SNAPSHOT_LIMIT_EXCEEDED', 'Knowledge impact snapshot exceeds the bounded limit.'))
    await expect(handler(eventWithUrl('/api/knowledge/impact-preview?kind=source&id=8'))).rejects.toMatchObject({ statusCode: 409 })
  })
})
