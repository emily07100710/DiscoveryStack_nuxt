import { describe, expect, it } from 'vitest'
import { composeContentStructuredData, createInMemoryKnowledgeRepository, createKnowledgeService, type KnowledgeContentAnchorSeed } from '../server/knowledge'

const OWNER = 73
const HASH = 'c'.repeat(64)

function anchors(): KnowledgeContentAnchorSeed[] {
  return [
    { ownerUserId: OWNER, briefId: 10, jobId: 20, draftId: 30, title: 'Draft version one', language: 'en', contentType: 'article', contentHash: HASH, draftCreatedAt: new Date('2026-08-01T00:00:00.000Z') },
    { ownerUserId: OWNER, briefId: 10, jobId: 20, draftId: 31, title: 'Draft version two', language: 'en', contentType: 'article', contentHash: HASH, draftCreatedAt: new Date('2026-08-02T00:00:00.000Z') },
  ]
}

async function createEntity(service: ReturnType<typeof createKnowledgeService>, entityType: 'Organization' | 'Person' | 'Author', canonicalName: string) {
  const result = await service.createEntity({ entityType, canonicalName })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.value.entity
}

describe('knowledge structured-data composer', () => {
  it('emits real publisher and author nodes with a stable content-piece id across draft versions', async () => {
    const repository = createInMemoryKnowledgeRepository(anchors())
    const service = createKnowledgeService({ ownerUserId: OWNER, repository })
    const publisher = await createEntity(service, 'Organization', 'Example Publisher')
    const author = await createEntity(service, 'Person', 'Real Author')
    await service.setPublisherEntity({ organizationEntityId: publisher.id })
    await service.linkContentEntity({ briefId: 10, entityId: author.id, role: 'author' })

    const first = await composeContentStructuredData({ ownerUserId: OWNER, draftId: 30, siteOrigin: 'https://example.com', siteName: 'Ignored fallback' }, repository)
    const repeated = await composeContentStructuredData({ ownerUserId: OWNER, draftId: 30, siteOrigin: 'https://example.com', siteName: 'Ignored fallback' }, repository)
    const second = await composeContentStructuredData({ ownerUserId: OWNER, draftId: 31, siteOrigin: 'https://example.com', siteName: 'Ignored fallback' }, repository)
    expect(first.gaps).toEqual([])
    expect(first.jsonLd).toEqual(repeated.jsonLd)
    expect(first.jsonLd[0]?.['@id']).toBe('https://example.com/#/knowledge/content/10')
    expect(second.jsonLd[0]?.['@id']).toBe(first.jsonLd[0]?.['@id'])
    expect(first.jsonLd[0]).toMatchObject({
      '@type': 'Article',
      headline: 'Draft version one',
      publisher: { '@type': 'Organization', '@id': `https://example.com/#/knowledge/${publisher.entityUid}`, name: 'Example Publisher' },
      author: [{ '@type': 'Person', '@id': `https://example.com/#/knowledge/${author.entityUid}`, name: 'Real Author' }],
    })
  })

  it('honestly omits missing author and publisher while returning explicit gaps', async () => {
    const repository = createInMemoryKnowledgeRepository(anchors())
    const result = await composeContentStructuredData({ ownerUserId: OWNER, briefId: 10, siteOrigin: 'https://example.com', siteName: 'Must not be fabricated' }, repository)
    expect(result.gaps).toEqual([{ type: 'missing_author', briefId: 10 }, { type: 'missing_publisher' }])
    expect(result.jsonLd[0]).not.toHaveProperty('author')
    expect(result.jsonLd[0]).not.toHaveProperty('publisher')
  })

  it('resolves a linked merged author to the canonical target entityUid', async () => {
    const repository = createInMemoryKnowledgeRepository(anchors())
    const service = createKnowledgeService({ ownerUserId: OWNER, repository })
    const publisher = await createEntity(service, 'Organization', 'Publisher')
    const oldAuthor = await createEntity(service, 'Author', 'Legacy Author Identity')
    const canonicalAuthor = await createEntity(service, 'Person', 'Canonical Author')
    await service.setPublisherEntity({ organizationEntityId: publisher.id })
    await service.linkContentEntity({ briefId: 10, entityId: oldAuthor.id, role: 'author' })
    await service.mergeEntities({ sourceEntityId: oldAuthor.id, targetEntityId: canonicalAuthor.id, reason: 'Owner approved canonical author identity.' })

    const result = await composeContentStructuredData({ ownerUserId: OWNER, briefId: 10, siteOrigin: 'https://example.com' }, repository)
    expect(result.jsonLd[0]?.author).toEqual([{ '@type': 'Person', '@id': `https://example.com/#/knowledge/${canonicalAuthor.entityUid}`, name: canonicalAuthor.canonicalName }])
    expect(JSON.stringify(result.jsonLd)).not.toContain(oldAuthor.entityUid)
  })
})
