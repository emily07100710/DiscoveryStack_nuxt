import { describe, expect, it } from 'vitest'
import { parseSitemap } from '../server/site-evidence/sitemap'

describe('site evidence sitemap parser', () => {
  it('parses namespaced urlsets with CDATA, entities, lastmod, and caps', () => {
    const result = parseSitemap(`<?xml version="1.0"?><sm:urlset xmlns:sm="x">
      <sm:url><sm:loc><![CDATA[https://example.com/a?x=1&y=2]]></sm:loc><sm:lastmod>2026-01-01</sm:lastmod></sm:url>
      <sm:url><sm:loc>https://example.com/b?x=1&amp;y=2</sm:loc></sm:url>
    </sm:urlset>`, 'application/xml', 1)
    expect(result.kind).toBe('urlset')
    expect(result.entries).toEqual([{ url: 'https://example.com/a?x=1&y=2', lastmod: '2026-01-01' }])
    expect(result.truncated).toBe(true)
  })

  it('parses a sitemap index separately from page URLs', () => {
    const result = parseSitemap('<sitemapindex><sitemap><loc> https://example.com/one.xml </loc></sitemap><sitemap><loc>https://example.com/two.xml</loc></sitemap></sitemapindex>')
    expect(result.kind).toBe('sitemapindex')
    expect(result.entries.map(entry => entry.url)).toEqual(['https://example.com/one.xml', 'https://example.com/two.xml'])
  })

  it('accepts bounded plain-text sitemaps and rejects unrecognized bodies honestly', () => {
    expect(parseSitemap('# urls\nhttps://example.com/a\ninvalid\nhttps://example.com/b', 'text/plain', 10)).toMatchObject({ kind: 'urlset', truncated: false, errorCode: null })
    expect(parseSitemap('<html>not a sitemap</html>', 'text/html')).toMatchObject({ kind: 'unknown', entries: [], errorCode: 'sitemap_parse_failed' })
  })
})
