import { beginOAuthLogin } from '../../utils/oauth'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const origin = typeof query.origin === 'string' ? query.origin : ''
  setHeader(event, 'X-DiscoveryStack-OAuth-Route', 'nuxt-origin-allowlist-v1')
  return sendRedirect(event, beginOAuthLogin(event, origin), 302)
})
