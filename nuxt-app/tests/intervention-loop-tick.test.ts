import { describe, expect, it, vi } from 'vitest'
import { confirmDeploymentManually, createInMemoryInterventionLoopRepository, getIntervention, registerIntervention, runInterventionLoopTick } from '../server/intervention-loop'
import { sha256Hex } from '../server/site-evidence/normalization'
import type { InterventionLoopDependencies } from '../server/intervention-loop'

function setup() {
  const repository = createInMemoryInterventionLoopRepository(); const state = { now: new Date('2026-09-02T00:00:00.000Z'), inventory: new Map<string, { contentHash: string | null, lastFetchedAt: Date | null }>(), delivered: [] as Awaited<ReturnType<InterventionLoopDependencies['deliveredPublications']['listDeliveredPublications']>> }
  const inspector = vi.fn<InterventionLoopDependencies['urlInspector']>(async input => ({ status: 'crawled', lastCrawlTime: input.now, property: 'sc-domain:example.com' }))
  const puller = vi.fn<InterventionLoopDependencies['pageMetricsPuller']>(async () => ({ status: 'succeeded', property: 'sc-domain:example.com', rows: [{ date: '2026-08-20', clicks: 10, impressions: 50, ctr: 0.2, position: 8 }] }))
  const dependencies: InterventionLoopDependencies = { repository, clock: { now: () => new Date(state.now) }, linkResolver: { resolveBrief: async (_o, id) => ({ id }), resolveDraft: async (_o, id) => ({ id, jobId: 1, contentHash: null }), resolveEntry: async (_o, id) => ({ id }) }, baselineProvider: { readInventoryHash: async (_owner, hash) => state.inventory.get(hash) || null }, pageFetcher: async url => ({ finalUrl: url, status: 200, body: '', contentType: 'text/html', redirectChain: [] }), urlInspector: inspector, pageMetricsPuller: puller, deliveredPublications: { listDeliveredPublications: async () => state.delivered } }
  return { repository, state, inspector, puller, dependencies }
}
const registration = (key: string, path = key) => ({ targetUrl: `https://example.com/${path}`, changeSummary: `更新 ${key}`, interventionType: 'content_update', idempotencyKey: key })

