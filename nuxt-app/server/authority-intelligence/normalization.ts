import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import {
  authorityPurposes,
  authoritySourceTypes,
  type AuthoritySourceCandidate,
} from './types'

export type AuthoritySourceCandidateWithoutHash = Omit<AuthoritySourceCandidate, 'sourceHash'>

export function normalizeAuthorityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

export function normalizeAuthorityComparison(value: string): string {
  return normalizeAuthorityText(value).toLocaleLowerCase('en-US')
}

export function stableAuthorityStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableAuthorityStringify(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${stableAuthorityStringify(record[key])}`).join(',')}}`
  }
  return 'null'
}

export function sha256Authority(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function isAuthoritySha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value.trim())
}

export function normalizeAuthorityDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeAuthorityText(value)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized)) return null
  const date = new Date(normalized)
  if (!Number.isFinite(date.getTime())) return null
  return date.toISOString()
}

function normalizeNullableDateTime(value: unknown): string | null | undefined {
  if (value === null) return null
  return normalizeAuthorityDateTime(value) ?? undefined
}

export function normalizeAuthorityDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  return normalizeAuthorityComparison(value).replace(/\.$/u, '')
}

function isReservedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [first, second, third, fourth] = parts
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return true
  if (first === 0 || first === 10 || first === 127 || first >= 224) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 192 && second === 0 && third === 0) return true
  if (first === 192 && second === 0 && third === 2) return true
  if (first === 198 && second === 18) return true
  if (first === 198 && second === 19) return true
  if (first === 198 && second === 51 && third === 100) return true
  if (first === 203 && second === 0 && third === 113) return true
  return first === 255 && second === 255 && third === 255 && fourth === 255
}

function parseIpv6Hextets(hostname: string): number[] | null {
  const parts = hostname.split('::')
  if (parts.length > 2) return null
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  if (left.some((part) => !/^[a-f0-9]{1,4}$/u.test(part)) || right.some((part) => !/^[a-f0-9]{1,4}$/u.test(part))) return null
  const missing = 8 - left.length - right.length
  if (parts.length === 1 ? missing !== 0 : missing < 1) return null
  return [...left.map((part) => Number.parseInt(part, 16)), ...Array.from({ length: missing }, () => 0), ...right.map((part) => Number.parseInt(part, 16))]
}

function isReservedIpv6(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase('en-US')
  if (normalized === '::' || normalized === '::1') return true
  if (/^fe[89ab]/u.test(normalized)) return true
  if (/^f[cd]/u.test(normalized)) return true
  if (/^ff/u.test(normalized)) return true
  if (normalized === '2001:db8' || normalized.startsWith('2001:db8:')) return true
  const hextets = parseIpv6Hextets(normalized)
  if (hextets && hextets[0] === 0x0100 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0) return true
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return isReservedIpv4(mapped)
    const mappedHextets = mapped.split(':')
    if (mappedHextets.length === 2 && mappedHextets.every((part) => /^[a-f0-9]{1,4}$/u.test(part))) {
      const high = Number.parseInt(mappedHextets[0]!, 16)
      const low = Number.parseInt(mappedHextets[1]!, 16)
      return isReservedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
  }
  return false
}

function isPublicHostname(hostname: string): boolean {
  const normalized = normalizeAuthorityDomain(hostname).replace(/^\[|\]$/gu, '')
  if (!normalized || /[\s\u0000-\u001f\u007f]/u.test(normalized)) return false
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal') || normalized.endsWith('.test') || normalized.endsWith('.invalid') || normalized.endsWith('.example') || normalized === 'onion' || normalized.endsWith('.onion')) return false
  const addressType = isIP(normalized)
  if (addressType === 4) return !isReservedIpv4(normalized)
  if (addressType === 6) return !isReservedIpv6(normalized)
  if (!normalized.includes('.')) return false
  return true
}

