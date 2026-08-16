import { createError } from 'h3'
import { getOwnerProviderCredentials } from './provider-repository'

export type FirecrawlPage = {
  url: string
  html: string
  title: string | null
  statusCode: number | null
  metadata: Record<string, unknown>
}

type FirecrawlResponse = {
  success?: boolean
  id?: string
  url?: string
  status?: string
  data?: Array<Record<string, unknown>>
  error?: string
  warning?: string
}

async function config(ownerUserId?: number) {
  const runtime = useRuntimeConfig()
  const stored = ownerUserId ? await getOwnerProviderCredentials(ownerUserId) : null
  return {
    token: stored?.firecrawlApiKey || String(runtime.firecrawlApiKey || ''),
    baseUrl: String(runtime.firecrawlApiBaseUrl || 'https://api.firecrawl.dev/v2').replace(/\/$/, ''),
  }
}

export async function isFirecrawlConfigured(ownerUserId?: number) {
  return Boolean((await config(ownerUserId)).token)
}

function providerError(statusCode: number, code: string, detail?: string): never {
  throw createError({ statusCode, statusMessage: detail ? `${code}: ${detail}` : code, data: { provider: 'firecrawl', code } })
}

async function request(path: string, init: RequestInit, ownerUserId?: number) {
  const { token, baseUrl } = await config(ownerUserId)
  if (!token) providerError(503, 'firecrawl_not_configured', 'Set FIRECRAWL_API_KEY in the server environment.')
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => ({})) as FirecrawlResponse
  if (!response.ok || body.success === false) providerError(response.status >= 400 && response.status < 500 ? 422 : 503, 'firecrawl_request_failed', body.error || `HTTP ${response.status}`)
  return body
}

function markdownAsHtml(markdown: string) {
  return markdown
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>')
}

function pageFromData(value: Record<string, unknown>): FirecrawlPage | null {
  const metadata = (value.metadata && typeof value.metadata === 'object' ? value.metadata : {}) as Record<string, unknown>
  const url = String(value.url || metadata.sourceURL || metadata.url || '')
  const html = String(value.html || value.rawHtml || (value.markdown ? markdownAsHtml(String(value.markdown)) : ''))
  if (!url || !html) return null
  return {
    url,
    html,
    title: value.title ? String(value.title) : metadata.title ? String(metadata.title) : null,
    statusCode: Number(value.statusCode || metadata.statusCode || 200) || null,
    metadata,
  }
}

export async function runFirecrawlBoundedCrawl(input: { ownerUserId?: number, url: string, maxPages: number, maxDepth: number }) {
  const started = await request('/crawl', {
    method: 'POST',
    body: JSON.stringify({
      url: input.url,
      limit: input.maxPages,
      maxDiscoveryDepth: input.maxDepth,
      crawlEntireDomain: false,
      allowExternalLinks: false,
      allowSubdomains: false,
      scrapeOptions: { formats: ['html'], onlyMainContent: false },
    }),
  }, input.ownerUserId)
  const providerJobId = String(started.id || '')
  if (!providerJobId) providerError(503, 'firecrawl_missing_job_id')

  const deadline = Date.now() + 90_000
  let latest: FirecrawlResponse = started
  while (Date.now() < deadline) {
    const status = String(latest.status || '').toLowerCase()
    if (status === 'completed') break
    if (status === 'failed' || status === 'cancelled') providerError(422, 'firecrawl_job_failed', latest.error || status)
    await new Promise(resolve => setTimeout(resolve, 2_000))
    latest = await request(`/crawl/${encodeURIComponent(providerJobId)}`, { method: 'GET' }, input.ownerUserId)
  }
  if (String(latest.status || '').toLowerCase() !== 'completed') providerError(504, 'firecrawl_job_timeout')
  const pages = (latest.data || []).map(pageFromData).filter((page): page is FirecrawlPage => Boolean(page)).slice(0, input.maxPages)
  return { providerJobId, pages, warning: latest.warning || null }
}
