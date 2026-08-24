import { GITHUB_CONTENTS_ORIGIN, type FirstPartyDecisionCode, type FirstPartyPublishTarget, type FirstPartyTargetValidationResult, type FirstPartyTransport, type ValidatedFirstPartyTarget } from './types'
import { isOpaqueReference, isValidBranch, isValidContentRoot, isValidRepositoryPart, normalizeAllowlist, readValue } from './normalization'

export const SIGNED_API_ENDPOINT_PATH = '/api/first-party/content-ingest' as const
const MAX_HOSTNAME_LENGTH = 253
const MAX_PAYLOAD_BYTES = 10_000_000
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.onion'] as const
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const FRAMEWORKS = new Set(['astro', 'nuxt'])
const TRANSPORTS = new Set<FirstPartyTransport>(['first_party_git', 'first_party_signed_api'])
const STATUSES = new Set(['active', 'paused', 'revoked'])
const TARGET_KEYS = new Set(['targetId', 'ownerScopeKey', 'framework', 'transport', 'targetOrigin', 'contentRoot', 'defaultBranch', 'repositoryOwner', 'repositoryName', 'endpointPath', 'credentialReference', 'status', 'allowedContentTypes', 'allowedLanguages', 'maximumPayloadBytes', 'executionEnabled'])

function blocked(code: FirstPartyDecisionCode, ...reasons: string[]): FirstPartyTargetValidationResult {
  return { status: 'blocked', code, reasons }
}

function ipv4ToNumber(value: string): number | undefined {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return undefined
  const octets = parts.map(Number)
  if (octets.some(octet => octet > 255)) return undefined
  const [first, second, third, fourth] = octets
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined
  return ((((first * 256) + second) * 256 + third) * 256 + fourth) >>> 0
}

function inIpv4Range(value: number, start: string, end: string): boolean {
  const lower = ipv4ToNumber(start)
  const upper = ipv4ToNumber(end)
  return lower !== undefined && upper !== undefined && value >= lower && value <= upper
}

function blockedIpv4(hostname: string): boolean {
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
  return /^[0-9a-f]{1,4}$/i.test(value) ? Number.parseInt(value, 16) : undefined
}

function expandIpv6(hostname: string): number[] | undefined {
  if (hostname.includes('%')) return undefined
  let address = hostname
  let ipv4Words: number[] = []
  if (hostname.includes('.')) {
    const lastColon = hostname.lastIndexOf(':')
    if (lastColon < 1) return undefined
    const ipv4 = ipv4ToNumber(hostname.slice(lastColon + 1))
    if (ipv4 === undefined) return undefined
    ipv4Words = [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff]
    address = hostname.slice(0, lastColon)
  }
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0]?.split(':').map(parseIpv6Word)
  const right = halves.length === 2 && halves[1] !== '' ? halves[1]?.split(':').map(parseIpv6Word) : []
  if (!left || !right || left.some(word => word === undefined) || right.some(word => word === undefined)) return undefined
  const explicit = left.length + right.length + ipv4Words.length
  if (halves.length === 1) return explicit === 8 ? [...left, ...right, ...ipv4Words] as number[] : undefined
  const missing = 8 - explicit
  if (missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right, ...ipv4Words] as number[]
}

function ipVersion(hostname: string): 0 | 4 | 6 | -1 {
  if (ipv4ToNumber(hostname) !== undefined) return 4
  if (hostname.includes(':')) return expandIpv6(hostname) === undefined ? -1 : 6
  if (hostname.split('.').every(label => /^\d+$/.test(label))) return -1
  return 0
}

