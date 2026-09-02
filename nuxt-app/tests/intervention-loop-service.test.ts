import { describe, expect, it, vi } from 'vitest'
import { PRE_POST_CAUSAL_STATEMENT, assessIntervention, checkDeploymentNow, checkRecrawl, confirmDeploymentManually, confirmRecrawlManually, createInMemoryInterventionLoopRepository, getIntervention, measureIntervention, pullMetrics, recordManualMeasurement, registerIntervention } from '../server/intervention-loop'
import { sha256Hex } from '../server/site-evidence/normalization'
import type { InterventionLoopDependencies } from '../server/intervention-loop'

function harness(overrides: Partial<InterventionLoopDependencies> = {}) {
  let now = new Date('2026-09-01T00:00:00.000Z')
  let body = '<html><body>new published answer</body></html>'
  const repository = createInMemoryInterventionLoopRepository()
  const dependencies: InterventionLoopDependencies = {
    repository,
    clock: { now: () => new Date(now) },
    linkResolver: { resolveBrief: async (_owner, id) => ({ id }), resolveDraft: async (_owner, id) => ({ id, jobId: 1, contentHash: null }), resolveEntry: async (_owner, id) => ({ id }) },
    baselineProvider: { readInventoryHash: async () => ({ contentHash: sha256Hex('old body'), lastFetchedAt: new Date('2026-08-31T00:00:00.000Z') }) },
    pageFetcher: async url => ({ finalUrl: url, status: 200, body, contentType: 'text/html', redirectChain: [] }),
    urlInspector: async () => ({ status: 'crawled', lastCrawlTime: new Date(now), property: 'sc-domain:example.com' }),
    pageMetricsPuller: async () => ({ status: 'succeeded', property: 'sc-domain:example.com', rows: [
      { date: '2026-08-20', clicks: 20, impressions: 100, ctr: 0.2, position: 8 },
      { date: '2026-09-10', clicks: 36, impressions: 120, ctr: 0.3, position: 6 },
    ] }),
    deliveredPublications: { listDeliveredPublications: async () => [] },
    ...overrides,
  }
  return { repository, dependencies, setNow(value: string) { now = new Date(value) }, setBody(value: string) { body = value } }
}

const registration = (key = 'register:1', extra: Record<string, unknown> = {}) => ({ targetUrl: 'https://example.com/page', changeSummary: '更新頁面內容', interventionType: 'content_update', idempotencyKey: key, ...extra })

async function expectCode(promise: Promise<unknown>, code: string, status = 409) {
  try { await promise; throw new Error('expected rejection') } catch (error) {
    expect(error).toMatchObject({ statusCode: status, data: { code } })
  }
}

