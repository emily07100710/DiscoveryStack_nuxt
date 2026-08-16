import { beginOAuthLogin } from '../../utils/oauth'

const OAUTH_NITRO_RELEASE = 'nitro-oauth-20260816-r10'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const origin = typeof query.origin === 'string' ? query.origin : ''
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'X-DiscoveryStack-OAuth-Release', OAUTH_NITRO_RELEASE)
  setHeader(event, 'X-DiscoveryStack-OAuth-Route', 'nuxt-origin-allowlist-v1')
  return sendRedirect(event, beginOAuthLogin(event, origin), 302)
})
