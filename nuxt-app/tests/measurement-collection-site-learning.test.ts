import { describe, expect, it } from 'vitest'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { learningFixture } from './support/learning-loop-memory-repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'
import { assessPublishedContentOutcome, OUTCOME_DATA_CONTRACT_VERSION, scanOutcomeLearningPii } from '../server/outcome-learning'
import { recordSiteLearningOptIn, revokeSiteLearningOptIn, resolveSiteLearningCollectionProof, reviewSiteLearningOutcome, buildSiteLearningRelease, type SiteLearningCollectionProof, type SiteLearningOptions } from '../server/content-operations/site-learning'
import { stableFingerprint } from '../server/content-operations/normalization'
import { processMeasurementRun } from '../server/measurement-collection/service'
import { buildSnapshot, deidentifiedSubjectKey, measurementInputFingerprint, measurementScopeFingerprint } from '../server/measurement-collection/normalization'
import { normalizeSiteLearningCollectionProof, sameSiteLearningCollectionProof, siteLearningCaptureAllowed, snapshotSiteLearningProof } from '../server/measurement-collection/site-learning-proof'
import type { ConfirmedSiteMeasurementLineage } from '../server/content-operations/site-measurement'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { ContentOperationOutcomeAssessmentRow } from '../server/content-operations/types'
import type { MeasurementConnectionRow, MeasurementRepository, MeasurementRunRow, MeasurementSnapshotRow, SiteConfirmationMeasurementPublicationLineage } from '../server/measurement-collection/types'

const OWNER = 1
const ENTRY = 30
const TARGET = 55
const CLIENT = 2
const PAGE = 'https://client.acme.taipei/articles/site-confirmation'
const NOW = new Date('2026-08-10T00:00:00.000Z')

function proof(overrides: Partial<SiteLearningCollectionProof> = {}): SiteLearningCollectionProof {
  return { contractVersion: 'site-learning-collection-proof-v1', grantFingerprint: 'a'.repeat(64), confirmationFingerprint: 'b'.repeat(64),
    authorizationId: 1, authorizationFingerprint: 'c'.repeat(64), sourceFingerprint: 'd'.repeat(64), grantedAt: '2026-08-02T00:00:00.000Z',
    approvedAt: '2026-08-01T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z', retentionDays: 30, consentVersion: 'site-learning-v1', ...overrides }
}

function piiPaths(value: unknown, path = '$'): string[] {
  const children: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, index) => [String(index), item])
    : value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : []
  if (!children.length) return scanOutcomeLearningPii(value).status === 'none_detected' ? [] : [path]
  const paths = children.flatMap(([key, item]) => piiPaths(item, `${path}.${key}`))
  return paths.length ? paths : scanOutcomeLearningPii(value).status === 'none_detected' ? [] : [path]
}

function lineage(): SiteConfirmationMeasurementPublicationLineage {
  return { evidenceKind: 'site_publication_confirmation', ownerUserId: OWNER, entryId: ENTRY, targetId: TARGET, clientId: CLIENT, canonicalPage: PAGE,
    publicationReceiptFingerprint: 'b'.repeat(64), confirmationFingerprint: 'b'.repeat(64), contentHash: 'e'.repeat(64), evidenceSnapshotHash: 'f'.repeat(64),
    publicationLocalDate: '2026-08-01', timeZone: 'Asia/Taipei', publishedAt: new Date('2026-08-01T01:00:00.000Z'), calendarId: 1,
    draftId: 5, draftVersion: 2, jobId: 4, productionPlanId: 7, scheduleKey: 'schedule-site-30', language: 'zh-hant', contentType: 'article',
    appliedRuleIds: ['rule-a'], topicClusterCode: 'topic-a' }
}

function connection(): MeasurementConnectionRow {
  return { id: 1, ownerUserId: OWNER, clientId: CLIENT, publicationTargetId: TARGET, source: 'google_search_console', activeSource: 'google_search_console',
    status: 'configured', credentialReference: 'secret-manager:synthetic', googleSearchConsoleProperty: 'https://client.acme.taipei', ga4PropertyId: null,
    llmVisibilityProjectId: null, canonicalOrigin: 'https://client.acme.taipei', timeZone: 'Asia/Taipei', allowedPageScope: [PAGE],
    sourceAvailabilityLagDays: 0, providerTargets: null, idempotencyKey: 'synthetic-gsc-connection', configurationFingerprint: '1'.repeat(64),
    connectedAt: NOW, revokedAt: null, createdAt: NOW, updatedAt: NOW } as MeasurementConnectionRow
}

