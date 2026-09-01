import { describe, expect, it } from 'vitest'
import * as contentSiteKitApi from '../server/first-party-content-site-kit'
import {
  buildAstroContentProjection,
  buildFirstPartyContentManifest,
  buildFirstPartySeoProjection,
  buildKnowledgeArticleJsonLd,
  buildNuxtContentProjection,
  knowledgeEntityJsonLdId,
  parseFirstPartyContentDocument,
} from '../server/first-party-content-site-kit'
import { buildFirstPartyMarkdownArtifact } from '../server/first-party-publishing/artifact'
import { isPublicHttpsOrigin } from '../server/first-party-publishing/target-guard'
import {
  CONTENT_ROOT,
  DEFAULT_BODY,
  FIXTURE_EVIDENCE_HASH,
  FIXTURE_NOW,
  makeArtifactMarkdown,
  makeBoundFaqEnvelope,
  makeDocument,
  makeFaqDocument,
  makePublication,
  makePublicationSet,
  makeSeoInput,
  makeServiceDocument,
  sha256,
} from './fixtures/first-party-content-site-kit/fixtures'
import { isJsonSafe, safeJsonStringify } from '../server/first-party-content-site-kit/canonical'
import type { ApprovedFirstPartyPublication } from '../server/first-party-publishing/types'

function parsePublication(publication: ApprovedFirstPartyPublication = makePublication(), sourcePath?: string, contentRoot = CONTENT_ROOT) {
  const artifact = makeArtifactMarkdown(publication, contentRoot)
  return parseFirstPartyContentDocument({ contentRoot, sourcePath: sourcePath ?? artifact.sourcePath, markdown: artifact.markdown })
}

