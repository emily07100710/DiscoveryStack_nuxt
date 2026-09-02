import { describe, expect, it, vi } from 'vitest'
import { inspectUrlWithSearchConsole } from '../server/measurement-collection/adapters/google-url-inspection'
import { runtimeGoogleServiceAccountCredentialResolver, unavailableGoogleCredentialResolver } from '../server/measurement-collection/credentials'
import type { GoogleRequestContext } from '../server/measurement-collection/adapters/google-shared'
import type { MeasurementConnectionRow } from '../server/measurement-collection/types'

const TOKEN = 'url-inspection-token-must-not-escape'
const PROPERTY = 'sc-domain:example.com'
const PAGE = 'https://www.example.com/article'

function connection(overrides: Partial<MeasurementConnectionRow> = {}): MeasurementConnectionRow {
  return {
    id: 1, ownerUserId: 7, clientId: 2, source: 'google_search_console', status: 'configured', credentialReference: 'service-account:test', googleSearchConsoleProperty: PROPERTY, ga4PropertyId: null, llmVisibilityProjectId: null, canonicalOrigin: 'https://example.com', timeZone: 'UTC', allowedPageScope: [], sourceAvailabilityLagDays: 2, providerTargets: null, idempotencyKey: 'gsc-test', configurationFingerprint: 'a'.repeat(64), connectedAt: null, revokedAt: null, createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'), ...overrides,
  } as MeasurementConnectionRow
}

function context(overrides: Partial<GoogleRequestContext> = {}): GoogleRequestContext {
  return {
    ownerUserId: 7,
    connection: connection(),
    resolver: async () => ({ accessToken: TOKEN, expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
    now: new Date('2026-09-02T12:00:00.000Z'),
    ...overrides,
  }
}

function response(body: unknown, status = 200, inspect?: (url: string, init?: RequestInit) => void) {
  return async (url: string, init?: RequestInit) => {
    inspect?.(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

describe('Google Search Console URL Inspection adapter', () => {
  it('uses the fixed endpoint and request, parses index status, and never returns the token', async () => {
    let requestUrl = ''
    let requestBody: unknown
    let authorization = ''
    const result = await inspectUrlWithSearchConsole(context({ fetcher: response({ inspectionResult: { indexStatusResult: { lastCrawlTime: '2026-09-01T03:04:05Z', verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL', robotsTxtState: 'ALLOWED' } } }, 200, (url, init) => {
      requestUrl = url
      requestBody = JSON.parse(String(init?.body))
      authorization = new Headers(init?.headers).get('authorization') || ''
    }) }), { inspectionUrl: PAGE, siteUrl: PROPERTY })
    expect(requestUrl).toBe('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect')
    expect(requestBody).toEqual({ inspectionUrl: PAGE, siteUrl: PROPERTY })
    expect(authorization).toBe(`Bearer ${TOKEN}`)
    expect(result).toMatchObject({ status: 'succeeded', property: PROPERTY, inspectionUrl: PAGE, lastCrawlTime: new Date('2026-09-01T03:04:05Z'), verdict: 'PASS', coverageState: 'Submitted and indexed' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('reports unavailable crawl time without treating the response as an API failure', async () => {
    const result = await inspectUrlWithSearchConsole(context({ fetcher: response({ inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL' } } }) }), { inspectionUrl: PAGE, siteUrl: PROPERTY })
    expect(result).toMatchObject({ status: 'succeeded', lastCrawlTime: null })
    if (result.status === 'succeeded') expect(result.limitations).toEqual(expect.arrayContaining(['url_inspection_quota_limited', 'last_crawl_time_unavailable']))
  })

  it('rejects a missing inspection result as malformed', async () => {
    expect(await inspectUrlWithSearchConsole(context({ fetcher: response({}) }), { inspectionUrl: PAGE, siteUrl: PROPERTY })).toMatchObject({ status: 'failed', code: 'MALFORMED_RESPONSE', retryable: false })
  })

  it.each([[403, 'blocked', 'NEEDS_REAUTHORIZATION'], [429, 'retry_wait', 'PROVIDER_RETRYABLE_HTTP']] as const)('classifies HTTP %s safely', async (status, expectedStatus, code) => {
    const result = await inspectUrlWithSearchConsole(context({ fetcher: response({ error: 'safe' }, status) }), { inspectionUrl: PAGE, siteUrl: PROPERTY })
    expect(result).toMatchObject({ status: expectedStatus, code })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('blocks when the resolver is unavailable and never fetches', async () => {
    const fetcher = vi.fn(response({}))
    const result = await inspectUrlWithSearchConsole(context({ resolver: unavailableGoogleCredentialResolver, fetcher }), { inspectionUrl: PAGE, siteUrl: PROPERTY })
    expect(result).toMatchObject({ status: 'blocked', code: 'CREDENTIAL_MISSING' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.env.DS_RUN_EXTERNAL_CREDENTIAL_TESTS !== '1' || !process.env.DS_TEST_GSC_PROPERTY || !process.env.DS_TEST_GSC_PAGE_URL)('live: GSC URL Inspection (opt-in)', () => {
  it('returns a live successful inspection response', async () => {
    const property = process.env.DS_TEST_GSC_PROPERTY!
    const page = process.env.DS_TEST_GSC_PAGE_URL!
    const origin = new URL(page).origin
    const result = await inspectUrlWithSearchConsole(context({ connection: connection({ googleSearchConsoleProperty: property, canonicalOrigin: origin, credentialReference: 'runtime-service-account' }), resolver: runtimeGoogleServiceAccountCredentialResolver, fetcher: undefined, now: new Date() }), { inspectionUrl: page, siteUrl: property })
    expect(result.status).toBe('succeeded')
  })
})
