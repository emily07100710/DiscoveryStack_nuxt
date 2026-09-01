import { getOwnerProviderCredentials } from '../public-intelligence/provider-repository'

export type RenderCapture = { html: string, httpStatus?: number } | { unavailable: true, reasonCode: string }

export interface RenderedSnapshotProvider {
  isConfigured(ownerUserId?: number): Promise<boolean>
  capture(url: string, ownerUserId?: number): Promise<RenderCapture>
}

type FirecrawlConfig = { token: string, baseUrl: string }

async function resolveFirecrawlConfig(ownerUserId?: number): Promise<FirecrawlConfig> {
  const runtime = useRuntimeConfig()
  const stored = ownerUserId ? await getOwnerProviderCredentials(ownerUserId).catch(() => null) : null
  return {
    token: stored?.firecrawlApiKey || String(runtime.firecrawlApiKey || ''),
    baseUrl: String(runtime.firecrawlApiBaseUrl || 'https://api.firecrawl.dev/v2').replace(/\/$/u, ''),
  }
}

export function createFirecrawlRenderedProvider(options: { fetchImpl?: typeof fetch, configResolver?: (ownerUserId?: number) => Promise<FirecrawlConfig>, timeoutMs?: number } = {}): RenderedSnapshotProvider {
  const fetchImpl = options.fetchImpl || fetch
  const configResolver = options.configResolver || resolveFirecrawlConfig
  return {
    async isConfigured(ownerUserId) { return Boolean((await configResolver(ownerUserId)).token) },
    async capture(url, ownerUserId) {
      try {
        const config = await configResolver(ownerUserId)
        if (!config.token) return { unavailable: true, reasonCode: 'renderer_not_configured' }
        const response = await fetchImpl(`${config.baseUrl}/scrape`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ url, formats: ['html'] }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        })
        const payload = await response.json().catch(() => ({})) as { success?: boolean, data?: { html?: unknown, metadata?: { statusCode?: unknown } }, html?: unknown }
        const html = typeof payload.data?.html === 'string' ? payload.data.html : typeof payload.html === 'string' ? payload.html : ''
        if (!response.ok || payload.success === false || !html) return { unavailable: true, reasonCode: 'renderer_failed' }
        const status = Number(payload.data?.metadata?.statusCode)
        return { html, ...(Number.isInteger(status) ? { httpStatus: status } : {}) }
      } catch { return { unavailable: true, reasonCode: 'renderer_failed' } }
    },
  }
}