function replaceFrontmatter(markdown: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}: .*?$`, 'm')
  return markdown.replace(pattern, `${key}: ${value}`)
}

function documentInput(document: ReturnType<typeof makeDocument>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeSeoInput(document, overrides)
}

describe('first-party content parser', () => {
  it('parses the formal publisher artifact happy path', () => {
    const result = parsePublication()
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.document.status).toBe('verified')
    expect(result.document.title).toBe('Verified First-party Article')
    expect(result.document.routePath).toBe('/en/articles/verified-first-party-article')
    expect(result.document.canonicalPath).toBe(result.document.routePath)
    expect(result.document.bodyHash).toBe(sha256(DEFAULT_BODY))
    expect(result.document.evidenceSnapshotHash).toBe(FIXTURE_EVIDENCE_HASH)
  })

  it('parses zh-hant and en route variants', () => {
    const zh = parsePublication(makePublication({ language: 'zh-hant', slug: 'zh-article' }))
    const en = parsePublication(makePublication({ language: 'en', slug: 'en-article', productionDeliverableId: 'publication-en' }))
    expect(zh.status).toBe('verified')
    expect(en.status).toBe('verified')
    if (zh.status === 'verified' && en.status === 'verified') {
      expect(zh.document.routePath).toBe('/zh-hant/articles/zh-article')
      expect(en.document.routePath).toBe('/en/articles/en-article')
    }
  })

  it.each([
    ['article', '/en/articles/article-page'],
    ['faq', '/en/faq/faq-page'],
    ['service_page', '/en/services/service-page'],
  ] as const)('uses the fixed route segment for %s', (contentType, expectedRoute) => {
    const result = parsePublication(makePublication({ contentType, slug: expectedRoute.split('/').at(-1) ?? 'page', productionDeliverableId: `publication-${contentType}` }))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.document.routePath).toBe(expectedRoute)
  })

  it('preserves fixed frontmatter field order through the formal artifact', () => {
    const artifact = buildFirstPartyMarkdownArtifact(CONTENT_ROOT, makePublication())
    expect(artifact.status).toBe('ok')
    if (artifact.status !== 'ok') return
    expect(artifact.artifact.frontmatter.split('\n').slice(0, 16)).toEqual([
      '---',
      'title: "Verified First-party Article"',
      'slug: "verified-first-party-article"',
      'language: "en"',
      'contentType: "article"',
      'publicationId: "publication-001"',
      'scheduleEntryId: "schedule-001"',
      'productionPlanId: "production-plan-001"',
      'draftId: "draft-001"',
      'reviewId: "review-001"',
      `evidenceSnapshotHash: "${FIXTURE_EVIDENCE_HASH}"`,
      `contentHash: "${sha256(DEFAULT_BODY)}"`,
      `publishedAt: "${FIXTURE_NOW}"`,
      'authoritySourceIds: ["source-001","source-002"]',
      'appliedRuleIds: ["rule-001","rule-002"]',
      '---',
    ])
  })

  it('rejects a missing leading frontmatter block', () => {
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: 'content/en/articles/article.md', markdown: '# article' })
    expect(result).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_MISSING' })
  })

  it('rejects a missing frontmatter field', () => {
    const artifact = makeArtifactMarkdown()
    const markdown = artifact.markdown.replace(/^reviewId: .*\n/m, '')
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown })
    expect(result).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
  })

  it('rejects an unknown security-sensitive frontmatter key', () => {
    const artifact = makeArtifactMarkdown()
    const markdown = artifact.markdown.replace(/^title: /m, 'secret: ')
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown })
    expect(result).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_UNKNOWN_KEY' })
  })

  it('rejects duplicate frontmatter keys', () => {
    const artifact = makeArtifactMarkdown()
    const markdown = artifact.markdown.replace(/^title: .*\n/m, match => `${match}${match}`)
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown })
    expect(result).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_DUPLICATE' })
  })

  it('rejects a second leading-style frontmatter block in the body', () => {
    const artifact = makeArtifactMarkdown()
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: `${artifact.markdown}\n---\ntitle: "fake"\n---\n` })
    expect(result).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_DUPLICATE' })
  })

  it('rejects frontmatter title newline injection', () => {
    const artifact = makeArtifactMarkdown()
    const markdown = replaceFrontmatter(artifact.markdown, 'title', JSON.stringify('safe\n---\nsecret: leaked'))
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown })
    expect(result).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
  })

  it('accepts quotes without treating them as frontmatter injection', () => {
    const publication = makePublication({ title: 'Quoted "article"' })
    const result = parsePublication(publication)
    expect(result.status).toBe('verified')
  })

  it('rejects malformed evidence hash and uppercase evidence hash', () => {
    const artifact = makeArtifactMarkdown()
    const malformed = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'evidenceSnapshotHash', JSON.stringify('not-a-hash')) })
    const uppercase = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'evidenceSnapshotHash', JSON.stringify(FIXTURE_EVIDENCE_HASH.toUpperCase())) })
    expect(malformed).toMatchObject({ status: 'blocked', code: 'EVIDENCE_HASH_INVALID' })
    expect(uppercase).toMatchObject({ status: 'blocked', code: 'EVIDENCE_HASH_INVALID' })
  })

  it('rejects a wrong content hash and body hash mismatch', () => {
    const artifact = makeArtifactMarkdown()
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'contentHash', JSON.stringify('b'.repeat(64))) })
    expect(result).toMatchObject({ status: 'blocked', code: 'BODY_HASH_MISMATCH' })
  })

  it('rejects invalid language and content type', () => {
    const artifact = makeArtifactMarkdown()
    const language = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'language', JSON.stringify('fr')) })
    const contentType = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'contentType', JSON.stringify('landing')) })
    expect(language).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
    expect(contentType).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
  })

  it('rejects invalid slug, encoded traversal and unsafe source paths', () => {
    const artifact = makeArtifactMarkdown()
    const invalidSlug = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'slug', JSON.stringify('Bad Slug')) })
    const encodedSlug = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: replaceFrontmatter(artifact.markdown, 'slug', JSON.stringify('safe%2fpath')) })
    const traversalPath = parsePublication(makePublication(), 'content/en/articles/../private/verified-first-party-article.md')
    const encodedPath = parsePublication(makePublication(), 'content/en/articles/%2e%2e/verified-first-party-article.md')
    expect(invalidSlug.status).toBe('blocked')
    expect(encodedSlug.status).toBe('blocked')
    expect(traversalPath).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
    expect(encodedPath).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
  })

  it('rejects absolute, query, fragment, duplicate slash and backslash source paths', () => {
    const absolute = parsePublication(makePublication(), '/etc/verified-first-party-article.md')
    const query = parsePublication(makePublication(), 'content/en/articles/verified-first-party-article.md?x=1')
    const fragment = parsePublication(makePublication(), 'content/en/articles/verified-first-party-article.md#x')
    const duplicateSlash = parsePublication(makePublication(), 'content/en//articles/verified-first-party-article.md')
    const backslash = parsePublication(makePublication(), 'content/en/articles\\verified-first-party-article.md')
    expect(absolute).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
    expect(query).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
    expect(fragment).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
    expect(duplicateSlash).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
    expect(backslash).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
  })

  it('requires sourcePath to be under the configured content root and not title-derived', () => {
    const artifact = makeArtifactMarkdown(makePublication({ title: 'Title does not become the slug' }))
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: artifact.markdown })
    expect(result.status).toBe('verified')
    const wrongRoot = parseFirstPartyContentDocument({ contentRoot: 'docs', sourcePath: artifact.sourcePath, markdown: artifact.markdown })
    expect(wrongRoot).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
  })

  it('rejects missing and empty authority or rule arrays', () => {
    const base = makeArtifactMarkdown()
    const missingAuthorities = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: base.sourcePath, markdown: replaceFrontmatter(base.markdown, 'authoritySourceIds', '[]') })
    const missingRules = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: base.sourcePath, markdown: replaceFrontmatter(base.markdown, 'appliedRuleIds', '[]') })
    expect(missingAuthorities).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
    expect(missingRules).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
  })

  it('deduplicates only by rejection and sorts valid authority/rule arrays deterministically', () => {
    const artifact = makeArtifactMarkdown()
    const markdown = replaceFrontmatter(replaceFrontmatter(artifact.markdown, 'authoritySourceIds', '["source-002","source-001"]'), 'appliedRuleIds', '["rule-002","rule-001"]')
    const result = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown })
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.document.authoritySourceIds).toEqual(['source-001', 'source-002'])
      expect(result.document.appliedRuleIds).toEqual(['rule-001', 'rule-002'])
    }
    const duplicateMarkdown = replaceFrontmatter(artifact.markdown, 'authoritySourceIds', '["source-001","source-001"]')
    const duplicate = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.sourcePath, markdown: duplicateMarkdown })
    expect(duplicate).toMatchObject({ status: 'blocked', code: 'FRONTMATTER_FIELD_INVALID' })
  })

  it('rejects malformed input, arrays, null and hostile getters without throwing', () => {
    expect(parseFirstPartyContentDocument(null)).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
    expect(parseFirstPartyContentDocument([])).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
    expect(parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: 'content/a.md', markdown: 4 })).toMatchObject({ status: 'blocked', code: 'DOCUMENT_INVALID' })
    const hostile = Object.defineProperty({}, 'contentRoot', { get: () => { throw new Error('fixture getter') } })
    expect(parseFirstPartyContentDocument(hostile)).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
  })
})

describe('first-party content manifest', () => {
  it('sorts by language, contentType, slug, then publicationId', () => {
    const documents = [
      makeDocument({ language: 'zh-hant', slug: 'z-page', productionDeliverableId: 'publication-z' }),
      makeServiceDocument({ language: 'en', slug: 'a-service', productionDeliverableId: 'publication-service' }),
      makeFaqDocument({ language: 'en', slug: 'a-faq', productionDeliverableId: 'publication-faq' }),
      makeDocument({ language: 'en', slug: 'a-article', productionDeliverableId: 'publication-article' }),
    ]
    const result = buildFirstPartyContentManifest(documents.reverse())
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.manifest.documents.map(document => document.routePath)).toEqual(['/en/articles/a-article', '/en/faq/a-faq', '/en/services/a-service', '/zh-hant/articles/z-page'])
  })

  it('produces a stable manifest fingerprint independent of input order', () => {
    const documents = makePublicationSet(3)
    const first = buildFirstPartyContentManifest(documents)
    const second = buildFirstPartyContentManifest([...documents].reverse())
    expect(first.status).toBe('verified')
    expect(second.status).toBe('verified')
    if (first.status === 'verified' && second.status === 'verified') expect(first.manifest.manifestFingerprint).toBe(second.manifest.manifestFingerprint)
  })

  it('rejects duplicate publicationId', () => {
    const documents = [makeDocument(), makeDocument({ productionDeliverableId: 'publication-001', slug: 'different-page', draftId: 'draft-002', reviewId: 'review-002' })]
    expect(buildFirstPartyContentManifest(documents)).toMatchObject({ status: 'blocked', code: 'MANIFEST_COLLISION' })
  })

  it('rejects duplicate route and duplicate language/contentType/slug', () => {
    const duplicateRoute = [makeDocument(), makeDocument({ productionDeliverableId: 'publication-002', draftId: 'draft-002', reviewId: 'review-002' })]
    const duplicateSlug = [makeDocument(), makeDocument({ productionDeliverableId: 'publication-003', draftId: 'draft-003', reviewId: 'review-003' })]
    expect(buildFirstPartyContentManifest(duplicateRoute)).toMatchObject({ status: 'blocked', code: 'MANIFEST_COLLISION' })
    expect(buildFirstPartyContentManifest(duplicateSlug)).toMatchObject({ status: 'blocked', code: 'MANIFEST_COLLISION' })
  })

  it('rejects a same publication identity with a different body hash', () => {
    const first = makeDocument()
    const second = makeDocument({ productionDeliverableId: first.publicationIdentity.publicationId, body: 'different body', draftId: 'draft-002', reviewId: 'review-002' })
    expect(first.publicationIdentity.publicationId).toBe(second.publicationIdentity.publicationId)
    expect(first.bodyHash).not.toBe(second.bodyHash)
    expect(buildFirstPartyContentManifest([first, second])).toMatchObject({ status: 'blocked', code: 'MANIFEST_COLLISION' })
  })

  it('rejects 501 documents and non-verified candidates', () => {
    expect(buildFirstPartyContentManifest(makePublicationSet(501))).toMatchObject({ status: 'blocked', code: 'MANIFEST_TOO_LARGE' })
    expect(buildFirstPartyContentManifest([{ status: 'blocked' }])).toMatchObject({ status: 'blocked', code: 'DOCUMENT_INVALID' })
  })

  it('rejects malformed manifest inputs and hostile getters', () => {
    expect(buildFirstPartyContentManifest(null)).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
    expect(buildFirstPartyContentManifest({ documents: 'not-an-array' })).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('fixture proxy') } })
    expect(buildFirstPartyContentManifest(hostile)).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
  })
})

describe('public origin safety', () => {
  it.each([
    'http://client.example.com',
    'https://client.example.com/path',
    'https://client.example.com?query=1',
    'https://client.example.com#fragment',
    'https://user:pass@client.example.com',
    'https://client.example.com:444',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://169.254.1.1',
    'https://192.0.2.1',
    'https://client.local',
    'https://client.internal',
    'https://client.onion',
    'https://[::1]',
    'https://[fc00::1]',
    'https://[2001:db8::1]',
  ])('rejects unsafe public origin %s', origin => expect(isPublicHttpsOrigin(origin)).toBe(false))

  it('accepts only a normal public HTTPS origin', () => {
    expect(isPublicHttpsOrigin('https://client.example.com')).toBe(true)
  })
})

describe('malformed document wrappers', () => {
  it('does not accept parser result wrappers as raw documents', () => {
    const parsed = parsePublication()
    expect(buildFirstPartyContentManifest([parsed])).toMatchObject({ status: 'verified' })
    expect(buildFirstPartyContentManifest([{ status: 'verified', document: parsed }])).toMatchObject({ status: 'blocked', code: 'DOCUMENT_INVALID' })
  })
})


describe('SEO and metadata projection', () => {
  it('builds deterministic Article metadata and JSON-LD', () => {
    const document = makeDocument()
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.title).toBe(document.title)
      expect(result.canonicalUrl).toBe('https://client.example.com/en/articles/verified-first-party-article')
      expect(result.meta.robots).toBe('index, follow')
      expect(result.meta.openGraph.type).toBe('article')
      expect(result.meta.openGraph.publishedTime).toBe(document.publishedAt)
      expect(result.jsonLd[0]).toMatchObject({ '@type': 'Article', headline: document.title, datePublished: document.publishedAt })
      expect(result.jsonLd[0]?.mainEntityOfPage).toEqual({ '@type': 'WebPage', '@id': result.canonicalUrl })
      expect(JSON.stringify(result)).not.toContain('undefined')
    }
  })

  it('uses a bounded plain-text excerpt for description', () => {
    const document = makeDocument({ body: '# Heading\n\nA [trusted link](https://example.com) and `code`.' })
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.description).toContain(document.title)
      expect(result.description).toContain('trusted link')
      expect(result.description).not.toContain('https://')
      expect(result.description).not.toContain('`')
      expect(result.description.length).toBeLessThanOrEqual(160)
    }
  })

  it('truncates descriptions by Unicode code point without leaving a lone surrogate', () => {
    const document = makeDocument({ title: 'T', body: `${'a'.repeat(156)}😀tail` })
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(Array.from(result.description)).toHaveLength(160)
      expect(result.description.endsWith('😀')).toBe(true)
      expect(result.description).not.toContain('\uFFFD')
    }
  })

  it('builds exact breadcrumb items from the normalized route', () => {
    const document = makeDocument()
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.meta.breadcrumb).toEqual([
      { name: 'Home', item: 'https://client.example.com/' },
      { name: 'articles', item: 'https://client.example.com/en/articles' },
      { name: document.title, item: result.canonicalUrl },
    ])
  })

  it('emits hreflang alternates in stable language order', () => {
    const en = makeDocument()
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', scheduleEntryId: 'schedule-zh', productionPlanId: 'production-plan-001', jobId: 'job-zh', draftId: 'draft-zh', reviewId: 'review-zh' })
    const result = buildFirstPartySeoProjection(makeSeoInput(en, { alternateDocuments: [zh] }))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.meta.hreflang).toEqual([
      { language: 'en', href: 'https://client.example.com/en/articles/verified-first-party-article' },
      { language: 'zh-hant', href: 'https://client.example.com/zh-hant/articles/zh-article' },
    ])
  })

  it('does not emit x-default without an explicit fallback document', () => {
    const document = makeDocument()
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.meta.xDefault).toBeUndefined()
  })

  it('emits x-default only for an explicit alternate fallback', () => {
    const en = makeDocument()
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', scheduleEntryId: 'schedule-zh', productionPlanId: 'production-plan-001', jobId: 'job-zh', draftId: 'draft-zh', reviewId: 'review-zh' })
    const result = buildFirstPartySeoProjection(makeSeoInput(en, { alternateDocuments: [zh], fallbackDocument: zh }))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.meta.xDefault).toBe('https://client.example.com/zh-hant/articles/zh-article')
  })

  it('rejects a fallback document that is not an explicit alternate', () => {
    const document = makeDocument()
    const fallback = makeDocument({ language: 'zh-hant', slug: 'fallback', productionDeliverableId: 'publication-fallback', scheduleEntryId: 'schedule-fallback', productionPlanId: 'plan-fallback', jobId: 'job-fallback', draftId: 'draft-fallback', reviewId: 'review-fallback' })
    expect(buildFirstPartySeoProjection(makeSeoInput(document, { fallbackDocument: fallback }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('adds a verified organization logo without inventing organization claims', () => {
    const result = buildFirstPartySeoProjection(documentInput(makeDocument(), { organizationLogoUrl: 'https://client.example.com/assets/logo.svg' }))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.jsonLd[0]?.publisher).toEqual({ '@type': 'Organization', name: 'Client Example', logo: { '@type': 'ImageObject', url: 'https://client.example.com/assets/logo.svg' } })
      expect(JSON.stringify(result)).not.toMatch(/foundingDate|award|rating|reviewCount|traffic|ranking|ROI|author|dateModified/i)
    }
  })

  it('keeps the complete legacy Article JSON-LD node deep-equal when entity inputs are absent', () => {
    const document = makeDocument()
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    const canonicalUrl = 'https://client.example.com/en/articles/verified-first-party-article'
    expect(result.jsonLd[0]).toEqual({
      '@context': 'https://schema.org',
      '@id': `${canonicalUrl}#article`,
      url: canonicalUrl,
      name: document.title,
      inLanguage: document.language,
      isPartOf: { '@type': 'WebSite', name: 'Client Example', url: 'https://client.example.com/' },
      publisher: { '@type': 'Organization', name: 'Client Example' },
      '@type': 'Article',
      headline: document.title,
      datePublished: document.publishedAt,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    })
  })

  it('blocks invalid entity references with ENTITY_INPUT_INVALID', () => {
    expect(buildFirstPartySeoProjection(documentInput(makeDocument(), {
      publisherEntity: { entityUid: 'org-1', name: '', kind: 'organization', secret: 'unknown' },
    }))).toMatchObject({ status: 'blocked', code: 'ENTITY_INPUT_INVALID' })
    expect(buildFirstPartySeoProjection(documentInput(makeDocument(), {
      authorEntities: [{ entityUid: 'person-1', name: 'Author', kind: 'person', url: 'http://example.com/author' }],
    }))).toMatchObject({ status: 'blocked', code: 'ENTITY_INPUT_INVALID' })
  })

  it('emits stable enriched publisher and author nodes', () => {
    const publisherEntity = { entityUid: 'ORG01', name: 'Real Publisher', kind: 'organization' as const, url: 'https://publisher.example.com/' }
    const authorEntities = [{ entityUid: 'PERSON01', name: 'Real Author', kind: 'person' as const, sameAs: ['https://profiles.example.com/author'] }]
    const result = buildFirstPartySeoProjection(documentInput(makeDocument(), { publisherEntity, authorEntities }))
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.jsonLd[0]?.publisher).toEqual({ '@type': 'Organization', '@id': knowledgeEntityJsonLdId('https://client.example.com', 'ORG01'), name: 'Real Publisher', url: 'https://publisher.example.com/' })
    expect(result.jsonLd[0]?.author).toEqual([{ '@type': 'Person', '@id': knowledgeEntityJsonLdId('https://client.example.com', 'PERSON01'), name: 'Real Author', sameAs: ['https://profiles.example.com/author'] }])
    expect(buildKnowledgeArticleJsonLd({ siteOrigin: 'https://client.example.com', article: { headline: 'Knowledge article', articleId: 'https://client.example.com/article#article' }, publisherEntity, authorEntities })).toMatchObject({ status: 'verified', jsonLd: { '@type': 'Article', publisher: { '@id': knowledgeEntityJsonLdId('https://client.example.com', 'ORG01') }, author: [{ '@id': knowledgeEntityJsonLdId('https://client.example.com', 'PERSON01') }] } })
  })

  it('builds FAQPage only when verified FAQ pairs are present', () => {
    const document = makeFaqDocument()
    const withoutPairs = buildFirstPartySeoProjection(documentInput(document))
    const withPairs = buildFirstPartySeoProjection(makeSeoInput(document, { faqPairs: makeBoundFaqEnvelope(document) }))
    expect(withoutPairs.status).toBe('verified')
    expect(withPairs.status).toBe('verified')
    if (withoutPairs.status === 'verified' && withPairs.status === 'verified') {
      expect(withoutPairs.meta.openGraph.type).toBe('website')
      expect(withPairs.meta.openGraph.type).toBe('website')
      expect(withoutPairs.jsonLd.some(item => item['@type'] === 'FAQPage')).toBe(false)
      expect(withPairs.jsonLd.some(item => item['@type'] === 'FAQPage')).toBe(true)
      expect(withPairs.jsonLd.find(item => item['@type'] === 'FAQPage')).toMatchObject({ mainEntity: [{ name: 'What is verified?', acceptedAnswer: { text: 'It is a tested content document.' } }] })
    }
  })

  it('rejects FAQ pairs for non-FAQ documents and malformed pairs', () => {
    const article = makeDocument()
    const nonFaq = buildFirstPartySeoProjection(makeSeoInput(article, { faqPairs: [{ question: 'q', answer: 'a' }] }))
    const malformed = buildFirstPartySeoProjection(makeSeoInput(makeFaqDocument(), { faqPairs: [{ question: 'q', answer: 4 }] }))
    expect(nonFaq).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
    expect(malformed).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
  })

  it('uses WebPage for service pages without inventing offers or prices', () => {
    const result = buildFirstPartySeoProjection(documentInput(makeServiceDocument()))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.meta.openGraph.type).toBe('website')
      expect(result.jsonLd[0]).toMatchObject({ '@type': 'WebPage' })
      expect(JSON.stringify(result)).not.toMatch(/price|offer|rating|review/i)
    }
  })

  it.each([
    'http://client.example.com',
    'https://client.example.com/path',
    'https://client.example.com?x=1',
    'https://client.example.com#x',
    'https://user:pass@client.example.com',
    'https://client.example.com:444',
    'https://localhost',
    'https://10.0.0.1',
    'https://[::1]',
  ])('blocks unsafe canonical site origin %s', origin => expect(buildFirstPartySeoProjection(documentInput(makeDocument(), { siteOrigin: origin }))).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' }))

  it('blocks invalid site name, invalid logo and unknown SEO keys', () => {
    expect(buildFirstPartySeoProjection(documentInput(makeDocument(), { siteName: '' }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
    expect(buildFirstPartySeoProjection(documentInput(makeDocument(), { organizationLogoUrl: 'http://client.example.com/logo.svg' }))).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' })
    expect(buildFirstPartySeoProjection(documentInput(makeDocument(), { unsafe: 'value' }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('blocks malformed, duplicate and unsafe alternate documents', () => {
    const document = makeDocument()
    const duplicate = buildFirstPartySeoProjection(makeSeoInput(document, { alternateDocuments: [document] }))
    const malformed = buildFirstPartySeoProjection(makeSeoInput(document, { alternateDocuments: [{ status: 'verified' }] }))
    expect(duplicate).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
    expect(malformed).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('produces a sitemap entry with canonical lastmod and alternate links', () => {
    const document = makeDocument()
    const result = buildFirstPartySeoProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') expect(result.sitemap).toEqual({ loc: result.canonicalUrl, lastmod: document.publishedAt, alternates: [{ language: 'en', href: result.canonicalUrl }] })
  })

  it('has a stable SEO projection for identical input', () => {
    const input = documentInput(makeDocument())
    expect(JSON.stringify(buildFirstPartySeoProjection(input))).toBe(JSON.stringify(buildFirstPartySeoProjection(input)))
  })
})

describe('Astro and Nuxt headless projections', () => {
  it('builds an Astro collection-compatible projection', () => {
    const document = makeDocument()
    const result = buildAstroContentProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.framework).toBe('astro')
      expect(result.routeParams).toEqual({ lang: 'en', slug: document.slug })
      expect(result.collection).toMatchObject({ id: document.sourcePath, body: document.body })
      expect(result.pageProps.document.publicationIdentity.publicationId).toBe(document.publicationIdentity.publicationId)
      expect(result.head).toEqual(result.pageProps.seo.meta)
      expect(result.jsonLd).toEqual(result.pageProps.seo.jsonLd)
    }
  })

  it('builds a Nuxt useHead-compatible projection', () => {
    const document = makeDocument({ language: 'zh-hant', slug: 'nuxt-article' })
    const result = buildNuxtContentProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.framework).toBe('nuxt')
      expect(result.routeParams).toEqual({ lang: 'zh-hant', slug: 'nuxt-article' })
      expect(result.pageData.document.routePath).toBe('/zh-hant/articles/nuxt-article')
      expect(result.useHead.title).toBe(document.title)
      expect(result.useHead.htmlAttrs).toEqual({ lang: 'zh-hant' })
      expect(Array.isArray(result.useHead.meta)).toBe(true)
      expect(Array.isArray(result.useHead.link)).toBe(true)
      expect(Array.isArray(result.useHead.script)).toBe(true)
      expect(result.useHead.meta).toEqual(expect.arrayContaining([
        { name: 'description', content: result.pageData.seo.description },
        { name: 'robots', content: 'index, follow' },
        { property: 'og:type', content: 'article' },
        { property: 'og:title', content: document.title },
        { property: 'og:description', content: result.pageData.seo.description },
        { property: 'og:url', content: result.pageData.seo.canonicalUrl },
        { property: 'og:locale', content: 'zh-hant' },
        { property: 'article:published_time', content: document.publishedAt },
      ]))
      expect(result.useHead.link).toEqual(expect.arrayContaining([
        { rel: 'canonical', href: result.pageData.seo.canonicalUrl },
        { rel: 'alternate', href: result.pageData.seo.canonicalUrl, hreflang: 'zh-hant' },
      ]))
      expect(result.useHead.script).toEqual([{ type: 'application/ld+json', textContent: JSON.stringify(result.jsonLd[0]) }])
      expect(result.sitemap).toEqual(result.pageData.seo.sitemap)
    }
  })

  it('keeps Astro and Nuxt canonical, JSON-LD and identity parity', () => {
    const document = makeDocument()
    const input = documentInput(document)
    const astro = buildAstroContentProjection(input)
    const nuxt = buildNuxtContentProjection(input)
    expect(astro.status).toBe('verified')
    expect(nuxt.status).toBe('verified')
    if (astro.status === 'verified' && nuxt.status === 'verified') {
      expect(astro.pageProps.seo.canonicalUrl).toBe(nuxt.pageData.seo.canonicalUrl)
      expect(astro.pageProps.seo.description).toBe(nuxt.pageData.seo.description)
      expect(astro.jsonLd).toEqual(nuxt.jsonLd)
      expect(astro.pageProps.document.publicationIdentity).toEqual(nuxt.pageData.document.publicationIdentity)
    }
  })

  it('contains no CSS, color, font, layout or visual component fields', () => {
    const input = documentInput(makeDocument())
    const astro = buildAstroContentProjection(input)
    const nuxt = buildNuxtContentProjection(input)
    expect(JSON.stringify(astro)).not.toMatch(/css|color|font|layout|component/i)
    expect(JSON.stringify(nuxt)).not.toMatch(/css|color|font|layout|component/i)
  })

  it('propagates blocked SEO inputs without fetching, writing or throwing', () => {
    const input = documentInput(makeDocument(), { siteOrigin: 'http://localhost' })
    expect(buildAstroContentProjection(input)).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' })
    expect(buildNuxtContentProjection(input)).toMatchObject({ status: 'blocked', code: 'ORIGIN_INVALID' })
    expect(buildAstroContentProjection(null)).toMatchObject({ status: 'blocked', code: 'PROJECTION_INVALID' })
    expect(buildNuxtContentProjection([])).toMatchObject({ status: 'blocked', code: 'PROJECTION_INVALID' })
  })

  it('accepts only verified normalized document inputs', () => {
    const malformedDocument = { status: 'verified', title: 'fake' } as unknown as ReturnType<typeof makeDocument>
    expect(buildAstroContentProjection(makeSeoInput(malformedDocument))).toMatchObject({ status: 'blocked', code: 'PROJECTION_INVALID' })
    expect(buildNuxtContentProjection(makeSeoInput(malformedDocument))).toMatchObject({ status: 'blocked', code: 'PROJECTION_INVALID' })
  })

  it('preserves the document body and content hash in both projections', () => {
    const document = makeDocument()
    const astro = buildAstroContentProjection(documentInput(document))
    const nuxt = buildNuxtContentProjection(documentInput(document))
    expect(astro.status).toBe('verified')
    expect(nuxt.status).toBe('verified')
    if (astro.status === 'verified' && nuxt.status === 'verified') {
      expect(astro.collection.body).toBe(document.body)
      expect(astro.collection.data.bodyHash).toBe(document.bodyHash)
      expect(nuxt.pageData.document.bodyHash).toBe(document.bodyHash)
    }
  })
})


describe('first-party content site kit repair contracts', () => {
  it('uses the same code-unit ordering for parser and manifest', () => {
    const values = ['a-', 'a_', 'A', 'a', 'source:1', 'source.1']
    const publication = makePublication({ authoritySourceIds: values, ruleIds: values })
    const parsed = parsePublication(publication)
    expect(parsed.status).toBe('verified')
    if (parsed.status !== 'verified') return
    expect(parsed.document.authoritySourceIds).toEqual(['A', 'a', 'a-', 'a_', 'source.1', 'source:1'])
    expect(parsed.document.appliedRuleIds).toEqual(['A', 'a', 'a-', 'a_', 'source.1', 'source:1'])
    const manifest = buildFirstPartyContentManifest([parsed])
    expect(manifest.status).toBe('verified')
    if (manifest.status === 'verified') {
      expect(manifest.manifest.documents[0]?.authoritySourceIds).toEqual(parsed.document.authoritySourceIds)
      expect(manifest.manifest.documents[0]?.appliedRuleIds).toEqual(parsed.document.appliedRuleIds)
    }
  })

  it('keeps parser and manifest fingerprints stable across repeated runs and input order', () => {
    const values = ['a-', 'a_', 'A', 'a', 'source:1', 'source.1']
    const firstParsed = parsePublication(makePublication({ authoritySourceIds: values, ruleIds: values }))
    const secondParsed = parsePublication(makePublication({ authoritySourceIds: [...values].reverse(), ruleIds: [...values].reverse() }))
    expect(firstParsed.status).toBe('verified')
    expect(secondParsed.status).toBe('verified')
    if (firstParsed.status === 'verified' && secondParsed.status === 'verified') {
      expect(firstParsed.document.documentFingerprint).toBe(secondParsed.document.documentFingerprint)
      const firstManifest = buildFirstPartyContentManifest([firstParsed.document])
      const secondManifest = buildFirstPartyContentManifest([secondParsed.document])
      expect(firstManifest.status).toBe('verified')
      expect(secondManifest.status).toBe('verified')
      if (firstManifest.status === 'verified' && secondManifest.status === 'verified') expect(firstManifest.manifest.manifestFingerprint).toBe(secondManifest.manifest.manifestFingerprint)
    }
  })

  it.each([
    ['en', 'article', 'content/en/articles/path-article.md'],
    ['zh-hant', 'article', 'content/zh-hant/articles/path-article.md'],
    ['en', 'faq', 'content/en/faq/path-faq.md'],
    ['zh-hant', 'service_page', 'content/zh-hant/services/path-service.md'],
  ] as const)('binds %s %s sourcePath to the exact formal route segment', (language, contentType, sourcePath) => {
    const slug = sourcePath.split('/').at(-1)?.replace(/\.md$/, '') ?? 'path'
    const parsed = parsePublication(makePublication({ language, contentType, slug, productionDeliverableId: `publication-${language}-${contentType}`, draftId: `draft-${language}-${contentType}`, reviewId: `review-${language}-${contentType}` }), sourcePath)
    expect(parsed.status).toBe('verified')
    if (parsed.status === 'verified') expect(parsed.document.sourcePath).toBe(sourcePath)
  })

  it.each([
    'content/zh-hant/articles/verified-first-party-article.md',
    'content/en/faq/verified-first-party-article.md',
    'content/en/articles/other-slug.md',
  ])('blocks a sourcePath that mismatches language, contentType folder, or slug: %s', sourcePath => {
    expect(parsePublication(makePublication(), sourcePath)).toMatchObject({ status: 'blocked', code: 'PATH_INVALID' })
  })

  it('accepts ordinary article text containing non-finite words without false JSON rejection', () => {
    const document = makeDocument({ body: 'undefined NaN Infinity -Infinity' })
    const seo = buildFirstPartySeoProjection(documentInput(document))
    const astro = buildAstroContentProjection(documentInput(document))
    const nuxt = buildNuxtContentProjection(documentInput(document))
    expect(seo.status).toBe('verified')
    expect(astro.status).toBe('verified')
    expect(nuxt.status).toBe('verified')
  })

  it.each([null, true, false, 'undefined', 'NaN', 'Infinity', '-Infinity', 0, 1.5, [], {}])('accepts a JSON-safe primitive or plain container: %s', value => {
    expect(isJsonSafe(value)).toBe(true)
    expect(safeJsonStringify(value)).toBeTypeOf('string')
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, () => 'function', Symbol('symbol'), 1n])('rejects a non-JSON-safe runtime value without throwing', value => {
    expect(() => isJsonSafe(value)).not.toThrow()
    expect(isJsonSafe(value)).toBe(false)
    expect(safeJsonStringify(value)).toBeUndefined()
  })

  it('rejects circular JSON input without throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => safeJsonStringify(circular)).not.toThrow()
    expect(safeJsonStringify(circular)).toBeUndefined()
  })

  it('rejects getter and Proxy exceptions without exposing a raw error', () => {
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('getter fixture') } })
    const proxy = new Proxy({ value: 'safe' }, { get: () => { throw new Error('proxy fixture') } })
    expect(() => safeJsonStringify(getter)).not.toThrow()
    expect(() => safeJsonStringify(proxy)).not.toThrow()
    expect(safeJsonStringify(getter)).toBeUndefined()
    expect(safeJsonStringify(proxy)).toBeUndefined()
  })

  it('rejects accessors and non-enumerable data instead of silently omitting hidden fields', () => {
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'safe-looking' })
    const hidden = Object.defineProperty({}, 'hiddenSecret', { enumerable: false, value: 'must-not-survive' })
    expect(isJsonSafe(accessor)).toBe(false)
    expect(isJsonSafe(hidden)).toBe(false)
    expect(safeJsonStringify(accessor)).toBeUndefined()
    expect(safeJsonStringify(hidden)).toBeUndefined()

    const document = makeDocument() as ReturnType<typeof makeDocument> & { hiddenSecret?: string }
    Object.defineProperty(document, 'hiddenSecret', { enumerable: false, value: 'must-not-survive' })
    expect(buildAstroContentProjection(documentInput(document))).toMatchObject({ status: 'blocked' })
    expect(buildNuxtContentProjection(documentInput(document))).toMatchObject({ status: 'blocked' })
  })

  it('rejects hreflang alternates from a different content type or production plan', () => {
    const article = makeDocument()
    const faq = makeFaqDocument({ language: 'zh-hant', productionPlanId: article.publicationIdentity.productionPlanId })
    const differentPlan = makeDocument({ language: 'zh-hant', slug: 'different-plan', productionDeliverableId: 'publication-different-plan', productionPlanId: 'different-plan', draftId: 'draft-different-plan', reviewId: 'review-different-plan' })
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { alternateDocuments: [faq] }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { alternateDocuments: [differentPlan] }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('rejects duplicate hreflang language, fingerprint, route, and the primary document', () => {
    const article = makeDocument()
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', productionPlanId: article.publicationIdentity.productionPlanId, draftId: 'draft-zh', reviewId: 'review-zh' })
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { alternateDocuments: [article] }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { alternateDocuments: [zh, zh] }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('fails closed when fallbackDocument and xDefaultDocument are both supplied', () => {
    const article = makeDocument()
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', productionPlanId: article.publicationIdentity.productionPlanId, draftId: 'draft-zh', reviewId: 'review-zh' })
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { alternateDocuments: [zh], fallbackDocument: zh, xDefaultDocument: zh }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('rejects the primary document as an x-default fallback', () => {
    const article = makeDocument()
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { fallbackDocument: article }))).toMatchObject({ status: 'blocked', code: 'SEO_INPUT_INVALID' })
  })

  it('blocks raw FAQ arrays instead of treating them as verified evidence', () => {
    const faq = makeFaqDocument()
    expect(buildFirstPartySeoProjection(makeSeoInput(faq, { faqPairs: [{ question: 'raw', answer: 'not bound' }] }))).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
  })

  it('blocks stale FAQ document fingerprint, evidence hash, and pairs fingerprint', () => {
    const faq = makeFaqDocument()
    const envelope = makeBoundFaqEnvelope(faq)
    expect(buildFirstPartySeoProjection(makeSeoInput(faq, { faqPairs: { ...envelope, documentFingerprint: 'b'.repeat(64) } }))).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
    expect(buildFirstPartySeoProjection(makeSeoInput(faq, { faqPairs: { ...envelope, evidenceSnapshotHash: 'b'.repeat(64) } }))).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
    expect(buildFirstPartySeoProjection(makeSeoInput(faq, { faqPairs: { ...envelope, pairsFingerprint: 'b'.repeat(64) } }))).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
  })

  it('blocks duplicate FAQ questions and an FAQ envelope on an article', () => {
    const faq = makeFaqDocument()
    const duplicate = makeBoundFaqEnvelope(faq, [{ question: 'same', answer: 'one' }, { question: 'same', answer: 'two' }])
    const article = makeDocument()
    const articleEnvelope = makeBoundFaqEnvelope(article)
    expect(buildFirstPartySeoProjection(makeSeoInput(faq, { faqPairs: duplicate }))).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
    expect(buildFirstPartySeoProjection(makeSeoInput(article, { faqPairs: articleEnvelope }))).toMatchObject({ status: 'blocked', code: 'FAQ_PAIRS_INVALID' })
  })

  it('serializes Nuxt JSON-LD scripts deterministically and escapes less-than safely', () => {
    const document = makeDocument({ title: '</script><script>alert(1)</script>' })
    const result = buildNuxtContentProjection(documentInput(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.useHead.script).toHaveLength(result.jsonLd.length)
      expect(result.useHead.script.every(script => script.type === 'application/ld+json')).toBe(true)
      expect(result.useHead.script.every(script => !script.textContent.includes('</script>'))).toBe(true)
      expect(result.useHead.script[0]?.textContent).toContain('\\u003C/script>')
      expect(result.useHead.script[0]?.textContent).toBe(JSON.stringify(result.jsonLd[0]).replace(/</g, '\\u003C'))
    }
  })

  it('emits x-default and every alternate as direct useHead links', () => {
    const article = makeDocument()
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', productionPlanId: article.publicationIdentity.productionPlanId, draftId: 'draft-zh', reviewId: 'review-zh' })
    const result = buildNuxtContentProjection(makeSeoInput(article, { alternateDocuments: [zh], fallbackDocument: zh }))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      expect(result.useHead.link).toEqual(expect.arrayContaining([
        { rel: 'canonical', href: result.pageData.seo.canonicalUrl },
        { rel: 'alternate', href: 'https://client.example.com/en/articles/verified-first-party-article', hreflang: 'en' },
        { rel: 'alternate', href: 'https://client.example.com/zh-hant/articles/zh-article', hreflang: 'zh-hant' },
        { rel: 'alternate', href: 'https://client.example.com/zh-hant/articles/zh-article', hreflang: 'x-default' },
      ]))
    }
  })

  it('exposes the legacy and entity-aware runtime public APIs', () => {
    expect(Object.keys(contentSiteKitApi).sort()).toEqual([
      'buildAstroContentProjection',
      'buildFirstPartyContentManifest',
      'buildFirstPartySeoProjection',
      'buildKnowledgeArticleJsonLd',
      'buildNuxtContentProjection',
      'knowledgeEntityJsonLdId',
      'parseFirstPartyContentDocument',
    ])
    expect('computeSeoProjectionFingerprint' in contentSiteKitApi).toBe(false)
  })
})
