import { describe, expect, it } from 'vitest'
import { cancelIntervention, confirmDeploymentManually, createInMemoryInterventionLoopRepository, enqueueRefreshManually, evaluateRefreshTriggers, getRefreshPolicy, listRefreshQueue, registerIntervention, updateRefreshPolicy, updateRefreshQueueItem } from '../server/intervention-loop'
import type { InterventionLoopDependencies } from '../server/intervention-loop'

function setup(now = '2026-09-01T00:00:00.000Z') {
  const repository = createInMemoryInterventionLoopRepository(); const clock = { value: new Date(now) }
  const dependencies: InterventionLoopDependencies = { repository, clock: { now: () => new Date(clock.value) }, linkResolver: { resolveBrief: async (_o, id) => ({ id }), resolveDraft: async (_o, id) => ({ id, jobId: 1, contentHash: null }), resolveEntry: async (_o, id) => ({ id }) }, baselineProvider: { readInventoryHash: async () => null }, pageFetcher: async url => ({ finalUrl: url, status: 200, body: '', contentType: 'text/html', redirectChain: [] }), urlInspector: async () => ({ status: 'unknown', reasonCode: 'not_configured' }), pageMetricsPuller: async () => ({ status: 'unknown', reasonCode: 'not_configured' }), deliveredPublications: { listDeliveredPublications: async () => [] } }
  return { repository, dependencies, clock }
}
const register = (key: string, url = `https://example.com/${key}`) => ({ targetUrl: url, changeSummary: `更新 ${key}`, interventionType: 'content_update', idempotencyKey: key })
async function expect422(value: unknown, h: ReturnType<typeof setup>) { try { await updateRefreshPolicy(1, value, h.dependencies); throw new Error('expected') } catch (error) { expect(error).toMatchObject({ statusCode: 422 }) } }

