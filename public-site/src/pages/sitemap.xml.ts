import { publicSiteOrigin } from '../lib/publicApi'
import { isPlaceholderSiteUrl, publicRoutePairs } from '../lib/site'

export function GET() {
  const entries = isPlaceholderSiteUrl(publicSiteOrigin)
    ? ''
    : publicRoutePairs.flatMap(({ path, lastmod }) => [
        ['en', `/en${path}`, lastmod] as const,
        ['zh-Hant', `/zh-hant${path}`, lastmod] as const,
      ]).map(([language, path, lastmod]) => {
        const counterpart = language === 'en' ? `/zh-hant${path.slice(3)}` : `/en${path.slice(8)}`
        return `<url><loc>${publicSiteOrigin}${path}</loc><lastmod>${lastmod}</lastmod><xhtml:link rel="alternate" hreflang="${language}" href="${publicSiteOrigin}${path}"/><xhtml:link rel="alternate" hreflang="${language === 'en' ? 'zh-Hant' : 'en'}" href="${publicSiteOrigin}${counterpart}"/><xhtml:link rel="alternate" hreflang="x-default" href="${publicSiteOrigin}${language === 'en' ? path : counterpart}"/></url>`
      }).join('')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries}</urlset>`
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