function queuedRun(site = lineage(), selected = connection()): MeasurementRunRow {
  const baselineWindowStart = new Date('2026-07-25T01:00:00.000Z')
  const followUpWindowEnd = new Date('2026-08-08T01:00:00.000Z')
  const scopeFingerprint = measurementScopeFingerprint({ ownerUserId: OWNER, clientId: site.clientId, websiteOrigin: selected.canonicalOrigin,
    entryId: site.entryId, targetId: site.targetId, canonicalPage: site.canonicalPage, source: 'google_search_console', checkpointDays: 7 })
  const fingerprintInput = { ownerUserId: OWNER, connectionId: selected.id, entryId: site.entryId, targetId: site.targetId, source: 'google_search_console', checkpointDays: 7,
    publicationReceiptFingerprint: site.confirmationFingerprint, canonicalPage: site.canonicalPage, contentHash: site.contentHash, evidenceSnapshotHash: site.evidenceSnapshotHash,
    scopeFingerprint, baselineStart: baselineWindowStart.toISOString(), baselineEnd: site.publishedAt.toISOString(), followUpStart: site.publishedAt.toISOString(),
    followUpEnd: followUpWindowEnd.toISOString(), dueAt: NOW.toISOString(), evidenceKind: site.evidenceKind, confirmationFingerprint: site.confirmationFingerprint,
    draftId: site.draftId, draftVersion: site.draftVersion, connectionConfigurationFingerprint: selected.configurationFingerprint }
  return { id: 101, ownerUserId: OWNER, clientId: site.clientId, connectionId: selected.id, entryId: site.entryId, targetId: site.targetId,
    source: 'google_search_console', checkpointDays: 7, publicationReceiptFingerprint: site.confirmationFingerprint, canonicalPage: site.canonicalPage,
    contentHash: site.contentHash, evidenceSnapshotHash: site.evidenceSnapshotHash, publicationLocalDate: site.publicationLocalDate, timeZone: site.timeZone,
    baselineWindowStart, baselineWindowEnd: site.publishedAt, followUpWindowStart: site.publishedAt, followUpWindowEnd, dueAt: NOW,
    state: 'queued', attemptNumber: 0, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, idempotencyKey: `site-measurement-run:${'2'.repeat(64)}`,
    inputFingerprint: measurementInputFingerprint(fingerprintInput), outputFingerprint: null, errorCode: null, errorSummary: null,
    startedAt: null, completedAt: null, createdAt: NOW, updatedAt: NOW }
}

function measurementRepository(selected: MeasurementConnectionRow, run: MeasurementRunRow) {
  const runs = [run], snapshots: MeasurementSnapshotRow[] = []
  const repository = {
    async listConnections() { return [selected] }, async listRuns() { return runs },
    async findRunByIdempotency(_owner: number, key: string) { return runs.find(row => row.idempotencyKey === key) || null },
    async insertRun(input: Omit<MeasurementRunRow, 'id' | 'createdAt' | 'updatedAt'>) { const row = { ...input, id: runs.length + 101, createdAt: NOW, updatedAt: NOW } as MeasurementRunRow; runs.push(row); return row },
    async findRun(_owner: number, id: number) { return runs.find(row => row.id === id) || null },
    async acquireRunLease(_owner: number, id: number) { const row = runs.find(item => item.id === id); if (!row) return null; Object.assign(row, { state: 'processing', attemptNumber: row.attemptNumber + 1, leaseOwner: 'synthetic-worker' }); return row },
    async releaseRunLease(_owner: number, id: number, _lease: string, state: MeasurementRunRow['state'], _at: Date, patch = {}) { const row = runs.find(item => item.id === id); if (!row) return null; Object.assign(row, { state, leaseOwner: null }, patch); return row },
    async findConnection(_owner: number, id: number) { return selected.id === id ? selected : null }, async updateConnection(_owner: number, _id: number, patch: Partial<MeasurementConnectionRow>) { Object.assign(selected, patch); return selected },
    async findSnapshot(_owner: number, runId: number, phase: 'baseline' | 'follow_up') { return snapshots.find(row => row.runId === runId && row.phase === phase) || null },
    async listSnapshots(_owner: number, runId?: number) { return snapshots.filter(row => runId === undefined || row.runId === runId) },
    async insertSnapshot(input: Omit<MeasurementSnapshotRow, 'id' | 'createdAt'>) { const row = { ...input, id: snapshots.length + 1, createdAt: NOW } as MeasurementSnapshotRow; snapshots.push(row); return row },
    runs, snapshots,
  }
  return repository as unknown as MeasurementRepository & { runs: MeasurementRunRow[]; snapshots: MeasurementSnapshotRow[] }
}

