import { describe, expect, it } from 'vitest'
import { ga4DataApiAdapter } from '../server/measurement-collection/adapters/ga4-data-api'
import { googleSearchConsoleAdapter } from '../server/measurement-collection/adapters/google-search-console'
import { buildSnapshot, snapshotSourceHash } from '../server/measurement-collection/normalization'
import type { MeasurementAdapterContext } from '../server/measurement-collection/types'

const TOKEN = 'synthetic-access-token-must-not-escape'
const CANONICAL_PAGE = 'https://client.example.com/articles/measurement'

function context(source: 'google_search_console' | 'first_party_analytics', overrides: Partial<MeasurementAdapterContext> = {}): MeasurementAdapterContext {
  const connection = {
    id: 1, ownerUserId: 10, clientId: 20, source, status: 'configured', credentialReference: 'secret-manager:owner-10/google-readonly', googleSearchConsoleProperty: source === 'google_search_console' ? 'https://client.example.com' : null, ga4PropertyId: source === 'first_party_analytics' ? '123456789' : null, llmVisibilityProjectId: null, canonicalOrigin: 'https://client.example.com', timeZone: 'Asia/Taipei', allowedPageScope: [CANONICAL_PAGE], sourceAvailabilityLagDays: 2, providerTargets: null, idempotencyKey: 'connection-key', configurationFingerprint: 'a'.repeat(64), connectedAt: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date(),
  } as any
  const run = { id: 1, ownerUserId: 10, clientId: 20, connectionId: 1, entryId: 30, targetId: 40, source, checkpointDays: 7, publicationReceiptFingerprint: 'b'.repeat(64), canonicalPage: CANONICAL_PAGE, contentHash: 'c'.repeat(64), evidenceSnapshotHash: 'd'.repeat(64), publicationLocalDate: '2026-08-01', timeZone: 'Asia/Taipei', baselineWindowStart: new Date('2026-07-25T00:00:00.000Z'), baselineWindowEnd: new Date('2026-08-01T00:00:00.000Z'), followUpWindowStart: new Date('2026-08-01T00:00:00.000Z'), followUpWindowEnd: new Date('2026-08-08T00:00:00.000Z'), dueAt: new Date('2026-08-10T00:00:00.000Z'), state: 'processing', attemptNumber: 1, leaseOwner: 'test', leaseExpiresAt: new Date('2026-08-10T00:00:00.000Z'), retryEligibleAt: null, idempotencyKey: 'run-key', inputFingerprint: 'e'.repeat(64), outputFingerprint: null, errorCode: null, errorSummary: null, startedAt: new Date(), completedAt: null, createdAt: new Date(), updatedAt: new Date(),
  } as any
  return { ownerUserId: 10, connection, run, phase: 'baseline', windowStart: new Date('2026-07-25T00:00:00.000Z'), windowEnd: new Date('2026-08-01T00:00:00.000Z'), canonicalPage: CANONICAL_PAGE, deidentifiedSubjectKey: 'f'.repeat(64), scopeFingerprint: '1'.repeat(64), resolver: async () => ({ accessToken: TOKEN, expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'] }), ...overrides }
}

function mockedFetch(body: unknown, status = 200, inspect?: (url: string, init?: RequestInit) => void) {
  return async (url: string, init?: RequestInit) => {
    inspect?.(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

describe('Google Search Console measurement adapter', () => {
  it('uses the fixed endpoint, readonly Authorization header, exact page scope, and aggregate metrics', async () => {
    let requestUrl = ''
    let requestBody: any
    let requestHeaders: Headers | undefined
    const result = await googleSearchConsoleAdapter.collect(context('google_search_console', { fetcher: mockedFetch({ rows: [{ keys: [CANONICAL_PAGE], clicks: 12, impressions: 100, ctr: 0.12, position: 4.5 }] }, 200, (url, init) => { requestUrl = url; requestBody = JSON.parse(String(init?.body)); requestHeaders = new Headers(init?.headers) }) }))
    expect(result.status).toBe('succeeded')
    expect(requestUrl).toBe('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fclient.example.com/searchAnalytics/query')
    expect(requestBody.dimensionFilterGroups[0].filters[0]).toMatchObject({ dimension: 'page', operator: 'equals', expression: CANONICAL_PAGE })
    expect(requestBody.dimensions).toEqual(['page'])
    expect(requestHeaders?.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    if (result.status === 'succeeded') expect(result.snapshot.normalizedMetrics).toEqual({ impressions: 100, clicks: 12, averagePosition: 4.5 })
  })

  it('distinguishes zero rows from API failure', async () => {
    const result = await googleSearchConsoleAdapter.collect(context('google_search_console', { fetcher: mockedFetch({ rows: [] }) }))
    expect(result).toMatchObject({ status: 'insufficient_data', reasonCode: 'ZERO_ROWS' })
  })

  it.each([[401, 'blocked', 'NEEDS_REAUTHORIZATION'], [403, 'blocked', 'NEEDS_REAUTHORIZATION'], [429, 'retry_wait', 'PROVIDER_RETRYABLE_HTTP'], [503, 'retry_wait', 'PROVIDER_RETRYABLE_HTTP']] as const)('classifies HTTP %s safely', async (status, expectedStatus, code) => {
    const result = await googleSearchConsoleAdapter.collect(context('google_search_console', { fetcher: mockedFetch({ error: 'not persisted' }, status) }))
    expect(result).toMatchObject({ status: expectedStatus, code })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('rejects wrong page scope and malformed or negative metrics', async () => {
    const wrongPage = await googleSearchConsoleAdapter.collect(context('google_search_console', { fetcher: mockedFetch({ rows: [{ keys: ['https://client.example.com/other'], clicks: 1, impressions: 2, position: 2 }] }) }))
    const negative = await googleSearchConsoleAdapter.collect(context('google_search_console', { fetcher: mockedFetch({ rows: [{ keys: [CANONICAL_PAGE], clicks: -1, impressions: 2, position: 2 }] }) }))
    expect(wrongPage).toMatchObject({ status: 'failed', code: 'MALFORMED_RESPONSE' })
    expect(negative).toMatchObject({ status: 'failed', code: 'MALFORMED_RESPONSE' })
  })
})

describe('GA4 Data API measurement adapter', () => {
  it('uses the fixed numeric property endpoint, exact pageLocation dimension, and only allowed aggregate metrics', async () => {
    let requestUrl = ''
    let requestBody: any
    const result = await ga4DataApiAdapter.collect(context('first_party_analytics', { fetcher: mockedFetch({ dimensionHeaders: [{ name: 'pageLocation' }], metricHeaders: [{ name: 'sessions' }, { name: 'engagedSessions' }], rows: [{ dimensionValues: [{ value: CANONICAL_PAGE }], metricValues: [{ value: '100' }, { value: '60' }] }], metadata: { subjectToThresholding: true, samplingMetadatas: [{}] } }, 200, (url, init) => { requestUrl = url; requestBody = JSON.parse(String(init?.body)) }) }))
    expect(result.status).toBe('succeeded')
    expect(requestUrl).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport')
    expect(requestBody.dimensionFilter.filter).toMatchObject({ fieldName: 'pageLocation' })
    expect(requestBody.dimensionFilter.filter.stringFilter).toMatchObject({ matchType: 'EXACT', value: CANONICAL_PAGE })
    expect(requestBody.metrics).toEqual([{ name: 'sessions' }, { name: 'engagedSessions' }])
    if (result.status === 'succeeded') expect(result.snapshot.limitations).toEqual(['ga4_sampling_applied', 'ga4_subject_to_thresholding'])
  })

  it('rejects visitor-level or extra metrics and malformed numeric rows', async () => {
    const visitorLevel = await ga4DataApiAdapter.collect(context('first_party_analytics', { fetcher: mockedFetch({ dimensionHeaders: [{ name: 'userPseudoId' }], metricHeaders: [{ name: 'sessions' }, { name: 'engagedSessions' }], rows: [] }) }))
    const extraMetric = await ga4DataApiAdapter.collect(context('first_party_analytics', { fetcher: mockedFetch({ dimensionHeaders: [{ name: 'pageLocation' }], metricHeaders: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'totalUsers' }], rows: [] }) }))
    const malformed = await ga4DataApiAdapter.collect(context('first_party_analytics', { fetcher: mockedFetch({ dimensionHeaders: [{ name: 'pageLocation' }], metricHeaders: [{ name: 'sessions' }, { name: 'engagedSessions' }], rows: [{ dimensionValues: [{ value: CANONICAL_PAGE }], metricValues: [{ value: '-1' }, { value: '0' }] }] }) }))
    expect(visitorLevel).toMatchObject({ status: 'failed', code: 'MALFORMED_RESPONSE' })
    expect(extraMetric).toMatchObject({ status: 'failed', code: 'MALFORMED_RESPONSE' })
    expect(malformed).toMatchObject({ status: 'failed', code: 'MALFORMED_RESPONSE' })
  })

  it('returns retryable classification for rate-limit and server failures without serializing tokens', async () => {
    for (const status of [429, 500, 504]) {
      const result = await ga4DataApiAdapter.collect(context('first_party_analytics', { fetcher: mockedFetch({ error: 'token must not persist' }, status) }))
      expect(result).toMatchObject({ status: 'retry_wait', code: 'PROVIDER_RETRYABLE_HTTP' })
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    }
  })
})

describe('measurement snapshot hashes', () => {
  it('is deterministic and rejects invalid metric shapes', () => {
    const input = { source: 'google_search_console' as const, deidentifiedSubjectKey: 'a'.repeat(64), scopeFingerprint: 'b'.repeat(64), phase: 'baseline' as const, windowStart: new Date('2026-07-25T00:00:00.000Z'), windowEnd: new Date('2026-08-01T00:00:00.000Z'), capturedAt: new Date('2026-08-02T00:00:00.000Z'), metrics: { impressions: 100, clicks: 10, averagePosition: 3 }, providerProvenance: { adapterVersion: 'test' }, limitations: [] }
    const first = buildSnapshot(input)
    const second = buildSnapshot(input)
    expect(first?.sourceHash).toBe(second?.sourceHash)
    expect(first?.sourceHash).toBe(snapshotSourceHash({ ...input, metrics: { impressions: 100, clicks: 10, averagePosition: 3 } }))
    expect(buildSnapshot({ ...input, metrics: { impressions: 10, clicks: 20, averagePosition: 3 } })).toBeNull()
  })
})
