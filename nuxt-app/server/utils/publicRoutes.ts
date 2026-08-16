/** SEO/GEO source of truth: only publicly approved, semantic routes belong in crawler documents. */
export const publicRoutePairs = [
  { path: '', lastmod: '2026-08-16' },
  { path: '/services/seo-geo-growth-system', lastmod: '2026-08-16' },
  { path: '/methodology/journey-intelligence', lastmod: '2026-08-16' },
  { path: '/methodology/bounded-ai-assistant', lastmod: '2026-08-16' },
  { path: '/glossary/seo', lastmod: '2026-08-16' },
  { path: '/glossary/geo', lastmod: '2026-08-16' },
  { path: '/glossary/journey-intelligence', lastmod: '2026-08-16' },
  { path: '/publications/what-a-public-website-can-tell-you', lastmod: '2026-08-16' },
] as const

export function normalizedSiteUrl(siteUrl: unknown) {
  return String(siteUrl || 'https://discoverystack.example').replace(/\/$/, '')
}

export function isConfiguredProductionUrl(siteUrl: string) {
  return !siteUrl.includes('discoverystack.example')
}
