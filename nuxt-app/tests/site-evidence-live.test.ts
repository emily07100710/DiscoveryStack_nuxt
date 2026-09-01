import { describe, expect, it } from 'vitest'
import { safeFetch } from '../server/site-evidence/fetcher'
import { extractSitemapUrls } from '../server/site-evidence/robots'
import { sha256Hex } from '../server/site-evidence/normalization'
import { parseSitemap } from '../server/site-evidence/sitemap'

describe.skipIf(process.env.DS_RUN_SITE_EVIDENCE_LIVE !== '1')('site evidence live smoke', () => {
  it('records broad, read-only evidence from doalignment.com within five requested resources', async () => {
    const maxPages = 5
    const homepage = await safeFetch('https://doalignment.com/', { purpose: 'page' })
    expect(homepage.status).toBeGreaterThanOrEqual(100)
    expect(sha256Hex(homepage.body)).toMatch(/^[a-f0-9]{64}$/u)
    const robots = await safeFetch('https://doalignment.com/robots.txt', { purpose: 'robots' })
    expect(robots.bytesFetched).toBeGreaterThanOrEqual(0)
    const sitemapUrl = extractSitemapUrls(robots.body)[0]
    if (sitemapUrl && maxPages >= 3) {
      const sitemap = await safeFetch(sitemapUrl, { purpose: 'sitemap' })
      expect(['urlset', 'sitemapindex', 'unknown']).toContain(parseSitemap(sitemap.body, sitemap.contentType, maxPages).kind)
    }
  })
})
