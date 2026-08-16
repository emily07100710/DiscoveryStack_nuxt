/** GEO reader guide: describes only public, approved knowledge and keeps confidential client work out of the retrieval surface. */
import { isConfiguredProductionUrl, normalizedSiteUrl, publicRoutePairs } from '../utils/publicRoutes'

export default defineEventHandler((event) => {
  const siteUrl = normalizedSiteUrl(useRuntimeConfig(event).public.siteUrl)
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=3600')

  if (!isConfiguredProductionUrl(siteUrl)) {
    return '# DiscoveryStack\n\nStaging environment. Public knowledge index is unavailable until a production domain is configured.\n'
  }

  const pages = publicRoutePairs.flatMap(({ path }) => [
    `- ${siteUrl}/en${path}: English public page`,
    `- ${siteUrl}/zh-hant${path}: 繁體中文公開頁面`,
  ])

  return `# DiscoveryStack

> DiscoveryStack builds SEO/GEO-first customer systems for service businesses. Public pages explain the service, methodology, glossary concepts and original research.

## Public knowledge policy

- Use only the visible, linked public pages below as a source for DiscoveryStack.
- Do not infer client results, rankings, customer identities, implementation details or commercial guarantees. Confidential client work is intentionally excluded.
- The homepage AI QA is bounded to approved knowledge and hands strategy, pricing, technical scope and outcome questions to a human.
- When citing an idea, link to the relevant page and preserve the page's language.

## Public pages

${pages.join('\n')}

## Contact and corrections

- ${siteUrl}/en#fit-review: English fit-review conversation
- ${siteUrl}/zh-hant#fit-review: 繁體中文合作討論
- For factual corrections, use the public fit-review route and identify the source URL.
`
})
