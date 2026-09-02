import { describe, expect, it } from 'vitest'
import { GROUPED_CAUSAL_STATEMENT, assessIntervention, attachInterventionToExperiment, concludeExperiment, confirmDeploymentManually, confirmRecrawlManually, createExperiment, createInMemoryInterventionLoopRepository, measureIntervention, recordManualMeasurement, registerIntervention } from '../server/intervention-loop'
import type { InterventionLoopDependencies } from '../server/intervention-loop'

function setup() {
  let now = new Date('2026-09-01T00:00:00.000Z'); const repository = createInMemoryInterventionLoopRepository()
  const dependencies: InterventionLoopDependencies = { repository, clock: { now: () => new Date(now) }, linkResolver: { resolveBrief: async (_o, id) => ({ id }), resolveDraft: async (_o, id) => ({ id, jobId: 1, contentHash: null }), resolveEntry: async (_o, id) => ({ id }) }, baselineProvider: { readInventoryHash: async () => null }, pageFetcher: async url => ({ finalUrl: url, status: 200, body: '', contentType: 'text/html', redirectChain: [] }), urlInspector: async () => ({ status: 'unknown', reasonCode: 'not_configured' }), pageMetricsPuller: async () => ({ status: 'unknown', reasonCode: 'not_configured' }), deliveredPublications: { listDeliveredPublications: async () => [] } }
  return { repository, dependencies, setNow(value: string) { now = new Date(value) } }
}

const input = (key: string, path = key) => ({ targetUrl: `https://example.com/${path}`, changeSummary: `更新 ${key}`, interventionType: 'content_update', idempotencyKey: key })

async function expect409(promise: Promise<unknown>, code: string) { try { await promise; throw new Error('expected') } catch (error) { expect(error).toMatchObject({ statusCode: 409, data: { code } }) } }

describe('intervention experiments', () => {
  it('auto-creates and attaches a pre_post experiment during assessment', async () => {
    const h = setup(); const row = (await registerIntervention(1, input('auto'), h.dependencies)).intervention
    await confirmDeploymentManually(1, row.id, { note: '已確認上線' }, h.dependencies); h.setNow('2026-09-02T00:00:00.000Z'); await confirmRecrawlManually(1, row.id, { note: '已確認重新抓取' }, h.dependencies)
    await recordManualMeasurement(1, row.id, { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-20T00:00:00.000Z', metrics: { clicks: 10, impressions: 50 } }, h.dependencies)
    await recordManualMeasurement(1, row.id, { windowStart: '2026-09-03T00:00:00.000Z', windowEnd: '2026-09-20T00:00:00.000Z', metrics: { clicks: 20, impressions: 60 } }, h.dependencies)
    await measureIntervention(1, row.id, h.dependencies); const assessed = await assessIntervention(1, row.id, h.dependencies)
    expect(assessed.intervention).toMatchObject({ experimentGroup: 'treatment', status: 'assessed' })
    expect(await h.repository.getExperiment(1, assessed.intervention.experimentId!)).toMatchObject({ design: 'pre_post', idempotencyKey: `auto:intervention:${row.id}` })
  })

  it('computes grouped difference with explicit mapping, limitations, n, and causal statement', async () => {
    const h = setup(); const experiment = (await createExperiment(1, { name: 'Grouped', design: 'grouped', idempotencyKey: 'grouped:1' }, h.dependencies)).experiment
    const treatment = (await registerIntervention(1, input('treatment'), h.dependencies)).intervention; const control = (await registerIntervention(1, input('control'), h.dependencies)).intervention
    await attachInterventionToExperiment(1, experiment.id, { interventionId: treatment.id, group: 'treatment' }, h.dependencies); await attachInterventionToExperiment(1, experiment.id, { interventionId: control.id, group: 'control' }, h.dependencies)
    const now = new Date('2026-09-20T00:00:00.000Z')
    await h.repository.updateIntervention(1, treatment.id, { status: 'assessed', updatedAt: now }); await h.repository.updateIntervention(1, control.id, { status: 'assessed', updatedAt: now })
    for (const [row, delta] of [[treatment, 0.5], [control, 0.1]] as const) await h.repository.createResult({ ownerUserId: 1, experimentId: experiment.id, interventionId: row.id, resultKind: 'pre_post', metric: 'clicksPerDay', sampleSizeBaseline: 100, sampleSizeFollowUp: 120, effect: { deltas: { clicksPerDay: delta } }, signal: 'positive_signal', limitations: [], causalStatement: 'pre-post', computedAt: now, resultFingerprint: `result-${row.id}`.padEnd(64, '0'), createdAt: now, updatedAt: now })
    const concluded = await concludeExperiment(1, experiment.id, h.dependencies)
    expect(concluded.result).toMatchObject({ resultKind: 'grouped_difference', sampleSizeBaseline: 220, sampleSizeFollowUp: 220, causalStatement: GROUPED_CAUSAL_STATEMENT })
    expect(concluded.result.limitations).toEqual(expect.arrayContaining(['no_randomization', 'small_group']))
    expect(concluded.result.effect).toMatchObject({ differenceInRelativeDelta: 0.4, sampleSizeMapping: { sampleSizeBaseline: 'treatment_total_n', sampleSizeFollowUp: 'control_total_n' } })
    expect((await concludeExperiment(1, experiment.id, h.dependencies)).replayed).toBe(true)
  })

  it('rejects attaching to another experiment and concluding unassessed work', async () => {
    const h = setup(); const first = (await createExperiment(1, { name: 'First', design: 'grouped', idempotencyKey: 'first' }, h.dependencies)).experiment; const second = (await createExperiment(1, { name: 'Second', design: 'grouped', idempotencyKey: 'second' }, h.dependencies)).experiment; const row = (await registerIntervention(1, input('conflict'), h.dependencies)).intervention
    await attachInterventionToExperiment(1, first.id, { interventionId: row.id, group: 'treatment' }, h.dependencies)
    await expect409(attachInterventionToExperiment(1, second.id, { interventionId: row.id, group: 'control' }, h.dependencies), 'ALREADY_ATTACHED')
    await expect409(concludeExperiment(1, first.id, h.dependencies), 'INVALID_TRANSITION')
  })
})
