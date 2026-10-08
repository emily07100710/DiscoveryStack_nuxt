import { describe, expect, it } from 'vitest'
import {
  type KnowledgeImpactAdapterCoverage,
  type KnowledgeImpactSnapshot,
} from '../server/knowledge/impact-types'
import { resolveKnowledgeImpact } from '../server/knowledge/impact-resolver'

const OWNER = 42
const OTHER_OWNER = 99
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const FP_A = '1'.repeat(64)
const FP_B = '2'.repeat(64)
const FP_C = '3'.repeat(64)
const at = new Date('2026-10-08T00:00:00.000Z')

type SubjectKind = 'entity' | 'claim' | 'source'
interface TestRevisionHead {
  ownerUserId: number
  subjectKind: SubjectKind
  subjectId: number
  revisionNumber: number
  contentHash: string
  revisionFingerprint: string
}
interface TestDependency {
  kind: 'entity' | 'claim' | 'source' | 'source_version' | 'content'
  id: number
  version: string | number | null
  contentHash: string | null
  revisionFingerprint?: string
}
type SnapshotWithHeads = KnowledgeImpactSnapshot & { revisionHeads?: readonly TestRevisionHead[] }
type MutableSnapshot = {
  -readonly [Key in keyof SnapshotWithHeads]: SnapshotWithHeads[Key] extends readonly (infer Row)[] ? Row[] : SnapshotWithHeads[Key]
}