function blockedIpv6(hostname: string): boolean {
  const words = expandIpv6(hostname)
  if (!words || words.length !== 8) return true
  const first = words[0] ?? 0
  const second = words[1] ?? 0
  const isZero = words.every(word => word === 0)
  const isLoopback = words.slice(0, 7).every(word => word === 0) && words[7] === 1
  const isMapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
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
  const isDiscardOnly = first === 0x0100 && words.slice(1, 4).every(word => word === 0)
  const isDocumentationBenchmark = first === 0x2001 && second === 0x0002
  return isZero || isLoopback || isMapped || isUla || isLinkLocal || isMulticast || isDocumentation || isTeredo || isBenchmarking || isOrchid || isOrchidV2 || isSixToFour || isNat64WellKnown || isNat64LocalUse || isDiscardOnly || isDocumentationBenchmark
}

function validatePublicOrigin(value: unknown, transport: FirstPartyTransport): { ok: true; origin: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || CONTROL.test(value)) return { ok: false, reason: 'targetOrigin must be a bounded string' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'targetOrigin must be an absolute URL' }
  }
  if (transport === 'first_party_git' && value !== GITHUB_CONTENTS_ORIGIN) return { ok: false, reason: 'first_party_git targetOrigin must be the exact GitHub Contents origin' }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'targetOrigin must use HTTPS' }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || (parsed.port && parsed.port !== '443')) return { ok: false, reason: 'targetOrigin must be a credential-free origin without path, query, fragment, or non-443 port' }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.') || hostname.includes('%') || BLOCKED_SUFFIXES.some(suffix => hostname.endsWith(suffix))) return { ok: false, reason: 'targetOrigin hostname is local or special-use' }
  const version = ipVersion(hostname)
  if (version === -1) return { ok: false, reason: 'targetOrigin IP literal is malformed' }
  if (version === 4 && blockedIpv4(hostname)) return { ok: false, reason: 'targetOrigin IPv4 is private or reserved' }
  if (version === 6 && blockedIpv6(hostname)) return { ok: false, reason: 'targetOrigin IPv6 is private or reserved' }
  if (version === 0) {
    if (hostname.length > MAX_HOSTNAME_LENGTH || hostname.startsWith('.') || hostname.includes('..') || !hostname.includes('.')) return { ok: false, reason: 'targetOrigin hostname is not a public DNS name' }
    const labels = hostname.split('.')
    if (labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return { ok: false, reason: 'targetOrigin hostname label is invalid' }
  }
  return { ok: true, origin: parsed.origin }
}

function validateEndpointPath(value: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value !== SIGNED_API_ENDPOINT_PATH || value.length > 256) return { ok: false, reason: 'signed API endpointPath must equal the fixed absolute path' }
  return { ok: true, path: value }
}

function invalidTransportFields(target: Record<string, unknown>, transport: FirstPartyTransport): string | undefined {
  const owner = readValue(target, 'repositoryOwner')
  const name = readValue(target, 'repositoryName')
  const endpoint = readValue(target, 'endpointPath')
  if (transport === 'first_party_git') {
    if (!isValidRepositoryPart(owner) || !isValidRepositoryPart(name)) return 'Git target requires valid repositoryOwner and repositoryName'
    if (endpoint !== null) return 'Git target endpointPath must be null'
  } else {
    if (owner !== null || name !== null) return 'signed API target repository fields must be null'
    if (!validateEndpointPath(endpoint).ok) return 'signed API target endpointPath is invalid'
  }
  return undefined
}

