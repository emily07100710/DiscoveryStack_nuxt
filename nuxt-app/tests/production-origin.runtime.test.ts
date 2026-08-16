import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchSsrHtml, startSsrServer, stopSsrServer } from './helpers/ssr-server'

const siteUrl = process.env.NUXT_PUBLIC_SITE_URL
const oauthOrigin = process.env.OAUTH_ALLOWED_ORIGIN

describe('production HTTPS origin', () => {
  beforeAll(startSsrServer)
  afterAll(stopSsrServer)

  it('serves the English SSR route with the configured HTTPS canonical URL', async () => {
    expect(siteUrl).toBeTruthy()
    expect(oauthOrigin).toBeTruthy()
    expect(new URL(oauthOrigin!).origin).toBe(new URL(siteUrl!).origin)

    const { response, html } = await fetchSsrHtml('/en')
    expect(response.ok).toBe(true)
    expect(html).toContain(`${siteUrl}/en`)
  })
})