describe('intervention loop tick', () => {
  it('auto-registers a delivered publication exactly once and marks receipt deployment strong', async () => {
    const h = setup(); h.state.delivered.push({ entryId: 10, targetId: 2, publicationUrl: 'https://example.com/published', contentHash: 'a'.repeat(64), receiptFingerprint: 'receipt-1', deliveredAt: new Date('2026-09-01T00:00:00.000Z'), briefId: null, draftId: null, changeSummary: '發布新內容' })
    expect((await runInterventionLoopTick(1, h.dependencies)).autoRegistered).toBe(1)
    expect((await runInterventionLoopTick(1, h.dependencies)).autoRegistered).toBe(0)
    const rows = await h.repository.listInterventions(1, { limit: 20 }); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: 'recrawl_confirmed', deployEvidenceLevel: 'strong', deployEvidenceSource: 'publication_receipt', registrationSource: 'content_operations_delivery' })
  })

  it('syncs changed inventory weakly and respects metrics and recrawl caps', async () => {
    const h = setup(); const registered = (await registerIntervention(1, registration('sync'), { ...h.dependencies, baselineProvider: { readInventoryHash: async () => ({ contentHash: sha256Hex('old'), lastFetchedAt: new Date('2026-08-31T00:00:00.000Z') }) } })).intervention
    h.state.now = new Date('2026-09-03T00:00:00.000Z')
    h.state.inventory.set(registered.urlHash, { contentHash: sha256Hex('new'), lastFetchedAt: new Date('2026-09-03T00:00:00.000Z') })
    const first = await runInterventionLoopTick(1, h.dependencies); expect(first).toMatchObject({ deploymentsSynced: 1, metricsPulled: 1, recrawlChecked: 1, recrawlConfirmed: 1 })
    const second = await runInterventionLoopTick(1, h.dependencies); expect(second.metricsCapped).toBe(1); expect(second.recrawlChecked).toBe(0); expect(h.puller).toHaveBeenCalledTimes(1)
    expect((await getIntervention(1, registered.id, h.dependencies)).intervention).toMatchObject({ deployEvidenceLevel: 'weak', recrawlAutoAttempts: 1 })
  })

  it('inspects only when measurements exist, spaces attempts by 24h, and stops at 30', async () => {
    const inspector = vi.fn<InterventionLoopDependencies['urlInspector']>(async () => ({ status: 'unknown', reasonCode: 'never_crawled' }))
    const puller = vi.fn<InterventionLoopDependencies['pageMetricsPuller']>(async input => input.pageUrl.endsWith('/empty') ? { status: 'unknown', reasonCode: 'not_configured' } : { status: 'succeeded', property: 'sc-domain:example.com', rows: [{ date: '2026-08-20', clicks: 1, impressions: 10, ctr: 0.1, position: 9 }] })
    const h = setup(); h.dependencies.urlInspector = inspector; h.dependencies.pageMetricsPuller = puller
    const empty = (await registerIntervention(1, registration('empty'), h.dependencies)).intervention; const retry = (await registerIntervention(1, registration('retry'), h.dependencies)).intervention; await confirmDeploymentManually(1, empty.id, { note: '已確認上線' }, h.dependencies); await confirmDeploymentManually(1, retry.id, { note: '已確認上線' }, h.dependencies)
    await runInterventionLoopTick(1, h.dependencies); expect(inspector).toHaveBeenCalledTimes(1)
    await runInterventionLoopTick(1, h.dependencies); expect(inspector).toHaveBeenCalledTimes(1)
    for (let day = 1; day <= 30; day += 1) { h.state.now = new Date(Date.UTC(2026, 8, 2 + day)); await runInterventionLoopTick(1, h.dependencies) }
    const retryRow = (await getIntervention(1, retry.id, h.dependencies)).intervention; const emptyRow = (await getIntervention(1, empty.id, h.dependencies)).intervention
    expect(retryRow.recrawlAutoAttempts).toBe(30); expect(emptyRow.recrawlAutoAttempts).toBe(0); expect(inspector).toHaveBeenCalledTimes(30)
  })

  it('stops after three automatic failures in one UTC day and retries on the next day', async () => {
    const h = setup(); const inspector = vi.fn<InterventionLoopDependencies['urlInspector']>(async () => ({ status: 'unknown', reasonCode: 'provider_failure' })); h.dependencies.urlInspector = inspector
    const row = (await registerIntervention(1, registration('failure-day'), h.dependencies)).intervention
    await confirmDeploymentManually(1, row.id, { note: '已確認上線' }, h.dependencies)
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await runInterventionLoopTick(1, h.dependencies)).recrawlChecked).toBe(1)
    expect((await runInterventionLoopTick(1, h.dependencies)).recrawlChecked).toBe(0)
    expect(inspector).toHaveBeenCalledTimes(3)
    expect((await getIntervention(1, row.id, h.dependencies)).intervention).toMatchObject({ recrawlAutoAttempts: 0, recrawlAutoFailureCount: 3, recrawlAutoFailureDay: '2026-09-02', recrawlLastReason: 'provider_failure' })
    h.state.now = new Date('2026-09-03T00:00:00.000Z')
    expect((await runInterventionLoopTick(1, h.dependencies)).recrawlChecked).toBe(1)
    expect(inspector).toHaveBeenCalledTimes(4)
    expect((await getIntervention(1, row.id, h.dependencies)).intervention).toMatchObject({ recrawlAutoFailureCount: 1, recrawlAutoFailureDay: '2026-09-03' })
  })

  it('isolates a throwing dependency so another intervention continues', async () => {
    const h = setup(); const bad = (await registerIntervention(1, registration('bad'), h.dependencies)).intervention; const good = (await registerIntervention(1, registration('good'), h.dependencies)).intervention
    h.dependencies.pageMetricsPuller = async input => { if (input.pageUrl.endsWith('/bad')) throw new Error('one row failed'); return { status: 'succeeded', property: 'sc-domain:example.com', rows: [{ date: '2026-08-20', clicks: 2, impressions: 20, ctr: 0.1, position: 7 }] } }
    const result = await runInterventionLoopTick(1, h.dependencies)
    expect(result.errors).toEqual(expect.arrayContaining([{ interventionId: bad.id, step: 'pull_metrics', code: 'INTERVENTION_STEP_FAILED' }]))
    expect((await h.repository.listMeasurements(1, good.id))).toHaveLength(1)
  })
})
