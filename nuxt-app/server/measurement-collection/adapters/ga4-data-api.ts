import { buildSnapshot, normalizeGa4PropertyId } from '../normalization'
import { GOOGLE_ANALYTICS_READONLY_SCOPE, postFixedJson, resolveGoogleCredential } from './google-shared'
import type { MeasurementAdapterContext, MeasurementAdapterResult, MeasurementSourceAdapter } from '../types'

const ADAPTER_VERSION = 'ga4-data-api-v1'
const ENDPOINT_ORIGIN = 'https://analyticsdata.googleapis.com'

function localDateFor(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

function metricValue(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function qualityLimitations(body: Record<string, unknown>): string[] {
  const limitations: string[] = []
  const metadata = typeof body.metadata === 'object' && body.metadata !== null && !Array.isArray(body.metadata) ? body.metadata as Record<string, unknown> : {}
  if (metadata.subjectToThresholding === true) limitations.push('ga4_subject_to_thresholding')
  if (metadata.dataLossFromOtherRow === true) limitations.push('ga4_data_loss_from_other_row')
  if (Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length > 0) limitations.push('ga4_sampling_applied')
  if (metadata.schemaRestrictionResponse !== undefined) limitations.push('ga4_schema_restriction_metadata_present')
  return limitations
}

function parseReport(body: unknown, canonicalPage: string): { status: 'ok'; metrics: Record<string, number>; rows: number; limitations: string[] } | { status: 'zero' } | { status: 'invalid' } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { status: 'invalid' }
  const record = body as Record<string, unknown>
  const dimensions = record.dimensionHeaders
  const metrics = record.metricHeaders
  if (!Array.isArray(dimensions) || dimensions.length !== 1 || (dimensions[0] as { name?: unknown })?.name !== 'pageLocation') return { status: 'invalid' }
  if (!Array.isArray(metrics) || metrics.length !== 2 || (metrics[0] as { name?: unknown })?.name !== 'sessions' || (metrics[1] as { name?: unknown })?.name !== 'engagedSessions') return { status: 'invalid' }
  const rows = record.rows
  if (rows === undefined) return { status: 'zero' }
  if (!Array.isArray(rows) || rows.length > 1_000) return { status: 'invalid' }
  if (rows.length === 0) return { status: 'zero' }
  let sessions = 0
  let engagedSessions = 0
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return { status: 'invalid' }
    const item = row as { dimensionValues?: unknown; metricValues?: unknown }
    if (!Array.isArray(item.dimensionValues) || item.dimensionValues.length !== 1 || (item.dimensionValues[0] as { value?: unknown })?.value !== canonicalPage) return { status: 'invalid' }
    if (!Array.isArray(item.metricValues) || item.metricValues.length !== 2) return { status: 'invalid' }
    const rowSessions = metricValue((item.metricValues[0] as { value?: unknown })?.value)
    const rowEngaged = metricValue((item.metricValues[1] as { value?: unknown })?.value)
    if (rowSessions === null || rowEngaged === null || rowEngaged > rowSessions) return { status: 'invalid' }
    sessions += rowSessions
    engagedSessions += rowEngaged
    if (!Number.isSafeInteger(sessions) || !Number.isSafeInteger(engagedSessions)) return { status: 'invalid' }
  }
  return { status: 'ok', metrics: { sessions, engagedSessions }, rows: rows.length, limitations: qualityLimitations(record) }
}

export const ga4DataApiAdapter: MeasurementSourceAdapter = {
  source: 'first_party_analytics',
  async collect(context: MeasurementAdapterContext): Promise<MeasurementAdapterResult> {
    const propertyId = normalizeGa4PropertyId(context.connection.ga4PropertyId)
    if (!propertyId) return { status: 'blocked', code: 'INVALID_GA4_PROPERTY', summary: 'invalid ga4 property identifier', retryable: false, limitations: ['ga4_property_not_configured'] }
    const credential = await resolveGoogleCredential(context, GOOGLE_ANALYTICS_READONLY_SCOPE)
    if ('failure' in credential) return credential.failure
    const startDate = localDateFor(context.windowStart, context.connection.timeZone)
    const endDate = localDateFor(new Date(context.windowEnd.getTime() - 1), context.connection.timeZone)
    const endpoint = `${ENDPOINT_ORIGIN}/v1beta/properties/${propertyId}:runReport`
    const response = await postFixedJson(context, endpoint, credential.credential, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pageLocation' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
      dimensionFilter: { filter: { fieldName: 'pageLocation', stringFilter: { matchType: 'EXACT', value: context.canonicalPage } } },
      limit: '1000',
      keepEmptyRows: false,
    })
    if (!response.ok) return response.failure
    const parsed = parseReport(response.body, context.canonicalPage)
    if (parsed.status === 'zero') return { status: 'insufficient_data', reasonCode: 'ZERO_ROWS', limitations: ['ga4_zero_rows_is_not_api_failure'] }
    if (parsed.status === 'invalid') return { status: 'failed', code: 'MALFORMED_RESPONSE', summary: 'malformed ga4 aggregate response', retryable: false, limitations: ['ga4_response_shape_invalid'] }
    const snapshot = buildSnapshot({
      source: 'first_party_analytics',
      phase: context.phase,
      deidentifiedSubjectKey: context.deidentifiedSubjectKey,
      scopeFingerprint: context.scopeFingerprint,
      windowStart: context.windowStart,
      windowEnd: context.windowEnd,
      capturedAt: context.now || new Date(),
      metrics: parsed.metrics,
      providerProvenance: { adapterVersion: ADAPTER_VERSION, endpoint, propertyId, request: { startDate, endDate, dimensions: ['pageLocation'], metrics: ['sessions', 'engagedSessions'], exactPageScope: true, limit: 1_000 }, returnedRowCount: parsed.rows, qualityMetadata: parsed.limitations },
      limitations: parsed.limitations,
    })
    if (!snapshot) return { status: 'failed', code: 'NORMALIZATION_FAILED', summary: 'normalized ga4 result was rejected', retryable: false, limitations: ['normalized_metrics_rejected'] }
    return { status: 'succeeded', snapshot }
  },
}
