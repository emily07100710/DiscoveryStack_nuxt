import { isIP } from 'node:net'
import { IANA_SPECIAL_USE_LABELS, SENSITIVE_QUERY_TERMS, MAX_URL_LENGTH } from './constants'
import { normalizeOpaqueReference } from './normalization'
import type { GuardResult } from './types'
import type { NormalizedTarget } from './normalization'

function invalid(...reasonCodes: string[]): GuardResult {
  return { valid: false, reasonCodes, reasons: reasonCodes, normalizedUrl: null, normalizedServiceReference: null }
}

function valid(normalizedUrl: string | null, normalizedServiceReference: string | null): GuardResult {
  return { valid: true, reasonCodes: [], reasons: [], normalizedUrl, normalizedServiceReference }
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return null
  return parts.reduce((total, part) => total * 256 + Number(part ?? ''), 0)
}

function inIpv4Range(value: number, start: string, end: string): boolean {
  const lower = ipv4ToNumber(start)
  const upper = ipv4ToNumber(end)
  return lower !== null && upper !== null && value >= lower && value <= upper
}

function ipv4IsReserved(value: string): boolean {
  const number = ipv4ToNumber(value)
  if (number === null) return true
  return [
    ['0.0.0.0', '0.255.255.255'],
    ['10.0.0.0', '10.255.255.255'],
    ['100.64.0.0', '100.127.255.255'],
    ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'],
    ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'],
    ['192.0.2.0', '192.0.2.255'],
    ['192.31.196.0', '192.31.196.255'],
    ['192.52.193.0', '192.52.193.255'],
    ['192.88.99.0', '192.88.99.255'],
    ['192.168.0.0', '192.168.255.255'],
    ['192.175.48.0', '192.175.48.255'],
    ['198.18.0.0', '198.19.255.255'],
    ['198.51.100.0', '198.51.100.255'],
    ['203.0.113.0', '203.0.113.255'],
    ['224.0.0.0', '255.255.255.255'],
  ].some(([start, end]) => inIpv4Range(number, start ?? '', end ?? ''))
}

function expandIpv6(value: string): string[] | null {
  const normalized = value.toLowerCase()
  if (normalized.includes('.')) return null
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  return [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => part.padStart(4, '0'))
}

function ipv6ToBigInt(value: string): bigint | null {
  const groups = expandIpv6(value)
  if (!groups) return null
  return groups.reduce((total, group) => (total << BigInt(16)) + BigInt(`0x${group}`), BigInt(0))
}

function ipv6InRange(value: bigint, prefix: bigint, bits: number): boolean {
  const mask = ((BigInt(1) << BigInt(bits)) - BigInt(1)) << BigInt(128 - bits)
  return (value & mask) === prefix
}

function ipv6IsReserved(value: string): boolean {
  const number = ipv6ToBigInt(value)
  if (number === null) return true
  const globalUnicast = ipv6ToBigInt('2000::')
  if (globalUnicast === null || !ipv6InRange(number, globalUnicast, 3)) return true
  const ranges: Array<[string, number]> = [
    ['::', 128],
    ['::1', 128],
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['100:0:0:1::', 64],
    ['2001::', 23],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:30::', 28],
    ['2002::', 16],
    ['2620:4f:8000::', 48],
    ['3fff::', 20],
    ['5f00::', 16],
  ]
  return ranges.some(([prefix, bits]) => {
    const prefixNumber = ipv6ToBigInt(prefix)
    return prefixNumber !== null && ipv6InRange(number, prefixNumber, bits)
  })
}

function hostIsSpecialUse(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  return [...IANA_SPECIAL_USE_LABELS].some((label) => host === label || host.endsWith(`.${label}`))
}

function queryTermIsSensitive(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  return [...SENSITIVE_QUERY_TERMS].some((term) => normalized === term || normalized.includes(term))
    || normalized.startsWith('bearer ')
    || normalized.startsWith('basic ')
    || normalized.startsWith('ghp_')
    || normalized.startsWith('sk-')
    || (normalized.split('.').length === 3 && normalized.split('.').every((part) => part.length > 0))
}

export function guardExternalTargetUrl(value: unknown): GuardResult {
  if (typeof value !== 'string' || value.length === 0) return invalid('TARGET_URL_REQUIRED')
  if (value.length > MAX_URL_LENGTH) return invalid('TARGET_URL_TOO_LONG')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid('TARGET_URL_MALFORMED')
  }
  if (parsed.protocol !== 'https:') return invalid('TARGET_URL_MUST_USE_HTTPS')
  if (parsed.username || parsed.password) return invalid('TARGET_URL_CREDENTIALS_FORBIDDEN')
  if (parsed.port !== '' && parsed.port !== '443') return invalid('TARGET_URL_PORT_FORBIDDEN')
  if (parsed.hash) return invalid('TARGET_URL_FRAGMENT_FORBIDDEN')
  const rawHostname = parsed.hostname
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (!hostname) return invalid('TARGET_URL_HOST_REQUIRED')
  if (rawHostname.endsWith('.')) return invalid('TARGET_URL_TRAILING_DOT_FORBIDDEN')
  if (/[^\x00-\x7f]/u.test(rawHostname) || hostname.split('.').some((label) => label.startsWith('xn--'))) return invalid('TARGET_URL_UNICODE_HOST_FORBIDDEN')
  if (hostname.includes('%')) return invalid('TARGET_URL_ZONE_ID_FORBIDDEN')
  if (hostIsSpecialUse(hostname)) return invalid('TARGET_URL_SPECIAL_USE_HOST_FORBIDDEN')
  const ipVersion = isIP(hostname)
  if (ipVersion === 4 && ipv4IsReserved(hostname)) return invalid('TARGET_URL_RESERVED_IPV4_FORBIDDEN')
  if (ipVersion === 6 && ipv6IsReserved(hostname)) return invalid('TARGET_URL_RESERVED_IPV6_FORBIDDEN')
  if (ipVersion === 0 && (hostname.includes(':') || hostname.includes('%'))) return invalid('TARGET_URL_INVALID_IP_LITERAL')
  if (ipVersion === 0 && !hostname.includes('.')) return invalid('TARGET_URL_SINGLE_LABEL_FORBIDDEN')
  for (const [key, valueEntry] of parsed.searchParams.entries()) {
    if (queryTermIsSensitive(key) || queryTermIsSensitive(valueEntry)) return invalid('TARGET_URL_SENSITIVE_QUERY_FORBIDDEN')
  }
  return valid(parsed.toString(), null)
}

export function guardServiceReference(value: unknown): GuardResult {
  try {
    const normalized = normalizeOpaqueReference(value, 'serviceReference')
    return valid(null, normalized)
  } catch {
    return invalid('SERVICE_REFERENCE_INVALID')
  }
}

export function guardTarget(target: NormalizedTarget): GuardResult {
  if (target.framework === 'geoflow_local' || target.transport === 'geoflow_local') {
    if (target.targetUrl !== null) return invalid('GEOFLOW_LOCAL_CALLER_URL_FORBIDDEN')
    if (target.serviceReference === null) return invalid('GEOFLOW_LOCAL_SERVICE_REFERENCE_REQUIRED')
    return guardServiceReference(target.serviceReference)
  }
  if (target.serviceReference !== null) return invalid('EXTERNAL_SERVICE_REFERENCE_FORBIDDEN')
  if (target.targetUrl === null) return invalid('EXTERNAL_TARGET_URL_REQUIRED')
  return guardExternalTargetUrl(target.targetUrl)
}
