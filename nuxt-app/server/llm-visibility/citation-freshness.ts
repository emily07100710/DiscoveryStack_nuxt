import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

export const CITATION_HEAD_MAX_REQUESTS = 100
export const CITATION_HEAD_TIMEOUT_MS = 5_000
export const CITATION_HEAD_MAX_REDIRECTS = 3

export type CitationDateSource = 'provider_metadata' | 'url_pattern' | 'http_last_modified' | 'unknown'
export type CitationFreshnessRecord = {
  url: string
  dateSource: CitationDateSource
  sourceDate: string | null
  ageDays: number | null
}

type DnsAddress = string | { address: string }
type HeadResult = { sourceDate: string | null }
export type CitationHeadFetchOptions = {
  enabled: boolean
  fetchImpl: typeof fetch
  resolveDns: (hostname: string) => Promise<DnsAddress[]>
  budget: { maxRequests: number, used?: number }
  cache: Map<string, Promise<HeadResult> | HeadResult>
  now?: () => Date
}

const blocked = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) blocked.addSubnet(network, prefix, 'ipv6')

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '')
}

function isPublicAddress(value: string): boolean {
  const address = normalizedHostname(value)
  if (address.startsWith('::ffff:')) return false
  const version = isIP(address)
  return version !== 0 && !blocked.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

export function isPublicHttpUrl(value: string, resolvedAddresses: DnsAddress[] = []): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  const hostname = normalizedHostname(url.hostname)
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || !isIP(hostname) && !hostname.includes('.')) return false
  if (isIP(hostname) && !isPublicAddress(hostname)) return false
  return resolvedAddresses.every(item => isPublicAddress(typeof item === 'string' ? item : item.address))
}

function validCalendarDate(value: string, maximumYear?: number, minimumYear = 1): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return null
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  if (year < minimumYear || maximumYear !== undefined && year > maximumYear) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null
}

export function normalizeCitationSourceDate(value: unknown, maximumYear?: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const direct = validCalendarDate(value.trim(), maximumYear)
  if (direct) return direct
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return null
  return validCalendarDate(parsed.toISOString().slice(0, 10), maximumYear)
}

export function dateFromCitationUrl(value: string, observedAt: Date): string | null {
  let path: string
  try { path = decodeURIComponent(new URL(value).pathname) } catch { return null }
  const candidates = [
    ...path.matchAll(/(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/gu),
    ...path.matchAll(/(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})(?:[^0-9]|$)/gu),
  ]
  for (const match of candidates) {
    const normalized = validCalendarDate(`${match[1]}-${match[2]}-${match[3]}`, observedAt.getUTCFullYear() + 1, 2000)
    if (normalized) return normalized
  }
  return null
}

function freshness(url: string, dateSource: CitationDateSource, sourceDate: string | null, observedAt: Date): CitationFreshnessRecord {
  const ageDays = sourceDate === null ? null : Math.floor((observedAt.getTime() - Date.parse(`${sourceDate}T00:00:00.000Z`)) / 86_400_000)
  return { url, dateSource, sourceDate, ageDays }
}

async function validatePublicTarget(url: URL, resolveDns: CitationHeadFetchOptions['resolveDns']): Promise<boolean> {
  if (!isPublicHttpUrl(url.toString())) return false
  if (isIP(normalizedHostname(url.hostname))) return true
  try {
    const addresses = await resolveDns(normalizedHostname(url.hostname))
    return addresses.length > 0 && isPublicHttpUrl(url.toString(), addresses)
  } catch { return false }
}

function lastModifiedDate(response: Response, fetchTime: Date): string | null {
  const raw = response.headers.get('last-modified')
  if (!raw) return null
  const modified = new Date(raw)
  if (!Number.isFinite(modified.getTime())) return null
  const responseDateRaw = response.headers.get('date')
  const responseDate = responseDateRaw ? new Date(responseDateRaw) : null
  if (responseDate && Number.isFinite(responseDate.getTime()) && responseDate.getTime() === modified.getTime()) return null
  if (modified.getTime() > fetchTime.getTime() || fetchTime.getTime() - modified.getTime() < 86_400_000) return null
  return normalizeCitationSourceDate(modified.toISOString())
}

