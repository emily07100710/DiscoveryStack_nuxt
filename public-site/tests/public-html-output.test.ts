// @vitest-environment jsdom
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

  it('offers public website diagnosis on the homepage and starts the builder with the brand brief', () => {
    for (const route of ['/zh-hant', '/en']) {
      const document = new DOMParser().parseFromString(htmlFor(route), 'text/html')
      const diagnosisInput = document.querySelector('#analysis-url')
      expect(diagnosisInput, `${route} has a visible diagnosis entry`).not.toBeNull()
      expect(diagnosisInput?.closest('details')).toBeNull()
      expect(document.querySelectorAll('#analysis')).toHaveLength(1)
    }
    const builder = new DOMParser().parseFromString(htmlFor('/zh-hant/website-builder-preview'), 'text/html')
    expect(builder.querySelector('#builder-brand')).not.toBeNull()
    expect(builder.querySelector('#builder-url')).toBeNull()
    expect(builder.body.textContent).not.toContain('開始公開診斷')
    expect(builder.body.textContent).not.toContain('你現在有網站嗎？')
  })

  it('renders the full API platform list with shipped marks and explains SEO versus GEO', () => {
    for (const route of ['/zh-hant', '/en']) {
      const document = new DOMParser().parseFromString(htmlFor(route), 'text/html')
      const platforms = [...document.querySelectorAll<HTMLAnchorElement>('.platform-grid a')]
      const marks = [...document.querySelectorAll<HTMLImageElement>('.platform-grid img')]
      expect(platforms, `${route} lists dozens of API-capable platforms`).toHaveLength(40)
      expect(new Set(platforms.map(platform => platform.getAttribute('aria-label'))).size).toBe(40)
      expect(marks.length, `${route} ships most platforms with identifying marks`).toBeGreaterThanOrEqual(30)
      for (const mark of marks) {
        const source = mark.getAttribute('src') ?? ''
        expect(source.startsWith('/platforms/')).toBe(true)
        expect(existsSync(join(publicRoot, source.slice(1))), `${source} is shipped`).toBe(true)
      }
      expect(document.querySelectorAll('.discovery-difference__card')).toHaveLength(2)
      expect(document.querySelector('.discovery-difference')?.textContent).toContain('SEO')
      expect(document.querySelector('.discovery-difference')?.textContent).toContain('GEO')
    }
    const english = htmlFor('/en')
    expect(english).toContain('100,000+ real-world')
    expect(english).not.toMatch(/Asia(?:'s|’s) only|ASIA’S ONLY/i)
  })
})
