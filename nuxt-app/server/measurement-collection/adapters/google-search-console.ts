import { buildSnapshot, normalizeSearchConsoleProperty } from '../normalization'
import { GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE, dateOnly, postFixedJson, resolveGoogleCredential } from './google-shared'
import type { MeasurementAdapterContext, MeasurementAdapterResult, MeasurementSourceAdapter } from '../types'

const ADAPTER_VERSION = 'gsc-search-analytics-v1'
const ENDPOINT_ORIGIN = 'https://www.googleapis.com'
const DAY_MS = 86_400_000

function localDateFor(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function boundedMetric(value: unknown, integer = true): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null
  if (integer && !Number.isSafeInteger(value)) return null
  return value
}

function parseRows(body: unknown, canonicalPage: string): { status: 'ok'; metrics: Record<string, number>; rows: number } | { status: 'zero' } | { status: 'invalid' } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { status: 'invalid' }
  const rows = (body as { rows?: unknown }).rows
  if (rows === undefined) return { status: 'zero' }
  if (!Array.isArray(rows) || rows.length > 1_000) return { status: 'invalid' }
  if (rows.length === 0) return { status: 'zero' }
  let impressions = 0
  let clicks = 0
  let weightedPosition = 0
  let totalImpressions = 0
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return { status: 'invalid' }
    const item = row as { keys?: unknown; clicks?: unknown; impressions?: unknown; position?: unknown; ctr?: unknown }
    if (!Array.isArray(item.keys) || item.keys.length !== 1 || item.keys[0] !== canonicalPage) return { status: 'invalid' }
    const rowClicks = boundedMetric(item.clicks)
    const rowImpressions = boundedMetric(item.impressions)
    const position = boundedMetric(item.position, false)
    if (rowClicks === null || rowImpressions === null || position === null || rowClicks > rowImpressions) return { status: 'invalid' }
    if (item.ctr !== undefined && (typeof item.ctr !== 'number' || !Number.isFinite(item.ctr) || item.ctr < 0 || item.ctr > 1)) return { status: 'invalid' }
    impressions += rowImpressions
    clicks += rowClicks
    weightedPosition += position * rowImpressions
    totalImpressions += rowImpressions
    if (![impressions, clicks, weightedPosition, totalImpressions].every(value => Number.isSafeInteger(value) || Number.isFinite(value))) return { status: 'invalid' }
  }
  const averagePosition = totalImpressions === 0 ? 0 : weightedPosition / totalImpressions
  if (![impressions, clicks, averagePosition].every(Number.isFinite) || impressions > Number.MAX_SAFE_INTEGER || clicks > impressions) return { status: 'invalid' }
  return { status: 'ok', metrics: { impressions, clicks, averagePosition }, rows: rows.length }
}

export const googleSearchConsoleAdapter: MeasurementSourceAdapter = {
  source: 'google_search_console',
  async collect(context: MeasurementAdapterContext): Promise<MeasurementAdapterResult> {
    const property = normalizeSearchConsoleProperty(context.connection.googleSearchConsoleProperty, context.connection.canonicalOrigin)
    if (!property) return { status: 'blocked', code: 'INVALID_SEARCH_CONSOLE_PROPERTY', summary: 'invalid search console property', retryable: false, limitations: ['search_console_property_not_configured'] }
    const canonicalPage = context.canonicalPage
    const credential = await resolveGoogleCredential(context, GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE)
    if ('failure' in credential) return credential.failure
    const startDate = localDateFor(context.windowStart, context.connection.timeZone)
    const endDate = localDateFor(new Date(context.windowEnd.getTime() - 1), context.connection.timeZone)
    const endpoint = `${ENDPOINT_ORIGIN}/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`
    const response = await postFixedJson(context, endpoint, credential.credential, {
      startDate,
      endDate,
      dimensions: ['page'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: canonicalPage }] }],
      rowLimit: 1_000,
    })
    if (!response.ok) return response.failure
    const parsed = parseRows(response.body, canonicalPage)
    if (parsed.status === 'zero') return { status: 'insufficient_data', reasonCode: 'ZERO_ROWS', limitations: ['search_console_zero_rows_is_not_api_failure', 'search_console_may_not_return_all_rows'] }
    if (parsed.status === 'invalid') return { status: 'failed', code: 'MALFORMED_RESPONSE', summary: 'malformed search console aggregate response', retryable: false, limitations: ['search_console_response_shape_invalid'] }
    const capturedAt = context.now || new Date()
    const snapshot = buildSnapshot({
      source: 'google_search_console',
      phase: context.phase,
      deidentifiedSubjectKey: context.deidentifiedSubjectKey,
      scopeFingerprint: context.scopeFingerprint,
      windowStart: context.windowStart,
      windowEnd: context.windowEnd,
      capturedAt,
      metrics: parsed.metrics,
      providerProvenance: { adapterVersion: ADAPTER_VERSION, endpoint, property, request: { startDate, endDate, dimensions: ['page'], rowLimit: 1_000 }, returnedRowCount: parsed.rows },
      limitations: ['search_console_may_not_return_all_rows'],
    })
    if (!snapshot) return { status: 'failed', code: 'NORMALIZATION_FAILED', summary: 'normalized search console result was rejected', retryable: false, limitations: ['normalized_metrics_rejected'] }
    return { status: 'succeeded', snapshot }
  },
}

export function gscDateRangeForTests(windowStart: Date, windowEnd: Date, timeZone: string): { startDate: string; endDate: string } {
  return { startDate: localDateFor(windowStart, timeZone), endDate: localDateFor(new Date(windowEnd.getTime() - 1), timeZone) }
}
