import { describe, expect, it } from 'vitest'
import {
  buildAstroContentProjection,
  buildFirstPartyContentManifest,
  buildFirstPartySeoProjection,
  buildNuxtContentProjection,
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
  makeDocument,
  makeFaqDocument,
  makePublication,
  makePublicationSet,
  makeSeoInput,
  makeServiceDocument,
  sha256,
} from './fixtures/first-party-content-site-kit/fixtures'
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
    const language = parsePublication(makePublication({ language: 'fr' as never }))
    const contentType = parsePublication(makePublication({ contentType: 'landing' as never }))
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
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', scheduleEntryId: 'schedule-zh', productionPlanId: 'plan-zh', jobId: 'job-zh', draftId: 'draft-zh', reviewId: 'review-zh' })
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
    const zh = makeDocument({ language: 'zh-hant', slug: 'zh-article', productionDeliverableId: 'publication-zh', scheduleEntryId: 'schedule-zh', productionPlanId: 'plan-zh', jobId: 'job-zh', draftId: 'draft-zh', reviewId: 'review-zh' })
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

  it('builds FAQPage only when verified FAQ pairs are present', () => {
    const document = makeFaqDocument()
    const withoutPairs = buildFirstPartySeoProjection(documentInput(document))
    const withPairs = buildFirstPartySeoProjection(makeSeoInput(document, { faqPairs: [{ question: 'What is verified?', answer: 'It is a tested content document.' }] }))
    expect(withoutPairs.status).toBe('verified')
    expect(withPairs.status).toBe('verified')
    if (withoutPairs.status === 'verified' && withPairs.status === 'verified') {
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
      expect(result.useHead).toEqual(result.pageData.seo.meta)
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
