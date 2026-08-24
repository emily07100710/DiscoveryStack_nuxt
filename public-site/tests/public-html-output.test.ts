import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const publicRoot = join(process.cwd(), 'dist')
const siteUrl = (process.env.PUBLIC_SITE_URL || 'https://www.example.com').replace(/\/$/, '')
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

function htmlFor(route: string) {
  return readFileSync(join(publicRoot, route.replace(/^\//, ''), 'index.html'), 'utf8')
}

describe('Astro public static output', () => {
  it('emits semantic, linked and schema-backed bilingual pages', () => {
    expect(indexableRoutes).toHaveLength(16)
    for (const route of indexableRoutes) {
      const html = htmlFor(route)
      expect(html, `${route} has H1`).toMatch(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)
      expect(html, `${route} has canonical`).toContain(`rel="canonical" href="${siteUrl}${route}"`)
      expect(html, `${route} has English alternate`).toContain('hreflang="en"')
      expect(html, `${route} has Traditional Chinese alternate`).toContain('hreflang="zh-Hant"')
      expect(html, `${route} has x-default alternate`).toContain('hreflang="x-default"')
      expect(html, `${route} has JSON-LD`).toContain('type="application/ld+json"')
      expect(html, `${route} has an internal language link`).toMatch(/href="\/(en|zh-hant)(?:\/[^"#?]*)?"/)
    }
  })

  it('keeps root privacy as a public entry while excluding private Nuxt routes', () => {
    expect(existsSync(join(publicRoot, 'privacy', 'index.html'))).toBe(true)
    expect(existsSync(join(publicRoot, 'audit-lab'))).toBe(false)
    expect(existsSync(join(publicRoot, 'en', 'audit-lab'))).toBe(false)
    expect(existsSync(join(publicRoot, 'zh-hant', 'audit-lab'))).toBe(false)
    expect(existsSync(join(publicRoot, 'api'))).toBe(false)
  })
})
