import { describe, expect, it } from 'vitest'
import { assessIntervention, confirmDeploymentManually, confirmRecrawlManually, createInMemoryInterventionLoopRepository, exportInterventionOutcomeDataset, measureIntervention, recordManualMeasurement, registerIntervention } from '../server/intervention-loop'
import type { InterventionLoopDependencies } from '../server/intervention-loop'

describe('intervention outcome export', () => {
  it('exports aggregate evidence without operational free text', async () => {
    let now = new Date('2026-09-01T00:00:00.000Z'); const repository = createInMemoryInterventionLoopRepository()
    const dependencies: InterventionLoopDependencies = { repository, clock: { now: () => new Date(now) }, linkResolver: { resolveBrief: async (_o, id) => ({ id }), resolveDraft: async (_o, id) => ({ id, jobId: 1, contentHash: null }), resolveEntry: async (_o, id) => ({ id }) }, baselineProvider: { readInventoryHash: async () => null }, pageFetcher: async url => ({ finalUrl: url, status: 200, body: '', contentType: 'text/html', redirectChain: [] }), urlInspector: async () => ({ status: 'unknown', reasonCode: 'not_configured' }), pageMetricsPuller: async () => ({ status: 'unknown', reasonCode: 'not_configured' }), deliveredPublications: { listDeliveredPublications: async () => [] } }
    const secrets = { summary: 'SECRET_CHANGE_SUMMARY', hypothesis: 'SECRET_HYPOTHESIS', deploy: 'SECRET_DEPLOY_NOTE', recrawl: 'SECRET_RECRAWL_NOTE', measure: 'SECRET_MEASUREMENT_NOTE' }
    const row = (await registerIntervention(77, { targetUrl: 'https://example.com/private-copy', changeSummary: secrets.summary, hypothesis: secrets.hypothesis, interventionType: 'content_update', idempotencyKey: 'export' }, dependencies)).intervention
    await confirmDeploymentManually(77, row.id, { note: secrets.deploy }, dependencies); now = new Date('2026-09-02T00:00:00.000Z'); await confirmRecrawlManually(77, row.id, { note: secrets.recrawl }, dependencies)
    await recordManualMeasurement(77, row.id, { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-20T00:00:00.000Z', metrics: { clicks: 10, impressions: 100 }, note: secrets.measure }, dependencies)
    await recordManualMeasurement(77, row.id, { windowStart: '2026-09-03T00:00:00.000Z', windowEnd: '2026-09-20T00:00:00.000Z', metrics: { clicks: 20, impressions: 120 }, note: secrets.measure }, dependencies)
    await measureIntervention(77, row.id, dependencies); await assessIntervention(77, row.id, dependencies)
    const dataset = await exportInterventionOutcomeDataset(77, dependencies); const encoded = JSON.stringify(dataset)
    expect(dataset.ownerKey).toMatch(/^[a-f0-9]{64}$/u); expect(dataset.interventions[0]).toMatchObject({ baseline: { n: 100 }, followUp: { n: 120 }, results: [{ sampleSizeBaseline: 100, sampleSizeFollowUp: 120 }] })
    expect(dataset.interventions[0]!.results[0]!.signal).toBeTruthy(); expect(dataset.interventions[0]!.results[0]!.causalStatement).toContain('只能視為相關')
    for (const secret of Object.values(secrets)) expect(encoded).not.toContain(secret)
  })
})
