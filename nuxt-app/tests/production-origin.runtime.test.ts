import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchSsrResponse, startSsrServer, stopSsrServer } from './helpers/ssr-server'

describe('private Nuxt runtime boundary', () => {
  beforeAll(startSsrServer)
  afterAll(stopSsrServer)

  it('redirects the root request to the private Audit Lab instead of public content', async () => {
    const response = await fetchSsrResponse('/', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/audit-lab')
  })
})
