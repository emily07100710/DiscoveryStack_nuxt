import { createHash } from 'node:crypto'
import type {
  DateWindow,
  GoogleTrendsObservation,
  GoogleTrendsParseOptions,
  GoogleTrendsSnapshot,
  MarketSignalRequest,
  MetaAdRecord,
  MetaAdSnapshot,
  MetaAdSnapshotInput,
  ParseIssue,
  ParseResult,
  RejectionReason,
} from './types'

export function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
}

export function normalizeKeyword(value: string): string {
  return normalizeText(value)
}

export function normalizePublisherIdentity(value: string): string {
  const withoutPath = normalizeText(value)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[\/#?].*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return withoutPath
    .replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc)\.?$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime())
}

export function normalizeIsoDateTime(value: unknown): string | null {
  if (!isIsoDateTime(value)) return null
  return new Date(value).toISOString()
}

export function normalizeWindow(window: DateWindow): DateWindow {
  return { start: window.start.trim(), end: window.end.trim() }
}

export function isDateWithinWindow(date: string, window: DateWindow): boolean {
  return date >= window.start && date <= window.end
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function fingerprint(value: unknown): string {
  return sha256(stableStringify(value))
}

function issue(code: RejectionReason, message: string, line?: number): ParseIssue {
  return { code, message, ...(line === undefined ? {} : { line }) }
}

function failed<T>(errors: ParseIssue[], warnings: ParseIssue[] = []): ParseResult<T> {
  return { ok: false, errors, warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStrictNumber(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '<1') return 0
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : null
}

function hasValidWindow(value: unknown): value is DateWindow {
  return isRecord(value) && isIsoDate(value.start) && isIsoDate(value.end) && value.start <= value.end
}

export function parseGoogleTrendsCsv(csv: unknown, options: unknown): ParseResult<GoogleTrendsSnapshot> {
  try {
    if (typeof csv !== 'string' || !isRecord(options)) return failed([issue('INVALID_INPUT', 'CSV input and parser options must be valid objects.')])
    const candidate = options as Partial<GoogleTrendsParseOptions>
    const errors: ParseIssue[] = []
    const warnings: ParseIssue[] = []
    if (typeof candidate.snapshotId !== 'string' || !candidate.snapshotId.trim() || typeof candidate.keyword !== 'string' || !candidate.keyword.trim() || typeof candidate.locale !== 'string' || !candidate.locale.trim()) errors.push(issue('MISSING_REQUIRED_FIELD', 'snapshotId, keyword and locale are required.'))
    if (!hasValidWindow(candidate.window)) errors.push(issue('INVALID_DATE', 'The observation window must contain valid ordered ISO dates.'))
    const capturedAt = normalizeIsoDateTime(candidate.capturedAt)
    if (!capturedAt) errors.push(issue('INVALID_DATE', 'capturedAt must be an ISO date-time with an explicit timezone.'))
    if (typeof candidate.sourceHash !== 'string' || !isSha256Hex(candidate.sourceHash)) errors.push(issue(typeof candidate.sourceHash === 'string' && String(candidate.sourceHash).trim() ? 'INVALID_SOURCE_HASH' : 'MISSING_SOURCE_HASH', 'sourceHash must be a SHA-256 hexadecimal string.'))
    if (errors.length > 0) return failed<GoogleTrendsSnapshot>(errors, warnings)
    const window = normalizeWindow(candidate.window!)
    const expectedHash = sha256(csv)
    if (candidate.sourceHash!.trim().toLocaleLowerCase('en-US') !== expectedHash) return failed<GoogleTrendsSnapshot>([issue('INVALID_SOURCE_HASH', 'sourceHash does not match the UTF-8 bytes of the supplied CSV.')], warnings)

    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length < 2) return failed<GoogleTrendsSnapshot>([issue('MISSING_TIME_SERIES_HEADER', 'Google Trends CSV requires a header and at least one observation.')], warnings)
    const header = lines[0]!.split(',').map(normalizeText)
    if (header.length !== 2 || header[0] !== 'date' || header[1] !== 'value') return failed<GoogleTrendsSnapshot>([issue('MISSING_TIME_SERIES_HEADER', 'Google Trends CSV header must be exactly date,value.')], warnings)

    const observations: GoogleTrendsObservation[] = []
    const seenDates = new Set<string>()
    lines.slice(1).forEach((line, index) => {
      const lineNumber = index + 2
      const fields = line.split(',').map((field) => field.trim())
      if (fields.length !== 2 || !fields[0] || !fields[1]) {
        errors.push(issue('MALFORMED_CSV', 'Each observation must have exactly date,value.', lineNumber))
        return
      }
      const [date, rawValue] = fields
      if (!isIsoDate(date)) {
        errors.push(issue('INVALID_DATE', `Invalid observation date: ${date}.`, lineNumber))
        return
      }
      if (seenDates.has(date)) {
        errors.push(issue('DUPLICATE_OBSERVATION', `Duplicate observation date: ${date}.`, lineNumber))
        return
      }
      const value = parseStrictNumber(rawValue)
      if (value === null) {
        errors.push(issue('INVALID_NUMBER', `Invalid Trends value: ${rawValue}.`, lineNumber))
        return
      }
      if (value < 0 || value > 100) {
        errors.push(issue('OUT_OF_RANGE_VALUE', 'Google Trends values must be between 0 and 100.', lineNumber))
        return
      }
      if (!isDateWithinWindow(date, window)) {
        errors.push(issue('SNAPSHOT_OUTSIDE_WINDOW', `Observation ${date} is outside the declared window.`, lineNumber))
        return
      }
      if (rawValue === '<1') warnings.push(issue('SUPPRESSED_VALUE', `Observation ${date} was suppressed below one and normalized to zero.`, lineNumber))
      seenDates.add(date)
      observations.push({ date, value, ...(rawValue === '<1' ? { suppressedBelowOne: true } : {}) })
    })
    if (observations.length === 0 && errors.length === 0) errors.push(issue('INSUFFICIENT_OBSERVATIONS', 'At least one valid observation is required.'))
    if (errors.length > 0) return failed<GoogleTrendsSnapshot>(errors, warnings)
    observations.sort((left, right) => left.date.localeCompare(right.date))
    return {
      ok: true,
      value: {
        provider: 'google_trends',
        snapshotId: candidate.snapshotId!.normalize('NFKC').trim(),
        keyword: normalizeKeyword(candidate.keyword!),
        locale: normalizeText(candidate.locale!),
        window,
        capturedAt: capturedAt!,
        sourceHash: expectedHash,
        observations,
        limitations: [
          'Google Trends is a normalized relative-interest signal, not search volume, causation, or proof of a factual claim.',
          ...(warnings.length > 0 ? ['One or more values were suppressed below one and normalized to zero.'] : []),
        ],
      },
      errors: [],
      warnings,
    }
  } catch {
    return failed<GoogleTrendsSnapshot>([issue('INVALID_INPUT', 'Google Trends input could not be safely validated.')])
  }
}

function normalizedMetaAd(ad: MetaAdRecord): MetaAdRecord {
  return {
    adId: normalizeText(ad.adId),
    startedAt: ad.startedAt,
    lastSeenAt: ad.lastSeenAt,
    status: ad.status,
    creativeHash: ad.creativeHash.trim().toLocaleLowerCase('en-US'),
    ...(ad.landingDomain?.trim() ? { landingDomain: normalizeText(ad.landingDomain) } : {}),
  }
}

export function canonicalMetaAdPayload(input: MetaAdSnapshotInput): Record<string, unknown> {
  const capturedAt = normalizeIsoDateTime(input.capturedAt) ?? input.capturedAt
  const ads = input.ads.map(normalizedMetaAd).sort((left, right) => left.adId.localeCompare(right.adId))
  return {
    provider: input.provider ?? 'meta_ad_library',
    snapshotId: normalizeText(input.snapshotId),
    publisher: normalizeText(input.publisher),
    locale: normalizeText(input.locale),
    window: normalizeWindow(input.window),
    capturedAt,
    ads,
  }
}

export function metaSnapshotSourceHash(input: MetaAdSnapshotInput): string {
  return fingerprint(canonicalMetaAdPayload(input))
}

function validateMetaAd(ad: unknown, index: number, window: DateWindow, seenAdIds: Set<string>): ParseIssue[] {
  const errors: ParseIssue[] = []
  const line = index + 1
  if (!isRecord(ad)) return [issue('INVALID_INPUT', 'Each Meta ad must be an object.', line)]
  const adId = typeof ad.adId === 'string' ? normalizeText(ad.adId) : ''
  const startedAt = typeof ad.startedAt === 'string' ? ad.startedAt : ''
  const lastSeenAt = typeof ad.lastSeenAt === 'string' ? ad.lastSeenAt : ''
  const status = ad.status
  const creativeHash = typeof ad.creativeHash === 'string' ? ad.creativeHash : ''
  if (!adId) errors.push(issue('MISSING_AD_ID', 'Each Meta ad requires an adId.', line))
  if (seenAdIds.has(adId)) errors.push(issue('DUPLICATE_AD_ID', `Duplicate normalized Meta adId: ${adId}.`, line))
  if (!isIsoDate(startedAt) || !isIsoDate(lastSeenAt) || startedAt > lastSeenAt) errors.push(issue('INVALID_DATE', `Invalid Meta ad date range for ${adId}.`, line))
  if (!['active', 'inactive', 'unknown'].includes(status as string)) errors.push(issue('UNKNOWN_STATUS', `Unknown Meta ad status for ${adId}.`, line))
  if (!isSha256Hex(creativeHash)) errors.push(issue(creativeHash ? 'INVALID_SOURCE_HASH' : 'MISSING_REQUIRED_FIELD', `creativeHash must be a SHA-256 hexadecimal string for ${adId}.`, line))
  if (isIsoDate(startedAt) && isIsoDate(lastSeenAt) && (lastSeenAt < window.start || startedAt > window.end)) errors.push(issue('SNAPSHOT_OUTSIDE_WINDOW', `Meta ad ${adId} does not overlap the declared window.`, line))
  return errors
}

export function parseMetaAdSnapshot(input: unknown): ParseResult<MetaAdSnapshot> {
  try {
    if (!isRecord(input)) return failed<MetaAdSnapshot>([issue('INVALID_INPUT', 'Meta snapshot input must be an object.')])
    const candidate = input as Partial<MetaAdSnapshotInput>
    const errors: ParseIssue[] = []
    if (candidate.provider !== undefined && candidate.provider !== 'meta_ad_library') errors.push(issue('UNKNOWN_PROVIDER', 'Meta snapshot provider must be meta_ad_library.'))
    if (typeof candidate.snapshotId !== 'string' || !candidate.snapshotId.trim()) errors.push(issue('MISSING_SNAPSHOT_ID', 'snapshotId is required.'))
    if (typeof candidate.publisher !== 'string' || !candidate.publisher.trim() || !normalizePublisherIdentity(candidate.publisher)) errors.push(issue('MISSING_PUBLISHER', 'publisher is required and must yield a normalized identity.'))
    if (typeof candidate.locale !== 'string' || !candidate.locale.trim()) errors.push(issue('MISSING_REQUIRED_FIELD', 'locale is required.'))
    if (!hasValidWindow(candidate.window)) errors.push(issue('INVALID_DATE', 'The snapshot window must contain valid ordered ISO dates.'))
    const capturedAt = normalizeIsoDateTime(candidate.capturedAt)
    if (!capturedAt) errors.push(issue('INVALID_DATE', 'capturedAt must be an ISO date-time with an explicit timezone.'))
    if (!Array.isArray(candidate.ads)) errors.push(issue('INVALID_INPUT', 'ads must be an array.'))
    if (typeof candidate.sourceHash !== 'string' || !isSha256Hex(candidate.sourceHash)) errors.push(issue(typeof candidate.sourceHash === 'string' && String(candidate.sourceHash).trim() ? 'INVALID_SOURCE_HASH' : 'MISSING_SOURCE_HASH', 'sourceHash must be a SHA-256 hexadecimal string.'))
    if (errors.length > 0) return failed<MetaAdSnapshot>(errors)

    const window = normalizeWindow(candidate.window!)
    const seenAdIds = new Set<string>()
    candidate.ads!.forEach((ad, index) => {
      validateMetaAd(ad, index, window, seenAdIds).forEach((validationIssue) => errors.push(validationIssue))
      if (isRecord(ad) && typeof ad.adId === 'string') seenAdIds.add(normalizeText(ad.adId))
    })
    if (errors.length > 0) return failed<MetaAdSnapshot>(errors)

    const canonicalInput: MetaAdSnapshotInput = {
      provider: 'meta_ad_library',
      snapshotId: candidate.snapshotId!,
      publisher: candidate.publisher!,
      locale: candidate.locale!,
      window,
      capturedAt: capturedAt!,
      sourceHash: candidate.sourceHash!,
      ads: candidate.ads as MetaAdRecord[],
    }
    const expectedHash = metaSnapshotSourceHash(canonicalInput)
    if (candidate.sourceHash!.trim().toLocaleLowerCase('en-US') !== expectedHash) return failed<MetaAdSnapshot>([issue('INVALID_SOURCE_HASH', 'sourceHash does not match the canonical bounded Meta metadata payload.')])
    const ads = canonicalInput.ads.map(normalizedMetaAd).sort((left, right) => left.adId.localeCompare(right.adId))
    return {
      ok: true,
      value: {
        provider: 'meta_ad_library',
        snapshotId: normalizeText(canonicalInput.snapshotId),
        publisher: canonicalInput.publisher.normalize('NFKC').trim(),
        publisherIdentity: normalizePublisherIdentity(canonicalInput.publisher),
        locale: normalizeText(canonicalInput.locale),
        window,
        capturedAt: capturedAt!,
        sourceHash: expectedHash,
        ads,
        limitations: [
          'Meta Ad Library snapshots describe observed advertising activity, not product quality, market share, conversion, or factual support.',
          'A snapshot is a bounded observation and does not establish why an advertiser ran an ad.',
        ],
      },
      errors: [],
      warnings: [],
    }
  } catch {
    return failed<MetaAdSnapshot>([issue('INVALID_INPUT', 'Meta snapshot input could not be safely validated.')])
  }
}

export function normalizeRequest(request: unknown): MarketSignalRequest {
  const candidate = isRecord(request) ? request : {}
  const signalKind = typeof candidate.signalKind === 'string' ? candidate.signalKind : 'demand_interest'
  const claimUse = typeof candidate.claimUse === 'string' ? candidate.claimUse : 'market_hypothesis'
  const locale = typeof candidate.locale === 'string' ? normalizeText(candidate.locale) : ''
  const window = hasValidWindow(candidate.window) ? normalizeWindow(candidate.window) : { start: '', end: '' }
  const googleTrends = Array.isArray(candidate.googleTrends) ? candidate.googleTrends as GoogleTrendsSnapshot[] : undefined
  const metaAdSnapshots = Array.isArray(candidate.metaAdSnapshots) ? candidate.metaAdSnapshots as MetaAdSnapshot[] : undefined
  return {
    requestId: typeof candidate.requestId === 'string' ? candidate.requestId.normalize('NFKC').trim() : '',
    signalKind: signalKind as MarketSignalRequest['signalKind'],
    claimUse: claimUse as MarketSignalRequest['claimUse'],
    locale,
    window,
    googleTrends: googleTrends?.slice().sort((left, right) => String(left?.snapshotId ?? '').localeCompare(String(right?.snapshotId ?? ''))),
    metaAdSnapshots: metaAdSnapshots?.slice().sort((left, right) => String(left?.snapshotId ?? '').localeCompare(String(right?.snapshotId ?? ''))),
  }
}
