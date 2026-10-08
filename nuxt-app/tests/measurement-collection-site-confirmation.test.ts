import { describe, expect, it } from 'vitest'
import { recordSitePublicationMeasurementAssessment } from '../server/measurement-collection/site-assessment'
import { dryRunMeasurementForEntry, processMeasurementRun, scheduleMeasurementForEntry } from '../server/measurement-collection/service'
import { measurementInputFingerprint, measurementScopeFingerprint } from '../server/measurement-collection/normalization'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { SiteConfirmationMeasurementPublicationLineage, MeasurementConnectionRow, MeasurementRepository, MeasurementRunRow, MeasurementSnapshotRow } from '../server/measurement-collection/types'

const ownerUserId = 10
const now = new Date('2026-08-10T00:00:00.000Z')
const page = 'https://client.acme.taipei/articles/confirmed'

function siteLineage(targetId = 55, confirmationFingerprint = String(targetId).padStart(64, 'a')): SiteConfirmationMeasurementPublicationLineage {
  return { evidenceKind: 'site_publication_confirmation', ownerUserId, entryId: 30, targetId, clientId: 20, canonicalPage: page,
    publicationReceiptFingerprint: confirmationFingerprint, confirmationFingerprint, contentHash: 'c'.repeat(64), evidenceSnapshotHash: 'd'.repeat(64),
    publicationLocalDate: '2026-08-01', timeZone: 'Asia/Taipei', publishedAt: new Date('2026-08-01T01:00:00.000Z'), calendarId: 1,
    draftId: 5, draftVersion: 2, jobId: 4, productionPlanId: 7, scheduleKey: 'schedule-site-30', language: 'zh-hant', contentType: 'article',
    appliedRuleIds: ['rule-a'], topicClusterCode: 'topic-a' }
}

function connection(targetId = 55): MeasurementConnectionRow {
  return { id: targetId - 54, ownerUserId, clientId: 20, source: 'google_search_console', status: 'configured', credentialReference: 'secret-manager:fixture',
    googleSearchConsoleProperty: 'https://client.acme.taipei', ga4PropertyId: null, llmVisibilityProjectId: null, canonicalOrigin: 'https://client.acme.taipei',
    timeZone: 'Asia/Taipei', allowedPageScope: [page], sourceAvailabilityLagDays: 0, providerTargets: null, idempotencyKey: `connection-${targetId}`,
    configurationFingerprint: `${targetId}`.repeat(64).slice(0, 64), connectedAt: now, revokedAt: null, createdAt: now, updatedAt: now,
    publicationTargetId: targetId } as MeasurementConnectionRow
}

function queuedRun(lineage = siteLineage(), selectedConnection = connection(lineage.targetId)): MeasurementRunRow {
  const baselineWindowStart = new Date('2026-07-25T01:00:00.000Z'), followUpWindowEnd = new Date('2026-08-08T01:00:00.000Z')
  const scopeFingerprint = measurementScopeFingerprint({ ownerUserId, clientId: lineage.clientId, websiteOrigin: selectedConnection.canonicalOrigin,
    entryId: lineage.entryId, targetId: lineage.targetId, canonicalPage: lineage.canonicalPage, source: 'google_search_console', checkpointDays: 7 })
  const inputFingerprint = measurementInputFingerprint({ ownerUserId, connectionId: selectedConnection.id, entryId: lineage.entryId, targetId: lineage.targetId,
    source: 'google_search_console', checkpointDays: 7, publicationReceiptFingerprint: lineage.confirmationFingerprint, canonicalPage: lineage.canonicalPage,
    contentHash: lineage.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, scopeFingerprint,
    baselineStart: baselineWindowStart.toISOString(), baselineEnd: lineage.publishedAt.toISOString(), followUpStart: lineage.publishedAt.toISOString(),
    followUpEnd: followUpWindowEnd.toISOString(), dueAt: now.toISOString(), evidenceKind: lineage.evidenceKind,
    confirmationFingerprint: lineage.confirmationFingerprint, draftId: lineage.draftId, draftVersion: lineage.draftVersion,
    connectionConfigurationFingerprint: selectedConnection.configurationFingerprint })
  return { id: 101, ownerUserId, clientId: lineage.clientId, connectionId: selectedConnection.id, entryId: lineage.entryId, targetId: lineage.targetId,
    source: 'google_search_console', checkpointDays: 7, publicationReceiptFingerprint: lineage.confirmationFingerprint, canonicalPage: lineage.canonicalPage,
    contentHash: lineage.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, publicationLocalDate: lineage.publicationLocalDate, timeZone: lineage.timeZone,
    baselineWindowStart, baselineWindowEnd: lineage.publishedAt, followUpWindowStart: lineage.publishedAt,
    followUpWindowEnd, dueAt: now, state: 'queued', attemptNumber: 0, leaseOwner: null, leaseExpiresAt: null,
    retryEligibleAt: null, idempotencyKey: `site-measurement-run:${'e'.repeat(64)}`, inputFingerprint, outputFingerprint: null,
    errorCode: null, errorSummary: null, startedAt: null, completedAt: null, createdAt: now, updatedAt: now }
}