describe('intervention refresh queue', () => {
  it('returns defaults, persists valid updates, and rejects unsafe thresholds', async () => {
    const h = setup(); expect(await getRefreshPolicy(1, h.dependencies)).toMatchObject({ regressionDropPercent: 20, minimumSampleSize: 30, staleAfterDays: 90, persisted: false })
    expect(await updateRefreshPolicy(1, { regressionDropPercent: 25, minimumSampleSize: 50, staleAfterDays: 120 }, h.dependencies)).toMatchObject({ regressionDropPercent: 25, minimumSampleSize: 50, staleAfterDays: 120, persisted: true })
    await expect422({ regressionDropPercent: 0 }, h); await expect422({ regressionDropPercent: 95 }, h); await expect422({ staleAfterDays: 3 }, h)
  })

  it('fires regression only with sufficient samples, escalates at 2x, and handles dedupe lifecycle', async () => {
    const h = setup('2026-09-20T00:00:00.000Z'); const row = (await registerIntervention(1, register('regression'), h.dependencies)).intervention; const low = (await registerIntervention(1, register('low-n'), h.dependencies)).intervention; const now = h.clock.value
    const experiment = await h.repository.createExperiment({ ownerUserId: 1, name: 'Regression source', design: 'pre_post', hypothesis: null, status: 'running', primaryMetric: 'clicks', startedAt: now, concludedAt: null, idempotencyKey: 'refresh-results', createdAt: now, updatedAt: now })
    await h.repository.updateIntervention(1, row.id, { status: 'assessed', deployedAt: new Date('2026-09-01T00:00:00.000Z'), updatedAt: now }); await h.repository.updateIntervention(1, low.id, { status: 'assessed', deployedAt: new Date('2026-09-01T00:00:00.000Z'), updatedAt: now })
    await h.repository.createResult({ ownerUserId: 1, experimentId: experiment.id, interventionId: row.id, resultKind: 'pre_post', metric: 'clicksPerDay', sampleSizeBaseline: 900, sampleSizeFollowUp: 640, effect: { baseline: { clicksPerDay: 12 }, followUp: { clicksPerDay: 7.2 }, deltas: { clicksPerDay: -0.4 } }, signal: 'negative_signal', limitations: [], causalStatement: 'correlation', computedAt: now, resultFingerprint: 'a'.repeat(64), createdAt: now, updatedAt: now })
    await h.repository.createResult({ ownerUserId: 1, experimentId: experiment.id, interventionId: low.id, resultKind: 'pre_post', metric: 'clicksPerDay', sampleSizeBaseline: 29, sampleSizeFollowUp: 100, effect: { baseline: { clicksPerDay: 10 }, followUp: { clicksPerDay: 1 }, deltas: { clicksPerDay: -0.9 } }, signal: 'negative_signal', limitations: [], causalStatement: 'correlation', computedAt: now, resultFingerprint: 'b'.repeat(64), createdAt: now, updatedAt: now })
    const first = await evaluateRefreshTriggers(1, h.dependencies)
    expect(first.enqueued).toHaveLength(1); expect(first.enqueued[0]).toMatchObject({ trigger: 'regression', severity: 'critical', reasonRule: 'regression_clicks_per_day_drop' }); expect(first.enqueued[0]!.reasonText).toContain('12.0'); expect(first.enqueued[0]!.reasonText).toContain('7.2'); expect(first.enqueued[0]!.reasonText).toContain('900')
    expect((await evaluateRefreshTriggers(1, h.dependencies)).skippedDuplicates).toBe(1)
    await updateRefreshQueueItem(1, first.enqueued[0]!.id, { status: 'done' }, h.dependencies)
    expect((await evaluateRefreshTriggers(1, h.dependencies)).enqueued).toHaveLength(1)
  })

  it('fires expiry exactly at the threshold and suppresses an older version of the same URL', async () => {
    const h = setup('2026-04-01T00:00:00.000Z'); const old = (await registerIntervention(1, register('old', 'https://example.com/shared'), h.dependencies)).intervention; const deployed = new Date('2026-01-01T00:00:00.000Z'); await h.repository.updateIntervention(1, old.id, { deployedAt: deployed, status: 'deployed', updatedAt: deployed })
    h.clock.value = new Date('2026-03-31T00:00:00.000Z'); expect((await evaluateRefreshTriggers(1, h.dependencies)).enqueued).toHaveLength(0)
    h.clock.value = new Date('2026-04-01T00:00:00.000Z'); const due = await evaluateRefreshTriggers(1, h.dependencies); expect(due.enqueued).toHaveLength(1); expect(due.enqueued[0]).toMatchObject({ trigger: 'expiry', dueAt: new Date('2026-04-01T00:00:00.000Z') })
    await updateRefreshQueueItem(1, due.enqueued[0]!.id, { status: 'done' }, h.dependencies)
    const newer = (await registerIntervention(1, register('new', 'https://example.com/shared'), h.dependencies)).intervention; await h.repository.updateIntervention(1, newer.id, { deployedAt: new Date('2026-03-01T00:00:00.000Z'), status: 'deployed', updatedAt: h.clock.value })
    const next = await evaluateRefreshTriggers(1, h.dependencies); expect(next.enqueued.some(item => item.interventionId === old.id)).toBe(false)
  })

  it('skips a cancelled deployed intervention during the expiry scan', async () => {
    const h = setup('2026-01-01T00:00:00.000Z'); const row = (await registerIntervention(1, register('cancelled-expiry'), h.dependencies)).intervention
    await confirmDeploymentManually(1, row.id, { note: '已確認上線' }, h.dependencies)
    await cancelIntervention(1, row.id, { note: '停止這項改動' }, h.dependencies)
    h.clock.value = new Date('2026-04-01T00:00:00.000Z')
    const result = await evaluateRefreshTriggers(1, h.dependencies)
    expect(result.enqueued).toEqual([])
    expect((await listRefreshQueue(1, {}, h.dependencies)).some(item => item.interventionId === row.id)).toBe(false)
  })

  it('stores manual notes as reasonText and requires a note', async () => {
    const h = setup(); const row = (await registerIntervention(1, register('manual'), h.dependencies)).intervention
    try { await enqueueRefreshManually(1, { interventionId: row.id }, h.dependencies); throw new Error('expected') } catch (error) { expect(error).toMatchObject({ statusCode: 422 }) }
    const created = await enqueueRefreshManually(1, { interventionId: row.id, note: '請重新檢查法規內容' }, h.dependencies)
    expect(created.item).toMatchObject({ trigger: 'manual', reasonText: '請重新檢查法規內容', reasonRule: 'manual' }); expect(await listRefreshQueue(1, {}, h.dependencies)).toHaveLength(1)
  })
})
