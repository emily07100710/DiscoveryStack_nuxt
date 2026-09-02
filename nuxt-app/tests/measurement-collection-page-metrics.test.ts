import { describe, expect, it, vi } from 'vitest'
import { runtimeGoogleServiceAccountCredentialResolver, unavailableGoogleCredentialResolver } from '../server/measurement-collection/credentials'
import { collectSearchConsolePageMetricsByUrl, findSearchConsolePropertyForUrl, inspectPageUrlWithSearchConsole } from '../server/measurement-collection/page-metrics'
import type { FetchLike, GoogleReadOnlyCredentialResolver, MeasurementConnectionRow } from '../server/measurement-collection/types'

const TOKEN = 'page-metrics-token-must-not-escape'
const resolver: GoogleReadOnlyCredentialResolver = async () => ({ accessToken: TOKEN, expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] })

function connection(id: number, property: string | null, canonicalOrigin = 'https://client.acme.taipei', status: MeasurementConnectionRow['status'] = 'configured'): MeasurementConnectionRow {
  return {
    id, ownerUserId: 7, clientId: id, source: 'google_search_console', status, credentialReference: 'service-account:test', googleSearchConsoleProperty: property, ga4PropertyId: null, llmVisibilityProjectId: null, canonicalOrigin, timeZone: 'UTC', allowedPageScope: [], sourceAvailabilityLagDays: 2, providerTargets: null, idempotencyKey: `gsc-${id}`, configurationFingerprint: String(id).repeat(64).slice(0, 64), connectedAt: null, revokedAt: null, createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'),
  } as MeasurementConnectionRow
}

const repository = (connections: MeasurementConnectionRow[]) => ({ async listConnections() { return connections } })

