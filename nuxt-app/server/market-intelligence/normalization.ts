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

export function normalizePublisherIdentity(value: string): string {
  return normalizeText(value)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[\/#?].*$/, '')
    .replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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
  if (typeof value !== 'string' || !value.includes('T')) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime())
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

function emptyResult<T>(errors: ParseIssue[], warnings: ParseIssue[] = []): ParseResult<T> {
  return { ok: errors.length === 0, ...(errors.length === 0 ? {} : {}), errors, warnings }
}

function parseStrictNumber(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '<1') return 0
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : null
}

export function parseGoogleTrendsCsv(csv: string, options: GoogleTrendsParseOptions): ParseResult<GoogleTrendsSnapshot> {
  const errors: ParseIssue[] = []
  const warnings: ParseIssue[] = []
  if (!options.snapshotId.trim() || !options.keyword.trim() || !options.locale.trim()) errors.push(issue('MISSING_REQUIRED_FIELD', 'snapshotId, keyword and locale are required.'))
  if (!isIsoDate(options.window.start) || !isIsoDate(options.window.end) || options.window.start > options.window.end) errors.push(issue('INVALID_DATE', 'The observation window must contain valid ordered ISO dates.'))
  if (!isIsoDateTime(options.capturedAt)) errors.push(issue('INVALID_DATE', 'capturedAt must be an ISO date-time.'))
  if (!options.sourceHash || !isSha256Hex(options.sourceHash)) errors.push(issue(options.sourceHash ? 'INVALID_SOURCE_HASH' : 'MISSING_SOURCE_HASH', 'sourceHash must be a SHA-256 hexadecimal string.'))
  if (errors.length > 0) return emptyResult<GoogleTrendsSnapshot>(errors, warnings)

  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return emptyResult<GoogleTrendsSnapshot>([issue('MISSING_TIME_SERIES_HEADER', 'Google Trends CSV requires a header and at least one observation.')], warnings)
  const header = lines[0]!.split(',').map(normalizeText)
  if (header.length !== 2 || header[0] !== 'date' || header[1] !== 'value') return emptyResult<GoogleTrendsSnapshot>([issue('MISSING_TIME_SERIES_HEADER', 'Google Trends CSV header must be exactly date,value.')], warnings)

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
    if (!isDateWithinWindow(date, options.window)) {
      errors.push(issue('SNAPSHOT_OUTSIDE_WINDOW', `Observation ${date} is outside the declared window.`, lineNumber))
      return
    }
    if (rawValue === '<1') warnings.push(issue('SUPPRESSED_VALUE', `Observation ${date} was suppressed below one and normalized to zero.`, lineNumber))
    seenDates.add(date)
    observations.push({ date, value, ...(rawValue === '<1' ? { suppressedBelowOne: true } : {}) })
  })
  if (observations.length === 0 && errors.length === 0) errors.push(issue('INSUFFICIENT_OBSERVATIONS', 'At least one valid observation is required.'))
  if (errors.length > 0) return emptyResult<GoogleTrendsSnapshot>(errors, warnings)
  observations.sort((left, right) => left.date.localeCompare(right.date))
  return {
    ok: true,
    value: {
      provider: 'google_trends',
      snapshotId: options.snapshotId.trim(),
      keyword: options.keyword.normalize('NFKC').trim(),
      locale: normalizeText(options.locale),
      window: normalizeWindow(options.window),
      capturedAt: options.capturedAt,
      sourceHash: options.sourceHash!.trim().toLocaleLowerCase('en-US'),
      observations,
      limitations: [
        'Google Trends is a normalized relative-interest signal, not search volume, causation, or proof of a factual claim.',
        ...(warnings.length > 0 ? ['One or more values were suppressed below one and normalized to zero.'] : []),
      ],
    },
    errors: [],
    warnings,
  }
}