function emptySnapshot(): MutableSnapshot {
  return {
    entities: [{ id: 1, ownerUserId: OWNER, entityUid: 'e1', entityType: 'Organization', canonicalName: 'Twin', slug: null, canonicalUri: null, canonicalUriHash: null, locale: 'en', summary: null, status: 'active', publicVisibility: 'private', mergedIntoEntityId: null, provenance: null, createdAt: at, updatedAt: at }],
    aliases: [], externalIds: [],
    sources: [{ id: 8, ownerUserId: OWNER, canonicalUrl: 'https://source.example/', urlHash: HASH_A, title: null, sourceClass: 'government', status: 'active', notes: null, createdAt: at, updatedAt: at }],
    sourceVersions: [],
    claims: [{ id: 5, ownerUserId: OWNER, statement: 'private claim', claimType: 'research findings', status: 'source_backed', validFrom: null, validTo: null, createdAt: at, updatedAt: at }],
    claimEntityLinks: [{ id: 50, ownerUserId: OWNER, claimId: 5, entityId: 1, createdAt: at, updatedAt: at }],
    evidence: [], contentLinks: [], publisher: null, contentAnchors: [],
    adapterCoverage: [
      { category: 'content', state: 'unconfigured', scope: 'none', limitationCodes: [], consumers: [] },
      { category: 'schema', state: 'unconfigured', scope: 'none', limitationCodes: [], consumers: [] },
      { category: 'dataset', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_not_configured'], consumers: [] },
      { category: 'public_api', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_not_configured'], consumers: [] },
      { category: 'benchmark_prompt', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_not_configured'], consumers: [] },
      { category: 'reviewer', state: 'unconfigured', scope: 'no adapter', limitationCodes: ['adapter_not_configured'], consumers: [] },
    ],
    revisionHeads: [],
  }
}

function head(subjectKind: SubjectKind, subjectId: number, revisionFingerprint: string, contentHash = HASH_A, revisionNumber = 1, ownerUserId = OWNER): TestRevisionHead {
  return { ownerUserId, subjectKind, subjectId, revisionNumber, contentHash, revisionFingerprint }
}

function dependency(kind: TestDependency['kind'], id: number, pin?: Partial<Pick<TestDependency, 'version' | 'contentHash' | 'revisionFingerprint'>>): TestDependency {
  return { kind, id, version: pin?.version ?? null, contentHash: pin?.contentHash ?? null, ...(pin?.revisionFingerprint ? { revisionFingerprint: pin.revisionFingerprint } : {}) }
}

function register(snapshot: MutableSnapshot, category: Exclude<KnowledgeImpactAdapterCoverage['category'], 'content' | 'schema'>, dependencies: readonly TestDependency[]): void {
  const coverage = snapshot.adapterCoverage.find(row => row.category === category)!
  snapshot.adapterCoverage[snapshot.adapterCoverage.indexOf(coverage)] = {
    ...coverage,
    state: 'complete',
    scope: 'test exact registry',
    limitationCodes: [],
    consumers: [{ category, ownerUserId: OWNER, consumerId: 'consumer-1', version: 'v7', contentHash: HASH_C, dependencies }],
  } as KnowledgeImpactAdapterCoverage
}

function withHeads(snapshot: MutableSnapshot, heads: readonly unknown[]): KnowledgeImpactSnapshot {
  return { ...snapshot, revisionHeads: heads } as unknown as KnowledgeImpactSnapshot
}

function consumerItem(snapshot: KnowledgeImpactSnapshot, subject: { kind: SubjectKind; id: number }, category: 'dataset' | 'public_api' | 'benchmark_prompt' | 'reviewer' = 'dataset') {
  const item = resolveKnowledgeImpact(OWNER, subject, snapshot).buckets.find(bucket => bucket.category === category)!.items[0]
  return item
}

describe('Knowledge impact semantic revision pins', () => {
  it.each([
    ['entity', 1, FP_A],
    ['claim', 5, FP_B],
    ['source', 8, FP_C],
  ] as const)('accepts a matching %s revision pin and emits a safe pin lineage ref', (kind, id, fingerprint) => {
    const snapshot = emptySnapshot()
    const hash = kind === 'entity' ? HASH_A : kind === 'claim' ? HASH_B : HASH_C
    register(snapshot, 'dataset', [dependency(kind, id, { version: 4, contentHash: hash, revisionFingerprint: fingerprint })])
    const reportSnapshot = withHeads(snapshot, [head(kind, id, fingerprint, hash, 4)])
    const item = consumerItem(reportSnapshot, { kind, id })
    expect(item?.reasonCode).toBe('exact_registered_dependency')
    expect(item?.lineage).toContainEqual({ kind, id, relation: 'registered_consumer_revision_pin', version: fingerprint, contentHash: hash })
    expect(JSON.stringify(item)).not.toContain('canonicalSnapshot')
  })

  it('preserves the pre-pin contract when a semantic dependency has no pin fields', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1)])
    const item = consumerItem(withHeads(snapshot, [head('entity', 1, FP_A)]), { kind: 'entity', id: 1 })
    expect(item?.reasonCode).toBe('exact_registered_dependency')
    expect(item?.lineage.some(ref => ref.relation === 'registered_consumer_revision_pin')).toBe(false)
  })

  it('preserves the pre-pin contract when the revisionHeads field is omitted entirely', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1)])
    const legacySnapshot = { ...snapshot }
    delete legacySnapshot.revisionHeads
    const item = consumerItem(legacySnapshot, { kind: 'entity', id: 1 })
    expect(item?.reasonCode).toBe('exact_registered_dependency')
    expect(item?.lineage.some(ref => ref.relation === 'registered_consumer_revision_pin')).toBe(false)
  })

  it('retains an exact consumer and marks an old revision number stale', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('claim', 5, { version: 1, contentHash: HASH_A, revisionFingerprint: FP_A })])
    const item = consumerItem(withHeads(snapshot, [head('claim', 5, FP_B, HASH_B, 2)]), { kind: 'claim', id: 5 })
    expect(item?.id).toBe('consumer-1')
    expect(item?.reasonCode).toBe('exact_registered_dependency_stale')
  })

  it('retains an exact consumer as stale when its subject has no revision head', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A })])
    const item = consumerItem(withHeads(snapshot, []), { kind: 'entity', id: 1 })
    expect(item?.id).toBe('consumer-1')
    expect(item?.reasonCode).toBe('exact_registered_dependency_stale')
  })

  it('retains an exact consumer as stale when the pinned hash disagrees with the same head', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A })])
    const item = consumerItem(withHeads(snapshot, [head('entity', 1, FP_A, HASH_B)]), { kind: 'entity', id: 1 })
    expect(item?.reasonCode).toBe('exact_registered_dependency_stale')
  })

  it('retains an exact consumer as stale when the pinned fingerprint disagrees with the same head', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('source', 8, { contentHash: HASH_A, revisionFingerprint: FP_A })])
    const item = consumerItem(withHeads(snapshot, [head('source', 8, FP_B)]), { kind: 'source', id: 8 })
    expect(item?.reasonCode).toBe('exact_registered_dependency_stale')
  })

  it('rejects duplicate owner/subject revision heads', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { revisionFingerprint: FP_A })])
    expect(() => consumerItem(withHeads(snapshot, [head('entity', 1, FP_A), head('entity', 1, FP_B)]), { kind: 'entity', id: 1 })).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('rejects cross-owner revision heads even when the subject ID exists for this owner', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { revisionFingerprint: FP_A })])
    expect(() => consumerItem(withHeads(snapshot, [head('entity', 1, FP_A, HASH_A, 1, OTHER_OWNER)]), { kind: 'entity', id: 1 })).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('rejects a revision head for an unknown subject ID', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { revisionFingerprint: FP_A })])
    expect(() => consumerItem(withHeads(snapshot, [head('entity', 999, FP_A)]), { kind: 'entity', id: 1 })).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('rejects a revision pin on a source_version dependency', () => {
    const snapshot = emptySnapshot()
    snapshot.sourceVersions = [{ id: 80, ownerUserId: OWNER, sourceId: 8, versionNumber: 1, contentHash: HASH_A, retrievedAt: at, excerpt: null, metadata: null, createdAt: at, updatedAt: at }]
    register(snapshot, 'dataset', [dependency('source_version', 80, { revisionFingerprint: FP_A })])
    expect(() => consumerItem(withHeads(snapshot, [head('source', 8, FP_A)]), { kind: 'source', id: 8 })).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('rejects a revision pin on a content dependency', () => {
    const snapshot = emptySnapshot()
    snapshot.contentAnchors = [{ ownerUserId: OWNER, briefId: 10, jobId: 20, draftId: 30, title: 'private draft', language: 'en', contentType: 'article', contentHash: HASH_A, draftCreatedAt: at }]
    register(snapshot, 'dataset', [dependency('content', 30, { revisionFingerprint: FP_A })])
    expect(() => consumerItem(withHeads(snapshot, []), { kind: 'entity', id: 1 })).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('uses exact IDs and does not infer dependencies from a same-name entity or claim/entity relation', () => {
    const snapshot = emptySnapshot()
    snapshot.entities.push({ ...snapshot.entities[0]!, id: 2, entityUid: 'e2' })
    register(snapshot, 'dataset', [dependency('entity', 2, { revisionFingerprint: FP_B, contentHash: HASH_B })])
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, withHeads(snapshot, [head('entity', 2, FP_B, HASH_B)]))
    expect(report.buckets.find(bucket => bucket.category === 'dataset')?.items).toEqual([])
  })

  it('changes the consumer dependency fingerprint when only the explicit pin changes', () => {
    const first = emptySnapshot()
    register(first, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A })])
    const second = emptySnapshot()
    register(second, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_B })])
    const itemA = consumerItem(withHeads(first, [head('entity', 1, FP_C)]), { kind: 'entity', id: 1 })
    const itemB = consumerItem(withHeads(second, [head('entity', 1, FP_C)]), { kind: 'entity', id: 1 })
    expect(itemA?.dependencyFingerprint).not.toBe(itemB?.dependencyFingerprint)
  })

  it('changes the consumer dependency fingerprint when the current head changes but the expected pin stays fixed', () => {
    const first = emptySnapshot()
    register(first, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A })])
    const second = emptySnapshot()
    register(second, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A })])
    const itemA = consumerItem(withHeads(first, [head('entity', 1, FP_A, HASH_A)]), { kind: 'entity', id: 1 })
    const itemB = consumerItem(withHeads(second, [head('entity', 1, FP_C, HASH_B, 2)]), { kind: 'entity', id: 1 })
    expect(itemA?.dependencyFingerprint).not.toBe(itemB?.dependencyFingerprint)
    expect(itemB?.lineage).toContainEqual({ kind: 'entity', id: 1, relation: 'registered_consumer_dependency_current_revision', version: FP_C, contentHash: HASH_B })
  })

  it('retains both same-consumer pins that differ only by fingerprint and fingerprints them independent of dependency order', () => {
    const first = emptySnapshot()
    register(first, 'dataset', [
      dependency('entity', 1, { version: 4, contentHash: HASH_A, revisionFingerprint: FP_A }),
      dependency('entity', 1, { version: 4, contentHash: HASH_A, revisionFingerprint: FP_B }),
    ])
    const second = emptySnapshot()
    register(second, 'dataset', [
      dependency('entity', 1, { version: 4, contentHash: HASH_A, revisionFingerprint: FP_B }),
      dependency('entity', 1, { version: 4, contentHash: HASH_A, revisionFingerprint: FP_A }),
    ])
    const heads = [head('entity', 1, FP_A, HASH_A, 4)]
    const reportA = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, withHeads(first, heads))
    const reportB = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, withHeads(second, heads))
    const itemA = reportA.buckets.find(bucket => bucket.category === 'dataset')!.items[0]!
    const pinFingerprints = itemA.lineage.filter(ref => ref.relation === 'registered_consumer_revision_pin').map(ref => ref.version)
    expect(pinFingerprints).toEqual([FP_A, FP_B])
    expect(itemA.reasonCode).toBe('exact_registered_dependency_stale')
    expect(reportB.graphFingerprint).toBe(reportA.graphFingerprint)
    expect(reportB.outputFingerprint).toBe(reportA.outputFingerprint)
  })

  it('keeps graph and output fingerprints stable when revision heads arrive in a different order', () => {
    const first = emptySnapshot()
    register(first, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A }), dependency('claim', 5, { contentHash: HASH_B, revisionFingerprint: FP_B })])
    const second = emptySnapshot()
    register(second, 'dataset', [dependency('entity', 1, { contentHash: HASH_A, revisionFingerprint: FP_A }), dependency('claim', 5, { contentHash: HASH_B, revisionFingerprint: FP_B })])
    const heads = [head('entity', 1, FP_A, HASH_A), head('claim', 5, FP_B, HASH_B)]
    const reportA = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, withHeads(first, heads))
    const reportB = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, withHeads(second, [...heads].reverse()))
    expect(reportB.graphFingerprint).toBe(reportA.graphFingerprint)
    expect(reportB.outputFingerprint).toBe(reportA.outputFingerprint)
  })

  it('rejects raw snapshots and unexpected revision head fields', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { revisionFingerprint: FP_A })])
    const invalid = { ...head('entity', 1, FP_A), canonicalSnapshot: '{"secret":true}' }
    expect(() => consumerItem(withHeads(snapshot, [invalid]), { kind: 'entity', id: 1 })).toThrowError(expect.objectContaining({ code: 'CORRUPT_GRAPH' }))
  })

  it('marks a consumer stale when another supplied pin field disagrees with its head', () => {
    const snapshot = emptySnapshot()
    register(snapshot, 'dataset', [dependency('entity', 1, { version: 5, contentHash: HASH_A, revisionFingerprint: FP_A })])
    const item = consumerItem(withHeads(snapshot, [head('entity', 1, FP_A, HASH_A, 4)]), { kind: 'entity', id: 1 })
    expect(item?.reasonCode).toBe('exact_registered_dependency_stale')
  })

  it('does not present unconfigured buckets as configured merely because heads exist', () => {
    const snapshot = emptySnapshot()
    const report = resolveKnowledgeImpact(OWNER, { kind: 'entity', id: 1 }, withHeads(snapshot, [head('entity', 1, FP_A)]))
    expect(report.buckets.slice(2).map(bucket => bucket.state)).toEqual(['unconfigured', 'unconfigured', 'unconfigured', 'unconfigured'])
    expect(report.buckets.slice(2).every(bucket => bucket.items.length === 0)).toBe(true)
  })
})
