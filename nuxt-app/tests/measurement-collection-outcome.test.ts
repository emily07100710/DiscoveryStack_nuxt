import { describe, expect, it } from 'vitest'
import { processMeasurementRun } from '../server/measurement-collection/service'
import type { MeasurementConnectionRow, MeasurementRepository, MeasurementRunRow, MeasurementSnapshotRow } from '../server/measurement-collection/types'

const ownerUserId = 10
const canonicalPage = 'https://client.example.com/articles/a'
const contentHash = 'c'.repeat(64)
const evidenceHash = 'd'.repeat(64)
const receiptHash = 'a'.repeat(64)

function delivered() {
  return {
    entry: { id: 30, ownerUserId, calendarId: 1, productionDeliverableId: 2, strategyRecommendationId: 3, jobId: 4, draftId: 5, reviewId: 6, scheduleKey: 'schedule-a', plannedLocalDate: '2026-08-01', publishLocalTime: '09:00', timeZone: 'Asia/Taipei', contentType: 'article', language: 'zh-hant', topicCluster: 'topic-a', evidenceSnapshotHash: evidenceHash, contentHash, publicationTargetId: 55, publicationSlug: 'a', publicationPath: '/articles/a', publicationIdentityFingerprint: 'i'.repeat(64), status: 'delivered', engineEntryId: 'engine-a', idempotencyKey: 'entry-key', updatedAt: new Date('2026-08-01T01:00:00.000Z') },
    calendar: { id: 1, ownerUserId, clientId: 20, productionPlanId: 7, timeZone: 'Asia/Taipei' },
    deliverable: { id: 2, ownerUserId, planId: 7, selectionId: 8, contentType: 'article', title: 'Title', audience: 'Audience', language: 'zh-hant', evidenceSnapshotHash: evidenceHash, opportunityKey: '3:topic-a', provenance: {} },
    job: { id: 4, ownerUserId, productionPlanId: 7, productionDeliverableId: 2, strategyRecommendationId: 3, evidenceSnapshotHash: evidenceHash, briefId: 9 },
    draft: { id: 5, jobId: 4, version: 1, contentHash, evidenceRefs: [], safetyStatus: 'passed' },
    review: { id: 6, jobId: 4, draftId: 5, reviewerUserId: ownerUserId, decision: 'approved_for_delivery', evidenceSnapshotHash: evidenceHash },
    riskGate: { id: 10, draftId: 5, status: 'passed', evidenceSnapshotHash: evidenceHash },
    publicationRun: { id: 11, ownerUserId, entryId: 30, stage: 'publication', state: 'succeeded', completedAt: new Date('2026-08-01T01:00:00.000Z') },
    publicationTarget: { id: 55, targetOrigin: 'https://client.example.com' },
    publicationAttempt: { id: 12, ownerUserId, entryId: 30, runId: 11, targetId: 55, status: 'delivered', receiptFingerprint: receiptHash, publicationUrl: canonicalPage, contentHash, evidenceSnapshotHash: evidenceHash },
  }
}

function run(source: 'google_search_console' | 'llm_visibility'): MeasurementRunRow {
  return { id: source === 'google_search_console' ? 100 : 101, ownerUserId, clientId: 20, connectionId: source === 'google_search_console' ? 1 : 2, entryId: 30, targetId: 55, source, checkpointDays: 7, publicationReceiptFingerprint: receiptHash, canonicalPage, contentHash, evidenceSnapshotHash: evidenceHash, publicationLocalDate: '2026-08-01', timeZone: 'Asia/Taipei', baselineWindowStart: new Date('2026-07-25T00:00:00.000Z'), baselineWindowEnd: new Date('2026-08-01T01:00:00.000Z'), followUpWindowStart: new Date('2026-08-01T01:00:00.000Z'), followUpWindowEnd: new Date('2026-08-08T01:00:00.000Z'), dueAt: new Date('2026-08-10T00:00:00.000Z'), state: 'queued', attemptNumber: 0, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, idempotencyKey: `run-${source}`, inputFingerprint: 'e'.repeat(64), outputFingerprint: null, errorCode: null, errorSummary: null, startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() }
}

function connection(source: 'google_search_console' | 'llm_visibility'): MeasurementConnectionRow {
  return { id: source === 'google_search_console' ? 1 : 2, ownerUserId, clientId: 20, source, status: 'configured', credentialReference: source === 'google_search_console' ? 'secret-manager:google-readonly' : null, googleSearchConsoleProperty: source === 'google_search_console' ? 'https://client.example.com' : null, ga4PropertyId: null, llmVisibilityProjectId: source === 'llm_visibility' ? 77 : null, canonicalOrigin: 'https://client.example.com', timeZone: 'Asia/Taipei', allowedPageScope: [canonicalPage], sourceAvailabilityLagDays: 2, providerTargets: source === 'llm_visibility' ? [{ provider: 'chatgpt', modelLabel: 'synthetic', adapterKey: 'synthetic', allowedLocales: ['zh-hant'], maximumResponseBytes: 120000, timeoutMs: 30000 }] : null, idempotencyKey: `connection-${source}`, configurationFingerprint: `${source === 'google_search_console' ? '1' : '2'}`.repeat(64).slice(0, 64), connectedAt: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date() } as unknown as MeasurementConnectionRow
}