export function validateFirstPartyPublishTarget(input: unknown): FirstPartyTargetValidationResult {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return blocked('INVALID_INPUT', 'target must be a plain object')
    const target = input as Record<string, unknown>
    if (Object.keys(target).some(key => !TARGET_KEYS.has(key))) return blocked('INVALID_INPUT', 'target contains an unknown key')
    const targetId = readValue(target, 'targetId')
    const ownerScopeKey = readValue(target, 'ownerScopeKey')
    const framework = readValue(target, 'framework')
    const transport = readValue(target, 'transport')
    const status = readValue(target, 'status')
    const credentialReference = readValue(target, 'credentialReference')
    const executionEnabled = readValue(target, 'executionEnabled')
    const maximumPayloadBytes = readValue(target, 'maximumPayloadBytes')
    if (!isOpaqueReference(targetId) || !isOpaqueReference(ownerScopeKey)) return blocked('INVALID_INPUT', 'target identity must be opaque')
    if (typeof framework !== 'string' || !FRAMEWORKS.has(framework)) return blocked('UNSUPPORTED_FRAMEWORK', 'framework must be astro or nuxt')
    if (typeof transport !== 'string' || !TRANSPORTS.has(transport as FirstPartyTransport)) return blocked('UNSUPPORTED_TRANSPORT', 'transport is not supported')
    const typedTransport = transport as FirstPartyTransport
    if (typeof status !== 'string' || !STATUSES.has(status)) return blocked('INVALID_INPUT', 'target status is invalid')
    if (status !== 'active') return blocked('TARGET_NOT_ACTIVE', 'target status must be active')
    if (!isOpaqueReference(credentialReference)) return blocked('INVALID_CREDENTIAL_REFERENCE', 'credentialReference must be an opaque server-side reference')
    if (typeof executionEnabled !== 'boolean') return blocked('INVALID_INPUT', 'executionEnabled must be boolean')
    if (typeof maximumPayloadBytes !== 'number' || !Number.isSafeInteger(maximumPayloadBytes) || maximumPayloadBytes < 1 || maximumPayloadBytes > MAX_PAYLOAD_BYTES) return blocked('INVALID_INPUT', 'maximumPayloadBytes exceeds bounded policy')
    const origin = validatePublicOrigin(readValue(target, 'targetOrigin'), typedTransport)
    if (!origin.ok) return blocked('INVALID_TARGET_ORIGIN', origin.reason)
    const root = readValue(target, 'contentRoot')
    if (!isValidContentRoot(root)) return blocked('INVALID_CONTENT_ROOT', 'contentRoot must be a safe relative path')
    const branch = readValue(target, 'defaultBranch')
    if (!isValidBranch(branch)) return blocked('INVALID_BRANCH', 'defaultBranch is invalid')
    const contentTypes = normalizeAllowlist(readValue(target, 'allowedContentTypes'), 'allowedContentTypes')
    if (!contentTypes.ok) return blocked('INVALID_INPUT', contentTypes.reason)
    const languages = normalizeAllowlist(readValue(target, 'allowedLanguages'), 'allowedLanguages')
    if (!languages.ok) return blocked('INVALID_INPUT', languages.reason)
    const transportFields = invalidTransportFields(target, typedTransport)
    if (transportFields) return blocked(typedTransport === 'first_party_git' ? 'INVALID_REPOSITORY' : 'INVALID_ENDPOINT_PATH', transportFields)
    const targetValue: ValidatedFirstPartyTarget = {
      targetId,
      ownerScopeKey,
      framework: framework as 'astro' | 'nuxt',
      transport: typedTransport,
      targetOrigin: origin.origin,
      contentRoot: root,
      defaultBranch: branch,
      repositoryOwner: typedTransport === 'first_party_git' ? readValue(target, 'repositoryOwner') as string : null,
      repositoryName: typedTransport === 'first_party_git' ? readValue(target, 'repositoryName') as string : null,
      endpointPath: typedTransport === 'first_party_signed_api' ? SIGNED_API_ENDPOINT_PATH : null,
      credentialReference,
      status: 'active',
      allowedContentTypes: contentTypes.values,
      allowedLanguages: languages.values,
      maximumPayloadBytes,
      executionEnabled,
    }
    return { status: 'valid', target: targetValue }
  } catch {
    return blocked('INVALID_INPUT', 'target could not be safely validated')
  }
}

export function isPublicHttpsOrigin(value: string): boolean {
  const result = validatePublicOrigin(value, 'first_party_signed_api')
  return result.ok
}

export function isFirstPartyTransport(value: unknown): value is FirstPartyTransport {
  return typeof value === 'string' && TRANSPORTS.has(value as FirstPartyTransport)
}

export type { FirstPartyPublishTarget }
