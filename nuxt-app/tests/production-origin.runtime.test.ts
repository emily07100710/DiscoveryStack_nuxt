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

  it.each([
    ['/api/content-operations/clients', 'POST'],
    ['/api/managed-sites/customer/contact-messages', 'GET'],
    ['/api/interventions/closed-loop/workspace', 'GET'],
    ['/api/interventions/closed-loop/effect-models', 'GET'],
    ['/api/interventions/closed-loop/effect-models/review', 'POST'],
    ['/api/interventions/closed-loop/effect-models/train', 'POST'],
  ])('loads the protected %s route without allowing an anonymous session', async (path, method) => {
    const response = await fetchSsrResponse(path, {
      method,
      redirect: 'manual',
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})