function contentRepository(outcomes: any[]) {
  const publication = delivered()
  let inserted: any = null
  const repository = {
    async resolveDeliveredPublication() { return publication },
    async resolveCanonicalContext() { return { evidenceSnapshot: { hash: evidenceHash, refs: [{ sourceId: 1 }] }, deliverable: { id: 2 }, strategy: { id: 3 }, opportunity: { key: 'topic-a' }, rules: [{ id: 'rule-1' }] } },
    async findOutcomeByIdempotency() { return null },
    async transaction(work: any) { return work(repository) },
    async insertOutcome(input: any) { inserted = { ...input, id: 900, createdAt: new Date() }; outcomes.push(inserted); return inserted },
    async appendEvent(input: any) { return { ...input, id: 901, occurredAt: new Date() } },
  }
  return { repository: repository as any, getInserted: () => inserted }
}

function measurementRepository(current: MeasurementRunRow, currentConnection: MeasurementConnectionRow) {
  const snapshots: MeasurementSnapshotRow[] = []
  const repository = {
    async findRun(_owner: number, id: number) { return id === current.id ? current : null },
    async findConnection(_owner: number, id: number) { return id === currentConnection.id ? currentConnection : null },
    async updateConnection(_owner: number, id: number, patch: any) { if (id === currentConnection.id) Object.assign(currentConnection, patch); return currentConnection },
    async acquireRunLease() { current.state = 'processing'; current.attemptNumber = 1; return current },
    async releaseRunLease(_owner: number, _id: number, _lease: string, state: any, _now: Date, patch: any) { current.state = state; current.errorCode = patch?.errorCode || null; current.outputFingerprint = patch?.outputFingerprint || null; return current },
    async listRuns() { return [current] },
    async listSnapshots() { return snapshots },
    async findSnapshot(_owner: number, _runId: number, phase: any) { return snapshots.find(snapshot => snapshot.phase === phase) || null },
    async insertSnapshot(input: any) { const row = { ...input, id: snapshots.length + 1, createdAt: new Date() } as MeasurementSnapshotRow; snapshots.push(row); return row },
    async listLlmScope() { return { project: { id: 77, ownerUserId, canonicalDomain: 'client.example.com', brandName: 'Client', brandAliases: [], competitorBrands: [], locale: 'zh-hant', status: 'active' }, queries: [{ id: 88, ownerUserId, projectId: 77, promptText: 'Which product?', promptHash: 'p'.repeat(64), intent: 'commercial', locale: 'zh-hant', active: true }] } },
  }
  return { repository: repository as unknown as MeasurementRepository, snapshots }
}

describe('measurement outcome integration', () => {
  it('calls the existing recordOwnerOutcomeAssessment chain and persists a one-source partial outcome without learning admission', async () => {
    const current = run('google_search_console')
    const outcomes: any[] = []
    const content = contentRepository(outcomes)
    const measurement = measurementRepository(current, connection('google_search_console'))
    const result = await processMeasurementRun(ownerUserId, current.id, { repository: measurement.repository, contentOperations: content.repository, googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }), fetcher: async () => new Response(JSON.stringify({ rows: [{ keys: [canonicalPage], clicks: 10, impressions: 100, position: 4 }] }), { status: 200 }), now: new Date('2026-12-01T00:00:00.000Z') })
    expect(result.run.state).toBe('succeeded')
    expect(result.assessment).toMatchObject({ assessment: { status: 'partial', validSourceCount: 1 }, learningCandidate: null })
    expect((result as any).learningCandidate).toBeUndefined()
    expect(outcomes).toHaveLength(1)
    expect(content.getInserted()).toMatchObject({ assessmentStatus: 'partial', baselineSnapshot: [{ source: 'google_search_console' }], followUpSnapshot: [{ source: 'google_search_console' }] })
  })

  it('persists provider API observations as secondary-only snapshots and sends no LLM row into the primary outcome payload', async () => {
    const current = run('llm_visibility')
    const outcomes: any[] = []
    const content = contentRepository(outcomes)
    const measurement = measurementRepository(current, connection('llm_visibility'))
    const candidate = { probeId: 'probe-1', requestFingerprint: 'a'.repeat(64), provider: 'chatgpt', modelLabel: 'synthetic', brandMentioned: true, citationUrls: ['https://client.example.com/articles/a'] }
    const result = await processMeasurementRun(ownerUserId, current.id, { repository: measurement.repository, contentOperations: content.repository, runProviderObservation: async () => ({ ownerScopeKey: `visibility-owner:${ownerUserId}`, plan: {} as any, runtime: { batch: { status: 'completed', results: [{ status: 'completed', candidate }], counts: { completed: 1, blocked: 0, failed: 0, retryable: 0 } }, persisted: [], persistenceFailures: [] } }) as any, now: new Date('2026-12-01T00:00:00.000Z') })
    expect(result.run.state).toBe('succeeded')
    expect(measurement.snapshots).toHaveLength(2)
    expect(measurement.snapshots.every(snapshot => (snapshot.providerProvenance as any).observationMode === 'provider_api_observation')).toBe(true)
    expect(measurement.snapshots.every(snapshot => (snapshot.providerProvenance as any).verifiedByOwner === false)).toBe(true)
    expect(content.getInserted()).toMatchObject({ assessmentStatus: 'insufficient_data', baselineSnapshot: [], followUpSnapshot: [] })
  })
})
