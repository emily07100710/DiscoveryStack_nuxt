import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { oauthConfig } from '../server/utils/oauth'

const event = {} as Parameters<typeof oauthConfig>[0]
const oauthEnvironmentNames = [
  'NUXT_OAUTH_SERVER_URL', 'OAUTH_SERVER_URL',
  'NUXT_OAUTH_PORTAL_URL', 'VITE_OAUTH_PORTAL_URL',
  'NUXT_OAUTH_APP_ID', 'VITE_APP_ID',
  'NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN', 'OAUTH_ALLOWED_ORIGIN',
] as const

beforeEach(() => {
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
  for (const name of oauthEnvironmentNames) vi.stubEnv(name, '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('OAuth request-time environment fallback', () => {
  it('keeps populated runtime config authoritative over environment fallbacks', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      oauthServerUrl: 'https://runtime-provider.example.net',
      oauthPortalUrl: 'https://runtime-portal.example.net',
      oauthAppId: 'runtime-app',
      discoveryStackOauthAllowedOrigin: 'https://runtime-ops.example.net',
    }))
    vi.stubEnv('NUXT_OAUTH_SERVER_URL', 'https://nuxt-provider.example.net')
    vi.stubEnv('OAUTH_SERVER_URL', 'https://legacy-provider.example.net')
    vi.stubEnv('NUXT_OAUTH_PORTAL_URL', 'https://nuxt-portal.example.net')
    vi.stubEnv('VITE_OAUTH_PORTAL_URL', 'https://legacy-portal.example.net')
    vi.stubEnv('NUXT_OAUTH_APP_ID', 'nuxt-app')
    vi.stubEnv('VITE_APP_ID', 'legacy-app')
    vi.stubEnv('NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN', 'https://nuxt-ops.example.net')
    vi.stubEnv('OAUTH_ALLOWED_ORIGIN', 'https://legacy-ops.example.net')

    expect(oauthConfig(event)).toEqual({
      serverUrl: 'https://runtime-provider.example.net',
      portalUrl: 'https://runtime-portal.example.net',
      appId: 'runtime-app',
      allowedOrigin: 'https://runtime-ops.example.net',
    })
  })

  it('prefers NUXT_* request-time values before supported legacy names', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      oauthServerUrl: '',
      oauthPortalUrl: '',
      oauthAppId: '',
      discoveryStackOauthAllowedOrigin: '',
    }))
    vi.stubEnv('NUXT_OAUTH_SERVER_URL', 'https://nuxt-provider.example.net')
    vi.stubEnv('OAUTH_SERVER_URL', 'https://legacy-provider.example.net')
    vi.stubEnv('NUXT_OAUTH_PORTAL_URL', 'https://nuxt-portal.example.net')
    vi.stubEnv('VITE_OAUTH_PORTAL_URL', 'https://legacy-portal.example.net')
    vi.stubEnv('NUXT_OAUTH_APP_ID', 'nuxt-app')
    vi.stubEnv('VITE_APP_ID', 'legacy-app')
    vi.stubEnv('NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN', 'https://nuxt-ops.example.net')
    vi.stubEnv('OAUTH_ALLOWED_ORIGIN', 'https://legacy-ops.example.net')

    expect(oauthConfig(event)).toEqual({
      serverUrl: 'https://nuxt-provider.example.net',
      portalUrl: 'https://nuxt-portal.example.net',
      appId: 'nuxt-app',
      allowedOrigin: 'https://nuxt-ops.example.net',
    })
  })

  it('supports the existing legacy deployment names when runtime and NUXT_* values are absent', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    vi.stubEnv('OAUTH_SERVER_URL', 'https://legacy-provider.example.net')
    vi.stubEnv('VITE_OAUTH_PORTAL_URL', 'https://legacy-portal.example.net')
    vi.stubEnv('VITE_APP_ID', 'legacy-app')
    vi.stubEnv('OAUTH_ALLOWED_ORIGIN', 'https://legacy-ops.example.net')

    expect(oauthConfig(event)).toEqual({
      serverUrl: 'https://legacy-provider.example.net',
      portalUrl: 'https://legacy-portal.example.net',
      appId: 'legacy-app',
      allowedOrigin: 'https://legacy-ops.example.net',
    })
  })

  it('fails with a fixed configuration error when any required value is absent', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({}))
    vi.stubEnv('OAUTH_SERVER_URL', 'https://legacy-provider.example.net')
    vi.stubEnv('VITE_OAUTH_PORTAL_URL', 'https://legacy-portal.example.net')
    vi.stubEnv('VITE_APP_ID', 'legacy-app')

    expect(() => oauthConfig(event)).toThrowError('Private sign-in is not configured.')
  })
})