function measurementRepository(connections = [connection()]) {
  const runs: MeasurementRunRow[] = []
  const snapshots: MeasurementSnapshotRow[] = []
  const repository = {
    async listConnections() { return connections },
    async listRuns() { return runs },
    async findRunByIdempotency(_owner: number, key: string) { return runs.find(run => run.idempotencyKey === key) || null },
    async insertRun(input: Omit<MeasurementRunRow, 'id' | 'createdAt' | 'updatedAt'>) { const row = { ...input, id: runs.length + 101, createdAt: now, updatedAt: now } as MeasurementRunRow; runs.push(row); return row },
    async findRun(_owner: number, id: number) { return runs.find(run => run.id === id) || null },
    async acquireRunLease(_owner: number, id: number) { const row = runs.find(run => run.id === id); if (!row) return null; Object.assign(row, { state: 'processing', attemptNumber: row.attemptNumber + 1, leaseOwner: 'worker' }); return row },
    async releaseRunLease(_owner: number, id: number, _lease: string, state: MeasurementRunRow['state'], _at: Date, patch = {}) { const row = runs.find(run => run.id === id); if (!row) return null; Object.assign(row, { state, leaseOwner: null }, patch); return row },
    async findConnection(_owner: number, id: number) { return connections.find(row => row.id === id) || null },
    async updateConnection(_owner: number, id: number, patch: Partial<MeasurementConnectionRow>) { const row = connections.find(value => value.id === id)!; Object.assign(row, patch); return row },
    async findSnapshot(_owner: number, runId: number, phase: 'baseline' | 'follow_up') { return snapshots.find(row => row.runId === runId && row.phase === phase) || null },
    async listSnapshots(_owner: number, runId?: number) { return snapshots.filter(row => runId === undefined || row.runId === runId) },
    async insertSnapshot(input: Omit<MeasurementSnapshotRow, 'id' | 'createdAt'>) { const row = { ...input, id: snapshots.length + 1, createdAt: now } as MeasurementSnapshotRow; snapshots.push(row); return row },
    snapshots, runs,
  }
  return repository as unknown as MeasurementRepository & { snapshots: MeasurementSnapshotRow[]; runs: MeasurementRunRow[] }
}

function contentOperations() {
  return { async resolveDeliveredPublication() { return null } } as unknown as ContentOperationsRepository
}

