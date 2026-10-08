import { describe, expect, it } from 'vitest'
import {
  KnowledgeImpactError,
  type KnowledgeImpactAdapterCoverage,
  type KnowledgeImpactSnapshot,
} from '../server/knowledge/impact-types'
import { resolveKnowledgeImpact } from '../server/knowledge/impact-resolver'
import type {
  KnowledgeClaim,
  KnowledgeClaimEntityLink,
  KnowledgeClaimEvidence,
  KnowledgeContentEntityLink,
  KnowledgeEntity,
  KnowledgeEntityAlias,
  KnowledgeEntityExternalId,
  KnowledgeSource,
  KnowledgeSourceVersion,
} from '../server/knowledge/types'

const OWNER = 42
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const at = new Date('2026-01-02T03:04:05.000Z')

type MutableSnapshot = {
  -readonly [Key in keyof KnowledgeImpactSnapshot]: KnowledgeImpactSnapshot[Key] extends readonly (infer Row)[] ? Row[] : KnowledgeImpactSnapshot[Key]
}

function entity(id: number, name: string, entityType: KnowledgeEntity['entityType'] = 'Person', patch: Partial<KnowledgeEntity> = {}): KnowledgeEntity {
  return {
    id, ownerUserId: OWNER, entityUid: `uid-${id}`, entityType, canonicalName: name, slug: null,
    canonicalUri: null, canonicalUriHash: null, locale: 'en', summary: null, status: 'active',
    publicVisibility: 'private', mergedIntoEntityId: null, provenance: null, createdAt: at, updatedAt: at,
    ...patch,
  }
}

function source(id: number): KnowledgeSource {
  return { id, ownerUserId: OWNER, canonicalUrl: `https://source-${id}.example/`, urlHash: HASH_A, title: null, sourceClass: 'government', status: 'active', notes: null, createdAt: at, updatedAt: at }
}

function sourceVersion(id: number, sourceId: number, versionNumber: number, contentHash: string): KnowledgeSourceVersion {
  return { id, ownerUserId: OWNER, sourceId, versionNumber, contentHash, retrievedAt: at, excerpt: 'must not leak', metadata: { token: 'must not leak' }, createdAt: at, updatedAt: at }
}

function claim(id: number): KnowledgeClaim {
  return { id, ownerUserId: OWNER, statement: `Claim text ${id}`, claimType: 'research findings', status: 'source_backed', validFrom: null, validTo: null, createdAt: at, updatedAt: at }
}

function contentLink(id: number, briefId: number, entityId: number, role: KnowledgeContentEntityLink['role']): KnowledgeContentEntityLink {
  return { id, ownerUserId: OWNER, briefId, entityId, role, createdAt: at, updatedAt: at }
}

function claimLink(id: number, claimId: number, entityId: number): KnowledgeClaimEntityLink {
  return { id, ownerUserId: OWNER, claimId, entityId, createdAt: at, updatedAt: at }
}

function evidence(id: number, claimId: number, sourceVersionId: number, relation: KnowledgeClaimEvidence['relation'] = 'supports'): KnowledgeClaimEvidence {
  return { id, ownerUserId: OWNER, claimId, sourceVersionId, relation, locator: 'page 2', locatorHash: HASH_B, contentHash: HASH_C, reviewNotes: 'private note', createdAt: at, updatedAt: at }
}

function coverage(): KnowledgeImpactAdapterCoverage[] {
  return [
    { category: 'content', state: 'unconfigured', scope: 'none', limitationCodes: [], consumers: [] },
    { category: 'schema', state: 'unconfigured', scope: 'none', limitationCodes: [], consumers: [] },
    { category: 'dataset', state: 'unconfigured', scope: 'no exact adapter', limitationCodes: ['adapter_not_configured'], consumers: [] },
    { category: 'public_api', state: 'unconfigured', scope: 'no public knowledge output', limitationCodes: ['adapter_not_configured'], consumers: [] },
    { category: 'benchmark_prompt', state: 'unconfigured', scope: 'no exact prompt binding', limitationCodes: ['adapter_not_configured'], consumers: [] },
    { category: 'reviewer', state: 'unconfigured', scope: 'no reviewer assignment binding', limitationCodes: ['adapter_not_configured'], consumers: [] },
  ]
}

