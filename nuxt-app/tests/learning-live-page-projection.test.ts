import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildPlannedLiveAction,
  livePageMatchesExpected,
  projectExpectedLiveDocument,
  projectLivePage,
  renderLiveContentArticle,
  verifyLivePageProjection,
  verifyPlannedLiveAction,
  type LiveDocumentInput,
} from '../server/learning-loop/live-page-projection'

const url = 'https://customer.example.test/zh-hant/articles/geo-content'
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function input(title = 'DiscoveryStack GEO', body = '## 受控頁面\n\n這是 **經審核** 的內容。\n\n- 第一項\n- [官方資料](https://docs.example.test/guide)'): LiveDocumentInput {
  return { publicationId: 'deliverable-17', draftId: 'draft-22', reviewId: 'review-31', contentHash: sha(body), evidenceSnapshotHash: 'a'.repeat(64), title, body }
}
function page(document: LiveDocumentInput, article = renderLiveContentArticle(document)!, canonical = url): string {
  return `<!doctype html><!-- safe shell comment --><html lang='zh-hant' class='site'><head><meta charset="utf-8"><title>Site title</title><link rel='stylesheet' href='/assets/site.css'><script>globalThis.ready = 1 < 2;</script><style>.page { color: navy }</style><link rel="canonical" href="${canonical}"></head><body class="layout"><header id="site-header"><a href="mailto:help@example.test">help@example.test</a></header><div id="app"><main class='page'>${article}</main></div><footer>Contact 415-555-0198</footer></body></html>`
}

