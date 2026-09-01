import { describe, expect, it } from 'vitest'
import { buildSiteEvidenceFindings, type FindingInventoryItem } from '../server/site-evidence/findings'
import { extractHtmlSignals } from '../server/site-evidence/html'
import { normalizeUrl, urlHash } from '../server/site-evidence/normalization'

let nextId = 1
function page(url: string, patch: Partial<FindingInventoryItem> = {}): FindingInventoryItem {
  const normalizedUrl = normalizeUrl(url)
  return {
    id: nextId++, ownerUserId: 1, siteHost: 'example.com', url, normalizedUrl, urlHash: urlHash(url), lastScanId: 7, discoverySources: ['crawl'], canonicalUrl: null, robotsVerdict: 'allowed', robotsMatchedRule: null, metaRobots: null, xRobotsTag: null, httpStatus: 200, redirectChain: [], finalUrl: url, contentHash: 'a'.repeat(64), contentType: 'text/html', bytesFetched: 100, errorCode: null, firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastFetchedAt: new Date('2026-01-01T00:00:00Z'), rawSignals: extractHtmlSignals('<title>OK</title><p>normal page</p>', url), renderedSignals: extractHtmlSignals('<title>OK</title><p>normal page</p>', url), renderedUnavailableReason: null, ...patch,
  }
}

describe('site evidence reconciliation findings', () => {
  it('emits every V1 category and honest rendered unknown statuses', () => {
    nextId = 1
    const rawSparse = extractHtmlSignals('<title>Raw</title><p>x</p><a href="/raw">raw</a>', 'https://example.com/render')
    const renderedRich = extractHtmlSignals(`<title>Rendered</title><link rel="canonical" href="/rendered"><meta name="robots" content="noindex"><p>${'rich '.repeat(200)}</p><a href="/raw">raw</a><a href="/js-only">js</a>`, 'https://example.com/render')
    const inventory = [
      page('https://example.com/in-sitemap', { httpStatus: 500 }),
      page('https://example.com/not-listed'),
      page('https://example.com/canonical', { canonicalUrl: 'https://example.com/other' }),
      page('https://example.com/canonical-variant', { canonicalUrl: 'http://example.com/canonical-variant' }),
      page('https://example.com/redirect', { redirectChain: [{ url: 'https://example.com/a', status: 301 }, { url: 'https://example.com/b', status: 302 }] }),
      page('https://example.com/soft', { rawSignals: extractHtmlSignals('<title>404 Page not found</title><p>missing</p>', 'https://example.com/soft') }),
      page('https://example.com/render', { rawSignals: rawSparse, renderedSignals: renderedRich }),
      page('https://example.com/unknown', { renderedSignals: null, renderedUnavailableReason: 'renderer_failed' }),
      page('http://example.com/dup'), page('https://example.com/dup'),
      page('https://www.example.com/www'), page('https://example.com/www'),
      page('https://example.com/slash/'), page('https://example.com/slash'),
      page('https://example.com/query?utm_source=x'), page('https://example.com/query'),
    ]
    const findings = buildSiteEvidenceFindings({
      inventory,
      targetOrigin: 'https://example.com/',
      sitemaps: [{ ownerUserId: 1, scanId: 7, url: 'https://example.com/sitemap.xml', urlHash: urlHash('https://example.com/sitemap.xml'), kind: 'urlset', status: 'fetched', httpStatus: 200, urlCount: 3, contentHash: 'b'.repeat(64), errorCode: null, discoveredFrom: 'wellknown', fetchedAt: new Date('2026-01-01T00:00:00Z'), entries: [{ url: 'https://example.com/in-sitemap', lastmod: null }, { url: 'https://example.com/missing-entirely', lastmod: null }, { url: 'https://sub.example.com/off-scope', lastmod: null }] }],
    })
    const categories = new Set(findings.map(item => item.category))
    expect(categories).toEqual(expect.objectContaining(new Set([
      'in_sitemap_not_crawlable', 'crawled_not_in_sitemap', 'canonical_mismatch', 'canonical_points_to_variant', 'redirect_chain', 'soft_404_suspect', 'http_https_duplicate', 'www_duplicate', 'trailing_slash_duplicate', 'query_param_duplicate', 'raw_missing_main_content', 'js_only_links', 'raw_rendered_mismatch', 'rendered_unknown',
    ])))
    expect(findings.filter(item => item.urlId === inventory[7]!.id && ['raw_missing_main_content', 'js_only_links', 'raw_rendered_mismatch', 'rendered_unknown'].includes(item.category)).every(item => item.status === 'unknown')).toBe(true)
    const attemptedAndFailed = findings.find(item => item.category === 'in_sitemap_not_crawlable' && item.evidence.url === 'https://example.com/in-sitemap')
    expect(attemptedAndFailed).toMatchObject({ status: 'detected', severity: 'warning', evidence: { reason: 'http_500' } })
    const neverAttempted = findings.find(item => item.category === 'in_sitemap_not_crawlable' && item.evidence.url === 'https://example.com/missing-entirely')
    expect(neverAttempted).toMatchObject({ status: 'unknown', severity: 'info', urlId: null, evidence: { reason: 'not_attempted' } })
    const outOfScope = findings.find(item => item.category === 'in_sitemap_not_crawlable' && item.evidence.url === 'https://sub.example.com/off-scope')
    expect(outOfScope).toMatchObject({ status: 'unknown', severity: 'info', evidence: { reason: 'out_of_site_scope' } })
    expect(findings.find(item => item.category === 'crawled_not_in_sitemap')?.status).toBe('detected')
  })

  it('never reports scanner-side limits as detected defects', () => {
    nextId = 1
    const sitemaps = [{ ownerUserId: 1, scanId: 7, url: 'https://example.com/sitemap.xml', urlHash: urlHash('https://example.com/sitemap.xml'), kind: 'urlset' as const, status: 'fetched' as const, httpStatus: 200, urlCount: 2, contentHash: 'b'.repeat(64), errorCode: null, discoveredFrom: 'wellknown' as const, fetchedAt: new Date('2026-01-01T00:00:00Z'), entries: [{ url: 'https://example.com/fetched', lastmod: null }, { url: 'https://example.com/never-reached', lastmod: null }] }]
    const findings = buildSiteEvidenceFindings({
      inventory: [page('https://example.com/fetched'), page('https://example.com/extra')],
      targetOrigin: 'https://example.com/',
      limitations: ['page_cap_reached', 'sitemap_url_consideration_cap_reached'],
      sitemaps,
    })
    const capped = findings.find(item => item.category === 'in_sitemap_not_crawlable' && item.evidence.url === 'https://example.com/never-reached')
    expect(capped).toMatchObject({ status: 'unknown', severity: 'info', evidence: { reason: 'not_attempted', scanLimits: ['page_cap_reached'] } })
    const truncatedBase = findings.find(item => item.category === 'crawled_not_in_sitemap' && item.evidence.url === 'https://example.com/extra')
    expect(truncatedBase).toMatchObject({ status: 'unknown', severity: 'info', evidence: { reason: 'sitemap_base_truncated' } })
    expect(findings.filter(item => item.status === 'detected')).toHaveLength(0)
  })
})
