import { describe, expect, it, vi } from 'vitest'
import { parseKnowledgeConsumerCatalogQuery, readKnowledgeConsumerCatalog } from '../server/knowledge/consumer-catalog'
import type { KnowledgeConsumerAnchor, KnowledgeConsumerBindingRepository } from '../server/knowledge/consumer-binding-types'

const OWNER = 91
const HASH = 'a'.repeat(64)
const anchor = (id: number): KnowledgeConsumerAnchor => ({ ownerUserId: OWNER, consumerKind: 'geo_dataset', consumerId: id, consumerVersion: HASH, consumerContentHash: HASH })
function repository(rows: KnowledgeConsumerAnchor[]) {
  const listNativeAnchors = vi.fn(async () => rows)
  return { listNativeAnchors, port: { listNativeAnchors } as unknown as KnowledgeConsumerBindingRepository }
}

describe('owner native consumer catalog', () => {
  it.each([
    null, [], {}, { kind: ['geo_dataset'] }, { kind: 'unknown' }, { kind: 'geo_dataset', ownerUserId: OWNER },
    { kind: 'geo_dataset', afterId: '0' }, { kind: 'geo_dataset', afterId: '01' }, { kind: 'geo_dataset', afterId: 1 },
    { kind: 'geo_dataset', afterId: ['1', '2'] }, { kind: 'geo_dataset', afterId: '2147483648' }, { kind: 'geo_dataset', afterId: '1e2' },
  ])('rejects noncanonical or extra query authority %#', input => {
    expect(() => parseKnowledgeConsumerCatalogQuery(input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('accepts only the exact native kind and optional canonical integer cursor', () => {
    expect(parseKnowledgeConsumerCatalogQuery({ kind: 'geo_dataset' })).toEqual({ kind: 'geo_dataset', afterId: 0 })
    expect(parseKnowledgeConsumerCatalogQuery({ kind: 'benchmark_prompt', afterId: '2147483647' })).toEqual({ kind: 'benchmark_prompt', afterId: 2147483647 })
  })

  it('returns 25 validated entries plus a forward cursor from the 26-row sentinel, without authority or raw text', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({ ...anchor(index + 101), promptText: 'SYNTHETIC_PRIVATE_PROMPT', requestKey: 'SYNTHETIC_SECRET_KEY' }))
    const { port, listNativeAnchors } = repository(rows)
    const result = await readKnowledgeConsumerCatalog(OWNER, { kind: 'geo_dataset', afterId: '100' }, port)
    expect(listNativeAnchors).toHaveBeenCalledExactlyOnceWith(OWNER, 'geo_dataset', 100, 26)
    expect(result.items).toHaveLength(25)
    expect(result.nextAfterId).toBe(125)
    expect(result.items[0]).toEqual({ consumerKind: 'geo_dataset', consumerId: 101, consumerVersion: HASH, consumerContentHash: HASH })
    expect(result).toMatchObject({ scope: 'owner_native_immutable_consumers_v1', rawTextIncluded: false, automaticPublication: false, automaticTrainingAdmission: false, productionActivation: false })
    expect(JSON.stringify(result)).not.toMatch(/ownerUserId|promptText|requestKey|SYNTHETIC_PRIVATE|SYNTHETIC_SECRET/u)
  })

  it('returns an explicit terminal empty page, not invented consumers', async () => {
    const { port } = repository([])
    expect(await readKnowledgeConsumerCatalog(OWNER, { kind: 'geo_dataset', afterId: '125' }, port)).toMatchObject({ items: [], nextAfterId: null })
  })

  it.each([
    [anchor(2), anchor(2)], [anchor(3), anchor(2)], [{ ...anchor(2), ownerUserId: OWNER + 1 }],
    [{ ...anchor(2), consumerKind: 'benchmark_prompt', consumerVersion: '1' }], [{ ...anchor(2), consumerContentHash: 'b'.repeat(64) }],
    [anchor(1)],
  ].map(rows => ({ rows })))('fails closed for duplicate, unordered, cross-owner, wrong-kind or corrupt native rows %#', async ({ rows }) => {
    const { port } = repository(rows as KnowledgeConsumerAnchor[])
    await expect(readKnowledgeConsumerCatalog(OWNER, { kind: 'geo_dataset', afterId: '1' }, port)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
  })

  it('rejects invalid owner, missing native adapter and over-capacity reads', async () => {
    const { port, listNativeAnchors } = repository([])
    await expect(readKnowledgeConsumerCatalog(0, { kind: 'geo_dataset' }, port)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(listNativeAnchors).not.toHaveBeenCalled()
    await expect(readKnowledgeConsumerCatalog(OWNER, { kind: 'geo_dataset' }, {} as KnowledgeConsumerBindingRepository)).rejects.toMatchObject({ code: 'CORRUPT_STATE' })
    await expect(readKnowledgeConsumerCatalog(OWNER, { kind: 'geo_dataset' }, repository(Array.from({ length: 27 }, (_, i) => anchor(i + 1))).port)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
})
