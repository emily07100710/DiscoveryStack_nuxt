import { describe, expect, it } from 'vitest'
import { renderManagedSiteStaticAssets } from '../server/managed-sites/live-connectors/internal-broker/static-renderer'
import type { ManagedSiteBlueprintV1, ManagedSiteGeneratedFile } from '../server/managed-sites/live-connectors/types'

const blueprint: ManagedSiteBlueprintV1 = {
  schemaVersion: 'managed-site-blueprint-v1', brandName: 'A&B <Brand>', locale: 'en', siteType: 'one_page', navigation: [{ label: 'Home "quoted"', route: '/' }],
  pages: [{ pageKey: 'home', route: '/', title: '<script>alert(1)</script>', description: '"quoted" & safe', sections: [{ sectionId: 'hero', kind: 'hero', heading: '<img src=x onerror=alert(1)>', body: "Tom & 'friends'", ctaLabel: 'Go >', ctaHref: '/', moduleKey: null }] }],
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
})
