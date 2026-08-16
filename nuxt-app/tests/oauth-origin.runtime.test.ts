import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchSsrResponse, startSsrServer, stopSsrServer } from './helpers/ssr-server'

const oauthOrigin = process.env.NUXT_DISCOVERY_STACK_OAUTH_ALLOWED_ORIGIN
const productionArtifact = join(process.cwd(), '.output/server/index.mjs')
const hasCurrentRuntimeConfig = existsSync(productionArtifact) && readFileSync(productionArtifact, 'utf8').includes('discoveryStackOauthAllowedOrigin')

describe('DiscoveryStack OAuth origin runtime secret', () => {
  beforeAll(startSsrServer)
  afterAll(stopSsrServer)

  it.skipIf(!hasCurrentRuntimeConfig)('accepts only the configured HTTPS production origin without contacting the OAuth provider', async () => {
    expect(oauthOrigin).toMatch(/^https:\/\//)

    const response = await fetchSsrResponse(`/api/auth/login?origin=${encodeURIComponent(oauthOrigin!)}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('x-discoverystack-oauth-route')).toBe('nuxt-origin-allowlist-v1')
    expect(response.headers.get('location')).toContain('oauth')
  })
})
