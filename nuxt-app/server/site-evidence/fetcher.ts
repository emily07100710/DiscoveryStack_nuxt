import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { assertSafeAuditTarget } from '../audit/targetGuard'
import { isPublicIpAddress } from '../utils/publicSiteAnalysis'
import type { RedirectHop } from './types'

export type FetchPurpose = 'page' | 'sitemap' | 'robots'
export type DnsCheck = (hostname: string) => Promise<void>

export type SafeFetchResult = {
  requestedUrl: string
  finalUrl: string
  status: number
  headers: Headers
  contentType: string
  body: string
  bytesFetched: number
  redirectChain: RedirectHop[]
  durationMs: number
}

export class SiteEvidenceFetchError extends Error {
  constructor(public readonly code: 'private_network_target' | 'unsupported_content_type' | 'response_too_large' | 'redirect_limit' | 'fetch_timeout' | 'fetch_failed', message = code) {
    super(message)
    this.name = 'SiteEvidenceFetchError'
  }
}

export async function defaultPublicDnsCheck(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new SiteEvidenceFetchError('private_network_target')
    return
  }
  let addresses: Array<{ address: string, family: number | string }>
  try { addresses = await lookup(hostname, { all: true, verbatim: true }) } catch { throw new SiteEvidenceFetchError('fetch_failed') }
  if (!addresses.length || addresses.some(item => !isPublicIpAddress(item.address))) throw new SiteEvidenceFetchError('private_network_target')
}

function safeTarget(rawUrl: string) {
  try { return assertSafeAuditTarget(rawUrl) } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/private|local|link-local|credentials|standard public web port/iu.test(message)) throw new SiteEvidenceFetchError('private_network_target')
    throw new SiteEvidenceFetchError('fetch_failed')
  }
}

function acceptFor(purpose: FetchPurpose) {
  if (purpose === 'page') return 'text/html,application/xhtml+xml'
  if (purpose === 'sitemap') return 'application/xml,text/xml,text/plain,text/html'
  return 'text/plain,text/*'
}

function contentTypeAllowed(purpose: FetchPurpose, raw: string) {
  const type = raw.split(';', 1)[0]!.trim().toLowerCase()
  if (purpose === 'page') return type === 'text/html' || type === 'application/xhtml+xml'
  if (purpose === 'sitemap') return ['application/xml', 'text/xml', 'text/plain', 'text/html'].includes(type)
  return type === 'text/plain' || type.startsWith('text/')
}

async function readBoundedBody(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new SiteEvidenceFetchError('response_too_large')
  if (!response.body) return { body: '', bytes: 0 }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new SiteEvidenceFetchError('response_too_large')
      }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
  return { body: new TextDecoder().decode(combined), bytes }
}

function asFetchError(error: unknown): SiteEvidenceFetchError {
  if (error instanceof SiteEvidenceFetchError) return error
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /timed? ?out|timeout/iu.test(error.message))) return new SiteEvidenceFetchError('fetch_timeout')
  if (error instanceof Error && error.message === 'private_network_target') return new SiteEvidenceFetchError('private_network_target')
  return new SiteEvidenceFetchError('fetch_failed')
}

export async function safeFetch(rawUrl: string, options: {
  purpose: FetchPurpose
  fetchImpl?: typeof fetch
  dnsCheck?: DnsCheck
  timeoutMs?: number
  maxBytes?: number
  nowMs?: () => number
}): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl || fetch
  const dnsCheck = options.dnsCheck || defaultPublicDnsCheck
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const nowMs = options.nowMs || Date.now
  const started = nowMs()
  const requestedUrl = rawUrl
  let current = rawUrl
  const redirectChain: RedirectHop[] = []
  try {
    for (;;) {
      const target = safeTarget(current)
      await dnsCheck(target.hostname)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new DOMException('Fetch timeout', 'TimeoutError')), timeoutMs)
      try {
        const response = await fetchImpl(target.normalizedUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: acceptFor(options.purpose), 'User-Agent': 'DiscoveryStack-SiteEvidence/1.0' },
          signal: controller.signal,
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location || redirectChain.length >= 5) throw new SiteEvidenceFetchError('redirect_limit')
          redirectChain.push({ url: target.normalizedUrl, status: response.status })
          try { current = new URL(location, target.normalizedUrl).toString() } catch { throw new SiteEvidenceFetchError('fetch_failed') }
          continue
        }
        const contentType = response.headers.get('content-type') || ''
        if (!contentTypeAllowed(options.purpose, contentType)) throw new SiteEvidenceFetchError('unsupported_content_type')
        const bounded = await readBoundedBody(response, maxBytes)
        return { requestedUrl, finalUrl: target.normalizedUrl, status: response.status, headers: response.headers, contentType: contentType.split(';', 1)[0]!.toLowerCase(), body: bounded.body, bytesFetched: bounded.bytes, redirectChain, durationMs: Math.max(0, nowMs() - started) }
      } finally {
        clearTimeout(timeout)
      }
    }
  } catch (error) { throw asFetchError(error) }
}

export function createSiteEvidenceFetcher(defaults: { fetchImpl?: typeof fetch, dnsCheck?: DnsCheck, timeoutMs?: number } = {}) {
  return (url: string, purpose: FetchPurpose) => safeFetch(url, { purpose, ...defaults })
}

export type SiteEvidenceFetcher = ReturnType<typeof createSiteEvidenceFetcher>
