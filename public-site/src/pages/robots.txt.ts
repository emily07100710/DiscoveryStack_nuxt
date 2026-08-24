import { publicSiteOrigin } from '../lib/publicApi'
import { isPlaceholderSiteUrl } from '../lib/site'

export function GET() {
  const body = isPlaceholderSiteUrl(publicSiteOrigin)
    ? `User-agent: *\nDisallow: /\n`
    : `User-agent: *\nAllow: /\nSitemap: ${publicSiteOrigin}/sitemap.xml\n`
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
