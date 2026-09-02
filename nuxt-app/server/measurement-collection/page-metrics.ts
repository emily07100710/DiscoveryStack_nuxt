import { createError } from 'h3'
import { inspectUrlWithSearchConsole } from './adapters/google-url-inspection'
import { GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, postFixedJson, resolveGoogleCredential, type GoogleRequestContext } from './adapters/google-shared'
import { normalizeCanonicalPage, normalizeSearchConsoleProperty } from './normalization'
import type { FetchLike, GoogleReadOnlyCredentialResolver, MeasurementConnectionRow, MeasurementRepository } from './types'

const SEARCH_ANALYTICS_ORIGIN = 'https://www.googleapis.com'
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u
const DAY_MS = 86_400_000
const BASE_LIMITATIONS = ['search_console_may_not_return_all_rows', 'search_console_data_lag_up_to_3_days']

export type SearchConsolePropertyMatch = {
  connection: MeasurementConnectionRow
  property: string
  canonicalPage: string
  matchKind: 'url_prefix' | 'domain'
}

export type PageMetricsRow = { date: string, clicks: number, impressions: number, ctr: number, position: number }

export type PageMetricsByUrlResult =
  | { status: 'succeeded', property: string, canonicalPage: string, rows: PageMetricsRow[], request: { startDate: string, endDate: string }, limitations: string[] }
  | { status: 'unknown', reasonCode: 'not_configured' | 'no_matching_property' | 'unsupported_page_url' | 'provider_failure' | 'rate_limited', detail?: string, limitations: string[] }

export type PageInspectionByUrlResult =
  | { status: 'crawled', lastCrawlTime: Date, property: string, canonicalPage: string, verdict: string | null, coverageState: string | null, inspectedAt: Date, limitations: string[] }
  | { status: 'unknown', reasonCode: 'not_configured' | 'no_matching_property' | 'unsupported_page_url' | 'provider_failure' | 'rate_limited' | 'never_crawled', detail?: string, limitations: string[] }

type UnknownReason = Extract<PageMetricsByUrlResult, { status: 'unknown' }>

function pageUrl(value: string): URL | null {
  if (typeof value !== 'string' || value.length > 2_048) return null
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    parsed.hostname = parsed.hostname.toLocaleLowerCase('en-US')
    parsed.hash = ''
    return parsed
  } catch {
    return null
  }
}

export function findSearchConsolePropertyForUrl(connections: MeasurementConnectionRow[], value: string): SearchConsolePropertyMatch | { match: null, reasonCode: 'no_matching_property' | 'unsupported_page_url' } {
  const parsed = pageUrl(value)
  if (!parsed) return { match: null, reasonCode: 'unsupported_page_url' }

  const matches: SearchConsolePropertyMatch[] = []
  for (const connection of connections) {
    if (connection.source !== 'google_search_console' || connection.status !== 'configured') continue
    const property = normalizeSearchConsoleProperty(connection.googleSearchConsoleProperty, connection.canonicalOrigin)
    if (!property) continue
    if (property === connection.canonicalOrigin && parsed.origin === property) {
      const canonicalPage = normalizeCanonicalPage(parsed.toString(), connection.canonicalOrigin)
      if (!canonicalPage) return { match: null, reasonCode: 'unsupported_page_url' }
      matches.push({ connection, property, canonicalPage, matchKind: 'url_prefix' })
      continue
    }
    if (property.startsWith('sc-domain:')) {
      const domain = property.slice('sc-domain:'.length)
      if (parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)) {
        matches.push({ connection, property, canonicalPage: parsed.toString(), matchKind: 'domain' })
      }
    }
  }

  matches.sort((left, right) => {
    if (left.matchKind !== right.matchKind) return left.matchKind === 'url_prefix' ? -1 : 1
    return left.connection.id - right.connection.id
  })
  return matches[0] || { match: null, reasonCode: 'no_matching_property' }
}

function parseDate(value: string): number | null {
  if (!DATE_ONLY.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const timestamp = Date.UTC(year!, month! - 1, day!)
  const date = new Date(timestamp)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null
  return timestamp
}

function validateRange(startDate: string, endDate: string): { start: number, end: number } {
  const start = parseDate(startDate)
  const end = parseDate(endDate)
  if (start === null || end === null || start > end || end - start > 119 * DAY_MS) {
    throw createError({ statusCode: 422, statusMessage: 'Search Console date range must contain at most 120 valid calendar dates.' })
  }
  return { start, end }
}

function boundedMetric(value: unknown, integer: boolean): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null
  if (integer && !Number.isSafeInteger(value)) return null
  return value
}

