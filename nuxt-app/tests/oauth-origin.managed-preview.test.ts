import { describe, expect, it } from 'vitest'

const previewBaseUrl = process.env.DISCOVERYSTACK_MANAGED_PREVIEW_URL
const oauthOrigin = process.env.NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN

describe('DiscoveryStack OAuth managed-preview secret', () => {
  it.skipIf(!previewBaseUrl)('accepts the dedicated HTTPS allowlist through the running private Nitro endpoint without contacting the provider', async () => {
    expect(oauthOrigin).toMatch(/^https:\/\//)
    const response = await fetch(`${previewBaseUrl}/api/auth/login?origin=${encodeURIComponent(oauthOrigin!)}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('x-discoverystack-oauth-route')).toBe('nuxt-origin-allowlist-v1')
    expect(response.headers.get('location')).toContain('oauth')
  })
})
