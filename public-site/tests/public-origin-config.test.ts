import { afterEach, describe, expect, it, vi } from 'vitest'

const envNames = ['PUBLIC_SITE_URL', 'PUBLIC_OPS_API_ORIGIN', 'PUBLIC_OPS_UI_ORIGIN'] as const

async function importConfiguredPublicApi(values: Partial<Record<(typeof envNames)[number], string>>) {
  vi.resetModules()
  for (const name of envNames) vi.stubEnv(name, values[name] ?? '')
  const publicApi = await import('../src/lib/publicApi')
  const destinations = await import('../src/lib/publicDestinations')
  return { ...publicApi, ...destinations }
}

describe('public deployment origin configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses statically named deployment values for canonical, API and customer UI origins', async () => {
    const publicApi = await importConfiguredPublicApi({
      PUBLIC_SITE_URL: 'https://public.launch.example',
      PUBLIC_OPS_API_ORIGIN: 'https://api.launch.example',
      PUBLIC_OPS_UI_ORIGIN: 'https://customer.launch.example',
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ received: true }) })
    vi.stubGlobal('fetch', fetchMock)

    expect(publicApi.publicSiteOrigin).toBe('https://public.launch.example')
    expect(publicApi.publicOpsApiOrigin).toBe('https://api.launch.example')
    expect(publicApi.publicOpsUiOrigin).toBe('https://customer.launch.example')
    expect(publicApi.customerManagedSiteStartUrl).toBe('https://customer.launch.example/customer/managed-sites/start')

    await publicApi.publicApiFetch('/api/leads', { body: { consent: true } })
    expect(fetchMock).toHaveBeenCalledWith('https://api.launch.example/api/leads', expect.objectContaining({ credentials: 'omit' }))
  })

  it('keeps the current single-Nuxt-service topology when a separate UI origin is omitted', async () => {
    const publicApi = await importConfiguredPublicApi({ PUBLIC_OPS_API_ORIGIN: 'https://ops.launch.example' })

    expect(publicApi.publicOpsUiOrigin).toBe('https://ops.launch.example')
    expect(publicApi.customerManagedSiteStartUrl).toBe('https://ops.launch.example/customer/managed-sites/start')
  })

  it('rejects deployment values that contain a path instead of an origin', async () => {
    await expect(importConfiguredPublicApi({ PUBLIC_OPS_API_ORIGIN: 'https://ops.launch.example/api' }))
      .rejects.toThrow('PUBLIC_OPS_API_ORIGIN must be an absolute HTTPS origin')
  })

  it.each(['', 'https://api.example.com', 'https://ops.example.net'])('rejects a production website with a missing or placeholder API origin %s', async apiOrigin => {
    vi.stubEnv('DEV', false)
    await expect(importConfiguredPublicApi({ PUBLIC_SITE_URL: 'https://discoverystack-web.onrender.com', PUBLIC_OPS_API_ORIGIN: apiOrigin }))
      .rejects.toThrow('PUBLIC_OPS_API_ORIGIN cannot be a placeholder')
  })

  it('rejects a separately configured placeholder customer UI origin in production', async () => {
    vi.stubEnv('DEV', false)
    await expect(importConfiguredPublicApi({ PUBLIC_SITE_URL: 'https://discoverystack-web.onrender.com', PUBLIC_OPS_API_ORIGIN: 'https://discoverystack-api.onrender.com', PUBLIC_OPS_UI_ORIGIN: 'https://ops.example.com' }))
      .rejects.toThrow('PUBLIC_OPS_UI_ORIGIN cannot be a placeholder')
  })

  it.each(['https://www.example.com', 'https://example.net', 'https://brand.example.org', 'https://brand.test'])('keeps all reserved documentation origins noindex %s', async origin => {
    const { isPlaceholderSiteUrl } = await import('../src/lib/site')
    expect(isPlaceholderSiteUrl(origin)).toBe(true)
    expect(isPlaceholderSiteUrl('https://discoverystack-web.onrender.com')).toBe(false)
  })
})
