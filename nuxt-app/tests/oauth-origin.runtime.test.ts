import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchSsrResponse, startSsrServer, stopSsrServer } from './helpers/ssr-server'

const oauthOrigin = 'https://ops.synthetic.example.test'
const oauthPortal = 'https://oauth.synthetic.example.test'

describe('DiscoveryStack OAuth origin runtime secret', () => {
  beforeAll(async () => {
    // Secrets are supplied at runtime, after the production build. These URLs
    // are synthetic; requests stop at the local server's redirect response.
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('NUXT_CONTENT_OPERATIONS_SCHEDULER_ENABLED', 'false')
    vi.stubEnv('NUXT_OAUTH_SERVER_URL', 'https://identity.synthetic.example.test')
    vi.stubEnv('NUXT_OAUTH_PORTAL_URL', oauthPortal)
    vi.stubEnv('NUXT_OAUTH_APP_ID', 'synthetic-runtime-app')
    vi.stubEnv('NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN', oauthOrigin)
    await startSsrServer()
  })
  afterAll(async () => {
    await stopSsrServer()
    vi.unstubAllEnvs()
  })

  it('accepts the configured HTTPS production origin without contacting the OAuth provider', async () => {
    const response = await fetchSsrResponse(`/api/auth/login?origin=${encodeURIComponent(oauthOrigin)}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('x-discoverystack-oauth-route')).toBe('nuxt-origin-allowlist-v1')
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe(oauthPortal)
    expect(location.pathname).toBe('/app-auth')
    expect(location.searchParams.get('appId')).toBe('synthetic-runtime-app')
    expect(location.searchParams.get('redirectUri')).toBe(`${oauthOrigin}/api/oauth/callback`)
    expect(response.headers.get('set-cookie')).toMatch(/__Host-discoverystack-oauth-state=.*; Path=\/;.*HttpOnly; Secure; SameSite=None/u)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('rejects a foreign browser origin instead of sending it to the provider', async () => {
    const response = await fetchSsrResponse('/api/auth/login?origin=https%3A%2F%2Fforeign.synthetic.example.test', { redirect: 'manual' })
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })
})
