/** SEO locale map: emits one canonical URL per language with explicit reciprocal alternate references. */
import { isConfiguredProductionUrl, normalizedSiteUrl, publicRoutePairs } from '../utils/publicRoutes'

const escapeXml = (value: string) => value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character] || character)

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const siteUrl = normalizedSiteUrl(config.public.discoveryStackSiteUrl || config.public.siteUrl)
  setHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')

  if (!isConfiguredProductionUrl(siteUrl)) {
    return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'
  }

  const urls = publicRoutePairs.flatMap(({ path, lastmod }) => ['en', 'zh-hant'].map((locale) => {
    const loc = `${siteUrl}/${locale}${path}`
    const en = `${siteUrl}/en${path}`
    const zh = `${siteUrl}/zh-hant${path}`
    return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <xhtml:link rel="alternate" hreflang="en" href="${escapeXml(en)}" />
    <xhtml:link rel="alternate" hreflang="zh-Hant" href="${escapeXml(zh)}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(en)}" />
  </url>`
  }))

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>`
})