function baseSnapshot(): MutableSnapshot {
  return {
    entities: [entity(1, 'Same Name'), entity(2, 'Same Name', 'Concept')],
    aliases: [], externalIds: [], sources: [source(8)],
    sourceVersions: [sourceVersion(80, 8, 1, HASH_A), sourceVersion(81, 8, 2, HASH_B)],
    claims: [claim(5), claim(6)], claimEntityLinks: [claimLink(50, 5, 1), claimLink(60, 6, 2)],
    evidence: [evidence(500, 5, 80), evidence(501, 5, 81)],
    contentLinks: [contentLink(100, 10, 1, 'author'), contentLink(101, 11, 1, 'about'), contentLink(102, 12, 2, 'author')],
    publisher: null,
    contentAnchors: [
      { ownerUserId: OWNER, briefId: 10, jobId: 110, draftId: 1010, title: 'not hashed to output', language: 'en', contentType: 'article', contentHash: HASH_C, draftCreatedAt: at },
      { ownerUserId: OWNER, briefId: 11, jobId: 111, draftId: 1011, title: 'about', language: 'en', contentType: 'article', contentHash: HASH_B, draftCreatedAt: at },
      { ownerUserId: OWNER, briefId: 12, jobId: 112, draftId: 1012, title: 'unrelated same-name', language: 'en', contentType: 'article', contentHash: HASH_A, draftCreatedAt: at },
    ],
    adapterCoverage: coverage(),
  }
}