describe('intervention loop service', () => {
  it('runs the full strong-evidence chain with an ordered fingerprinted ledger', async () => {
    const h = harness()
    const registered = await registerIntervention(7, registration('full', { expectedSnippet: 'new published answer' }), h.dependencies)
    expect(registered.intervention.baselineHashSource).toBe('site_evidence_inventory')
    expect((await checkDeploymentNow(7, registered.intervention.id, h.dependencies)).outcome).toBe('deployed_strong')
    h.setNow('2026-09-02T00:00:00.000Z')
    expect((await checkRecrawl(7, registered.intervention.id, h.dependencies)).outcome).toBe('confirmed')
    h.setNow('2026-09-20T00:00:00.000Z')
    expect((await pullMetrics(7, registered.intervention.id, h.dependencies, { reason: 'owner_request' })).rowsUpserted).toBe(2)
    await measureIntervention(7, registered.intervention.id, h.dependencies)
    const assessed = await assessIntervention(7, registered.intervention.id, h.dependencies)
    expect(assessed.intervention.status).toBe('assessed')
    expect(assessed.result).toMatchObject({ sampleSizeBaseline: 100, sampleSizeFollowUp: 120, causalStatement: PRE_POST_CAUSAL_STATEMENT })
    const detail = await getIntervention(7, registered.intervention.id, h.dependencies)
    expect(detail.events.map(item => item.eventType)).toEqual(['registered', 'baseline_captured', 'deployment_check', 'deployed', 'recrawl_check', 'recrawl_confirmed', 'metrics_pulled', 'measured', 'experiment_attached', 'assessed'])
    expect(detail.events.every(item => /^[a-f0-9]{64}$/u.test(item.evidenceFingerprint))).toBe(true)
  })

  it('refuses measurement before recrawl confirmation and assessment before measurement', async () => {
    const h = harness(); const first = await registerIntervention(1, registration('guards-registered'), h.dependencies)
    await expectCode(measureIntervention(1, first.intervention.id, h.dependencies), 'RECRAWL_NOT_CONFIRMED')
    await confirmDeploymentManually(1, first.intervention.id, { note: '已由發布人員確認' }, h.dependencies)
    await expectCode(measureIntervention(1, first.intervention.id, h.dependencies), 'RECRAWL_NOT_CONFIRMED')
    await expectCode(assessIntervention(1, first.intervention.id, h.dependencies), 'RECRAWL_NOT_CONFIRMED')
  })

  it('labels changed-fingerprint deployment weak and carries the limitation into assessment', async () => {
    const h = harness(); const row = (await registerIntervention(1, registration('weak'), h.dependencies)).intervention
    const deployment = await checkDeploymentNow(1, row.id, h.dependencies)
    expect(deployment).toMatchObject({ outcome: 'deployed_weak', intervention: { deployEvidenceLevel: 'weak' } })
    h.setNow('2026-09-02T00:00:00.000Z'); await checkRecrawl(1, row.id, h.dependencies)
    h.setNow('2026-09-20T00:00:00.000Z'); await pullMetrics(1, row.id, h.dependencies, { reason: 'owner_request' }); await measureIntervention(1, row.id, h.dependencies)
    expect((await assessIntervention(1, row.id, h.dependencies)).result.limitations).toContain('deployment_weak_evidence')
  })

  it('captures a live-fetch baseline, detects no change, then deploys weakly on change', async () => {
    const h = harness({ baselineProvider: { readInventoryHash: async () => null } }); h.setBody('<p>first version</p>')
    const row = (await registerIntervention(1, registration('capture'), h.dependencies)).intervention
    expect((await checkDeploymentNow(1, row.id, h.dependencies)).outcome).toBe('baseline_captured')
    expect((await checkDeploymentNow(1, row.id, h.dependencies)).outcome).toBe('no_change_detected')
    h.setBody('<p>second version</p>')
    expect((await checkDeploymentNow(1, row.id, h.dependencies)).outcome).toBe('deployed_weak')
    expect((await getIntervention(1, row.id, h.dependencies)).intervention.baselineHashSource).toBe('live_fetch')
  })

  it.each(['http://localhost/x', 'http://10.0.0.5/', 'http://169.254.169.254/', 'ftp://example.com/', 'https://user:pass@example.com/'])('rejects unsafe target %s', async targetUrl => {
    const h = harness(); await expectCode(registerIntervention(1, { ...registration(`unsafe:${targetUrl.length}`), targetUrl }, h.dependencies), 'TARGET_URL_NOT_ALLOWED', 422)
  })

  it('records a failed deployment check without transitioning', async () => {
    const h = harness({ pageFetcher: async () => { throw new Error('offline') } }); const row = (await registerIntervention(1, registration('fetch-fail'), h.dependencies)).intervention
    expect((await checkDeploymentNow(1, row.id, h.dependencies)).outcome).toBe('check_failed')
    const detail = await getIntervention(1, row.id, h.dependencies)
    expect(detail.intervention.status).toBe('registered'); expect(detail.events.at(-1)?.eventType).toBe('deployment_check')
  })

  it('replays identical registration, rejects conflicting replay, and hides cross-owner rows', async () => {
    const h = harness(); await registerIntervention(1, registration('same'), h.dependencies)
    expect((await registerIntervention(1, registration('same'), h.dependencies)).replayed).toBe(true)
    await expectCode(registerIntervention(1, registration('same', { changeSummary: '完全不同的內容' }), h.dependencies), 'IDEMPOTENCY_CONFLICT')
    await expectCode(getIntervention(2, 1, h.dependencies), 'NOT_FOUND', 404)
  })

  it('requires a manual recrawl note and preserves the manual limitation', async () => {
    const h = harness(); const row = (await registerIntervention(1, registration('manual-recrawl'), h.dependencies)).intervention; await confirmDeploymentManually(1, row.id, { note: '已確認上線' }, h.dependencies)
    await expectCode(confirmRecrawlManually(1, row.id, {}, h.dependencies), 'INVALID_INPUT', 422)
    h.setNow('2026-09-02T00:00:00.000Z'); await confirmRecrawlManually(1, row.id, { note: '已從搜尋結果與後台人工確認' }, h.dependencies)
    await recordManualMeasurement(1, row.id, { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-20T00:00:00.000Z', metrics: { clicks: 40, impressions: 100 }, note: 'before' }, h.dependencies)
    await recordManualMeasurement(1, row.id, { windowStart: '2026-09-03T00:00:00.000Z', windowEnd: '2026-09-20T00:00:00.000Z', metrics: { clicks: 50, impressions: 120 }, note: 'after' }, h.dependencies)
    await measureIntervention(1, row.id, h.dependencies)
    expect((await assessIntervention(1, row.id, h.dependencies)).result.limitations).toContain('recrawl_manual_confirmation')
  })

  it.each(['crawled', 'never_crawled'] as const)('counts %s as an answered automatic recrawl and resets failures', async answer => {
    let inspected: Awaited<ReturnType<InterventionLoopDependencies['urlInspector']>> = { status: 'unknown', reasonCode: 'provider_failure' }
    const h = harness({ urlInspector: async () => inspected }); const row = (await registerIntervention(1, registration(`answered:${answer}`), h.dependencies)).intervention
    await confirmDeploymentManually(1, row.id, { note: '已確認上線' }, h.dependencies)
    await checkRecrawl(1, row.id, h.dependencies, { automatic: true })
    h.setNow('2026-09-02T00:00:00.000Z')
    inspected = answer === 'crawled' ? { status: 'crawled', lastCrawlTime: new Date('2026-08-31T00:00:00.000Z'), property: 'sc-domain:example.com' } : { status: 'unknown', reasonCode: 'never_crawled' }
    await checkRecrawl(1, row.id, h.dependencies, { automatic: true })
    expect((await getIntervention(1, row.id, h.dependencies)).intervention).toMatchObject({ recrawlAutoAttempts: 1, recrawlLastAutoAttemptAt: new Date('2026-09-02T00:00:00.000Z'), recrawlAutoFailureCount: 0, recrawlAutoFailureDay: null })
    expect((await getIntervention(1, row.id, h.dependencies)).events.filter(item => item.eventType === 'recrawl_check')).toHaveLength(2)
  })

  it.each(['not_configured', 'no_matching_property', 'unsupported_page_url', 'provider_failure', 'rate_limited'] as const)('does not spend answer quota for automatic %s failures and restarts their UTC-day count', async reasonCode => {
    const h = harness({ urlInspector: async () => ({ status: 'unknown', reasonCode }) }); const row = (await registerIntervention(1, registration(`failure:${reasonCode}`), h.dependencies)).intervention
    await confirmDeploymentManually(1, row.id, { note: '已確認上線' }, h.dependencies)
    await checkRecrawl(1, row.id, h.dependencies, { automatic: true })
    expect((await getIntervention(1, row.id, h.dependencies)).intervention).toMatchObject({ recrawlAutoAttempts: 0, recrawlLastAutoAttemptAt: null, recrawlAutoFailureCount: 1, recrawlAutoFailureDay: '2026-09-01', recrawlLastReason: reasonCode })
    await checkRecrawl(1, row.id, h.dependencies)
    expect((await getIntervention(1, row.id, h.dependencies)).intervention).toMatchObject({ recrawlAutoAttempts: 0, recrawlLastAutoAttemptAt: null, recrawlAutoFailureCount: 1, recrawlAutoFailureDay: '2026-09-01', recrawlLastReason: reasonCode })
    h.setNow('2026-09-02T00:00:00.000Z')
    await checkRecrawl(1, row.id, h.dependencies, { automatic: true })
    expect((await getIntervention(1, row.id, h.dependencies)).intervention).toMatchObject({ recrawlAutoAttempts: 0, recrawlLastAutoAttemptAt: null, recrawlAutoFailureCount: 1, recrawlAutoFailureDay: '2026-09-02', recrawlLastReason: reasonCode })
  })

  it('enforces the 24-hour pull cap including unknown attempts', async () => {
    const puller = vi.fn<InterventionLoopDependencies['pageMetricsPuller']>(async () => ({ status: 'unknown', reasonCode: 'not_configured' }))
    const h = harness({ pageMetricsPuller: puller }); const row = (await registerIntervention(1, registration('cap'), h.dependencies)).intervention
    expect((await pullMetrics(1, row.id, h.dependencies, { reason: 'owner_request' })).outcome).toBe('unknown')
    expect((await pullMetrics(1, row.id, h.dependencies, { reason: 'owner_request' })).outcome).toBe('capped'); expect(puller).toHaveBeenCalledTimes(1)
    h.setNow('2026-09-02T00:00:00.000Z'); await pullMetrics(1, row.id, h.dependencies, { reason: 'owner_request' }); expect(puller).toHaveBeenCalledTimes(2)
    expect((await getIntervention(1, row.id, h.dependencies)).events.filter(item => item.eventType === 'metrics_unknown')).toHaveLength(2)
  })

  it('upserts manual windows, labels origin, and reports mixed origins', async () => {
    const h = harness(); const row = (await registerIntervention(1, registration('mixed'), h.dependencies)).intervention; await confirmDeploymentManually(1, row.id, { note: '已確認上線', deployedAt: '2026-09-01T00:00:00.000Z' }, h.dependencies); h.setNow('2026-09-02T00:00:00.000Z'); await confirmRecrawlManually(1, row.id, { note: '已人工確認重新抓取' }, h.dependencies)
    const input = { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-20T00:00:00.000Z', metrics: { clicks: 10, impressions: 100 } }
    expect((await recordManualMeasurement(1, row.id, input, h.dependencies)).measurement.origin).toBe('manual')
    expect((await recordManualMeasurement(1, row.id, { ...input, metrics: { clicks: 20, impressions: 100 } }, h.dependencies)).replaced).toBe(true)
    h.setNow('2026-09-20T00:00:00.000Z'); await pullMetrics(1, row.id, h.dependencies, { reason: 'owner_request' }); await measureIntervention(1, row.id, h.dependencies)
    expect((await assessIntervention(1, row.id, h.dependencies)).result.limitations).toContain('mixed_measurement_origins')
  })
})
