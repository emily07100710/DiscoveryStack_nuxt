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

export const publicRoutes = publicRoutePairs.flatMap(({ path, lastmod }) => [
  { path: `/en${path}`, locale: 'en' as const, lastmod },
  { path: `/zh-hant${path}`, locale: 'zh-hant' as const, lastmod },
])

export function normalizedSiteUrl(siteUrl: string) {
  return siteUrl.replace(/\/$/, '')
}

export function routeForLocale(path: string, locale: 'en' | 'zh-hant') {
  const suffix = path.replace(/^\/(en|zh-hant)/, '')
  return `/${locale}${suffix}`.replace(/\/$/, '') || `/${locale}`
}

export function absoluteUrl(path: string, siteUrl: string) {
  return `${normalizedSiteUrl(siteUrl)}${path === '/' ? '' : path}`
}

export function isPlaceholderSiteUrl(siteUrl: string) {
  return siteUrl.includes('www.example.com') || siteUrl.includes('discoverystack.example')
}

export function contentSchemaType(route: string, contentRole: string) {
  if (contentRole === 'pillar') return 'Service'
  if (route.includes('/glossary/')) return 'DefinedTerm'
  return 'Article'
}

export function pageJsonLd(page: {
  title: string
  description: string
  route: string
  locale: 'en' | 'zh-hant'
  contentRole: string
  translationKey: string
  updatedAt: string
}, siteUrl: string) {
  const baseUrl = normalizedSiteUrl(siteUrl)
  const canonical = absoluteUrl(page.route, baseUrl)
  const schemaType = contentSchemaType(page.route, page.contentRole)
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        url: canonical,
        name: page.title,
        description: page.description,
        isPartOf: { '@id': `${baseUrl}/#website` },
        about: { '@id': `${baseUrl}/#organization` },
        inLanguage: page.locale === 'zh-hant' ? 'zh-Hant' : 'en',
      },
      {
        '@type': schemaType,
        '@id': `${canonical}#primary`,
        name: page.title,
        headline: page.title,
        description: page.description,
        url: canonical,
        dateModified: page.updatedAt,
        inLanguage: page.locale === 'zh-hant' ? 'zh-Hant' : 'en',
        mainEntityOfPage: { '@id': `${canonical}#webpage` },
        publisher: { '@id': `${baseUrl}/#organization` },
        ...(schemaType === 'Service' ? { provider: { '@id': `${baseUrl}/#organization` } } : {}),
        ...(schemaType === 'DefinedTerm' ? { termCode: page.translationKey, inDefinedTermSet: `${baseUrl}/glossary` } : {}),
      },
    ],
  }
}

export function homeJsonLd(locale: 'en' | 'zh-hant', title: string, description: string, siteUrl: string) {
  const baseUrl = normalizedSiteUrl(siteUrl)
  const route = `/${locale}`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${baseUrl}/#organization`, name: 'DiscoveryStack', url: baseUrl, description },
      { '@type': 'WebSite', '@id': `${baseUrl}/#website`, name: 'DiscoveryStack', url: baseUrl, publisher: { '@id': `${baseUrl}/#organization` } },
      { '@type': 'WebPage', '@id': `${baseUrl}${route}#webpage`, url: `${baseUrl}${route}`, name: title, description, isPartOf: { '@id': `${baseUrl}/#website` }, about: { '@id': `${baseUrl}/#organization` }, inLanguage: locale === 'zh-hant' ? 'zh-Hant' : 'en' },
    ],
  }
}
