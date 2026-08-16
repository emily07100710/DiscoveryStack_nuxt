import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchSsrHtml, startSsrServer, stopSsrServer } from './helpers/ssr-server'

const publicRoot = join(process.cwd(), '.output/public')
const siteUrl = (process.env.NUXT_PUBLIC_SITE_URL || 'https://discoverystack.example').replace(/\/$/, '')
const escapedSiteUrl = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const canonicalPattern = new RegExp(`<link\\b(?=[^>]*\\brel="canonical")(?=[^>]*\\bhref="${escapedSiteUrl}\\/(en|zh-hant)[^"]*")[^>]*>`, 'i')
const englishAlternatePattern = /<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="en")(?=[^>]*\bhref="[^"]+")[^>]*>/i
const traditionalChineseAlternatePattern = /<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="zh-Hant")(?=[^>]*\bhref="[^"]+")[^>]*>/i
const defaultAlternatePattern = /<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="x-default")(?=[^>]*\bhref="[^"]+")[^>]*>/i
const indexableRoutes = [
  '/en', '/zh-hant',
  '/en/services/seo-geo-growth-system', '/zh-hant/services/seo-geo-growth-system',
  '/en/methodology/journey-intelligence', '/zh-hant/methodology/journey-intelligence',
  '/en/methodology/bounded-ai-assistant', '/zh-hant/methodology/bounded-ai-assistant',
  '/en/glossary/seo', '/zh-hant/glossary/seo',
  '/en/glossary/geo', '/zh-hant/glossary/geo',
  '/en/glossary/journey-intelligence', '/zh-hant/glossary/journey-intelligence',
  '/en/publications/what-a-public-website-can-tell-you', '/zh-hant/publications/what-a-public-website-can-tell-you',
]

describe('Public bilingual production HTML', () => {
  beforeAll(startSsrServer)
  afterAll(stopSsrServer)

  it('keeps every indexable language route semantic, linked and schema-backed in Nitro SSR responses', async () => {
    expect(indexableRoutes).toHaveLength(16)

    for (const path of indexableRoutes) {
      const { response, html } = await fetchSsrHtml(path)
      expect(response.status, `${path} responds from the SSR server`).toBe(200)
      expect(html, `${path} has a semantic H1`).toMatch(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)
      expect(html, `${path} has a canonical`).toMatch(canonicalPattern)
      expect(html, `${path} declares English alternate`).toMatch(englishAlternatePattern)
      expect(html, `${path} declares Traditional Chinese alternate`).toMatch(traditionalChineseAlternatePattern)
      expect(html, `${path} declares x-default alternate`).toMatch(defaultAlternatePattern)
      expect(html, `${path} includes matching JSON-LD`).toContain('type="application/ld+json"')
      expect(html, `${path} has a crawlable internal language link`).toMatch(/href="\/(en|zh-hant)(?:\/[^"#?]*)?"/)
    }
  })

  it('does not emit private Audit Lab routes into public static output', () => {
    expect(existsSync(join(publicRoot, 'audit-lab'))).toBe(false)
    expect(existsSync(join(publicRoot, 'en/audit-lab'))).toBe(false)
    expect(existsSync(join(publicRoot, 'zh-hant/audit-lab'))).toBe(false)
  })
})