async function coreHarness(options: { grant?: boolean } = {}) {
  const site = lineage(), content = new ContentOperationsFixture(), auth = learningFixture()
  auth.now.setTime(new Date('2026-08-01T00:00:00.000Z').getTime())
  auth.repository.clients[0]!.canonicalSiteOrigin = 'https://client.acme.taipei'
  auth.repository.sources[0]!.sourceUrl = 'https://client.acme.taipei/'
  auth.repository.sources[0]!.canonicalUrl = 'https://client.acme.taipei/'
  const created = await createLearningAuthorization(OWNER, { ...auth.input, expiresAt: '2026-08-31T00:00:00.000Z' }, { repository: auth.repository, now: () => auth.now })
  Object.assign(content.repository, {
    listSiteLearningEvents: async (owner: number, entry: number) => content.events.filter(row => row.ownerUserId === owner && row.entryId === entry && ['site_learning_opt_in','site_learning_revoked','site_learning_outcome_reviewed'].includes(row.eventType)).sort((a,b) => b.id-a.id).slice(0, 501),
    findSiteLearningEvent: async (owner: number, fp: string) => content.events.find(row => row.ownerUserId === owner && row.eventFingerprint === fp) || null,
  })
  const siteClock = { value: new Date('2026-08-02T00:00:00.000Z') }
  const learningOptions: SiteLearningOptions = { operations: content.repository, learning: auth.repository, now: () => siteClock.value,
    resolveSiteLineages: async (owner, entry) => owner === OWNER && entry === ENTRY ? [site as unknown as ConfirmedSiteMeasurementLineage] : [] }
  const authorization = { targetRowId: TARGET, expectedConfirmationFingerprint: site.confirmationFingerprint, authorizationId: created.authorization.id,
    expectedAuthorizationFingerprint: created.authorization.authorizationFingerprint, customerEvidenceConfirmed: true as const, scopeConfirmed: true as const, idempotencyKey: 'site-learning-integration-grant' }
  const grant = options.grant === false ? null : await recordSiteLearningOptIn(OWNER, ENTRY, authorization, learningOptions)
  return { site, content, auth, created, siteClock, learningOptions, authorization, grant }
}