export function normalizeAuthoritySourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = normalizeAuthorityText(value)
  if (!input) return null
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null
    const hostname = normalizeAuthorityDomain(url.hostname)
    if (!isPublicHostname(hostname)) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function normalizeStringField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeAuthorityText(value)
  return normalized || null
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const normalized = value.map((item) => typeof item === 'string' ? normalizeAuthorityComparison(item) : '').filter(Boolean)
  if (normalized.length !== value.length || normalized.length === 0) return null
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right))
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function normalizeCoreCandidate(input: unknown): AuthoritySourceCandidateWithoutHash | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const sourceId = normalizeStringField(record.sourceId)
  const sourceName = normalizeStringField(record.sourceName)
  const sourceUrl = normalizeAuthoritySourceUrl(record.sourceUrl)
  const publisherDomain = normalizeAuthorityDomain(record.publisherDomain)
  const title = normalizeStringField(record.title)
  const sourceType = record.sourceType
  const sectors = normalizeStringArray(record.sectors)
  const topics = normalizeStringArray(record.topics)
  const locale = record.locale
  const jurisdiction = record.jurisdiction === null ? null : normalizeStringField(record.jurisdiction)
  const publisher = normalizeStringField(record.publisher)
  const publishedAt = normalizeNullableDateTime(record.publishedAt)
  const updatedAt = normalizeNullableDateTime(record.updatedAt)
  const capturedAt = normalizeAuthorityDateTime(record.capturedAt)
  const licenceStatus = record.licenceStatus
  const termsStatus = record.termsStatus
  const robotsStatus = record.robotsStatus
  const copyrightRisk = record.copyrightRisk
  const piiStatus = record.piiStatus
  const accessMethod = record.accessMethod
  const evidenceLocator = normalizeStringField(record.evidenceLocator)

  if (!sourceId || !sourceName || !sourceUrl || !publisherDomain || !title || !isOneOf(sourceType, authoritySourceTypes) || !sectors || !topics) return null
  if (locale !== 'en' && locale !== 'zh-hant' && locale !== 'multilingual') return null
  if (record.jurisdiction !== null && !jurisdiction) return null
  if (record.publishedAt !== null && publishedAt === undefined) return null
  if (record.updatedAt !== null && updatedAt === undefined) return null
  if (!capturedAt || !publisher || !evidenceLocator) return null
  if (!isOneOf(licenceStatus, ['verified_permissive', 'verified_restricted', 'unknown', 'not_applicable'] as const)) return null
  if (!isOneOf(termsStatus, ['allows_research', 'allows_citation', 'allows_automation', 'prohibits_automation', 'unknown'] as const)) return null
  if (!isOneOf(robotsStatus, ['reviewed_allow', 'reviewed_restrict', 'unavailable', 'not_applicable', 'unreviewed'] as const)) return null
  if (!isOneOf(copyrightRisk, ['low', 'medium', 'high', 'blocked', 'unreviewed'] as const)) return null
  if (!isOneOf(piiStatus, ['none_detected', 'possible', 'restricted', 'unreviewed'] as const)) return null
  if (!isOneOf(accessMethod, ['manual', 'official_api', 'licensed_feed', 'public_web'] as const)) return null
  if (normalizeAuthorityDomain(new URL(sourceUrl).hostname) !== publisherDomain) return null

  const normalizedPublishedAt = publishedAt === undefined ? null : publishedAt
  const normalizedUpdatedAt = updatedAt === undefined ? null : updatedAt
  if (normalizedPublishedAt && normalizedPublishedAt > capturedAt) return null
  if (normalizedUpdatedAt && normalizedUpdatedAt > capturedAt) return null
  if (normalizedPublishedAt && normalizedUpdatedAt && normalizedPublishedAt > normalizedUpdatedAt) return null

  return {
    sourceId,
    sourceName,
    sourceUrl,
    publisherDomain,
    title,
    sourceType,
    sectors,
    topics,
    locale,
    jurisdiction,
    publisher,
    publishedAt: normalizedPublishedAt,
    updatedAt: normalizedUpdatedAt,
    capturedAt,
    licenceStatus,
    termsStatus,
    robotsStatus,
    copyrightRisk,
    piiStatus,
    accessMethod,
    evidenceLocator,
  }
}

export function canonicalAuthoritySourcePayload(candidateWithoutHash: unknown): Record<string, unknown> | null {
  const candidate = normalizeCoreCandidate(candidateWithoutHash)
  if (!candidate) return null
  return { ...candidate }
}

