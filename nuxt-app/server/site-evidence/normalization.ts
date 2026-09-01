import { createHash } from 'node:crypto'

const trackingNames = new Set(['gclid', 'fbclid', 'msclkid'])

function cleanPath(pathname: string) {
  const collapsed = pathname.replace(/\/{2,}/g, '/') || '/'
  return collapsed === '/' ? '/' : collapsed.replace(/\/+$/u, '') || '/'
}

function isTracking(name: string) {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || trackingNames.has(lower)
}

export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  url.protocol = url.protocol.toLowerCase()
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = ''
  url.hash = ''
  url.pathname = cleanPath(url.pathname)
  const entries = [...url.searchParams.entries()].filter(([name]) => !isTracking(name)).sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv))
  url.search = ''
  for (const [name, value] of entries) url.searchParams.append(name, value)
  return url.toString()
}

export function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function urlHash(rawUrl: string) {
  return sha256Hex(normalizeUrl(rawUrl))
}

export function apexTwinHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`
}

function standardPort(url: URL) {
  return !url.port || (url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')
}

export function isSameSite(leftRaw: string, rightRaw: string): boolean {
  let left: URL
  let right: URL
  try { left = new URL(leftRaw); right = new URL(rightRaw) } catch { return false }
  if (!['http:', 'https:'].includes(left.protocol) || !['http:', 'https:'].includes(right.protocol) || !standardPort(left) || !standardPort(right)) return false
  const leftHost = left.hostname.toLowerCase().replace(/\.$/u, '')
  const rightHost = right.hostname.toLowerCase().replace(/\.$/u, '')
  return leftHost === rightHost || apexTwinHost(leftHost) === rightHost
}

export type UrlVariantRelation = 'scheme_variant' | 'www_variant' | 'slash_variant' | 'param_variant' | 'identical' | 'unrelated'

function comparable(url: URL) {
  return {
    host: url.hostname.toLowerCase().replace(/^www\./u, ''),
    path: cleanPath(url.pathname),
    query: [...url.searchParams.entries()].filter(([name]) => !isTracking(name)).sort().map(([key, value]) => `${key}=${value}`).join('&'),
  }
}

export function classifyUrlVariant(leftRaw: string, rightRaw: string): UrlVariantRelation {
  let left: URL
  let right: URL
  try { left = new URL(leftRaw); right = new URL(rightRaw) } catch { return 'unrelated' }
  if (left.toString() === right.toString()) return 'identical'
  const a = comparable(left)
  const b = comparable(right)
  if (a.host !== b.host || a.path !== b.path) return 'unrelated'
  if (left.protocol !== right.protocol && left.hostname.toLowerCase() === right.hostname.toLowerCase() && a.query === b.query) return 'scheme_variant'
  if (left.hostname.toLowerCase() !== right.hostname.toLowerCase() && isSameSite(left.toString(), right.toString()) && left.protocol === right.protocol && a.query === b.query) return 'www_variant'
  if (left.pathname !== right.pathname && cleanPath(left.pathname) === cleanPath(right.pathname) && left.protocol === right.protocol && left.hostname.toLowerCase() === right.hostname.toLowerCase() && a.query === b.query) return 'slash_variant'
  if ((left.search !== right.search || normalizeUrl(leftRaw) === normalizeUrl(rightRaw)) && left.protocol === right.protocol && left.hostname.toLowerCase() === right.hostname.toLowerCase()) return 'param_variant'
  return normalizeUrl(leftRaw) === normalizeUrl(rightRaw) ? 'identical' : 'unrelated'
}
