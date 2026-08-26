import { describe, expect, it } from 'vitest'
import { buildMeasurementWindow } from '../server/measurement-collection/normalization'
import { createMeasurementConnection, parseMeasurementConnectionInput, retryMeasurementRun, revokeMeasurementConnection, scheduleMeasurementForEntry } from '../server/measurement-collection/service'
import type { MeasurementConnectionRow, MeasurementRepository, MeasurementRunRow } from '../server/measurement-collection/types'

const ownerUserId = 10
const connectionBase = { id: 1, ownerUserId, clientId: 20, source: 'google_search_console', status: 'configured', credentialReference: null, googleSearchConsoleProperty: 'https://client.acme.taipei', ga4PropertyId: null, llmVisibilityProjectId: null, canonicalOrigin: 'https://client.acme.taipei', timeZone: 'Asia/Taipei', allowedPageScope: ['https://client.acme.taipei/articles/a'], sourceAvailabilityLagDays: 2, providerTargets: null, idempotencyKey: 'connection-idempotency', configurationFingerprint: '1'.repeat(64), connectedAt: null, revokedAt: null, createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: new Date('2026-08-01T00:00:00.000Z') } as unknown as MeasurementConnectionRow

function delivered() {
  return {
    entry: { id: 30, ownerUserId, calendarId: 1, productionDeliverableId: 2, strategyRecommendationId: 3, jobId: 4, draftId: 5, reviewId: 6, scheduleKey: 'schedule-a', plannedLocalDate: '2026-08-01', publishLocalTime: '09:00', timeZone: 'Asia/Taipei', contentType: 'article', language: 'zh-hant', topicCluster: 'topic-a', evidenceSnapshotHash: 'd'.repeat(64), contentHash: 'c'.repeat(64), publicationTargetId: 55, publicationSlug: 'a', publicationPath: '/articles/a', publicationIdentityFingerprint: 'i'.repeat(64), status: 'delivered', engineEntryId: 'engine-a', idempotencyKey: 'entry-key', updatedAt: new Date('2026-08-01T01:00:00.000Z') },
    calendar: { id: 1, ownerUserId, clientId: 20, productionPlanId: 7, timeZone: 'Asia/Taipei' },
    deliverable: { id: 2, ownerUserId, planId: 7, selectionId: 8, contentType: 'article', title: 'Title', audience: 'Audience', language: 'zh-hant', evidenceSnapshotHash: 'd'.repeat(64), opportunityKey: '3:topic-a', provenance: {} },
    job: { id: 4, ownerUserId, productionPlanId: 7, productionDeliverableId: 2, strategyRecommendationId: 3, evidenceSnapshotHash: 'd'.repeat(64), briefId: 9 },
    draft: { id: 5, jobId: 4, version: 1, contentHash: 'c'.repeat(64), evidenceRefs: [], safetyStatus: 'passed' },
    review: { id: 6, jobId: 4, draftId: 5, reviewerUserId: ownerUserId, decision: 'approved_for_delivery', evidenceSnapshotHash: 'd'.repeat(64) },
    riskGate: { id: 10, draftId: 5, status: 'passed', evidenceSnapshotHash: 'd'.repeat(64) },
    publicationRun: { id: 11, ownerUserId, entryId: 30, stage: 'publication', state: 'succeeded', completedAt: new Date('2026-08-01T01:00:00.000Z') },
    publicationTarget: { id: 55, targetOrigin: 'https://client.acme.taipei' },
    publicationAttempt: { id: 12, ownerUserId, entryId: 30, runId: 11, targetId: 55, status: 'delivered', receiptFingerprint: 'a'.repeat(64), publicationUrl: 'https://client.acme.taipei/articles/a', contentHash: 'c'.repeat(64), evidenceSnapshotHash: 'd'.repeat(64) },
  }
}

function fakeRepository(connections: MeasurementConnectionRow[] = [connectionBase]): MeasurementRepository {
  const runs = new Map<string, MeasurementRunRow>()
  let id = 100
  const repository = {
    async listConnections() { return connections },
    async listRuns() { return [...runs.values()] },
    async findRunByIdempotency(_owner: number, key: string) { return [...runs.values()].find(run => run.idempotencyKey === key) || null },
    async insertRun(input: any) { const row = { ...input, id: ++id, createdAt: new Date(), updatedAt: new Date() } as MeasurementRunRow; runs.set(row.idempotencyKey, row); return row },
    async findRun(_owner: number, runId: number) { return [...runs.values()].find(run => run.id === runId) || null },
    async updateRun(_owner: number, runId: number, patch: any) { const row = [...runs.values()].find(candidate => candidate.id === runId)!; Object.assign(row, patch); return row },
  } as unknown as MeasurementRepository
  return repository
}

