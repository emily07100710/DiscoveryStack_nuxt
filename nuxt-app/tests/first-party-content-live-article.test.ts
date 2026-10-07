import { describe, expect, it } from 'vitest'
import { buildAstroContentProjection, buildFirstPartyLiveArticleProjection, buildNuxtContentProjection, parseFirstPartyContentDocument } from '../server/first-party-content-site-kit'
import { buildFirstPartyMarkdownArtifact } from '../server/first-party-publishing/artifact'
import { livePageMatchesExpected, projectLivePage } from '../server/learning-loop/live-page-projection'
import { CONTENT_ROOT, DEFAULT_BODY, FIXTURE_EVIDENCE_HASH, makePublication } from './fixtures/first-party-content-site-kit/fixtures'

const siteOrigin = 'https://client.example.com'
const siteName = 'Client Example'

function parsePublication(overrides: Parameters<typeof makePublication>[0] = {}) {
  const publication = makePublication(overrides)
  const artifact = buildFirstPartyMarkdownArtifact(CONTENT_ROOT, publication)
  if (artifact.status !== 'ok') throw new Error('synthetic publisher artifact failed')
  const parsed = parseFirstPartyContentDocument({ contentRoot: CONTENT_ROOT, sourcePath: artifact.artifact.path, markdown: `${artifact.artifact.frontmatter}\n${artifact.artifact.body}` })
  if (parsed.status !== 'verified') throw new Error('synthetic markdown parser failed')
  return { publication, document: parsed.document }
}

function input(document: unknown, overrides: Record<string, unknown> = {}) {
  return { document, siteOrigin, siteName, ...overrides }
}