describe('learning live page projection', () => {
  it('projects controlled English and Traditional Chinese content to hash-only fields', () => {
    const doc = input('English title', 'A paragraph with **bold** and *emphasis*.')
    const expected = projectExpectedLiveDocument(doc, url)!
    const actual = projectLivePage({ html: page(doc), status: 200, url })!
    expect(verifyLivePageProjection(expected)).toBe(true)
    expect(verifyLivePageProjection(actual)).toBe(true)
    expect(livePageMatchesExpected(actual, expected)).toBe(true)
    expect(actual.responseHash).not.toBe(expected.responseHash)
    expect(JSON.stringify(actual)).not.toContain('English title')
    expect(JSON.stringify(actual)).not.toContain('paragraph with')
    expect(JSON.stringify(actual)).not.toContain('customer.example.test')
    const zh = input()
    expect(livePageMatchesExpected(projectLivePage({ html: page(zh), status: 200, url })!, projectExpectedLiveDocument(zh, url)!)).toBe(true)
  })

  it('rejects body changes despite correct marker hashes and binds exact page URL', () => {
    const doc = input()
    const mutated = page(doc).replace('經審核', '已竄改')
    expect(projectLivePage({ html: mutated, status: 200, url })).not.toBeNull()
    expect(livePageMatchesExpected(projectLivePage({ html: mutated, status: 200, url })!, projectExpectedLiveDocument(doc, url)!)).toBe(false)
    expect(projectLivePage({ html: page(doc), status: 200, url: 'https://customer.example.test/other' })).toBeNull()
  })

  it('rejects duplicate roots, duplicate attributes, hidden and active markup', () => {
    const doc = input()
    const article = renderLiveContentArticle(doc)!
    for (const [index, bad] of [
      page(doc, article + article),
      page(doc, article.replace('data-ds-live-content="v1"', 'data-ds-live-content="v1" data-ds-live-content="v1"')),
      page(doc, article.replace('<section data-ds-live-body="">', '<section hidden data-ds-live-body="">')),
      page(doc, article).replace('<main class=\'page\'>', '<main class=\'page\' hidden>'),
      page(doc, article).replace('<main class=\'page\'>', '<main class=\'page\' style=\'display:none\'>'),
      page(doc, article).replace("<html lang='zh-hant'", "<html hidden lang='zh-hant'"),
      page(doc, article).replace('<body class="layout">', '<body aria-hidden="true" class="layout">'),
      page(doc, article).replace('<div id="app">', '<div id="app" style="visibility: hidden">'),
      page(doc, article).replace('<div id="app">', '<div id="app" inert>'),
      page(doc, article.replace('</section>', '<script>alert(1)</script></section>')),
      page(doc, article.replace('</section>', '<iframe src="https://evil.example.test"></iframe></section>')),
      page(doc).replace('</head>', '<link rel="canonical" href="' + url + '"></head>'),
    ].entries()) expect(projectLivePage({ html: bad, status: 200, url }), `case ${index}`).toBeNull()
  })

  it('decodes valid entities but rejects malformed or unsupported entity/HTML semantics', () => {
    const doc = input('AT&amp;T &amp; GEO', 'A &amp; B and &#x4E2D;&#25991;.')
    expect(livePageMatchesExpected(projectLivePage({ html: page(doc), status: 200, url })!, projectExpectedLiveDocument(doc, url)!)).toBe(true)
    expect(projectLivePage({ html: page(doc).replace('AT&amp;T', 'AT&unknown;'), status: 200, url })).toBeNull()
    expect(renderLiveContentArticle(input('Title', '<script>unsafe</script>'))).toBeNull()
    expect(renderLiveContentArticle(input('Title', '```\ncode\n```'))).toBeNull()
    const punctuation = input('AT&T!', 'People use 100% of ideas! R&D matters; 5 < 7 and 9 > 3.')
    expect(livePageMatchesExpected(projectLivePage({ html: page(punctuation), status: 200, url })!, projectExpectedLiveDocument(punctuation, url)!)).toBe(true)
  })

  it('preserves Unicode normalization and rejects malformed surrogate or unsupported inline syntax', () => {
    const doc = input('Café', 'Café and 漢字.')
    expect(livePageMatchesExpected(projectLivePage({ html: page(doc), status: 200, url })!, projectExpectedLiveDocument(doc, url)!)).toBe(true)
    expect(renderLiveContentArticle(input('Title', '![image](https://img.example.test/x.png)'))).toBeNull()
    expect(renderLiveContentArticle(input('Title', 'Text with `code`'))).toBeNull()
    expect(renderLiveContentArticle(input('Title', ''))).toBeNull()
    expect(renderLiveContentArticle(input('Title', `bad ${String.fromCharCode(0xd800)} surrogate`))).toBeNull()
    const endingHighSurrogate = String.fromCharCode(0xd800)
    expect(projectExpectedLiveDocument(input(`title${endingHighSurrogate}`, 'valid body'), url)).toBeNull()
    expect(projectExpectedLiveDocument(input('valid title', `body${endingHighSurrogate}`), url)).toBeNull()
    expect(projectLivePage({ html: page(input()).replace('</footer>', `${endingHighSurrogate}</footer>`), status: 200, url })).toBeNull()
  })

  it('enforces source and unit bounds and scans PII before returning hashes', () => {
    expect(projectExpectedLiveDocument(input('Title', 'x'.repeat(256 * 1024 + 1)), url)).toBeNull()
    const tooMany = Array.from({ length: 513 }, (_, index) => `line ${index}`).join('\n\n')
    expect(projectExpectedLiveDocument(input('Title', tooMany), url)).toBeNull()
    expect(projectExpectedLiveDocument(input('Person', 'Contact alice@example.test'), url)).toBeNull()
    expect(projectExpectedLiveDocument(input('Phone', 'Call +1 (415) 555-0123'), url)).toBeNull()
  })

  it('represents only a known exact-URL 404 as a new-page baseline without scanning its body', () => {
    const notFound = projectLivePage({ html: '<html><body>customer@example.test</body></html>', status: 404, url })!
    expect(notFound.kind).toBe('not_found')
    expect(notFound.bodyUnitHashes).toEqual([])
    expect(notFound.canonicalUrlHash).toBeNull()
    expect(verifyLivePageProjection(notFound)).toBe(true)
    expect(projectLivePage({ html: '', status: 404, url: 'https://customer.example.test/elsewhere' })?.urlHash).not.toBe(notFound.urlHash)
    expect(projectLivePage({ html: '', status: 500, url })).toBeNull()
  })

  it('computes covered deterministic LCS action features and rejects tampering/impossible counts', () => {
    const beforeDoc = input('Old title', 'one\n\ntwo\n\nkeep')
    const expectedDoc = input('New title', 'one\n\nreplacement\n\nkeep\n\nadded')
    const before = projectLivePage({ html: page(beforeDoc), status: 200, url })!
    const expected = projectExpectedLiveDocument(expectedDoc, url)!
    const action = buildPlannedLiveAction(before, expected)!
    expect(action.features).toMatchObject({ titleChanged: 1, paragraphsAdded: 1, paragraphsRemoved: 0, paragraphsReplaced: 1, paragraphsUnmodified: 2, beforeParagraphCount: 3, plannedParagraphCount: 4 })
    expect(verifyPlannedLiveAction(action, before, expected)).toBe(true)
    const forged = { ...action, features: { ...action.features, paragraphsAdded: 9 } }
    const { actionFingerprint: _oldFingerprint, ...forgedPayload } = forged
    forged.actionFingerprint = sha(`discoverystack-learning-planned-live-action-v1\n${JSON.stringify(forgedPayload)}`)
    expect(verifyPlannedLiveAction(forged, before, expected)).toBe(false)
    const newPage = projectLivePage({ html: '<html><body>anything</body></html>', status: 404, url })!
    expect(buildPlannedLiveAction(newPage, expected)?.features.newPage).toBe(1)
  })

  it('rejects getters, proxies, symbols, noncanonical hashes and raw extra fields in validators', () => {
    const doc = input()
    const projection = projectExpectedLiveDocument(doc, url)!
    const getter = Object.defineProperty({ ...projection }, 'urlHash', { get: () => projection.urlHash })
    const extra = { ...projection, url }
    const symbol = { ...projection, [Symbol('extra')]: true }
    const badHash = { ...projection, urlHash: projection.urlHash.toUpperCase() }
    expect(verifyLivePageProjection(getter)).toBe(false)
    expect(verifyLivePageProjection(extra)).toBe(false)
    expect(verifyLivePageProjection(symbol)).toBe(false)
    expect(verifyLivePageProjection(badHash)).toBe(false)
    expect(verifyLivePageProjection(new Proxy(projection, { ownKeys: () => { throw new Error('proxy') } }))).toBe(false)
  })
})