async function fetchHeadSourceDate(initialUrl: string, options: CitationHeadFetchOptions): Promise<HeadResult> {
  let current: URL
  try { current = new URL(initialUrl) } catch { return { sourceDate: null } }
  const visited: string[] = []
  const finish = (result: HeadResult) => {
    for (const url of visited) options.cache.set(url, result)
    return result
  }
  for (let redirects = 0; redirects <= CITATION_HEAD_MAX_REDIRECTS; redirects += 1) {
    if (!await validatePublicTarget(current, options.resolveDns)) return finish({ sourceDate: null })
    visited.push(current.toString())
    const used = options.budget.used || 0
    if (used >= Math.min(options.budget.maxRequests, CITATION_HEAD_MAX_REQUESTS)) return finish({ sourceDate: null })
    options.budget.used = used + 1
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CITATION_HEAD_TIMEOUT_MS)
    let response: Response
    const fetchTime = (options.now || (() => new Date()))()
    try {
      response = await options.fetchImpl(current.toString(), { method: 'HEAD', redirect: 'manual', signal: controller.signal })
    } catch { return finish({ sourceDate: null }) } finally { clearTimeout(timeout) }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects === CITATION_HEAD_MAX_REDIRECTS) return finish({ sourceDate: null })
      try { current = new URL(location, current) } catch { return finish({ sourceDate: null }) }
      continue
    }
    return finish({ sourceDate: response.ok ? lastModifiedDate(response, fetchTime) : null })
  }
  return finish({ sourceDate: null })
}

async function cachedHead(url: string, options: CitationHeadFetchOptions): Promise<HeadResult> {
  const cached = options.cache.get(url)
  if (cached) return cached
  const pending = fetchHeadSourceDate(url, options)
  options.cache.set(url, pending)
  const resolved = await pending
  options.cache.set(url, resolved)
  return resolved
}

export async function resolveCitationFreshness(urls: string[], input: { observedAt: Date | string, providerDates?: Record<string, string>, headFetch?: CitationHeadFetchOptions }): Promise<CitationFreshnessRecord[]> {
  const observedAt = new Date(input.observedAt)
  if (!Number.isFinite(observedAt.getTime())) throw new Error('INVALID_OBSERVED_AT')
  const output: CitationFreshnessRecord[] = []
  for (const url of urls.slice(0, 50)) {
    const providerDate = normalizeCitationSourceDate(input.providerDates?.[url], observedAt.getUTCFullYear() + 1)
    if (providerDate) { output.push(freshness(url, 'provider_metadata', providerDate, observedAt)); continue }
    const urlDate = dateFromCitationUrl(url, observedAt)
    if (urlDate) { output.push(freshness(url, 'url_pattern', urlDate, observedAt)); continue }
    if (input.headFetch?.enabled) {
      const { sourceDate } = await cachedHead(url, input.headFetch)
      if (sourceDate) { output.push(freshness(url, 'http_last_modified', sourceDate, observedAt)); continue }
    }
    output.push(freshness(url, 'unknown', null, observedAt))
  }
  return output
}

export function citationHeadFetchEnabled(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.LLM_VISIBILITY_CITATION_HEAD_FETCH === 'true'
}

export function createDefaultCitationHeadFetch(environment: Record<string, string | undefined> = process.env): CitationHeadFetchOptions {
  return {
    enabled: citationHeadFetchEnabled(environment),
    fetchImpl: fetch,
    resolveDns: async hostname => (await lookup(hostname, { all: true })).map(row => row.address),
    budget: { maxRequests: CITATION_HEAD_MAX_REQUESTS },
    cache: new Map(),
  }
}