function coreDependencies(f: Awaited<ReturnType<typeof coreHarness>>, overrides: { provider?: () => Promise<void>; beforeInsert?: () => Promise<void>; includeSiteResolver?: boolean } = {}) {
  f.siteClock.value = NOW
  const selected = connection(), run = queuedRun(f.site, selected), measurements = measurementRepository(selected, run)
  const fakeProviderProof = proof({ grantFingerprint: '9'.repeat(64), confirmationFingerprint: '9'.repeat(64) })
  let fetchCount = 0
  const dependencies = {
    repository: measurements, contentOperations: f.content.repository, now: NOW,
    async resolveSiteMeasurementLineages(ownerUserId: number, entryId: number) { return ownerUserId === OWNER && entryId === ENTRY ? [f.site] : [] },
    async resolveSiteLearningCollectionProof(ownerUserId: number, publication: SiteConfirmationMeasurementPublicationLineage, context: { repository: ContentOperationsRepository }) {
      return resolveSiteLearningCollectionProof(ownerUserId, publication as unknown as ConfirmedSiteMeasurementLineage, f.learningOptions, { repository: context.repository })
    },
    googleCredentialResolver: async () => ({ accessToken: 'synthetic-only-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] }),
    async fetcher() {
      fetchCount++
      await overrides.provider?.()
      const metrics = fetchCount === 1 ? { clicks: 70, impressions: 700, position: 5 } : { clicks: 210, impressions: 1400, position: 5 }
      return new Response(JSON.stringify({ siteLearningCollectionProof: fakeProviderProof,
        rows: [{ keys: [PAGE], ...metrics, siteLearningCollectionProof: fakeProviderProof }] }), { status: 200 })
    },
  }
  if (overrides.includeSiteResolver === false) delete (dependencies as Partial<typeof dependencies>).resolveSiteMeasurementLineages
  if (overrides.beforeInsert) {
    const find = f.content.repository.findOutcomeByIdempotency.bind(f.content.repository)
    let reads = 0
    f.content.repository.findOutcomeByIdempotency = async (...args) => {
      reads++
      if (reads === 2) await overrides.beforeInsert!()
      return find(...args)
    }
  }
  return { dependencies, measurements, run, fetchCount: () => fetchCount }
}

describe('measurement collection site-learning proof handoff', () => {
  it('normalizes exact eleven-field proofs and rejects accessors, proxy traps, invalid hashes, and invalid time/retention', () => {
    const valid = proof()
    expect(normalizeSiteLearningCollectionProof(valid)).toEqual(valid)
    expect(sameSiteLearningCollectionProof(valid, structuredClone(valid))).toBe(true)
    expect(sameSiteLearningCollectionProof(valid, { ...valid, unexpected: true })).toBe(false)
    expect(snapshotSiteLearningProof({ siteLearningCollectionProof: valid })).toEqual(valid)
    expect(snapshotSiteLearningProof(Object.defineProperty({}, 'siteLearningCollectionProof', { enumerable: true, get: () => valid }))).toBeNull()
    expect(snapshotSiteLearningProof(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('synthetic descriptor trap') } }))).toBeNull()
    expect(normalizeSiteLearningCollectionProof(Object.defineProperty({}, 'grantFingerprint', { enumerable: true, get: () => valid.grantFingerprint }))).toBeNull()
    expect(normalizeSiteLearningCollectionProof(new Proxy(valid, { ownKeys() { throw new Error('synthetic proxy trap') } }))).toBeNull()
    for (const invalid of [
      { ...valid, grantFingerprint: 'not-a-hash' }, { ...valid, confirmationFingerprint: 'A'.repeat(64) }, { ...valid, authorizationId: 0 },
      { ...valid, grantedAt: '2026-08-02' }, { ...valid, approvedAt: '2026-08-03T00:00:00.000Z' }, { ...valid, expiresAt: '2026-08-01T00:00:00.000Z' },
      { ...valid, retentionDays: 31 }, { ...valid, consentVersion: 'contains spaces' }, (() => { const row = { ...valid } as Record<string, unknown>; delete row.sourceFingerprint; return row })(),
    ]) expect(normalizeSiteLearningCollectionProof(invalid)).toBeNull()
  })

  it('allows capture only after grant and within confirmation, expiry, current clock, and retention bounds', () => {
    const current = proof()
    expect(siteLearningCaptureAllowed(current, '2026-08-10T00:00:00.000Z', current.confirmationFingerprint, NOW)).toBe(true)
    expect(siteLearningCaptureAllowed(current, '2026-08-01T00:00:00.000Z', current.confirmationFingerprint, NOW)).toBe(false)
    expect(siteLearningCaptureAllowed(current, '2026-08-11T00:00:00.000Z', current.confirmationFingerprint, NOW)).toBe(false)
    expect(siteLearningCaptureAllowed(current, '2026-08-10T00:00:00.000Z', '0'.repeat(64), NOW)).toBe(false)
    expect(siteLearningCaptureAllowed({ ...current, retentionDays: 1 }, '2026-08-08T00:00:00.000Z', current.confirmationFingerprint, NOW)).toBe(false)
    expect(siteLearningCaptureAllowed({ ...current, expiresAt: '2026-08-09T00:00:00.000Z' }, '2026-08-08T00:00:00.000Z', current.confirmationFingerprint, NOW)).toBe(false)
  })

  it('runs actual core grant through both mocked provider phases into review-only assessment and release', async () => {
    const f = await coreHarness(), run = coreDependencies(f)
    const result = await processMeasurementRun(OWNER, run.run.id, run.dependencies)
    expect(result.run.state).toBe('succeeded')
    expect(run.fetchCount()).toBe(2)
    expect(run.measurements.snapshots).toHaveLength(2)
    for (const snapshot of run.measurements.snapshots) {
      const provenance = snapshot.providerProvenance as Record<string, unknown>
      expect(provenance.siteLearningCollectionProof).toMatchObject({ grantFingerprint: f.grant!.grantFingerprint, confirmationFingerprint: f.site.confirmationFingerprint })
      expect(provenance.siteLearningCollectionProof).not.toMatchObject({ grantFingerprint: '9'.repeat(64) })
    }
    const outcome = f.content.outcomes[0] as ContentOperationOutcomeAssessmentRow
    const saved = outcome.assessmentSnapshot as Record<string, unknown>
    expect(outcome.runId).toBeNull()
    expect(outcome.consentLineageSnapshot).toMatchObject({ consentStatus: 'unknown', rightsConfirmed: false })
    expect(saved).toMatchObject({ evidenceKind: 'site_publication_confirmation', learningCandidate: false, siteLearningCollectionProof: { grantFingerprint: f.grant!.grantFingerprint } })
    expect(Object.keys(saved.siteLearningCollectionProof as Record<string, unknown>).sort()).toEqual(['approvedAt','authorizationFingerprint','authorizationId','confirmationFingerprint','consentVersion','contractVersion','expiresAt','grantFingerprint','grantedAt','retentionDays','sourceFingerprint'].sort())
    const stripProvenance = (value: unknown) => { const { providerProvenance: _ignored, ...row } = value as Record<string, unknown>; return row }
    const baseline = (outcome.baselineSnapshot as unknown[]).map(stripProvenance), followUp = (outcome.followUpSnapshot as unknown[]).map(stripProvenance)
    const engineAssessment = assessPublishedContentOutcome({ publication: saved.publication, baselineMeasurements: baseline, followUpMeasurements: followUp, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION })
    const scanPayloads = { publication: saved.publication, assessment: engineAssessment, baselineMeasurements: baseline, followUpMeasurements: followUp }
    const pii = scanOutcomeLearningPii(scanPayloads)
    expect(pii.status, JSON.stringify(piiPaths(scanPayloads))).toBe('none_detected')
    const review = await reviewSiteLearningOutcome(OWNER, outcome.id, { expectedAssessmentFingerprint: outcome.assessmentFingerprint, expectedGrantFingerprint: f.grant!.grantFingerprint,
      decision: 'approve', piiReviewed: true, limitationsUnderstood: true, idempotencyKey: 'site-learning-integration-review' }, f.learningOptions)
    expect(review.state).toBe('approved')
    const release = await buildSiteLearningRelease(OWNER, f.learningOptions)
    expect(release).toMatchObject({ modelTrainingAllowed: false, citationTrainingEligible: false, eligibleCandidateCount: 1 })
  })

  it('does not attach proof when grant appears during provider work or is revoked/changed during that await', async () => {
    const lateGrant = await coreHarness({ grant: false })
    let grantedDuringCall = false
    const lateRun = coreDependencies(lateGrant, { provider: async () => {
      if (!grantedDuringCall) { grantedDuringCall = true; await recordSiteLearningOptIn(OWNER, ENTRY, lateGrant.authorization, lateGrant.learningOptions) }
    } })
    const lateResult = await processMeasurementRun(OWNER, lateRun.run.id, lateRun.dependencies)
    expect(lateResult.run.state).toBe('succeeded')
    expect(lateGrant.content.outcomes[0]?.assessmentSnapshot).not.toHaveProperty('siteLearningCollectionProof')

    for (const change of ['revoke', 'source_changed'] as const) {
      const f = await coreHarness()
      let changedDuringCall = false
      const run = coreDependencies(f, { provider: async () => {
        if (changedDuringCall) return
        changedDuringCall = true
        if (change === 'revoke') await revokeSiteLearningOptIn(OWNER, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: f.grant!.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-provider-revoke' }, f.learningOptions)
        else f.auth.repository.sources[0]!.canonicalUrl = 'https://changed.example/'
      } })
      const result = await processMeasurementRun(OWNER, run.run.id, run.dependencies)
      expect(result.run.state).toBe('succeeded')
      expect(f.content.outcomes[0]?.assessmentSnapshot).not.toHaveProperty('siteLearningCollectionProof')
      expect(run.measurements.snapshots.every(snapshot => !('siteLearningCollectionProof' in (snapshot.providerProvenance as Record<string, unknown>)))).toBe(true)
    }
  })

  it('drops provider-supplied proofs, does not retrofit an old baseline, and never uses production fallback with injected repositories', async () => {
    const f = await coreHarness(), run = coreDependencies(f)
    const old = queuedRun(f.site, connection())
    const oldSnapshot = buildSnapshot({ source: 'google_search_console', phase: 'baseline', deidentifiedSubjectKey: deidentifiedSubjectKey(OWNER), scopeFingerprint: measurementScopeFingerprint({ ownerUserId: OWNER, clientId: CLIENT, websiteOrigin: 'https://client.acme.taipei', entryId: ENTRY, targetId: TARGET, canonicalPage: PAGE, source: 'google_search_console', checkpointDays: 7 }),
      windowStart: old.baselineWindowStart, windowEnd: old.baselineWindowEnd, capturedAt: new Date('2026-08-02T00:00:00.000Z'), metrics: { impressions: 10, clicks: 1, averagePosition: 3 },
      providerProvenance: { providerSuppliedCollectionProof: proof() }, limitations: [] })!
    await run.measurements.insertSnapshot({ ownerUserId: OWNER, runId: old.id, entryId: ENTRY, targetId: TARGET, source: 'google_search_console', phase: 'baseline',
      deidentifiedSubjectKey: oldSnapshot.deidentifiedSubjectKey, scopeFingerprint: oldSnapshot.scopeFingerprint, windowStart: new Date(oldSnapshot.windowStart), windowEnd: new Date(oldSnapshot.windowEnd),
      capturedAt: new Date(oldSnapshot.capturedAt), sourceHash: oldSnapshot.sourceHash, normalizedMetrics: oldSnapshot.normalizedMetrics, providerProvenance: oldSnapshot.providerProvenance, limitations: [] })
    const result = await processMeasurementRun(OWNER, run.run.id, run.dependencies)
    expect(result.run.state).toBe('succeeded')
    expect(run.measurements.snapshots[0]?.providerProvenance).toMatchObject({ providerSuppliedCollectionProof: proof() })
    expect(run.measurements.snapshots[1]?.providerProvenance).not.toHaveProperty('providerSuppliedCollectionProof')
    expect(f.content.outcomes[0]?.assessmentSnapshot).not.toHaveProperty('siteLearningCollectionProof')

    const noDI = await coreHarness(), blocked = coreDependencies(noDI, { includeSiteResolver: false })
    let providerCalls = 0
    blocked.dependencies.fetcher = async () => { providerCalls++; return new Response('{}', { status: 200 }) }
    const blockedRun = await processMeasurementRun(OWNER, blocked.run.id, blocked.dependencies)
    expect(blockedRun.run.state).toBe('blocked')
    expect(providerCalls).toBe(0)
  })

  it('removes a proof revoked while assessment persistence awaits', async () => {
    const f = await coreHarness()
    const run = coreDependencies(f, { beforeInsert: async () => {
      await revokeSiteLearningOptIn(OWNER, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: f.grant!.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-assessment-revoke' }, f.learningOptions)
    } })
    const result = await processMeasurementRun(OWNER, run.run.id, run.dependencies)
    expect(result.run.state).toBe('succeeded')
    expect(f.content.outcomes[0]?.assessmentSnapshot).not.toHaveProperty('siteLearningCollectionProof')
  })
})