export function authoritySourceHash(candidateWithoutHash: unknown): string {
  const payload = canonicalAuthoritySourcePayload(candidateWithoutHash)
  return payload ? sha256Authority(stableAuthorityStringify(payload)) : ''
}

export function normalizeAuthoritySourceCandidate(input: unknown): AuthoritySourceCandidate | null {
  const core = normalizeCoreCandidate(input)
  if (!core || !isAuthoritySha256Hex((input as Record<string, unknown> | null)?.sourceHash)) return null
  return { ...core, sourceHash: String((input as Record<string, unknown>).sourceHash).trim().toLocaleLowerCase('en-US') }
}

export interface AuthorityCandidateValidation {
  candidate: AuthoritySourceCandidate | null
  reasonCodes: string[]
  sourceId: string
  sourceHash: string
}

function safeSourceId(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>).sourceId
  return typeof value === 'string' ? normalizeAuthorityText(value).slice(0, 256) : ''
}

function safeSourceHash(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>).sourceHash
  return isAuthoritySha256Hex(value) ? value.trim().toLocaleLowerCase('en-US') : ''
}

export function validateAuthoritySourceCandidate(input: unknown, asOf: unknown): AuthorityCandidateValidation {
  const reasonCodes: string[] = []
  const sourceId = safeSourceId(input)
  const sourceHash = safeSourceHash(input)
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { candidate: null, reasonCodes: ['INVALID_INPUT'], sourceId: '', sourceHash: '' }

  const record = input as Record<string, unknown>
  const sourceUrl = normalizeAuthoritySourceUrl(record.sourceUrl)
  const sourceDomain = normalizeAuthorityDomain(record.publisherDomain)
  const core = normalizeCoreCandidate(input)
  const sourceHashValid = isAuthoritySha256Hex(record.sourceHash)
  if (!sourceHashValid) reasonCodes.push('INVALID_SOURCE_HASH')
  if (!sourceUrl) reasonCodes.push('INVALID_SOURCE_URL')
  if (sourceUrl && sourceDomain && normalizeAuthorityDomain(new URL(sourceUrl).hostname) !== sourceDomain) reasonCodes.push('SOURCE_DOMAIN_MISMATCH')
  if (!core) reasonCodes.push('INVALID_INPUT')

  const asOfUtc = normalizeAuthorityDateTime(asOf)
  const capturedAt = normalizeAuthorityDateTime(record.capturedAt)
  const publishedAt = record.publishedAt === null ? null : normalizeAuthorityDateTime(record.publishedAt)
  const updatedAt = record.updatedAt === null ? null : normalizeAuthorityDateTime(record.updatedAt)
  if (!asOfUtc || !capturedAt || (record.publishedAt !== null && !publishedAt) || (record.updatedAt !== null && !updatedAt)) reasonCodes.push('INVALID_INPUT')
  if (capturedAt && asOfUtc && capturedAt > asOfUtc) reasonCodes.push('INVALID_INPUT')
  if (publishedAt && capturedAt && publishedAt > capturedAt) reasonCodes.push('INVALID_INPUT')
  if (updatedAt && capturedAt && updatedAt > capturedAt) reasonCodes.push('INVALID_INPUT')
  if (publishedAt && updatedAt && publishedAt > updatedAt) reasonCodes.push('INVALID_INPUT')

  const candidate = core && reasonCodes.filter((code) => code !== 'INVALID_SOURCE_HASH').length === 0
    ? { ...core, sourceHash }
    : null
  if (candidate && sourceHashValid && authoritySourceHash(candidate) !== sourceHash) reasonCodes.push('SOURCE_HASH_MISMATCH')
  return { candidate, reasonCodes: [...new Set(reasonCodes)], sourceId, sourceHash }
}

export function normalizeAuthorityRequestText(value: unknown): string {
  return typeof value === 'string' ? normalizeAuthorityText(value) : ''
}

export function normalizeAuthorityTopicList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map(normalizeAuthorityComparison).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

export function isAuthorityPurpose(value: unknown): value is (typeof authorityPurposes)[number] {
  return isOneOf(value, authorityPurposes)
}