describe('knowledge impact resolver', () => {
  it('returns six bounded buckets and distinguishes native known scope from unconfigured adapters', () => {
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, baseSnapshot())
    expect(report.buckets.map(bucket => bucket.category)).toEqual(['content', 'schema', 'dataset', 'public_api', 'benchmark_prompt', 'reviewer'])
    expect(report.buckets.slice(0, 2).map(bucket => [bucket.state, bucket.scope])).toEqual([
      ['complete', 'native_knowledge_bindings'], ['complete', 'native_knowledge_bindings'],
    ])
    expect(report.buckets.slice(2).every(bucket => bucket.state === 'unconfigured')).toBe(true)
    expect(report.coverageScope).toBe('known_explicit_dependencies_only')
    expect(report.exhaustive).toBe(false)
    expect(report.automaticPublication).toBe(false)
    expect(report.productionActivation).toBe(false)
    expect(report.automaticTrainingAdmission).toBe(false)
    expect(report.graphFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(report.outputFingerprint).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('uses exact entity IDs, emits direct native content links, and does not confuse same-name entities', () => {
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, baseSnapshot())
    expect(report.buckets[0].items.map(item => item.id)).toEqual(['1010', '1011'])
    expect(report.buckets[0].items[0]?.lineage.some(item => item.kind === 'claim')).toBe(false)
    expect(report.buckets[0].items.some(item => item.id === '1012')).toBe(false)
  })

  it('does not claim schema impact for about/mentions roles', () => {
    const snapshot = baseSnapshot()
    snapshot.contentLinks = [contentLink(101, 11, 1, 'about'), contentLink(103, 11, 1, 'mentions')]
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot)
    expect(report.buckets[0].items.map(item => item.id)).toEqual(['1011'])
    expect(report.buckets[1].items).toEqual([])
  })

  it('skips non-author entity types for schema while retaining their explicit content relationship', () => {
    const snapshot = baseSnapshot()
    snapshot.contentLinks = [contentLink(102, 12, 2, 'author')]
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 2 }, snapshot)
    expect(report.buckets[0].items.map(item => item.id)).toEqual(['1012'])
    expect(report.buckets[1].items).toEqual([])
  })

  it('tracks merged entity author input through explicit redirect path and canonical supported kind', () => {
    const snapshot = baseSnapshot()
    snapshot.entities = [entity(1, 'Canonical', 'Organization'), entity(3, 'Old alias', 'Concept', { status: 'merged', mergedIntoEntityId: 1 })]
    snapshot.claimEntityLinks = []
    snapshot.contentLinks = [contentLink(130, 13, 3, 'author')]
    snapshot.contentAnchors = [{ ownerUserId: OWNER, briefId: 13, jobId: 113, draftId: 1013, title: 'merged', language: 'en', contentType: 'article', contentHash: HASH_A, draftCreatedAt: at }]
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 3 }, snapshot)
    const schemaItem = report.buckets[1].items[0]
    expect(schemaItem?.contentHash).toBeNull()
    expect(schemaItem?.reasonCode).toBe('projection_inputs_only')
    expect([...new Set(schemaItem?.lineage.filter(item => item.kind === 'entity').map(item => item.id))]).toEqual([1, 3])
  })

  it('includes every historical source version and exact evidence-to-claim registered consumer path', () => {
    const snapshot = baseSnapshot()
    const adapters = coverage()
    adapters[2] = {
      category: 'dataset', state: 'complete', scope: 'exact test adapter', limitationCodes: [],
      consumers: [{ category: 'dataset', ownerUserId: OWNER, consumerId: 'dataset-9', version: 'v2', contentHash: HASH_C, dependencies: [{ kind: 'claim', id: 5, version: null, contentHash: null }] }],
    }
    snapshot.adapterCoverage = adapters
    const report = resolveKnowledgeImpact(OWNER, { kind: 'source', id: 8 }, snapshot)
    const dataset = report.buckets[2].items[0]
    expect(dataset?.id).toBe('dataset-9')
    expect([...new Set(dataset?.lineage.filter(item => item.kind === 'source_version').map(item => item.id))]).toEqual([80, 81])
    expect(dataset?.lineage.some(item => item.kind === 'claim' && item.id === 5)).toBe(true)
    expect(dataset?.lineage.some(item => item.kind === 'claim' && item.id === 6)).toBe(false)
    expect(report.affectedKnowledge.some(item => item.kind === 'claim' && item.id === 5)).toBe(true)
    expect(report.affectedKnowledge.some(item => item.kind === 'source_version' && item.id === 80)).toBe(true)
  })

  it('retains exact-ID consumers with stale expected hashes and labels the drift instead of returning empty', () => {
    const snapshot = baseSnapshot()
    const adapters = coverage()
    adapters[2] = {
      category: 'dataset', state: 'complete', scope: 'exact test adapter', limitationCodes: [],
      consumers: [{ category: 'dataset', ownerUserId: OWNER, consumerId: 'stale-dataset', version: 'v4', contentHash: HASH_B, dependencies: [{ kind: 'content', id: 1010, version: 'older-draft', contentHash: HASH_A }] }],
    }
    snapshot.adapterCoverage = adapters
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot)
    const datasetBucket = report.buckets[2]
    expect(datasetBucket.items[0]?.id).toBe('stale-dataset')
    expect(datasetBucket.items[0]?.reasonCode).toBe('exact_registered_dependency_stale')
    expect(datasetBucket.items[0]?.lineage.some(item => item.relation === 'registered_consumer_dependency_stale')).toBe(true)
    expect(datasetBucket.limitationCodes).toContain('registered_dependency_snapshot_drift')
  })

  it('fails closed when a typed consumer registration points to an absent object', () => {
    const snapshot = baseSnapshot()
    const adapters = coverage()
    adapters[2] = {
      category: 'dataset', state: 'complete', scope: 'exact test adapter', limitationCodes: [],
      consumers: [{ category: 'dataset', ownerUserId: OWNER, consumerId: 'broken-dataset', version: 'v1', contentHash: HASH_B, dependencies: [{ kind: 'claim', id: 999, version: null, contentHash: null }] }],
    }
    snapshot.adapterCoverage = adapters
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot)).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('does not infer content through Claim → Entity links', () => {
    const snapshot = baseSnapshot()
    const adapters = coverage()
    adapters[2] = {
      category: 'dataset', state: 'complete', scope: 'exact test adapter', limitationCodes: [],
      consumers: [{ category: 'dataset', ownerUserId: OWNER, consumerId: 'source-only', version: 'v1', contentHash: HASH_C, dependencies: [{ kind: 'source', id: 8, version: null, contentHash: null }] }],
    }
    snapshot.adapterCoverage = adapters
    const report = resolveKnowledgeImpact(OWNER, { kind: 'claim', id: 5 }, snapshot)
    expect(report.buckets[0].items).toEqual([])
    expect(report.buckets[1].items).toEqual([])
    expect(report.buckets[2].items).toEqual([])
    expect(report.affectedKnowledge.map(item => item.kind)).toEqual(['claim'])
  })

  it('does not leak statements, excerpts, metadata, review notes, or full provenance in output', () => {
    const snapshot = baseSnapshot()
    snapshot.entities[0] = entity(1, 'private-name', 'Person', { provenance: { secret: 'private-provenance' } })
    const serialized = JSON.stringify(resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot))
    for (const secret of ['Claim text', 'must not leak', 'private note', 'private-provenance', 'private-name']) expect(serialized).not.toContain(secret)
  })

  it('produces deterministic fingerprints independent of row order and changes fingerprint when graph content changes', () => {
    const first = baseSnapshot()
    const second = baseSnapshot()
    second.entities.reverse()
    second.contentLinks.reverse()
    second.sourceVersions.reverse()
    const reportA = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, first)
    const reportB = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, second)
    expect(reportB.graphFingerprint).toBe(reportA.graphFingerprint)
    expect(reportB.outputFingerprint).toBe(reportA.outputFingerprint)
    const changed = baseSnapshot()
    changed.entities[0] = entity(1, 'changed name')
    expect(resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, changed).graphFingerprint).not.toBe(reportA.graphFingerprint)
  })

  it('keeps graph fingerprints deterministic when one consumer has multiple registered versions', () => {
    const first = baseSnapshot()
    const consumers = [
      { category: 'dataset', ownerUserId: OWNER, consumerId: 'dataset-shared', version: 'v1', contentHash: HASH_A, dependencies: [{ kind: 'entity', id: 1, version: null, contentHash: null }] },
      { category: 'dataset', ownerUserId: OWNER, consumerId: 'dataset-shared', version: 'v2', contentHash: HASH_B, dependencies: [{ kind: 'entity', id: 1, version: null, contentHash: null }] },
    ] as const
    first.adapterCoverage[2] = { ...first.adapterCoverage[2]!, state: 'complete', scope: 'synthetic exact consumer fixture', limitationCodes: [], consumers }
    const second = baseSnapshot()
    second.adapterCoverage[2] = { ...second.adapterCoverage[2]!, state: 'complete', scope: 'synthetic exact consumer fixture', limitationCodes: [], consumers: [...consumers].reverse() }

    expect(resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, second).graphFingerprint)
      .toBe(resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, first).graphFingerprint)
  })

  it('rejects aggregate typed consumer dependency expansion before fingerprint serialization', () => {
    const snapshot = baseSnapshot()
    const consumers = Array.from({ length: 11 }, (_, consumerIndex) => ({
      category: 'dataset' as const,
      ownerUserId: OWNER,
      consumerId: `bounded-consumer-${consumerIndex}`,
      version: 'v1',
      contentHash: HASH_A,
      dependencies: Array.from({ length: 1_000 }, (_, dependencyIndex) => ({ kind: 'entity' as const, id: 1, version: `pin-${dependencyIndex}`, contentHash: null })),
    }))
    snapshot.adapterCoverage[2] = { ...snapshot.adapterCoverage[2]!, state: 'complete', scope: 'synthetic exact consumer fixture', limitationCodes: [], consumers }
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_LIMIT_EXCEEDED', message: 'Impact snapshot exceeds the bounded dependency expansion limit.' }))
  })

  it('rejects large explicit entity-to-content expansion before constructing draft lineage', () => {
    const snapshot = baseSnapshot()
    snapshot.entities = [entity(1, 'root'), ...Array.from({ length: 1_999 }, (_, index) => entity(index + 2, `merged-${index}`, 'Concept', { status: 'merged', mergedIntoEntityId: 1 }))]
    snapshot.contentLinks = snapshot.entities.map((row, index) => contentLink(index + 1, 10, row.id, 'about'))
    snapshot.contentAnchors = Array.from({ length: 6 }, (_, index) => ({ ownerUserId: OWNER, briefId: 10, jobId: 110, draftId: index + 1, title: 'bounded fixture', language: 'en', contentType: 'article', contentHash: HASH_A, draftCreatedAt: at }))
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, snapshot)).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_LIMIT_EXCEEDED', message: 'Impact snapshot exceeds the bounded dependency expansion limit.' }))
  })

  it('fails closed for cross-owner rows, unknown subjects, duplicate links, corrupt references, and redirect cycles', () => {
    const crossOwner = baseSnapshot()
    crossOwner.claims[0] = { ...claim(5), ownerUserId: OWNER + 1 }
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, crossOwner)).toThrow(KnowledgeImpactError)
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 999 }, baseSnapshot())).toThrowError(expect.objectContaining({ code: 'SUBJECT_NOT_FOUND' }))
    const duplicate = baseSnapshot()
    duplicate.contentLinks.push({ ...duplicate.contentLinks[0]! })
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, duplicate)).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
    const missingRef = baseSnapshot()
    missingRef.evidence[0] = evidence(500, 5, 999)
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, missingRef)).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
    const cycle = baseSnapshot()
    cycle.entities = [entity(1, 'one', 'Person', { status: 'merged', mergedIntoEntityId: 2 }), entity(2, 'two', 'Person', { status: 'merged', mergedIntoEntityId: 1 })]
    expect(() => resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, cycle)).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })
})
