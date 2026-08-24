import { publicSiteOrigin } from '../lib/publicApi'
import { publicRoutePairs } from '../lib/site'

export function GET() {
  const links = publicRoutePairs.flatMap(({ path }) => [`- [en](${publicSiteOrigin}/en${path})`, `- [zh-Hant](${publicSiteOrigin}/zh-hant${path})`]).join('\n')
  const body = `# DiscoveryStack\n\nDiscoveryStack publishes public explanations of SEO/GEO, customer-path methodology, bounded AI assistance and responsible observation of public websites.\n\n## Public pages\n${links}\n\nConfidential client work, owner operations, audit data, training data, credentials and private APIs are excluded. For corrections or a scoped conversation, use the public fit-review form at ${publicSiteOrigin}/en#fit or ${publicSiteOrigin}/zh-hant#fit.\n`
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
