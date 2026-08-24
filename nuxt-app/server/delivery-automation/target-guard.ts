import type {
  DeliveryAdapter,
  DeliveryTargetInput,
  DeliveryTargetStatus,
  TargetValidationResult,
  ValidatedDeliveryTarget,
} from './types'

const MAX_ENDPOINT_LENGTH = 512
const adapters = new Set<DeliveryAdapter>(['wordpress_rest', 'generic_http', 'manual_export'])
const statuses = new Set<DeliveryTargetStatus>(['active', 'paused', 'revoked'])

const blockedDnsSuffixes = ['.local', '.internal', '.localhost', '.onion'] as const

function blocked<T extends TargetValidationResult['code']>(code: T, ...reasons: string[]): TargetValidationResult {
  return { status: 'blocked', code, reasons }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  try {
    const value = record[key]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function readValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function ipv4ToNumber(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  const octets = parts.map(Number)
  if (octets.some((part) => part < 0 || part > 255)) return undefined
  const [first = 0, second = 0, third = 0, fourth = 0] = octets
  return (((first * 256 + second) * 256 + third) * 256 + fourth) >>> 0
}

function inIpv4Range(value: number, start: string, end: string): boolean {
  const lower = ipv4ToNumber(start)
  const upper = ipv4ToNumber(end)
  return lower !== undefined && upper !== undefined && value >= lower && value <= upper
}

function isBlockedIpv4(hostname: string): boolean {
  const value = ipv4ToNumber(hostname)
  if (value === undefined) return true
  return [
    ['0.0.0.0', '0.255.255.255'],
    ['10.0.0.0', '10.255.255.255'],
    ['100.64.0.0', '100.127.255.255'],
    ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'],
    ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'],
    ['192.0.2.0', '192.0.2.255'],
    ['192.88.99.0', '192.88.99.255'],
    ['192.168.0.0', '192.168.255.255'],
    ['198.18.0.0', '198.19.255.255'],
    ['198.51.100.0', '198.51.100.255'],
    ['203.0.113.0', '203.0.113.255'],
    ['224.0.0.0', '255.255.255.255'],
  ].some(([start, end]) => inIpv4Range(value, start ?? '', end ?? ''))
}

function expandIpv6(hostname: string): number[] | undefined {
  const withoutZone = hostname.split('%')[0] ?? ''
  if (withoutZone.includes('.')) {
    const lastColon = withoutZone.lastIndexOf(':')
    const mappedIpv4 = lastColon >= 0 ? ipv4ToNumber(withoutZone.slice(lastColon + 1)) : undefined
    if (mappedIpv4 === undefined) return undefined
    const prefix = withoutZone.slice(0, lastColon)
    const prefixWords = prefix.split(':').filter(Boolean)
    if (prefixWords.length > 6) return undefined
    const ipv4Words = [(mappedIpv4 / 65536) & 0xffff, mappedIpv4 & 0xffff]
    const words = [...prefixWords.map((word) => Number.parseInt(word, 16)), ...ipv4Words]
    if (prefix.includes('::')) {
      const missing = 8 - words.length
      if (missing < 1) return undefined
      const [left, right = ''] = prefix.split('::')
      const leftWords = left ? left.split(':').filter(Boolean).map((word) => Number.parseInt(word, 16)) : []
      const rightWords = right ? right.split(':').filter(Boolean).map((word) => Number.parseInt(word, 16)) : []
      return [...leftWords, ...Array.from({ length: 8 - leftWords.length - rightWords.length }, () => 0), ...rightWords, ...ipv4Words].slice(0, 8)
    }
    return words.length === 8 ? words : undefined
  }
  const pieces = hostname.split('::')
  if (pieces.length > 2) return undefined
  const left = pieces[0] ? pieces[0].split(':').filter(Boolean) : []
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':').filter(Boolean) : []
  if (left.concat(right).some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return undefined
  const missing = 8 - left.length - right.length
  if (pieces.length === 1 && missing !== 0) return undefined
  if (pieces.length === 2 && missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right].map((word) => typeof word === 'number' ? word : Number.parseInt(word, 16))
}

function detectIpVersion(hostname: string): 0 | 4 | 6 | -1 {
  if (ipv4ToNumber(hostname) !== undefined) return 4
  if (hostname.includes(':')) return expandIpv6(hostname) === undefined ? -1 : 6
  return 0
}

function isBlockedIpv6(hostname: string): boolean {
  const words = expandIpv6(hostname)
  if (!words || words.length !== 8) return true
  const first = words[0] ?? 0
  const second = words[1] ?? 0
  const isZero = words.every((word) => word === 0)
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  const isUla = (first & 0xfe00) === 0xfc00
  const isLinkLocal = (first & 0xffc0) === 0xfe80
  const isMulticast = (first & 0xff00) === 0xff00
  const isDocumentation = first === 0x2001 && second === 0x0db8
  const isDiscardOnly = first === 0x0100 && words.slice(1).every((word) => word === 0)
  const isBenchmarking = first === 0x2001 && (second & 0xfff0) === 0x0002
  const isOrchid = first === 0x2001 && (second & 0xfff0) === 0x0010
  const isMapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  let mappedPrivate = false
  if (isMapped) {
    const mappedValue = ((words[6] ?? 0) * 65536 + (words[7] ?? 0)) >>> 0
    mappedPrivate = [
      ['0.0.0.0', '0.255.255.255'],
      ['10.0.0.0', '10.255.255.255'],
      ['127.0.0.0', '127.255.255.255'],
      ['169.254.0.0', '169.254.255.255'],
      ['172.16.0.0', '172.31.255.255'],
      ['192.0.0.0', '192.0.0.255'],
      ['192.0.2.0', '192.0.2.255'],
      ['192.168.0.0', '192.168.255.255'],
      ['198.51.100.0', '198.51.100.255'],
      ['203.0.113.0', '203.0.113.255'],
    ].some(([start, end]) => {
      const low = ipv4ToNumber(start ?? '') ?? 0
      const high = ipv4ToNumber(end ?? '') ?? 0
      return mappedValue >= low && mappedValue <= high
    })
  }
  return isZero || isLoopback || isUla || isLinkLocal || isMulticast || isDocumentation || isDiscardOnly || isBenchmarking || isOrchid || mappedPrivate
}

function validateOrigin(value: unknown): { ok: true; origin: string } | { ok: false; reason: string } {
  if (!nonEmptyString(value)) return { ok: false, reason: 'targetOrigin must be a non-empty string' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'targetOrigin must be an absolute URL' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'targetOrigin must use HTTPS' }
  if (parsed.username || parsed.password) return { ok: false, reason: 'targetOrigin cannot contain credentials' }
  if (parsed.port && parsed.port !== '443') return { ok: false, reason: 'targetOrigin may only use port 443' }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return { ok: false, reason: 'targetOrigin must be an origin without path, query or fragment' }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || blockedDnsSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, reason: 'targetOrigin hostname is not a public DNS hostname' }
  }
  const ipVersion = detectIpVersion(hostname)
  if (ipVersion === -1) return { ok: false, reason: 'targetOrigin IP literal is malformed' }
  if (ipVersion === 4 && isBlockedIpv4(hostname)) return { ok: false, reason: 'targetOrigin IPv4 is private or reserved' }
  if (ipVersion === 6 && isBlockedIpv6(hostname)) return { ok: false, reason: 'targetOrigin IPv6 is private or reserved' }
  if (ipVersion === 0 && (!hostname.includes('.') || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..'))) {
    return { ok: false, reason: 'targetOrigin hostname must be a normal public DNS hostname' }
  }
  if (hostname.includes('%')) return { ok: false, reason: 'targetOrigin hostname cannot contain a zone identifier' }
  return { ok: true, origin: parsed.origin }
}

function validateEndpoint(value: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: 'endpointPath length is invalid' }
  if (!value.startsWith('/') || value.startsWith('//')) return { ok: false, reason: 'endpointPath must be a path beginning with one slash' }
  if (/[\r\n\0?#]/.test(value) || value.includes('://') || value.includes('\\')) return { ok: false, reason: 'endpointPath contains a forbidden delimiter' }
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return { ok: false, reason: 'endpointPath contains malformed percent encoding' }
  }
  if (decoded.includes('/') && decoded !== value) return { ok: false, reason: 'endpointPath cannot encode a path separator' }
  const rawSegments = value.split('/')
  const decodedSegments = decoded.split('/')
  if ([...rawSegments, ...decodedSegments].some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, reason: 'endpointPath contains dot-segment traversal' }
  }
  return { ok: true, path: value }
}

