import { DELIVERY_POLICY_VERSION } from './policy-catalog'
import { isOpaqueIdentifier } from './idempotency'
import type {
  DeliveryAdapter,
  DeliveryTargetInput,
  DeliveryTargetStatus,
  TargetValidationResult,
  ValidatedDeliveryTarget,
} from './types'

const MAX_ENDPOINT_LENGTH = 512
const MAX_ALLOWLIST_ENTRIES = 20
const MAX_ALLOWLIST_ITEM_LENGTH = 64
const MAX_PAYLOAD_BYTES = 10_000_000
const MAX_HOSTNAME_LENGTH = 253

const adapters = new Set<DeliveryAdapter>(['wordpress_rest', 'generic_http', 'manual_export', 'first_party_git', 'first_party_signed_api'])
const statuses = new Set<DeliveryTargetStatus>(['active', 'paused', 'revoked'])
const blockedDnsSuffixes = ['.local', '.internal', '.localhost', '.onion'] as const
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/

function blocked<T extends TargetValidationResult['code']>(code: T, ...reasons: string[]): TargetValidationResult {
  return { status: 'blocked', code, reasons }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function parseIpv6Word(value: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/i.test(value)) return undefined
  return Number.parseInt(value, 16)
}

function expandIpv6(hostname: string): number[] | undefined {
  if (hostname.includes('%')) return undefined
  const hasIpv4Suffix = hostname.includes('.')
  let address = hostname
  let ipv4Words: number[] = []
  if (hasIpv4Suffix) {
    const lastColon = hostname.lastIndexOf(':')
    if (lastColon < 1) return undefined
    const ipv4 = ipv4ToNumber(hostname.slice(lastColon + 1))
    if (ipv4 === undefined) return undefined
    ipv4Words = [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff]
    address = hostname.slice(0, lastColon)
  }

  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const leftWords = halves[0] === '' ? [] : halves[0]?.split(':').map(parseIpv6Word)
  const rightWords = halves.length === 2 && halves[1] !== '' ? halves[1]?.split(':').map(parseIpv6Word) : []
  if (!leftWords || !rightWords || leftWords.some((word) => word === undefined) || rightWords.some((word) => word === undefined)) return undefined
  const left = leftWords as number[]
  const right = rightWords as number[]
  const explicitLength = left.length + right.length + ipv4Words.length
  if (halves.length === 1) return explicitLength === 8 ? [...left, ...right, ...ipv4Words] : undefined
  const missing = 8 - explicitLength
  if (missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right, ...ipv4Words]
}

function detectIpVersion(hostname: string): 0 | 4 | 6 | -1 {
  if (ipv4ToNumber(hostname) !== undefined) return 4
  if (hostname.includes(':')) return expandIpv6(hostname) === undefined ? -1 : 6
  if (hostname.split('.').every((label) => /^\d+$/.test(label))) return -1
  return 0
}

function isBlockedIpv6(hostname: string): boolean {
  const words = expandIpv6(hostname)
  if (!words || words.length !== 8) return true
  const first = words[0] ?? 0
  const second = words[1] ?? 0
  const isZero = words.every((word) => word === 0)
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  const isMapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  const isUla = (first & 0xfe00) === 0xfc00
  const isLinkLocal = (first & 0xffc0) === 0xfe80
  const isMulticast = (first & 0xff00) === 0xff00
  const isDocumentation = first === 0x2001 && second === 0x0db8
  const isTeredo = first === 0x2001 && second === 0
  const isBenchmarking = first === 0x2001 && second === 0x0002
  const isOrchid = first === 0x2001 && (second & 0xfff0) === 0x0010
  const isOrchidV2 = first === 0x2001 && (second & 0xfff0) === 0x0020
  const isSixToFour = first === 0x2002
  const isNat64WellKnown = first === 0x0064 && second === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0
  const isNat64LocalUse = first === 0x0064 && second === 0xff9b && words[2] === 1
  const isDiscardOnly = first === 0x0100 && words.slice(1, 4).every((word) => word === 0)
  return isZero || isLoopback || isMapped || isUla || isLinkLocal || isMulticast || isDocumentation || isTeredo || isBenchmarking || isOrchid || isOrchidV2 || isSixToFour || isNat64WellKnown || isNat64LocalUse || isDiscardOnly
}