function response(body: unknown, status = 200, inspect?: (url: string, init?: RequestInit) => void): FetchLike {
  return async (url, init) => {
    inspect?.(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

function input(overrides: Partial<Parameters<typeof collectSearchConsolePageMetricsByUrl>[0]> = {}): Parameters<typeof collectSearchConsolePageMetricsByUrl>[0] {
  return { ownerUserId: 7, pageUrl: 'https://client.acme.taipei/article', startDate: '2026-08-01', endDate: '2026-08-31', repository: repository([connection(1, 'https://client.acme.taipei')]), resolver, fetcher: response({ rows: [] }), now: new Date('2026-09-02T00:00:00Z'), ...overrides }
}

describe('Search Console property matching by URL', () => {
  it('matches URL-prefix properties and canonicalizes the page', () => {
    expect(findSearchConsolePropertyForUrl([connection(1, 'https://client.acme.taipei')], 'https://CLIENT.ACME.TAIPEI/article#fragment')).toMatchObject({ property: 'https://client.acme.taipei', canonicalPage: 'https://client.acme.taipei/article', matchKind: 'url_prefix' })
  })

  it('matches domain properties at apex and subdomains, but not suffix-confusion domains', () => {
    const rows = [connection(1, 'sc-domain:example.com')]
    expect(findSearchConsolePropertyForUrl(rows, 'https://example.com/a')).toMatchObject({ matchKind: 'domain' })
    expect(findSearchConsolePropertyForUrl(rows, 'http://news.example.com/a?ref=1#x')).toMatchObject({ canonicalPage: 'http://news.example.com/a?ref=1', matchKind: 'domain' })
    expect(findSearchConsolePropertyForUrl(rows, 'https://notexample.com/a')).toEqual({ match: null, reasonCode: 'no_matching_property' })
  })

  it('ignores paused and revoked properties', () => {
    expect(findSearchConsolePropertyForUrl([connection(1, 'sc-domain:acme.taipei', 'https://client.acme.taipei', 'paused'), connection(2, 'https://client.acme.taipei', 'https://client.acme.taipei', 'revoked')], 'https://client.acme.taipei/a')).toEqual({ match: null, reasonCode: 'no_matching_property' })
  })

  it('prefers URL-prefix over domain and then the lowest connection id', () => {
    const match = findSearchConsolePropertyForUrl([connection(5, 'sc-domain:acme.taipei'), connection(3, 'https://client.acme.taipei'), connection(2, 'https://client.acme.taipei')], 'https://client.acme.taipei/a')
    expect(match).toMatchObject({ matchKind: 'url_prefix', connection: { id: 2 } })
  })

  it.each(['https://client.acme.taipei/a?q=1', 'ftp://client.acme.taipei/a', 'https://user:password@client.acme.taipei/a'])('rejects unsupported page URL %s', value => {
    expect(findSearchConsolePropertyForUrl([connection(1, 'https://client.acme.taipei')], value)).toEqual({ match: null, reasonCode: 'unsupported_page_url' })
  })

  it('reports no matching property when nothing is configured', () => {
    expect(findSearchConsolePropertyForUrl([], 'https://example.com/a')).toEqual({ match: null, reasonCode: 'no_matching_property' })
  })
})

describe('Search Console page metrics by URL', () => {
  it('sends the date dimension and exact page filter to the encoded property endpoint', async () => {
    let requestUrl = ''
    let requestBody: any
    let authorization = ''
    const result = await collectSearchConsolePageMetricsByUrl(input({ fetcher: response({ rows: [] }, 200, (url, init) => { requestUrl = url; requestBody = JSON.parse(String(init?.body)); authorization = new Headers(init?.headers).get('authorization') || '' }) }))
    expect(requestUrl).toBe('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fclient.acme.taipei/searchAnalytics/query')
    expect(requestBody).toEqual({ startDate: '2026-08-01', endDate: '2026-08-31', dimensions: ['date'], dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: 'https://client.acme.taipei/article' }] }], rowLimit: 1000 })
    expect(authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('parses, sorts, and de-duplicates rows with the last date value winning', async () => {
    const rows = [
      { keys: ['2026-08-03'], clicks: 3, impressions: 10, ctr: 0.3, position: 5.5 },
      { keys: ['2026-08-01'], clicks: 1, impressions: 4, position: 7 },
      { keys: ['2026-08-03'], clicks: 4, impressions: 10, ctr: 0.4, position: 4 },
    ]
    const result = await collectSearchConsolePageMetricsByUrl(input({ fetcher: response({ rows }) }))
    expect(result).toMatchObject({ status: 'succeeded', rows: [{ date: '2026-08-01', clicks: 1, impressions: 4, ctr: 0.25, position: 7 }, { date: '2026-08-03', clicks: 4, impressions: 10, ctr: 0.4, position: 4 }] })
  })

  it('treats zero rows as a successful empty result', async () => {
    const result = await collectSearchConsolePageMetricsByUrl(input())
    expect(result).toMatchObject({ status: 'succeeded', rows: [] })
    if (result.status === 'succeeded') expect(result.limitations).toEqual(expect.arrayContaining(['search_console_zero_rows_is_not_api_failure', 'search_console_may_not_return_all_rows', 'search_console_data_lag_up_to_3_days']))
  })

  it.each([
    { keys: ['2026-08-02'], clicks: 5, impressions: 4, ctr: 1, position: 3 },
    { keys: ['2026-08-02'], clicks: -1, impressions: 4, ctr: 0, position: 3 },
    { keys: ['2026-08-02'], clicks: 1, impressions: 4, ctr: 1.2, position: 3 },
  ])('maps a malformed row to provider failure', async row => {
    expect(await collectSearchConsolePageMetricsByUrl(input({ fetcher: response({ rows: [row] }) }))).toMatchObject({ status: 'unknown', reasonCode: 'provider_failure', detail: 'MALFORMED_RESPONSE' })
  })

  it('rejects provider dates outside the requested range', async () => {
    expect(await collectSearchConsolePageMetricsByUrl(input({ fetcher: response({ rows: [{ keys: ['2026-09-01'], clicks: 1, impressions: 4, ctr: 0.25, position: 3 }] }) }))).toMatchObject({ status: 'unknown', reasonCode: 'provider_failure', detail: 'MALFORMED_RESPONSE' })
  })

  it('maps missing credentials without fetching and never exposes tokens', async () => {
    const fetcher = vi.fn(response({ rows: [] }))
    const result = await collectSearchConsolePageMetricsByUrl(input({ resolver: unavailableGoogleCredentialResolver, fetcher }))
    expect(result).toMatchObject({ status: 'unknown', reasonCode: 'not_configured', detail: 'CREDENTIAL_MISSING' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it.each([[429, 'rate_limited'], [403, 'provider_failure']] as const)('maps HTTP %s to %s', async (status, reasonCode) => {
    expect(await collectSearchConsolePageMetricsByUrl(input({ fetcher: response({ error: 'safe' }, status) }))).toMatchObject({ status: 'unknown', reasonCode })
  })

  it('rejects ranges longer than 120 inclusive days with a 422-style error', async () => {
    await expect(collectSearchConsolePageMetricsByUrl(input({ startDate: '2026-01-01', endDate: '2026-05-01' }))).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('Search Console page inspection by URL', () => {
  it('maps a crawl time into the page inspection contract', async () => {
    const result = await inspectPageUrlWithSearchConsole({ ownerUserId: 7, pageUrl: 'https://client.acme.taipei/article', repository: repository([connection(1, 'https://client.acme.taipei')]), resolver, fetcher: response({ inspectionResult: { indexStatusResult: { lastCrawlTime: '2026-09-01T00:00:00Z', verdict: 'PASS', coverageState: 'Indexed' } } }), now: new Date('2026-09-02T00:00:00Z') })
    expect(result).toMatchObject({ status: 'crawled', property: 'https://client.acme.taipei', canonicalPage: 'https://client.acme.taipei/article', lastCrawlTime: new Date('2026-09-01T00:00:00Z'), verdict: 'PASS' })
  })

  it('maps a missing crawl time to never crawled', async () => {
    const result = await inspectPageUrlWithSearchConsole({ ownerUserId: 7, pageUrl: 'https://client.acme.taipei/article', repository: repository([connection(1, 'https://client.acme.taipei')]), resolver, fetcher: response({ inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL' } } }) })
    expect(result).toMatchObject({ status: 'unknown', reasonCode: 'never_crawled', detail: 'NEUTRAL' })
  })
})

describe.skipIf(process.env.DS_RUN_EXTERNAL_CREDENTIAL_TESTS !== '1' || !process.env.DS_TEST_GSC_PROPERTY || !process.env.DS_TEST_GSC_PAGE_URL)('live: GSC page metrics (opt-in)', () => {
  it('returns a live successful page-metrics response', async () => {
    const page = process.env.DS_TEST_GSC_PAGE_URL!
    const property = process.env.DS_TEST_GSC_PROPERTY!
    const end = new Date(Date.now() - 4 * 86_400_000)
    const date = end.toISOString().slice(0, 10)
    const result = await collectSearchConsolePageMetricsByUrl({ ownerUserId: 7, pageUrl: page, startDate: date, endDate: date, repository: repository([connection(1, property, new URL(page).origin)]), resolver: runtimeGoogleServiceAccountCredentialResolver })
    expect(result.status).toBe('succeeded')
  })
})