function parseRows(body: unknown, start: number, end: number): PageMetricsRow[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const rawRows = (body as { rows?: unknown }).rows
  if (rawRows === undefined) return []
  if (!Array.isArray(rawRows) || rawRows.length > 1_000) return null
  const rows = new Map<string, PageMetricsRow>()
  for (const rawRow of rawRows) {
    if (typeof rawRow !== 'object' || rawRow === null || Array.isArray(rawRow)) return null
    const row = rawRow as { keys?: unknown, clicks?: unknown, impressions?: unknown, ctr?: unknown, position?: unknown }
    if (!Array.isArray(row.keys) || row.keys.length !== 1 || typeof row.keys[0] !== 'string') return null
    const date = parseDate(row.keys[0])
    const clicks = boundedMetric(row.clicks, true)
    const impressions = boundedMetric(row.impressions, true)
    const position = boundedMetric(row.position, false)
    if (date === null || date < start || date > end || clicks === null || impressions === null || position === null || clicks > impressions) return null
    let ctr: number
    if (row.ctr === undefined) ctr = impressions === 0 ? 0 : clicks / impressions
    else {
      const parsedCtr = boundedMetric(row.ctr, false)
      if (parsedCtr === null || parsedCtr > 1) return null
      ctr = parsedCtr
    }
    rows.set(row.keys[0], { date: row.keys[0], clicks, impressions, ctr, position })
  }
  return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date))
}

function context(input: { ownerUserId: number, match: SearchConsolePropertyMatch, resolver: GoogleReadOnlyCredentialResolver, fetcher?: FetchLike, now?: Date }): GoogleRequestContext {
  return { ownerUserId: input.ownerUserId, connection: input.match.connection, resolver: input.resolver, fetcher: input.fetcher, now: input.now }
}

function unknownFromFailure(failure: { status: 'blocked' | 'failed' | 'retry_wait', code: string, limitations: string[] }): UnknownReason {
  if (failure.status === 'retry_wait') return { status: 'unknown', reasonCode: 'rate_limited', detail: failure.code, limitations: failure.limitations }
  if (failure.code === 'CREDENTIAL_NOT_CONFIGURED' || failure.code === 'CREDENTIAL_MISSING') return { status: 'unknown', reasonCode: 'not_configured', detail: failure.code, limitations: failure.limitations }
  return { status: 'unknown', reasonCode: 'provider_failure', detail: failure.code, limitations: failure.limitations }
}

function metricsUnknownFromFailure(failure: { status: 'blocked' | 'failed' | 'retry_wait', code: string, limitations: string[] }): UnknownReason {
  const result = unknownFromFailure(failure)
  return { ...result, limitations: [...new Set([...BASE_LIMITATIONS, ...result.limitations])] }
}

async function propertyMatch(input: { ownerUserId: number, pageUrl: string, repository: Pick<MeasurementRepository, 'listConnections'> }): Promise<SearchConsolePropertyMatch | { match: null, reasonCode: 'no_matching_property' | 'unsupported_page_url' }> {
  return findSearchConsolePropertyForUrl(await input.repository.listConnections(input.ownerUserId), input.pageUrl)
}

export async function collectSearchConsolePageMetricsByUrl(input: { ownerUserId: number, pageUrl: string, startDate: string, endDate: string, repository: Pick<MeasurementRepository, 'listConnections'>, resolver: GoogleReadOnlyCredentialResolver, fetcher?: FetchLike, now?: Date }): Promise<PageMetricsByUrlResult> {
  const range = validateRange(input.startDate, input.endDate)
  const match = await propertyMatch(input)
  if ('match' in match) return { status: 'unknown', reasonCode: match.reasonCode, limitations: [...BASE_LIMITATIONS] }
  const requestContext = context({ ...input, match })
  const credential = await resolveGoogleCredential(requestContext, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
  if ('failure' in credential) return metricsUnknownFromFailure(credential.failure)

  const endpoint = `${SEARCH_ANALYTICS_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(match.property)}/searchAnalytics/query`
  const response = await postFixedJson(requestContext, endpoint, credential.credential, {
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions: ['date'],
    dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: match.canonicalPage }] }],
    rowLimit: 1_000,
  })
  if (!response.ok) return metricsUnknownFromFailure(response.failure)
  const rows = parseRows(response.body, range.start, range.end)
  if (!rows) return { status: 'unknown', reasonCode: 'provider_failure', detail: 'MALFORMED_RESPONSE', limitations: [...BASE_LIMITATIONS, 'search_console_response_shape_invalid'] }
  const limitations = [...BASE_LIMITATIONS]
  if (rows.length === 0) limitations.push('search_console_zero_rows_is_not_api_failure')
  return { status: 'succeeded', property: match.property, canonicalPage: match.canonicalPage, rows, request: { startDate: input.startDate, endDate: input.endDate }, limitations }
}

export async function inspectPageUrlWithSearchConsole(input: { ownerUserId: number, pageUrl: string, repository: Pick<MeasurementRepository, 'listConnections'>, resolver: GoogleReadOnlyCredentialResolver, fetcher?: FetchLike, now?: Date }): Promise<PageInspectionByUrlResult> {
  const match = await propertyMatch(input)
  if ('match' in match) return { status: 'unknown', reasonCode: match.reasonCode, limitations: [] }
  const result = await inspectUrlWithSearchConsole(context({ ...input, match }), { inspectionUrl: match.canonicalPage, siteUrl: match.property })
  if (result.status !== 'succeeded') return unknownFromFailure(result)
  if (!result.lastCrawlTime) return { status: 'unknown', reasonCode: 'never_crawled', detail: result.verdict || result.coverageState || undefined, limitations: result.limitations }
  return {
    status: 'crawled',
    lastCrawlTime: result.lastCrawlTime,
    property: result.property,
    canonicalPage: match.canonicalPage,
    verdict: result.verdict,
    coverageState: result.coverageState,
    inspectedAt: result.inspectedAt,
    limitations: result.limitations,
  }
}
