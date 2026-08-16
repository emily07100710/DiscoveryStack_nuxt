/** GEO crawler policy: staging is blocked; production welcomes public search/AI crawlers but protects private surfaces. */
import { isConfiguredProductionUrl, normalizedSiteUrl } from '../utils/publicRoutes'

export default defineEventHandler((event) => {
  const siteUrl = normalizedSiteUrl(useRuntimeConfig(event).public.siteUrl)
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')

  if (!isConfiguredProductionUrl(siteUrl)) {
    return '# DiscoveryStack staging policy\nUser-agent: *\nDisallow: /\n'
  }

  return `# DiscoveryStack public crawler policy
User-agent: *
Allow: /
Disallow: /audit-lab/
Disallow: /api/

# Public research and documentation may be crawled. Private audit workspaces, leads, credentials and client-confidential material are never public content.
User-agent: GPTBot
Allow: /
Disallow: /audit-lab/
Disallow: /api/

User-agent: ClaudeBot
Allow: /
Disallow: /audit-lab/
Disallow: /api/

User-agent: PerplexityBot
Allow: /
Disallow: /audit-lab/
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml
`
})