function normalizeAllowlist(value: unknown, field: string): { ok: true; values: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWLIST_ENTRIES) return { ok: false, reason: `${field} must contain 1-${MAX_ALLOWLIST_ENTRIES} entries` }
  const values: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length < 1 || item.length > MAX_ALLOWLIST_ITEM_LENGTH || controlPattern.test(item)) return { ok: false, reason: `${field} contains an invalid entry` }
    const normalized = item.normalize('NFKC').trim().toLowerCase()
    if (normalized.length < 1 || normalized.length > MAX_ALLOWLIST_ITEM_LENGTH || controlPattern.test(normalized)) return { ok: false, reason: `${field} contains an invalid normalized entry` }
    if (values.includes(normalized)) return { ok: false, reason: `${field} contains a duplicate entry` }
    values.push(normalized)
  }
  return { ok: true, values }
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
  if (!hostname || hostname === 'localhost' || hostname.includes('%') || blockedDnsSuffixes.some((suffix) => hostname.endsWith(suffix))) return { ok: false, reason: 'targetOrigin hostname is not a public DNS hostname' }
  const ipVersion = detectIpVersion(hostname)
  if (ipVersion === -1) return { ok: false, reason: 'targetOrigin IP literal is malformed' }
  if (ipVersion === 4 && isBlockedIpv4(hostname)) return { ok: false, reason: 'targetOrigin IPv4 is private or reserved' }
  if (ipVersion === 6 && isBlockedIpv6(hostname)) return { ok: false, reason: 'targetOrigin IPv6 is private or reserved' }
  if (ipVersion === 0) {
    if (hostname.length > MAX_HOSTNAME_LENGTH || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..') || !hostname.includes('.')) return { ok: false, reason: 'targetOrigin hostname must be a normal public DNS hostname' }
    const labels = hostname.split('.')
    if (labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return { ok: false, reason: 'targetOrigin hostname label is invalid' }
  }
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
  if (controlPattern.test(decoded) || decoded.includes('\\') || /%(?:2e|2f|5c)/i.test(decoded)) return { ok: false, reason: 'endpointPath contains an encoded control, separator, or backslash' }
  if (decoded.includes('/') && decoded !== value) return { ok: false, reason: 'endpointPath cannot encode a path separator' }
  const rawSegments = value.split('/')
  const decodedSegments = decoded.split('/')
  if ([...rawSegments, ...decodedSegments].some((segment) => segment === '.' || segment === '..')) return { ok: false, reason: 'endpointPath contains dot-segment traversal' }
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

    if (!isOpaqueIdentifier(targetId) || !isOpaqueIdentifier(ownerScopeKey)) return blocked('INVALID_INPUT', 'target identity fields must be opaque identifiers')
    if (!adapter || !adapters.has(adapter as DeliveryAdapter)) return blocked('UNSUPPORTED_ADAPTER', 'adapter is not supported')
    if (!status || !statuses.has(status as DeliveryTargetStatus)) return blocked('INVALID_INPUT', 'target status is invalid')
    if (policyVersion !== DELIVERY_POLICY_VERSION) return blocked('POLICY_VERSION_MISMATCH', 'target policyVersion is not the exact supported policy')
    if (typeof serverCredentialConfigured !== 'boolean') return blocked('INVALID_INPUT', 'serverCredentialConfigured must be boolean')
    const contentTypes = normalizeAllowlist(allowedContentTypes, 'allowedContentTypes')
    if (!contentTypes.ok) return blocked('INVALID_INPUT', contentTypes.reason)
    const languages = normalizeAllowlist(allowedLanguages, 'allowedLanguages')
    if (!languages.ok) return blocked('INVALID_INPUT', languages.reason)
    if (typeof maximumPayloadBytes !== 'number' || !Number.isSafeInteger(maximumPayloadBytes) || maximumPayloadBytes < 1 || maximumPayloadBytes > MAX_PAYLOAD_BYTES) return blocked('INVALID_INPUT', 'maximumPayloadBytes must be a positive safe integer within policy')

    const target: ValidatedDeliveryTarget = {
      targetId,
      ownerScopeKey,
      adapter: adapter as DeliveryAdapter,
      targetOrigin: origin.origin,
      endpointPath: endpoint.path,
      status: status as DeliveryTargetStatus,
      serverCredentialConfigured,
      allowedContentTypes: contentTypes.values,
      allowedLanguages: languages.values,
      maximumPayloadBytes,
      policyVersion: DELIVERY_POLICY_VERSION,
      normalizedOrigin: origin.origin,
      normalizedEndpointPath: endpoint.path,
    }
    return { status: 'valid', target, reasons: [] }
  } catch {
    return blocked('INVALID_INPUT', 'target could not be validated')
  }
}