const contentRepository = { async resolveDeliveredPublication() { return delivered() } } as any

describe('measurement windows and scheduling', () => {
  it.each([7, 15, 30, 60, 90] as const)('creates a non-overlapping baseline/follow-up pair for %s days', checkpoint => {
    const publishedAt = new Date('2026-08-01T01:23:45.000Z')
    const window = buildMeasurementWindow('2026-08-01', 'Asia/Taipei', checkpoint, 2, new Date('2026-08-02T00:00:00.000Z'), publishedAt)
    expect(window.baselineEnd.getTime()).toBe(window.followUpStart.getTime())
    expect(window.baselineEnd.getTime() - window.baselineStart.getTime()).toBe(checkpoint * 86_400_000)
    expect(window.followUpEnd.getTime() - window.followUpStart.getTime()).toBe(checkpoint * 86_400_000)
    expect(window.dueAt.getTime()).toBeGreaterThan(window.followUpEnd.getTime())
  })

  it('respects a timezone boundary around a daylight-saving transition', () => {
    const window = buildMeasurementWindow('2026-03-08', 'America/New_York', 7, 0, new Date('2026-03-09T00:00:00.000Z'))
    expect(window.baselineEnd.toISOString()).toBe(window.followUpStart.toISOString())
    expect(window.followUpEnd.getTime() - window.followUpStart.getTime()).toBeGreaterThan(6 * 86_400_000)
  })

  it('creates exactly five checkpoint runs and replays them idempotently', async () => {
    const repository = fakeRepository()
    const first = await scheduleMeasurementForEntry(ownerUserId, 30, { repository, contentOperations: contentRepository, now: new Date('2026-08-10T00:00:00.000Z') })
    const second = await scheduleMeasurementForEntry(ownerUserId, 30, { repository, contentOperations: contentRepository, now: new Date('2026-08-10T00:00:00.000Z') })
    expect(first.scheduled).toBe(5)
    expect(second.scheduled).toBe(5)
    expect([...new Set(first.runs.map(run => run.checkpointDays))].sort((left, right) => left - right)).toEqual([7, 15, 30, 60, 90])
  })

  it('schedules target-bound windows for every delivered site without mixing receipts', async () => {
    const primary = delivered()
    const secondTarget = { ...primary.publicationTarget, id: 56, ownerUserId, clientId: 20, targetOrigin: 'https://second.acme.taipei' }
    const secondAttempt = { ...primary.publicationAttempt, id: 13, runId: 14, targetId: 56, receiptFingerprint: 'b'.repeat(64), publicationUrl: 'https://second.acme.taipei/articles/a' }
    const secondRun = { ...primary.publicationRun, id: 14, completedAt: new Date('2026-08-01T02:00:00.000Z') }
    const connections = [
      { ...connectionBase, publicationTargetId: 55, websiteIdentity: 'target:55' },
      { ...connectionBase, id: 2, publicationTargetId: 56, websiteIdentity: 'target:56', canonicalOrigin: 'https://second.acme.taipei', allowedPageScope: ['https://second.acme.taipei/articles/a'], googleSearchConsoleProperty: 'https://second.acme.taipei', idempotencyKey: 'connection-second', configurationFingerprint: '2'.repeat(64) },
    ] as MeasurementConnectionRow[]
    const contentOperations = {
      async resolveDeliveredPublication() { return primary },
      async listEntryTargetBindings() { return [{ ownerUserId, clientId: 20, entryId: 30, targetId: 55, slot: 1 }, { ownerUserId, clientId: 20, entryId: 30, targetId: 56, slot: 2 }] },
      async listPublicationTargets() { return [{ ...primary.publicationTarget, ownerUserId, clientId: 20 }, secondTarget] },
      async listPublicationAttempts() { return [primary.publicationAttempt, secondAttempt] },
      async listRuns() { return [primary.publicationRun, secondRun] },
    } as any
    const result = await scheduleMeasurementForEntry(ownerUserId, 30, { repository: fakeRepository(connections), contentOperations, now: new Date('2026-08-10T00:00:00.000Z') })
    expect(result.targetIds).toEqual([55, 56])
    expect(result.scheduled).toBe(10)
    expect(new Set(result.runs.map(run => run.targetId))).toEqual(new Set([55, 56]))
    expect(result.runs.filter(run => run.targetId === 56).every(run => run.publicationReceiptFingerprint === 'b'.repeat(64))).toBe(true)
  })

  it('does not create new runs for a revoked connection', async () => {
    const revoked = { ...connectionBase, status: 'revoked' } as MeasurementConnectionRow
    const result = await scheduleMeasurementForEntry(ownerUserId, 30, { repository: fakeRepository([revoked]), contentOperations: contentRepository })
    expect(result.scheduled).toBe(0)
  })

  it('rejects raw credentials, headers, and malformed provider targets at the connection boundary', () => {
    const base = { clientId: 20, source: 'google_search_console', googleSearchConsoleProperty: 'https://client.acme.taipei', canonicalOrigin: 'https://client.acme.taipei', timeZone: 'Asia/Taipei', allowedPageScope: ['https://client.acme.taipei/articles/a'], idempotencyKey: 'connection-key' }
    expect(() => parseMeasurementConnectionInput({ ...base, accessToken: 'raw-token' })).toThrowError()
    expect(() => parseMeasurementConnectionInput({ ...base, credentialReference: 'Bearer raw-token' })).toThrowError()
    expect(() => parseMeasurementConnectionInput({ ...base, providerTargets: [{ provider: 'chatgpt', modelLabel: 'model', adapterKey: 'adapter', allowedLocales: ['zh-hant'], headers: { authorization: 'raw-token' } }] })).toThrowError()
  })

  it('does not retry succeeded runs and enforces the bounded retry budget', async () => {
    const repository = { findRun: async () => ({ id: 1, state: 'succeeded', attemptNumber: 1 } as any), updateRun: async () => { throw new Error('must not update') } } as unknown as MeasurementRepository
    await expect(retryMeasurementRun(ownerUserId, 1, { repository })).rejects.toMatchObject({ statusCode: 409 })
    const exhausted = { findRun: async () => ({ id: 2, state: 'failed', attemptNumber: 3 } as any), updateRun: async () => { throw new Error('must not update') } } as unknown as MeasurementRepository
    await expect(retryMeasurementRun(ownerUserId, 2, { repository: exhausted })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('releases a revoked website/source slot and permits an immutable replacement row', async () => {
    const revoked = { ...connectionBase, activeSource: null, status: 'revoked', websiteIdentity: 'target:55', publicationTargetId: 55 } as MeasurementConnectionRow
    let inserted: any = null
    const repository = {
      async findClient() { return { id: 20, ownerUserId, canonicalSiteOrigin: 'https://client.acme.taipei', timeZone: 'Asia/Taipei' } },
      async findConnectionByIdempotency() { return null },
      async listConnections() { return [revoked] },
      async insertConnection(input: any) { inserted = { ...input, id: 2, createdAt: new Date(), updatedAt: new Date() }; return inserted },
      async findConnection() { return inserted || revoked },
      async updateConnection(_owner: number, _id: number, patch: any) { return { ...(inserted || revoked), ...patch } },
    } as unknown as MeasurementRepository
    const contentOperations = { async findPublicationTarget() { return { id: 55, ownerUserId, clientId: 20, targetOrigin: 'https://client.acme.taipei', status: 'active' } } } as any
    const input = { clientId: 20, publicationTargetId: 55, source: 'google_search_console', googleSearchConsoleProperty: 'https://client.acme.taipei', canonicalOrigin: 'https://client.acme.taipei', timeZone: 'Asia/Taipei', allowedPageScope: ['https://client.acme.taipei/articles/a'], idempotencyKey: 'replacement-key' }
    const result = await createMeasurementConnection(ownerUserId, input, { repository, contentOperations })
    expect(result.replayed).toBe(false)
    expect(result.connection).toMatchObject({ publicationTargetId: 55, websiteIdentity: 'target:55', activeSource: 'google_search_console', status: 'configured' })
    const revokedReplacement = await revokeMeasurementConnection(ownerUserId, 2, { repository, contentOperations, now: new Date('2026-08-20T00:00:00.000Z') })
    expect(revokedReplacement).toMatchObject({ status: 'revoked', activeSource: null })
  })
})
