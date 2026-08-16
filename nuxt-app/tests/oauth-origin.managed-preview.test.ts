import { describe, expect, it } from 'vitest'

const previewBaseUrl = process.env.DISCOVERYSTACK_MANAGED_PREVIEW_URL
const oauthOrigin = process.env.NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN
const siteUrl = (process.env.NUXT_PUBLIC_DISCOVERY_STACK_SITE_URL || '').replace(/\/$/, '')
const escapedSiteUrl = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('DiscoveryStack OAuth managed-preview secret', () => {
  it.skipIf(!previewBaseUrl)('accepts the dedicated HTTPS allowlist through the running Nitro endpoint without contacting the provider', async () => {
    expect(oauthOrigin).toMatch(/^https:\/\//)
    const response = await fetch(`${previewBaseUrl}/api/auth/login?origin=${encodeURIComponent(oauthOrigin!)}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('x-discoverystack-oauth-route')).toBe('nuxt-origin-allowlist-v1')
    expect(response.headers.get('location')).toContain('oauth')
  })

  it.skipIf(!previewBaseUrl)('renders canonical and hreflang metadata from the dedicated public site URL', async () => {
    expect(siteUrl).toMatch(/^https:\/\//)
    const response = await fetch(`${previewBaseUrl}/en`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toMatch(new RegExp(`<link\\b(?=[^>]*\\brel="canonical")(?=[^>]*\\bhref="${escapedSiteUrl}/en")[^>]*>`, 'i'))
    expect(html).toMatch(/<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="en")(?=[^>]*\bhref="[^"]+")[^>]*>/i)
    expect(html).toMatch(/<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="zh-Hant")(?=[^>]*\bhref="[^"]+")[^>]*>/i)
    expect(html).toMatch(/<link\b(?=[^>]*\brel="alternate")(?=[^>]*\bhreflang="x-default")(?=[^>]*\bhref="[^"]+")[^>]*>/i)
  })
})
