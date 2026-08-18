const OAUTH_NITRO_RELEASE = 'nitro-public-intelligence-20260818-r16-quality-feedback'

export default defineEventHandler((event) => {
  // This endpoint is intentionally limited to non-sensitive deployment identity.
  // It differentiates the Nuxt/Nitro SSR container from stale or legacy handlers.
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'X-DiscoveryStack-OAuth-Release', OAUTH_NITRO_RELEASE)
  setHeader(event, 'X-DiscoveryStack-Handler', 'nitro')
  return { release: OAUTH_NITRO_RELEASE, handler: 'nitro' }
})
