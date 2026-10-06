import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isSpecialUseIpv4, isSpecialUseIpv6 } from '../../../content-operations/normalization'

export const MAX_MANAGED_SITE_PRODUCTION_HTML_BYTES = 1024 * 1024
export type ManagedSiteProductionProbe = (canonicalDomain: string, timeoutMs: number, pathname?: string) => Promise<{ status: number; contentType: string; body: string }>

function safePathname(value: string): string | null {
  if (!value.startsWith('/') || value.length > 1024 || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) return null
  let url: URL
  try { url = new URL(value, 'https://managed-site.invalid') } catch { return null }
  if (url.origin !== 'https://managed-site.invalid' || url.search || url.hash || url.pathname !== value || url.pathname.includes('//') || url.pathname.split('/').some(segment => segment === '.' || segment === '..')) return null
  return url.pathname
}

/** Observe only the canonical HTTPS homepage, pinning a public address and retaining normal TLS verification. */
export async function probeManagedSiteProductionPath(canonicalDomain: string, pathname: string, timeoutMs: number, dependencies: {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  request?: typeof httpsRequest
} = {}): ReturnType<ManagedSiteProductionProbe> {
  const empty = { status: 0, contentType: '', body: '' }
  const safePath = safePathname(pathname)
  if (!safePath || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(canonicalDomain) || isIP(canonicalDomain)) return empty
  const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 5_000))
  const lookup = dependencies.lookup || (hostname => dnsLookup(hostname, { all: true, verbatim: true }))
  let timer: ReturnType<typeof setTimeout> | undefined
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await Promise.race([lookup(canonicalDomain), new Promise<Array<{ address: string; family: number }>>(resolve => { timer = setTimeout(() => resolve([]), Math.max(1, deadline - Date.now())) })])
  } catch { return empty } finally { clearTimeout(timer) }
  if (!addresses.length || addresses.some(({ address, family }) => isIP(address) !== family || (family === 4 ? isSpecialUseIpv4(address) : family === 6 ? isSpecialUseIpv6(address) : true))) return empty
  const pinned = addresses[0]!
  return new Promise(resolve => {
    let settled = false; let total = 0; const chunks: Buffer[] = []
    const finish = (value: typeof empty) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
    const request = (dependencies.request || httpsRequest)({ protocol: 'https:', hostname: canonicalDomain, servername: canonicalDomain, family: pinned.family, port: 443, path: safePath, method: 'GET', headers: { accept: 'text/html', 'accept-encoding': 'identity', 'cache-control': 'no-cache', 'user-agent': 'DiscoveryStack-Production-Verification/1' }, lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family as 4 | 6) }, response => {
      const status = response.statusCode || 0
      const contentType = String(response.headers['content-type'] || '')
      if (status !== 200 || !/^text\/html(?:\s*;|$)/iu.test(contentType) || Number(response.headers['content-length'] || 0) > MAX_MANAGED_SITE_PRODUCTION_HTML_BYTES) { response.destroy(); finish(empty); return }
      response.on('data', chunk => { const bytes = Buffer.from(chunk); total += bytes.byteLength; if (total > MAX_MANAGED_SITE_PRODUCTION_HTML_BYTES) { request.destroy(); finish(empty) } else chunks.push(bytes) })
      response.on('end', () => finish({ status, contentType, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', () => finish(empty))
    })
    timer = setTimeout(() => { request.destroy(); finish(empty) }, Math.max(1, deadline - Date.now()))
    request.on('error', () => finish(empty))
    request.end()
  })
}

/** Backwards-compatible homepage verifier used by the initial production release path. */
export async function probeManagedSiteProductionHomepage(canonicalDomain: string, timeoutMs: number, dependencies: {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  request?: typeof httpsRequest
} = {}): ReturnType<ManagedSiteProductionProbe> {
  return probeManagedSiteProductionPath(canonicalDomain, '/', timeoutMs, dependencies)
}