describe('site publication confirmation measurement lineage', () => {
  it('schedules target-specific runs from cached owner confirmations without signed status reads', async () => {
    const first = siteLineage(55, '1'.repeat(64)), second = siteLineage(56, '2'.repeat(64))
    const repo = measurementRepository([connection(55), connection(56)])
    const calls: boolean[] = []
    const dependencies = { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages(_owner: number, _entry: number, options: { fresh: boolean }) { calls.push(options.fresh); return [first, second] } }
    const preview = await dryRunMeasurementForEntry(ownerUserId, 30, dependencies)
    expect(preview.planned).toHaveLength(10)
    expect(new Set(preview.planned.map(item => item.evidenceKind))).toEqual(new Set(['site_publication_confirmation']))
    const scheduled = await scheduleMeasurementForEntry(ownerUserId, 30, dependencies)
    expect(scheduled.scheduled).toBe(10)
    expect(new Set(scheduled.runs.map(run => run.targetId))).toEqual(new Set([55, 56]))
    expect(scheduled.runs.every(run => run.idempotencyKey.startsWith('site-measurement-run:'))).toBe(true)
    expect(scheduled.runs.filter(run => run.targetId === 55).every(run => run.publicationReceiptFingerprint === first.confirmationFingerprint)).toBe(true)
    expect(scheduled.runs.filter(run => run.targetId === 56).every(run => run.publicationReceiptFingerprint === second.confirmationFingerprint)).toBe(true)
    expect(calls).toEqual([false, false])
  })

  it('does not use production resolver fallback when a test or caller injects a content repository without the site resolver', async () => {
    await expect(scheduleMeasurementForEntry(ownerUserId, 30, { repository: measurementRepository(), contentOperations: contentOperations(), now }))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('rechecks before/after provider work and persists no phase snapshot if the connection is revoked during the await', async () => {
    const lineage = siteLineage(), selectedConnection = connection(), run = queuedRun(lineage, selectedConnection), repo = measurementRepository([selectedConnection])
    repo.runs.push(run)
    const calls: boolean[] = []
    let providerCalls = 0
    const result = await processMeasurementRun(ownerUserId, run.id, { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages(_owner: number, _entry: number, options: { fresh: boolean }) { calls.push(options.fresh); return [lineage] },
      googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      async fetcher() { providerCalls += 1; selectedConnection.status = 'revoked'; return new Response(JSON.stringify({ rows: [{ keys: [page], clicks: 2, impressions: 20, position: 3 }] }), { status: 200 }) },
    })
    expect(providerCalls).toBe(1)
    expect(calls).toEqual([true, true, true])
    expect(result.run.state).toBe('blocked')
    expect(result.run.errorCode).toBe('STALE_SITE_PUBLICATION_CONFIRMATION')
    expect(repo.snapshots).toHaveLength(0)
  })

  it('does not persist a provider result when the confirmed public version changes during the provider await', async () => {
    const lineage = siteLineage(), selectedConnection = connection(), run = queuedRun(lineage, selectedConnection), repo = measurementRepository([selectedConnection])
    repo.runs.push(run)
    let freshChecks = 0
    const result = await processMeasurementRun(ownerUserId, run.id, { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages(_owner: number, _entry: number, options: { fresh: boolean }) {
        expect(options.fresh).toBe(true)
        freshChecks += 1
        return freshChecks === 3 ? [] : [lineage]
      },
      googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      async fetcher() { return new Response(JSON.stringify({ rows: [{ keys: [page], clicks: 2, impressions: 20, position: 3 }] }), { status: 200 }) },
    })
    expect(freshChecks).toBe(3)
    expect(result.run.state).toBe('blocked')
    expect(result.run.errorCode).toBe('STALE_SITE_PUBLICATION_CONFIRMATION')
    expect(repo.snapshots).toHaveLength(0)
  })

  it('never revives a site measurement connection revoked while snapshot persistence awaited', async () => {
    const lineage = siteLineage(), selectedConnection = connection(), run = queuedRun(lineage, selectedConnection), repo = measurementRepository([selectedConnection])
    selectedConnection.connectedAt = null
    repo.runs.push(run)
    const insertSnapshot = repo.insertSnapshot.bind(repo)
    repo.insertSnapshot = async input => {
      const inserted = await insertSnapshot(input)
      if (repo.snapshots.length === 2) selectedConnection.status = 'revoked'
      return inserted
    }
    const result = await processMeasurementRun(ownerUserId, run.id, { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages() { return [lineage] },
      googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      async fetcher() { return new Response(JSON.stringify({ rows: [{ keys: [page], clicks: 2, impressions: 20, position: 3 }] }), { status: 200 }) },
    })
    expect(selectedConnection.status).toBe('revoked')
    expect(result.run.state).toBe('blocked')
  })

  it('does not overwrite a connection paused while a provider reports reauthorization required', async () => {
    const lineage = siteLineage(), selectedConnection = connection(), run = queuedRun(lineage, selectedConnection), repo = measurementRepository([selectedConnection])
    repo.runs.push(run)
    const result = await processMeasurementRun(ownerUserId, run.id, { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages() { return [lineage] },
      googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      async fetcher() { selectedConnection.status = 'paused'; return new Response('{}', { status: 401 }) },
    })
    expect(selectedConnection.status).toBe('paused')
    expect(result.run.state).toBe('blocked')
  })

  it.each([
    ['client id', { clientId: 21 }],
    ['time zone', { timeZone: 'UTC' }],
    ['publication local date', { publicationLocalDate: '2026-08-02' }],
    ['published-at window', { publishedAt: new Date('2026-08-01T02:00:00.000Z') }],
  ] as const)('rejects a site run whose %s no longer matches its confirmed lineage', async (_field, changes) => {
    const lineage = siteLineage(), selectedConnection = connection(), run = queuedRun(lineage, selectedConnection), repo = measurementRepository([selectedConnection])
    repo.runs.push(run)
    let providerCalls = 0
    const current = { ...lineage, ...changes }
    const result = await processMeasurementRun(ownerUserId, run.id, { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages() { return [current] },
      googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      async fetcher() { providerCalls += 1; return new Response(JSON.stringify({ rows: [] }), { status: 200 }) },
    })
    expect(providerCalls).toBe(0)
    expect(result.run.state).toBe('blocked')
  })

  it('blocks a queued site run if the measurement connection configuration changed after scheduling', async () => {
    const lineage = siteLineage(), selectedConnection = connection(), run = queuedRun(lineage, selectedConnection), repo = measurementRepository([selectedConnection])
    repo.runs.push(run)
    selectedConnection.configurationFingerprint = '9'.repeat(64)
    let providerCalls = 0
    const result = await processMeasurementRun(ownerUserId, run.id, { repository: repo, contentOperations: contentOperations(), now,
      async resolveSiteMeasurementLineages() { return [lineage] },
      googleCredentialResolver: async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
      async fetcher() { providerCalls += 1; return new Response(JSON.stringify({ rows: [] }), { status: 200 }) },
    })
    expect(providerCalls).toBe(0)
    expect(result.run.state).toBe('blocked')
    expect(result.run.errorCode).toBe('STALE_SITE_MEASUREMENT_CONFIGURATION')
  })

  it('persists site-confirmation outcome as a distinct non-learning assessment without a publication run id', async () => {
    const lineage = siteLineage()
    const inserts: Record<string, unknown>[] = []
    const repository = {
      async findOutcomeByIdempotency() { return null },
      async transaction<T>(work: (transaction: ContentOperationsRepository) => Promise<T>) { return work(this as unknown as ContentOperationsRepository) },
      async insertOutcome(value: Record<string, unknown>) { inserts.push(value); return { ...value, id: 900, createdAt: now } },
    } as unknown as ContentOperationsRepository
    const result = await recordSitePublicationMeasurementAssessment({ ownerUserId, lineage, checkpointDays: 7, baselineMeasurements: [], followUpMeasurements: [], measuredAt: now, repository, revalidate: async () => lineage, revalidateForPersistence: async () => lineage })
    const inserted = inserts[0]
    expect(result.evidenceKind).toBe('site_publication_confirmation')
    expect(result.learningCandidate).toBeNull()
    expect(inserted).toMatchObject({ runId: null, targetId: lineage.targetId, publicationReceiptFingerprint: lineage.confirmationFingerprint,
      consentLineageSnapshot: { consentStatus: 'unknown', rightsConfirmed: false } })
    expect(inserted?.assessmentSnapshot).toMatchObject({ evidenceKind: 'site_publication_confirmation', learningCandidate: false, confirmationFingerprint: lineage.confirmationFingerprint })
  })

  it('refuses to persist an assessment if the final fresh confirmation no longer matches', async () => {
    const lineage = siteLineage()
    let inserted = false, rechecks = 0
    const repository = {
      async findOutcomeByIdempotency() { return null },
      async transaction<T>(work: (transaction: ContentOperationsRepository) => Promise<T>) { return work(this as unknown as ContentOperationsRepository) },
      async insertOutcome() { inserted = true; return {} },
    } as unknown as ContentOperationsRepository
    await expect(recordSitePublicationMeasurementAssessment({ ownerUserId, lineage, checkpointDays: 7, baselineMeasurements: [], followUpMeasurements: [], measuredAt: now, repository,
      revalidate: async () => ++rechecks === 1 ? lineage : null, revalidateForPersistence: async () => lineage })).rejects.toThrow(/became stale/u)
    expect(rechecks).toBe(2)
    expect(inserted).toBe(false)
  })

  it('revalidates cached authority after the transactional idempotency read and before inserting', async () => {
    const lineage = siteLineage()
    let inserted = false, transaction: ContentOperationsRepository | null = null, rechecks = 0
    const repository = {
      async findOutcomeByIdempotency() { return null },
      async transaction<T>(work: (tx: ContentOperationsRepository) => Promise<T>) {
        const tx = {
          async findOutcomeByIdempotency() { return null },
          async insertOutcome() { inserted = true; return {} },
        } as unknown as ContentOperationsRepository
        transaction = tx
        return work(tx)
      },
      async insertOutcome() { inserted = true; return {} },
    } as unknown as ContentOperationsRepository
    await expect(recordSitePublicationMeasurementAssessment({ ownerUserId, lineage, checkpointDays: 7, baselineMeasurements: [], followUpMeasurements: [], measuredAt: now, repository,
      revalidate: async () => lineage,
      revalidateForPersistence: async tx => {
        rechecks += 1
        expect(tx).toBe(transaction)
        return null
      } })).rejects.toThrow(/became stale/u)
    expect(rechecks).toBe(1)
    expect(inserted).toBe(false)
  })
})
