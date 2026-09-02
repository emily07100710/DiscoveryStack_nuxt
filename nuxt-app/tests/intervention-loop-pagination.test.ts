import { describe, expect, it } from 'vitest'
import { concludeExperiment, createInMemoryInterventionLoopRepository, evaluateRefreshTriggers, exportInterventionOutcomeDataset, listAllInterventions } from '../server/intervention-loop'
import type { EventCreate, InterventionCreate } from '../server/intervention-loop'

const now = new Date('2026-09-01T00:00:00.000Z')
const deployedAt = new Date('2026-01-01T00:00:00.000Z')

function intervention(ownerUserId: number, key: string, experimentId: number | null = null): InterventionCreate {
  return {
    ownerUserId,
    targetUrl: `https://example.com/${key}`,
    normalizedUrl: `https://example.com/${key}`,
    urlHash: `hash-${key}`,
    siteHost: 'example.com',
    briefId: null,
    draftId: null,
    entryId: null,
    targetId: null,
    interventionType: 'content_update',
    changeSummary: `Change ${key}`,
    hypothesis: null,
    expectedImpact: null,
    expectedSnippet: null,
    registrationSource: 'manual',
    status: 'assessed',
    baselineContentHash: null,
    baselineHashSource: null,
    baselineCapturedAt: null,
    deployedAt,
    deployEvidenceLevel: 'strong',
    deployEvidenceSource: 'manual',
    deployedContentHash: null,
    deploymentNote: null,
    recrawlStatus: 'confirmed',
    recrawlConfirmedAt: now,
    recrawlSource: 'manual',
    recrawlLastCrawlTime: null,
    recrawlNote: null,
    recrawlAutoAttempts: 0,
    recrawlLastAutoAttemptAt: null,
    recrawlAutoFailureCount: 0,
    recrawlAutoFailureDay: null,
    recrawlLastReason: null,
    measuredAt: now,
    assessedAt: now,
    cancelledAt: null,
    lastMetricsPullAt: null,
    lastMetricsPullReason: null,
    experimentId,
    experimentGroup: 'treatment',
    idempotencyKey: `key-${key}`,
    inputFingerprint: `fingerprint-${key}`,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

function missingEvent(): EventCreate {
  return { ownerUserId: 1, interventionId: 999, eventType: 'test', fromStatus: null, toStatus: null, evidence: {}, evidenceFingerprint: 'event-fingerprint', occurredAt: now, createdAt: now, updatedAt: now }
}

describe('intervention loop pagination', () => {
  it('walks every owner intervention past 200 for export, expiry, and experiment conclusion', async () => {
    const repository = createInMemoryInterventionLoopRepository()
    const dependencies = { repository, clock: { now: () => now } }
    const experiment = await repository.createExperiment({ ownerUserId: 1, name: 'All interventions', design: 'pre_post', hypothesis: null, status: 'running', primaryMetric: 'clicks', startedAt: now, concludedAt: null, idempotencyKey: 'all-interventions', createdAt: now, updatedAt: now })
    const ownerRows = []
    for (let index = 1; index <= 201; index += 1) ownerRows.push(await repository.createIntervention(intervention(1, String(index), experiment.id)))
    await repository.createIntervention(intervention(2, 'other-owner'))
    for (const row of ownerRows) {
      await repository.createResult({ ownerUserId: 1, experimentId: experiment.id, interventionId: row.id, resultKind: 'pre_post', metric: 'clicksPerDay', sampleSizeBaseline: 30, sampleSizeFollowUp: 30, effect: { deltas: { clicksPerDay: 0.1 } }, signal: 'positive_signal', limitations: [], causalStatement: 'pre-post', computedAt: now, resultFingerprint: String(row.id).padStart(64, '0'), createdAt: now, updatedAt: now })
    }

    const paged = await listAllInterventions(repository, 1, { pageSize: 200 })
    expect(paged).toHaveLength(201)
    expect(paged.map(row => row.id)).toEqual(ownerRows.map(row => row.id))
    expect(paged.some(row => row.ownerUserId === 2)).toBe(false)

    const dataset = await exportInterventionOutcomeDataset(1, dependencies)
    expect(dataset.counts.interventions).toBe(201)
    expect(dataset.interventions.map(row => row.id)).toContain(ownerRows[200]!.id)

    const refresh = await evaluateRefreshTriggers(1, dependencies, { now: new Date('2026-04-01T00:00:00.000Z') })
    expect(refresh.enqueued).toHaveLength(201)
    expect(refresh.enqueued.map(row => row.interventionId)).toContain(ownerRows[200]!.id)

    const concluded = await concludeExperiment(1, experiment.id, dependencies)
    expect(concluded.result.effect).toMatchObject({ interventions: 201 })
  })

  it('returns the Drizzle-aligned 404 NOT_FOUND error for an event with no owned intervention', async () => {
    const repository = createInMemoryInterventionLoopRepository()
    await expect(repository.appendEvent(missingEvent())).rejects.toMatchObject({ statusCode: 404, data: { code: 'NOT_FOUND' } })
  })
})