function renderedShell(article: string, canonicalUrl: string, language = 'en') {
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>Client page</title><link rel="stylesheet" href="/assets/site.css"><script>globalThis.siteReady = true;</script><link rel="canonical" href="${canonicalUrl}"></head><body><header><nav aria-label="Primary">Home</nav></header><main class="content">${article}</main><footer>Client footer</footer></body></html>`
}

describe('first-party controlled live article fragment', () => {
  it('revalidates a formal publication artifact and matches Astro/Nuxt and live-page projections', () => {
    const { publication, document } = parsePublication()
    const astro = buildAstroContentProjection(input(document))
    const nuxt = buildNuxtContentProjection(input(document))
    const result = buildFirstPartyLiveArticleProjection(input(document))
    expect(astro.status).toBe('verified')
    expect(nuxt.status).toBe('verified')
    expect(result.status).toBe('verified')
    if (astro.status !== 'verified' || nuxt.status !== 'verified' || result.status !== 'verified') return
    expect(result.canonicalUrl).toBe(astro.pageProps.seo.canonicalUrl)
    expect(result.canonicalUrl).toBe(nuxt.pageData.seo.canonicalUrl)
    expect(result.documentFingerprint).toBe(document.documentFingerprint)
    expect(document.evidenceSnapshotHash).toBe(FIXTURE_EVIDENCE_HASH)
    expect(result.expectedProjection.contractVersion).toBe('learning-live-page-projection-v1')
    expect(result.controlledArticleHtml).toContain(`data-ds-publication-id="${publication.productionDeliverableId}"`)
    expect(result.controlledArticleHtml).toContain('data-ds-live-title')
    expect(result.controlledArticleHtml).toContain('data-ds-live-body')
    const rendered = renderedShell(result.controlledArticleHtml, result.canonicalUrl, document.language)
    const actual = projectLivePage({ html: rendered, status: 200, url: result.canonicalUrl })
    expect(actual).not.toBeNull()
    expect(livePageMatchesExpected(actual!, result.expectedProjection)).toBe(true)
    expect(result.controlledArticleHtml).toContain(DEFAULT_BODY)
    expect(result.controlledArticleHtml).not.toContain('<html')
    expect(result.controlledArticleHtml).not.toContain('<head')
  })

  it.each([
    ['en', 'article', 'article'], ['zh-hant', 'article', 'articles'],
    ['en', 'faq', 'faq'], ['zh-hant', 'faq', 'faq'],
    ['en', 'service_page', 'services'], ['zh-hant', 'service_page', 'services'],
  ] as const)('supports %s %s without guessing the route segment', (language, contentType, routeSegment) => {
    const slug = `${language}-${contentType.replace('_', '-')}`
    const body = contentType === 'faq' ? '## What is this?\n\nA verified answer.' : contentType === 'service_page' ? 'A verified service description.' : 'A verified article paragraph.'
    const { document } = parsePublication({ language, contentType, slug, title: `${language} ${contentType}`, productionDeliverableId: `publication-${slug}`, draftId: `draft-${slug}`, reviewId: `review-${slug}`, body })
    const result = buildFirstPartyLiveArticleProjection(input(document))
    expect(result.status).toBe('verified')
    if (result.status === 'verified') {
      const expectedSegment = routeSegment === 'article' ? 'articles' : routeSegment
      expect(result.canonicalUrl).toBe(`${siteOrigin}/${language}/${expectedSegment}/${slug}`)
      expect(livePageMatchesExpected(projectLivePage({ html: renderedShell(result.controlledArticleHtml, result.canonicalUrl, language), status: 200, url: result.canonicalUrl })!, result.expectedProjection)).toBe(true)
    }
  })

  it('does not match changed visible body text even if the article marker is otherwise valid', () => {
    const { document } = parsePublication()
    const result = buildFirstPartyLiveArticleProjection(input(document))
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    const changedShell = renderedShell(result.controlledArticleHtml.replace('verified first-party content body', 'tampered visible body'), result.canonicalUrl)
    const actual = projectLivePage({ html: changedShell, status: 200, url: result.canonicalUrl })
    expect(actual).not.toBeNull()
    expect(livePageMatchesExpected(actual!, result.expectedProjection)).toBe(false)
  })

  it('fails closed for invalid origin, forged wrappers, hash mismatch, unsupported Markdown, PII and active HTML', () => {
    const { document } = parsePublication()
    expect(buildFirstPartyLiveArticleProjection(input(document, { siteOrigin: 'http://client.example.com' }))).toMatchObject({ status: 'blocked' })
    expect(buildFirstPartyLiveArticleProjection(input(document, { siteOrigin: 'https://user:secret@client.example.com' }))).toMatchObject({ status: 'blocked' })
    expect(buildFirstPartyLiveArticleProjection({ ...input(document), status: 'verified' })).toMatchObject({ status: 'blocked' })
    expect(buildFirstPartyLiveArticleProjection(input({ status: 'verified', document }))).toMatchObject({ status: 'blocked' })

    const forgedHash = { ...document, bodyHash: 'f'.repeat(64) }
    expect(buildFirstPartyLiveArticleProjection(input(forgedHash))).toMatchObject({ status: 'blocked' })
    const { document: unsupported } = parsePublication({ body: '```js\nalert(1)\n```' })
    expect(buildFirstPartyLiveArticleProjection(input(unsupported))).toMatchObject({ status: 'blocked' })
    const { document: pii } = parsePublication({ body: 'Contact customer@example.com for details.' })
    expect(buildFirstPartyLiveArticleProjection(input(pii))).toMatchObject({ status: 'blocked' })
    const { document: activeHtml } = parsePublication({ body: '<script>alert(1)</script>' })
    expect(buildFirstPartyLiveArticleProjection(input(activeHtml))).toMatchObject({ status: 'blocked' })
  })

  it('rejects malformed getter and proxy inputs without throwing', () => {
    const { document } = parsePublication()
    const getterInput = { ...input(document) }
    Object.defineProperty(getterInput, 'siteOrigin', { enumerable: true, get: () => { throw new Error('no invoke') } })
    expect(buildFirstPartyLiveArticleProjection(getterInput)).toMatchObject({ status: 'blocked' })
    const hostile = new Proxy(input(document), { ownKeys: () => { throw new Error('hostile keys') } })
    expect(buildFirstPartyLiveArticleProjection(hostile)).toMatchObject({ status: 'blocked' })
  })

  it('rejects visible content whose source body hash no longer matches its normalized document', () => {
    const { document } = parsePublication()
    const altered = { ...document, body: `${document.body} modified`, bodyHash: document.bodyHash }
    expect(buildFirstPartyLiveArticleProjection(input(altered))).toMatchObject({ status: 'blocked' })
  })
})
