import { describe, expect, it } from 'vitest'
import { renderManagedSiteStaticAssets, STATIC_RENDERER_FINGERPRINT } from '../server/managed-sites/live-connectors/internal-broker/static-renderer'
import type { ManagedSiteBlueprintV1, ManagedSiteGeneratedFile } from '../server/managed-sites/live-connectors/types'

const blueprint: ManagedSiteBlueprintV1 = {
  schemaVersion: 'managed-site-blueprint-v1', brandName: 'A&B <Brand>', locale: 'en', siteType: 'one_page', navigation: [{ label: 'Home "quoted"', route: '/' }],
  pages: [{ pageKey: 'home', route: '/', title: '<script>alert(1)</script>', description: '"quoted" & safe', sections: [{ sectionId: 'hero', kind: 'hero', heading: '<img src=x onerror=alert(1)>', body: "Tom & 'friends'", ctaLabel: 'Go >', ctaHref: '/', moduleKey: null, formEndpoint: null }] }],
  faq: [{ question: '<question>', answer: '<answer>' }], selectedModulePlacements: [], seoGeo: { summaryAnswer: 'summary', canonicalPlaceholder: '{{CANONICAL_ORIGIN}}', organizationName: 'A&B', evidenceLimitations: ['No <claim>'], structuredDataKinds: ['Organization'] }, provenance: { evidenceSnapshotHash: 'a'.repeat(64), authoritySourceIds: [], providerContentHash: 'b'.repeat(64) },
}