export function validateDeliveryTarget(input: unknown): TargetValidationResult {
  try {
    if (!isRecord(input)) return blocked('INVALID_INPUT', 'target must be a plain object')
    const targetOrigin = readValue(input, 'targetOrigin')
    const endpointPath = readValue(input, 'endpointPath')
    const origin = validateOrigin(targetOrigin)
    if (!origin.ok) return blocked('INVALID_TARGET_ORIGIN', origin.reason)
    const endpoint = validateEndpoint(endpointPath)
    if (!endpoint.ok) return blocked('INVALID_ENDPOINT_PATH', endpoint.reason)

    const targetId = readString(input, 'targetId')
    const ownerScopeKey = readString(input, 'ownerScopeKey')
    const adapter = readString(input, 'adapter')
    const status = readString(input, 'status')
    const policyVersion = readString(input, 'policyVersion')
    const serverCredentialConfigured = readValue(input, 'serverCredentialConfigured')
    const allowedContentTypes = readValue(input, 'allowedContentTypes')
    const allowedLanguages = readValue(input, 'allowedLanguages')
    const maximumPayloadBytes = readValue(input, 'maximumPayloadBytes')

    if (!nonEmptyString(targetId) || !nonEmptyString(ownerScopeKey) || !nonEmptyString(policyVersion)) return blocked('INVALID_INPUT', 'target identity fields are required')
    if (!adapter || !adapters.has(adapter as DeliveryAdapter)) return blocked('UNSUPPORTED_ADAPTER', 'adapter is not supported')
    if (!status || !statuses.has(status as DeliveryTargetStatus)) return blocked('INVALID_INPUT', 'target status is invalid')
    if (typeof serverCredentialConfigured !== 'boolean') return blocked('INVALID_INPUT', 'serverCredentialConfigured must be boolean')
    if (!Array.isArray(allowedContentTypes) || allowedContentTypes.length > 100 || allowedContentTypes.some((value) => !nonEmptyString(value))) return blocked('INVALID_INPUT', 'allowedContentTypes must be a bounded string array')
    if (!Array.isArray(allowedLanguages) || allowedLanguages.length > 100 || allowedLanguages.some((value) => !nonEmptyString(value))) return blocked('INVALID_INPUT', 'allowedLanguages must be a bounded string array')
    if (!finitePositive(maximumPayloadBytes)) return blocked('INVALID_INPUT', 'maximumPayloadBytes must be a finite positive number')

    const target: ValidatedDeliveryTarget = {
      targetId,
      ownerScopeKey,
      adapter: adapter as DeliveryAdapter,
      targetOrigin: targetOrigin as string,
      endpointPath: endpointPath as string,
      status: status as DeliveryTargetStatus,
      serverCredentialConfigured,
      allowedContentTypes: [...(allowedContentTypes as string[])],
      allowedLanguages: [...(allowedLanguages as string[])],
      maximumPayloadBytes,
      policyVersion,
      normalizedOrigin: origin.origin,
      normalizedEndpointPath: endpoint.path,
    }
    return { status: 'valid', target, reasons: [] }
  } catch {
    return blocked('INVALID_INPUT', 'target could not be validated')
  }
}