function validateMetaAd(ad: MetaAdRecord, index: number, window: DateWindow, seenAdIds: Set<string>): ParseIssue[] {
  const errors: ParseIssue[] = []
  const line = index + 1
  if (!ad.adId.trim()) errors.push(issue('MISSING_AD_ID', 'Each Meta ad requires an adId.', line))
  if (seenAdIds.has(ad.adId.trim())) errors.push(issue('DUPLICATE_AD_ID', `Duplicate Meta adId: ${ad.adId}.`, line))
  if (!isIsoDate(ad.startedAt) || !isIsoDate(ad.lastSeenAt) || ad.startedAt > ad.lastSeenAt) errors.push(issue('INVALID_DATE', `Invalid Meta ad date range for ${ad.adId}.`, line))
  if (!['active', 'inactive', 'unknown'].includes(ad.status)) errors.push(issue('UNKNOWN_STATUS', `Unknown Meta ad status for ${ad.adId}.`, line))
  if (!ad.creativeHash.trim()) errors.push(issue('MISSING_REQUIRED_FIELD', `creativeHash is required for ${ad.adId}.`, line))
  if (ad.lastSeenAt < window.start || ad.startedAt > window.end) errors.push(issue('SNAPSHOT_OUTSIDE_WINDOW', `Meta ad ${ad.adId} does not overlap the declared window.`, line))
  return errors
}

export function parseMetaAdSnapshot(input: MetaAdSnapshotInput): ParseResult<MetaAdSnapshot> {
  const errors: ParseIssue[] = []
  if (!input.snapshotId.trim()) errors.push(issue('MISSING_SNAPSHOT_ID', 'snapshotId is required.'))
  if (!input.publisher.trim()) errors.push(issue('MISSING_PUBLISHER', 'publisher is required.'))
  if (!normalizePublisherIdentity(input.publisher)) errors.push(issue('MISSING_PUBLISHER', 'publisher identity cannot be normalized.'))
  if (!isIsoDate(input.window.start) || !isIsoDate(input.window.end) || input.window.start > input.window.end) errors.push(issue('INVALID_DATE', 'The snapshot window must contain valid ordered ISO dates.'))
  if (!isIsoDateTime(input.capturedAt)) errors.push(issue('INVALID_DATE', 'capturedAt must be an ISO date-time.'))
  if (!input.sourceHash || !isSha256Hex(input.sourceHash)) errors.push(issue(input.sourceHash ? 'INVALID_SOURCE_HASH' : 'MISSING_SOURCE_HASH', 'sourceHash must be a SHA-256 hexadecimal string.'))
  if (!Array.isArray(input.ads)) errors.push(issue('INVALID_INPUT', 'ads must be an array.'))
  if (errors.length > 0) return emptyResult<MetaAdSnapshot>(errors)

  const seenAdIds = new Set<string>()
  input.ads.forEach((ad, index) => {
    validateMetaAd(ad, index, input.window, seenAdIds).forEach((validationIssue) => errors.push(validationIssue))
    seenAdIds.add(ad.adId.trim())
  })
  if (errors.length > 0) return emptyResult<MetaAdSnapshot>(errors)
  const ads = input.ads.map((ad) => ({
    adId: ad.adId.normalize('NFKC').trim(),
    startedAt: ad.startedAt,
    lastSeenAt: ad.lastSeenAt,
    status: ad.status,
    creativeHash: ad.creativeHash.normalize('NFKC').trim().toLocaleLowerCase('en-US'),
    ...(ad.landingDomain?.trim() ? { landingDomain: normalizeText(ad.landingDomain) } : {}),
  }))
  ads.sort((left, right) => left.adId.localeCompare(right.adId))
  return {
    ok: true,
    value: {
      provider: 'meta_ad_library',
      snapshotId: input.snapshotId.normalize('NFKC').trim(),
      publisher: input.publisher.normalize('NFKC').trim(),
      publisherIdentity: normalizePublisherIdentity(input.publisher),
      locale: normalizeText(input.locale),
      window: normalizeWindow(input.window),
      capturedAt: input.capturedAt,
      sourceHash: input.sourceHash!.trim().toLocaleLowerCase('en-US'),
      ads,
      limitations: [
        'Meta Ad Library snapshots describe observed advertising activity, not product quality, market share, conversion, or factual support.',
        'A snapshot is a bounded observation and does not establish why an advertiser ran an ad.',
      ],
    },
    errors: [],
    warnings: [],
  }
}

export function normalizeRequest(request: MarketSignalRequest): MarketSignalRequest {
  return {
    ...request,
    requestId: request.requestId.normalize('NFKC').trim(),
    locale: normalizeText(request.locale),
    window: normalizeWindow(request.window),
    googleTrends: request.googleTrends?.slice().sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
    metaAdSnapshots: request.metaAdSnapshots?.slice().sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)),
  }
}