describe('managed-site static renderer', () => {
  it('is deterministic, escapes blueprint text, and emits no active HTML', () => {
    const first = renderManagedSiteStaticAssets(blueprint); const second = renderManagedSiteStaticAssets(structuredClone(blueprint))
    expect(first).toEqual(second)
    const html = first.find(asset => asset.path === 'index.html')!.content
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('A&amp;B &lt;Brand&gt;')
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/iu)
  })

  it('passes through only the public allowlist and never Astro sources', () => {
    const files = [
      { path: 'public/robots.txt', mediaType: 'text/markdown', content: 'User-agent: *', sha256: 'a'.repeat(64) },
      { path: 'public/manifest.json', mediaType: 'application/json', content: '{"name":"safe"}', sha256: 'b'.repeat(64) },
      { path: 'src/pages/index.astro', mediaType: 'text/astro', content: '<script>bad</script>', sha256: 'c'.repeat(64) },
      { path: 'public/not-allowed.txt', mediaType: 'text/markdown', content: 'no', sha256: 'd'.repeat(64) },
    ] as ManagedSiteGeneratedFile[]
    expect(renderManagedSiteStaticAssets(blueprint, files).map(asset => asset.path)).toEqual(['index.html', 'manifest.json', 'robots.txt'])
  })

  it('binds canonical metadata and crawler files to the verified domain on the initial deployment', () => {
    const site = structuredClone(blueprint)
    site.pages[0]!.sections.push({ sectionId: 'faq', kind: 'faq', heading: 'FAQ', body: '', ctaLabel: null, ctaHref: null, moduleKey: null, formEndpoint: null })
    site.pages.push({ ...structuredClone(site.pages[0]!), pageKey: 'services', route: '/services' })
    const files = [{ path: 'public/sitemap.xml', mediaType: 'text/xml', content: '{{CANONICAL_ORIGIN}}', sha256: 'a'.repeat(64) }, { path: 'public/robots.txt', mediaType: 'text/markdown', content: '{{CANONICAL_ORIGIN}}', sha256: 'b'.repeat(64) }] as ManagedSiteGeneratedFile[]
    const assets = renderManagedSiteStaticAssets(site, files, 'https://brand.acme.taipei/')
    const html = assets.find(asset => asset.path === 'index.html')!.content
    expect(html).toContain('<link rel="canonical" href="https://brand.acme.taipei/">')
    expect(html.match(/application\/ld\+json/gu)).toHaveLength(1)
    const graph = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/u.exec(html)![1]!)['@graph']
    expect(graph.map((item: Record<string, unknown>) => item['@type'])).toEqual(['Organization', 'WebPage', 'FAQPage'])
    expect(graph[0]).toMatchObject({ name: 'A&B', url: 'https://brand.acme.taipei' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('"name":"<script>')
    expect(assets.find(asset => asset.path === 'sitemap.xml')!.content).toContain('<loc>https://brand.acme.taipei/services</loc>')
    expect(assets.filter(asset => asset.path === 'sitemap.xml')).toHaveLength(1)
    expect(assets.find(asset => asset.path === 'robots.txt')!.content).toContain('Sitemap: https://brand.acme.taipei/sitemap.xml')
    expect(JSON.stringify(assets)).not.toContain('{{CANONICAL_ORIGIN}}')
    expect(STATIC_RENDERER_FINGERPRINT).toMatch(/^managed-site-static-renderer-v3:/u)
  })

  it('renders three fixed premium presets without remote assets or executable scripts', () => {
    const rendered = Object.fromEntries((['atelier', 'bloom', 'alignment'] as const).map(preset => [preset, renderManagedSiteStaticAssets(blueprint, [], undefined, preset).find(asset => asset.path === 'index.html')!.content]))

    expect(new Set(Object.values(rendered))).toHaveLength(3)
    for (const [preset, html] of Object.entries(rendered)) {
      expect(html).toContain(`class="site-preset--${preset}"`)
      expect(html).toContain(`data-site-preset="${preset}"`)
      expect(html).toContain('class="hero"')
      expect(html).toContain('class="content-grid"')
      expect(html).toContain('@media(max-width:54rem)')
      expect(html).not.toMatch(/<script\b/iu)
      expect(html).not.toMatch(/<(?:img|iframe|object|embed)\b/iu)
      expect(html).not.toMatch(/@import|url\s*\(/iu)
    }
    expect(rendered.atelier).toContain('.site-preset--atelier{--canvas:#f3eee6')
    expect(rendered.bloom).toContain('.site-preset--bloom .hero{grid-template-columns:1fr;text-align:center')
    expect(rendered.alignment).toContain('.site-preset--alignment .content-grid{grid-template-columns:repeat(3,minmax(0,1fr))')
  })

  it('falls back to the fixed atelier preset for an untrusted runtime value', () => {
    const html = renderManagedSiteStaticAssets(blueprint, [], undefined, 'alignment"><style>bad' as never).find(asset => asset.path === 'index.html')!.content
    expect(html).toContain('data-site-preset="atelier"')
    expect(html).not.toContain('alignment&quot;&gt;&lt;style&gt;bad')
    expect(html).not.toContain('alignment"><style>bad')
  })

  it('does not invent FAQ structured data on pages without a displayed FAQ', () => {
    const html = renderManagedSiteStaticAssets(blueprint, [], 'https://brand.acme.taipei').find(asset => asset.path === 'index.html')!.content
    expect(html).not.toContain('FAQPage')
    expect(html).not.toContain('aggregateRating')
    expect(html).not.toContain('offers')
  })

  it.each(['https://example.com', 'http://brand.acme.taipei', 'https://127.0.0.1', 'https://brand.acme.taipei/?token=secret'])('rejects an unbound or unsafe origin %s', origin => {
    expect(() => renderManagedSiteStaticAssets(blueprint, [], origin)).toThrow()
  })

  it('keeps the confirmation page noindex and out of the bound sitemap', () => {
    const site = structuredClone(blueprint)
    site.selectedModulePlacements = [{ moduleKey: 'contact_lead_capture', pageKey: 'home', sectionId: 'contact' }] as ManagedSiteBlueprintV1['selectedModulePlacements']
    const assets = renderManagedSiteStaticAssets(site, [], 'https://brand.acme.taipei')
    expect(assets.find(asset => asset.path === 'thanks/index.html')!.content).toContain('noindex')
    expect(assets.find(asset => asset.path === 'sitemap.xml')!.content).not.toContain('/thanks')
  })
})
