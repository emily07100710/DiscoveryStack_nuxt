import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchSsrResponse, startSsrServer, stopSsrServer } from './helpers/ssr-server'

describe('private Nuxt runtime boundary', () => {
  beforeAll(async () => {
    // This mirror is injected after the production build, exactly as a Docker
    // host supplies runtime values. It is a public URL, never a secret.
    vi.stubEnv('NUXT_PUBLIC_DISCOVERY_STACK_PUBLIC_SITE_ORIGIN', 'https://public.synthetic.example.test')
    await startSsrServer()
  })
  afterAll(async () => {
    await stopSsrServer()
    vi.unstubAllEnvs()
  })

  it('redirects the root request to the private Audit Lab instead of public content', async () => {
    const response = await fetchSsrResponse('/', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/audit-lab')
    const workbench = await fetchSsrResponse('/audit-lab/learning-loop')
    expect(workbench.status).toBe(200)
    const html = await workbench.text()
    expect(html).toContain('href="https://public.synthetic.example.test/zh-hant"')
    expect(html).not.toContain('href="https://www.example.com/zh-hant"')
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
