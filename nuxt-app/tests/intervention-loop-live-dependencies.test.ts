import { describe, expect, it, vi } from 'vitest'
import { unavailableGoogleCredentialResolver } from '../server/measurement-collection/credentials'
import { checkRecrawl, confirmDeploymentManually, createInMemoryInterventionLoopRepository, getIntervention, pullMetrics, registerIntervention } from '../server/intervention-loop'
import { createMeasurementCollectionPageMetricsPuller, createMeasurementCollectionUrlInspector, resolveInterventionLoopDependencies } from '../server/intervention-loop/dependencies'
import type { InterventionLoopDependencies } from '../server/intervention-loop/dependencies'
import type { GoogleReadOnlyCredentialResolver, MeasurementConnectionRow } from '../server/measurement-collection/types'

const TOKEN = 'intervention-live-dependency-token'

function connection(): MeasurementConnectionRow {
  return { id: 1, ownerUserId: 7, clientId: 2, source: 'google_search_console', status: 'configured', credentialReference: 'service-account:test', googleSearchConsoleProperty: 'https://client.acme.taipei', ga4PropertyId: null, llmVisibilityProjectId: null, canonicalOrigin: 'https://client.acme.taipei', timeZone: 'UTC', allowedPageScope: [], sourceAvailabilityLagDays: 2, providerTargets: null, idempotencyKey: 'gsc-live-dependency', configurationFingerprint: 'a'.repeat(64), connectedAt: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date() } as MeasurementConnectionRow
}

function baseDependencies(urlInspector: InterventionLoopDependencies['urlInspector'], pageMetricsPuller: InterventionLoopDependencies['pageMetricsPuller'], now = new Date('2026-09-20T00:00:00Z')): InterventionLoopDependencies {
  const repository = createInMemoryInterventionLoopRepository()
  return {
    repository,
    clock: { now: () => new Date(now) },
    linkResolver: { resolveBrief: async (_owner, id) => ({ id }), resolveDraft: async (_owner, id) => ({ id, jobId: 1, contentHash: null }), resolveEntry: async (_owner, id) => ({ id }) },
    baselineProvider: { readInventoryHash: async () => null },
    pageFetcher: async url => ({ finalUrl: url, status: 200, body: '', contentType: 'text/html', redirectChain: [] }),
    urlInspector,
    pageMetricsPuller,
    deliveredPublications: { listDeliveredPublications: async () => [] },
  }
}

const registration = (key: string) => ({ targetUrl: `https://client.acme.taipei/${key}`, changeSummary: `更新 ${key}`, interventionType: 'content_update' as const, idempotencyKey: key })

describe('intervention loop measurement-collection dependencies', () => {
  it('pulls one system row per date and confirms a post-deployment crawl', async () => {
    const repository = { async listConnections() { return [connection()] } }
    const resolver: GoogleReadOnlyCredentialResolver = async () => ({ accessToken: TOKEN, expiresAt: '2099-01-01T00:00:00Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] })
    const fetcher = vi.fn(async (url: string) => url.includes('searchAnalytics/query')
      ? new Response(JSON.stringify({ rows: [{ keys: ['2026-09-10'], clicks: 2, impressions: 10, ctr: 0.2, position: 4 }] }), { status: 200 })
      : new Response(JSON.stringify({ inspectionResult: { indexStatusResult: { lastCrawlTime: '2026-09-20T00:00:00Z', verdict: 'PASS', coverageState: 'Indexed' } } }), { status: 200 }))
    const dependencies = baseDependencies(createMeasurementCollectionUrlInspector({ repository, resolver, fetcher }), createMeasurementCollectionPageMetricsPuller({ repository, resolver, fetcher }))
    const intervention = (await registerIntervention(7, registration('connected'), dependencies)).intervention

    expect(await pullMetrics(7, intervention.id, dependencies, { reason: 'owner_request' })).toMatchObject({ outcome: 'pulled', rowsUpserted: 1 })
    const measurements = await dependencies.repository.listMeasurements(7, intervention.id)
    expect(measurements).toHaveLength(1)
    expect(measurements[0]).toMatchObject({ origin: 'system_pulled', property: 'https://client.acme.taipei' })

    await confirmDeploymentManually(7, intervention.id, { note: '已確認部署', deployedAt: '2026-09-19T00:00:00Z' }, dependencies)
    expect(await checkRecrawl(7, intervention.id, dependencies)).toMatchObject({ outcome: 'confirmed' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('records unknown metric and recrawl events without HTTP when credentials are unavailable', async () => {
    const repository = { async listConnections() { return [connection()] } }
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    const dependencies = baseDependencies(createMeasurementCollectionUrlInspector({ repository, resolver: unavailableGoogleCredentialResolver, fetcher }), createMeasurementCollectionPageMetricsPuller({ repository, resolver: unavailableGoogleCredentialResolver, fetcher }))
    const intervention = (await registerIntervention(7, registration('not-configured'), dependencies)).intervention

    expect(await pullMetrics(7, intervention.id, dependencies, { reason: 'owner_request' })).toMatchObject({ outcome: 'unknown', reasonCode: 'not_configured' })
    await confirmDeploymentManually(7, intervention.id, { note: '已確認部署', deployedAt: '2026-09-19T00:00:00Z' }, dependencies)
    expect(await checkRecrawl(7, intervention.id, dependencies)).toMatchObject({ outcome: 'unknown', reasonCode: 'not_configured' })
    expect(fetcher).not.toHaveBeenCalled()
    const events = (await getIntervention(7, intervention.id, dependencies)).events
    expect(events.map(event => event.eventType)).toEqual(expect.arrayContaining(['metrics_unknown', 'recrawl_check']))
  })

  it('constructs default live dependency functions lazily', () => {
    const dependencies = resolveInterventionLoopDependencies()
    expect(dependencies.urlInspector).toBeTypeOf('function')
    expect(dependencies.pageMetricsPuller).toBeTypeOf('function')
  })
})
