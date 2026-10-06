import { describe, expect, it } from 'vitest'
import {
  assessIntervention, checkDeploymentNow, checkRecrawl, confirmDeploymentManually, confirmRecrawlManually,
  createInMemoryInterventionLoopRepository, exportInterventionOutcomeDataset, fingerprint, getIntervention,
  markPublicationInterventionDeployed, measureIntervention, recordManualMeasurement, registerIntervention,
} from '../server/intervention-loop'
import type { InterventionLoopDependencies, InterventionMeasurement } from '../server/intervention-loop'
import { sha256Hex } from '../server/site-evidence/normalization'

const owner = 7
const page = 'https://example.com/closed-loop'
const receipt = 'a'.repeat(64)
const newContent = sha256Hex('published content')
const baseline = { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-20T00:00:00.000Z', metrics: { clicks: 10, impressions: 100 } }
const followUp = { windowStart: '2026-09-03T00:00:00.000Z', windowEnd: '2026-09-20T00:00:00.000Z', metrics: { clicks: 30, impressions: 120 } }

function harness(overrides: Partial<InterventionLoopDependencies> = {}) {
  let now = new Date('2026-09-01T00:00:00.000Z')
  const repository = createInMemoryInterventionLoopRepository()
  const dependencies: InterventionLoopDependencies = {
    repository, clock: { now: () => new Date(now) },
    linkResolver: { resolveBrief: async (_o, id) => ({ id }), resolveDraft: async (_o, id) => ({ id, jobId: 1, contentHash: newContent }), resolveEntry: async (_o, id) => ({ id }) },
    baselineProvider: { readInventoryHash: async () => ({ contentHash: sha256Hex('before content'), lastFetchedAt: new Date('2026-08-30T00:00:00.000Z') }) },
    pageFetcher: async url => ({ finalUrl: url, status: 200, body: '<p>published content</p>', contentType: 'text/html', redirectChain: [] }),
    urlInspector: async () => ({ status: 'crawled', lastCrawlTime: now, property: 'sc-domain:example.com' }),
    pageMetricsPuller: async () => ({ status: 'unknown', reasonCode: 'not_configured' }),
    deliveredPublications: { listDeliveredPublications: async () => [], resolveDeliveredPublication: async () => ({ entryId: 30, targetId: 55, publicationUrl: page, contentHash: newContent, receiptFingerprint: receipt, deliveredAt: new Date('2026-09-01T00:00:00.000Z') }) },
    ...overrides,
  }
  return { repository, dependencies, setNow(value: string) { now = new Date(value) } }
}

async function journey(h: ReturnType<typeof harness>, useReceipt = false) {
  const row = (await registerIntervention(owner, {
    targetUrl: page, changeSummary: 'PRIVATE_SUMMARY_NOT_TRAINING_DATA', hypothesis: 'PRIVATE_HYPOTHESIS_NOT_TRAINING_DATA',
    interventionType: 'content_update', idempotencyKey: 'closed-loop:1', expectedSnippet: 'published content',
    ...(useReceipt ? { entryId: 30, targetId: 55 } : {}),
  }, h.dependencies)).intervention
  if (useReceipt) await markPublicationInterventionDeployed(owner, row.id, { deliveredAt: new Date('2026-09-01T00:00:00.000Z'), contentHash: newContent, receiptFingerprint: receipt }, h.dependencies)
  else await checkDeploymentNow(owner, row.id, h.dependencies)
  h.setNow('2026-09-02T00:00:00.000Z')
  await checkRecrawl(owner, row.id, h.dependencies)
  h.setNow('2026-09-21T00:00:00.000Z')
  await recordManualMeasurement(owner, row.id, baseline, h.dependencies)
  await recordManualMeasurement(owner, row.id, followUp, h.dependencies)
  await measureIntervention(owner, row.id, h.dependencies)
  await assessIntervention(owner, row.id, h.dependencies)
  return row
}

describe('intervention envelope service journey', () => {
  it('projects register → baseline → executed receipt → recrawl → measurement → assessment → export with the same lineage', async () => {
    const h = harness(); const row = await journey(h, true)
    const detail = await getIntervention(owner, row.id, h.dependencies)
    expect(detail.envelope).toMatchObject({
      schemaVersion: 'intervention-envelope-v1',
      before: { availability: 'known', contentHash: sha256Hex('before content') },
      intervention: { publication: { entryId: 30, targetId: 55, receiptFingerprint: receipt, binding: 'verified' } },
      after: { recrawl: { status: 'confirmed' }, assessment: { status: 'current', signal: 'positive_signal' } },
      confidence: { percentage: null, sampleSize: { before: 100, after: 120 }, observedDays: { before: 19, after: 17 } },
      learning: { status: 'blocked', modelTrainingAllowed: false, primaryCitationLabelAllowed: false },
    })
    const exported = await exportInterventionOutcomeDataset(owner, h.dependencies)
    expect(exported.datasetVersion).toBe('intervention-outcome-v2')
    expect(exported.interventions[0]!.envelope).toEqual(detail.envelope)
    expect(exported.interventions[0]!.baseline?.n).toBe(100)
    expect(exported.interventions[0]!.followUp?.n).toBe(120)
    expect(JSON.stringify(exported)).not.toMatch(/PRIVATE_SUMMARY_NOT_TRAINING_DATA|PRIVATE_HYPOTHESIS_NOT_TRAINING_DATA/)
    expect(detail.envelope.confidence.causalStatement).toContain('只能視為相關')
    expect(detail.envelope.envelopeFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    h.setNow('2026-09-22T00:00:00.000Z')
    expect((await getIntervention(owner, row.id, h.dependencies)).envelope.envelopeFingerprint).toBe(detail.envelope.envelopeFingerprint)
  })

  it('does not invent a baseline from post-publication content or from a later inventory scan', async () => {
    const h = harness({ baselineProvider: { readInventoryHash: async () => null } })
    const row = await journey(h, true)
    expect((await getIntervention(owner, row.id, h.dependencies)).intervention).toMatchObject({ baselineContentHash: null, baselineCapturedAt: null, baselineHashSource: null })
    expect((await getIntervention(owner, row.id, h.dependencies)).envelope.before).toMatchObject({ availability: 'unknown', contentHash: null })
    const later = harness({ baselineProvider: { readInventoryHash: async () => ({ contentHash: newContent, lastFetchedAt: new Date('2026-09-02T00:00:00.000Z') }) } })
    const lateRow = (await registerIntervention(owner, { targetUrl: page, changeSummary: 'later registration', interventionType: 'content_update', idempotencyKey: 'late' }, later.dependencies)).intervention
    expect(lateRow.baselineContentHash).toBeNull()
  })

  it('keeps missing measurements unknown rather than zero and keeps training closed', async () => {
    const h = harness({ baselineProvider: { readInventoryHash: async () => null } })
    const row = (await registerIntervention(owner, { targetUrl: page, changeSummary: 'empty baseline', interventionType: 'content_update', idempotencyKey: 'empty' }, h.dependencies)).intervention
    const { envelope } = await getIntervention(owner, row.id, h.dependencies)
    expect(envelope.before.availability).toBe('unknown')
    expect(envelope.confidence.sampleSize).toEqual({ before: null, after: null })
    expect(envelope.after).toMatchObject({ measurements: [], assessment: { status: 'not_assessed', signal: 'insufficient_data' } })
    expect(envelope.learning.reasonCodes).toContain('consent_authority_not_bound')
  })

  it('never adds AI/provider metrics to the Google page comparison', async () => {
    const h = harness(); const row = await journey(h)
    await recordManualMeasurement(owner, row.id, { ...baseline, source: 'llm_visibility', metrics: { clicks: 9000, impressions: 10000 } }, h.dependencies)
    await recordManualMeasurement(owner, row.id, { ...followUp, source: 'llm_visibility', metrics: { clicks: 1, impressions: 10000 } }, h.dependencies)
    const assessed = await assessIntervention(owner, row.id, h.dependencies)
    expect(assessed.result).toMatchObject({ sampleSizeBaseline: 100, sampleSizeFollowUp: 120, signal: 'positive_signal' })
    expect(assessed.result.limitations).toContain('non_search_sources_kept_separate')
    const { envelope } = await getIntervention(owner, row.id, h.dependencies)
    expect(envelope.after.measurements).toHaveLength(2)
    expect(envelope.after.measurements.find(group => group.source === 'llm_visibility')).toMatchObject({ status: 'unsupported', baseline: { aggregates: null, sampleSize: null } })
    expect(envelope.confidence.sampleSize).toEqual({ before: 100, after: 120 })
  })

  it('blocks overlapping aggregate windows instead of double-counting them', async () => {
    const h = harness(); const row = await journey(h)
    await recordManualMeasurement(owner, row.id, { ...baseline, windowStart: '2026-08-10T00:00:00.000Z', windowEnd: '2026-08-25T00:00:00.000Z' }, h.dependencies)
    const assessed = await assessIntervention(owner, row.id, h.dependencies)
    expect(assessed.result.signal).toBe('insufficient_data')
    expect(assessed.result.limitations).toContain('measurement_windows_overlap')
    expect((await getIntervention(owner, row.id, h.dependencies)).envelope.after.measurements[0]).toMatchObject({ status: 'blocked', baseline: { aggregates: null, sampleSize: null } })
  })

  it('does not compare different Google properties or collection modes', async () => {
    const h = harness(); const row = await journey(h)
    const rows = await h.repository.listMeasurements(owner, row.id)
    const follow = rows.find(value => value.windowStart.toISOString() === followUp.windowStart)!
    await h.repository.upsertMeasurement({ ...follow, property: 'sc-domain:other.example', origin: 'system_pulled', sourceHash: fingerprint({ source: follow.source, origin: 'system_pulled', windowStart: follow.windowStart, windowEnd: follow.windowEnd, metrics: follow.metrics }) })
    const result = await assessIntervention(owner, row.id, h.dependencies)
    expect(result.result.signal).toBe('insufficient_data')
    expect(result.result.limitations).toContain('multiple_measurement_scopes')
    const exported = await exportInterventionOutcomeDataset(owner, h.dependencies)
    expect(exported.interventions[0]).toMatchObject({ baseline: null, followUp: null })
    expect(JSON.stringify(exported)).not.toContain('sc-domain:other.example')
  })

  it('invalidates the assessment after metric replacement and recovers only after reassessment', async () => {
    const h = harness(); const row = await journey(h)
    const old = (await getIntervention(owner, row.id, h.dependencies)).envelope
    await recordManualMeasurement(owner, row.id, { ...followUp, metrics: { clicks: 1, impressions: 120 } }, h.dependencies)
    const changed = (await getIntervention(owner, row.id, h.dependencies)).envelope
    expect(changed.after.assessment).toMatchObject({ status: 'stale', signal: 'insufficient_data' })
    expect(changed.envelopeFingerprint).not.toBe(old.envelopeFingerprint)
    expect(changed.confidence.limitations).toContain('assessment_stale')
    await assessIntervention(owner, row.id, h.dependencies)
    // Clicks fell while impressions rose; the engine must retain the conflicting signals.
    expect((await getIntervention(owner, row.id, h.dependencies)).envelope.after.assessment).toMatchObject({ status: 'current', signal: 'mixed_signal' })
  })

  it.each(['receipt', 'content', 'page', 'target', 'time', 'revoked', 'unavailable'] as const)('revalidates exact publication authority on every read after %s drift', async scenario => {
    const h = harness(); const row = await journey(h, true)
    const original = await h.dependencies.deliveredPublications.resolveDeliveredPublication!(owner, 30)
    h.dependencies.deliveredPublications.resolveDeliveredPublication = async () => {
      if (scenario === 'revoked') return null
      if (scenario === 'unavailable') throw new Error('private provider information must not leak')
      return { ...original!,
        ...(scenario === 'receipt' ? { receiptFingerprint: 'b'.repeat(64) } : {}),
        ...(scenario === 'content' ? { contentHash: 'd'.repeat(64) } : {}),
        ...(scenario === 'page' ? { publicationUrl: 'https://example.com/other-page' } : {}),
        ...(scenario === 'target' ? { targetId: 999 } : {}),
        ...(scenario === 'time' ? { deliveredAt: new Date('2026-08-31T00:00:00.000Z') } : {}),
      }
    }
    const { envelope } = await getIntervention(owner, row.id, h.dependencies)
    expect(envelope.intervention.publication.binding).toBe(scenario === 'unavailable' ? 'unavailable' : 'stale')
    expect(envelope.after.assessment).toMatchObject({ status: 'stale', signal: 'insufficient_data' })
    expect(envelope.learning.modelTrainingAllowed).toBe(false)
    expect(JSON.stringify(envelope)).not.toContain('private provider information')
  })

  it('fails closed on cross-owner reads and cross-owner child evidence', async () => {
    const h = harness(); const row = await journey(h)
    await expect(getIntervention(999, row.id, h.dependencies)).rejects.toMatchObject({ statusCode: 404, data: { code: 'NOT_FOUND' } })
    expect((await exportInterventionOutcomeDataset(999, h.dependencies)).interventions).toEqual([])
    const children = await h.repository.listMeasurements(owner, row.id)
    h.dependencies.repository = { ...h.repository, listMeasurements: async () => children.map(child => ({ ...child, ownerUserId: 999 })) }
    await expect(getIntervention(owner, row.id, h.dependencies)).rejects.toMatchObject({ statusCode: 409, data: { code: 'INTERVENTION_LINEAGE_MISMATCH' } })
  })

  it('does not keep a result current when an event checksum drifts', async () => {
    const h = harness(); const row = await journey(h)
    const events = await h.repository.listEvents(owner, row.id)
    h.dependencies.repository = { ...h.repository, listEvents: async () => events.map(event => ({ ...event, evidenceFingerprint: 'b'.repeat(64) })) }
    const { envelope } = await getIntervention(owner, row.id, h.dependencies)
    expect(envelope.after.assessment.status).toBe('stale')
    expect(envelope.before.availability).toBe('unknown')
    expect(envelope.confidence.limitations).toContain('event_fingerprint_mismatch')
  })

  it('keeps zero-impression CTR undefined and cannot call zero samples sufficient', async () => {
    const h = harness(); const row = await journey(h)
    for (const input of [baseline, followUp]) await recordManualMeasurement(owner, row.id, { ...input, metrics: { clicks: 0, impressions: 0 }, sampleSize: 0 }, h.dependencies)
    await assessIntervention(owner, row.id, h.dependencies)
    const { envelope } = await getIntervention(owner, row.id, h.dependencies)
    expect(envelope.after.measurements[0]!.baseline.aggregates?.ctr).toBeNull()
    expect(envelope.confidence.sampleSize).toEqual({ before: 0, after: 0 })
    expect(envelope.after.assessment.signal).toBe('insufficient_data')
  })

  it('blocks tampered measurement hashes instead of accepting a stored result', async () => {
    const h = harness(); const row = await journey(h)
    const rows = await h.repository.listMeasurements(owner, row.id)
    h.dependencies.repository = { ...h.repository, listMeasurements: async (): Promise<InterventionMeasurement[]> => rows.map(item => ({ ...item, sourceHash: 'b'.repeat(64) })) }
    const { envelope } = await getIntervention(owner, row.id, h.dependencies)
    expect(envelope.after.measurements[0]!.status).toBe('blocked')
    expect(envelope.after.assessment.status).toBe('stale')
  })
})

describe('intervention evidence input guards', () => {
  it.each([
    { metrics: { clicks: 101, impressions: 100 } }, { metrics: { clicks: 0.5, impressions: 100 } },
    { metrics: { clicks: 10, impressions: 100, ctr: 1.5 } }, { sampleSize: 101 }, { sampleSize: 0.5 },
  ])('rejects impossible counts/rates/sample sizes: %j', async invalid => {
    const h = harness(); const row = await journey(h)
    await expect(recordManualMeasurement(owner, row.id, { ...baseline, ...invalid }, h.dependencies)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('rejects incomplete future windows before persisting evidence', async () => {
    const h = harness(); const row = await journey(h)
    await expect(recordManualMeasurement(owner, row.id, { ...followUp, windowEnd: '2026-09-22T00:00:00.000Z' }, h.dependencies)).rejects.toMatchObject({ statusCode: 422, data: { code: 'FUTURE_MEASUREMENT_WINDOW' } })
    expect(await h.repository.listMeasurements(owner, row.id)).toHaveLength(2)
  })

  it('rejects a manual recrawl time before publication', async () => {
    const h = harness()
    const row = (await registerIntervention(owner, { targetUrl: page, changeSummary: 'time guard', interventionType: 'content_update', idempotencyKey: 'time-guard' }, h.dependencies)).intervention
    await confirmDeploymentManually(owner, row.id, { note: '已由擁有者確認上線' }, h.dependencies)
    await expect(confirmRecrawlManually(owner, row.id, { note: '人工確認的重抓時間', confirmedAt: '2026-08-31T00:00:00.000Z' }, h.dependencies)).rejects.toMatchObject({ statusCode: 422, data: { code: 'RECRAWL_BEFORE_DEPLOYMENT' } })
  })
})
