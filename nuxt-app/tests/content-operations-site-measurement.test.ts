import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createOwnerPublicationTarget } from '../server/content-operations/orchestrator'
import { singleDraftReceiptFingerprint } from '../server/content-operations/draft-receipt'
import { checkOwnerSitePublication, projectSitePublicationHistory, sitePublicationContext } from '../server/content-operations/site-publication'
import { getOwnerContentOperationsWorkspace, recordOwnerOutcomeAssessment } from '../server/content-operations/service'
import { ContentOperationsFixture, HASH } from './fixtures/content-operations/repository'
import type { FirstPartyFetch } from '../server/first-party-publishing/types'
import { normalizeFirstPartyDraftReceipt } from '../server/first-party-publishing/draft-receipt'

import { confirmOwnerSiteMeasurement, projectSiteMeasurement, resolveConfirmedSiteMeasurementLineages, parseSiteMeasurementConfirmInput } from '../server/content-operations/site-measurement'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { stableFingerprint } from '../server/content-operations/normalization'
import { dryRunMeasurementForEntry, scheduleMeasurementForEntry, processMeasurementRun } from '../server/measurement-collection/service'
import { buildOwnerContentLearningDataset } from '../server/content-operations/service'
import type { MeasurementRepository, MeasurementRunRow, MeasurementSnapshotRow, MeasurementConnectionRow } from '../server/measurement-collection/types'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const SECRET = 'synthetic-site-status-secret-000000000000'
const BODY = '本機測試內容'
const BODY_HASH = createHash('sha256').update(BODY).digest('hex')
const CONTENT_HASH = contentFingerprint('合成測試文章', BODY)
const DOC_HASH = 'c'.repeat(64)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const db = new ContentOperationsFixture()
  const client = db.addClient(1)
  Object.assign(client, { framework: 'nextjs', publicationTransport: 'first_party_signed_api', canonicalSiteOrigin: 'https://doalignment.com' })
  const calendar = await db.addCalendar(1, '2026-10-08', 1)
  const entry = db.entries.find(row => row.calendarId === calendar.id)!
  const created = await createOwnerPublicationTarget(1, client.id, { idempotencyKey: 'site-check-target-0001', framework: 'nextjs', transport: 'first_party_signed_api', targetOrigin: 'https://doalignment.com', contentRoot: 'journal', endpointPath: '/api/first-party/content-ingest', credentialReference: 'ref-do-site-observe', allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], maximumPayloadBytes: 100_000, executionEnabled: true }, db.repository)
  const target = db.targets.find(row => row.id === created.target.id)!
  Object.assign(entry, { status: 'awaiting_site_review', publicationTargetId: target.id, jobId: 800, draftId: 801, contentHash: CONTENT_HASH, language: 'zh-hant', publicationSlug: 'fixture-article', publicationPath: 'journal/zh-hant/articles/fixture-article.md',
    publicationIdentityFingerprint: stableFingerprint({ clientId: client.id, entryId: entry.id, language: 'zh-hant', contentType: 'article', targetId: target.targetId, targetOrigin: target.targetOrigin, slug: 'fixture-article', path: 'journal/zh-hant/articles/fixture-article.md' }) })
  entry.reviewId = 804
  const bundle = db.bundles.get(`1:${calendar.productionPlanId}`)!
  const deliverable = bundle.deliverables.find(row => row.id === entry.productionDeliverableId)!
  Object.assign(deliverable, { language: 'zh-hant' })
  const job = { id: 800, ownerUserId: 1, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 806 }
  const draft = { id: 801, jobId: 800, version: 1, title: '合成測試文章', body: BODY, contentHash: CONTENT_HASH, safetyStatus: 'passed', evidenceRefs: [] }
  const riskGate = { id: 805, draftId: 801, status: 'passed', evidenceSnapshotHash: entry.evidenceSnapshotHash }
  db.generated.set(entry.id, { deliverable: deliverable as unknown as Record<string, unknown>, job, draft, riskGate })
  db.reviews.set(entry.id, { id: 804, ownerUserId: 1, reviewerUserId: 1, jobId: 800, draftId: 801, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
  const receipt = { status: 'draft_received' as const, published: false as const, receiptScope: 'draft_ingest_outcome' as const, receiptIsCurrentState: false as const,
    publicationId: `deliverable-${entry.productionDeliverableId}`, contentHash: BODY_HASH, postId: '9b131e17-a5c2-45e1-a40f-44b6084de9b1', postVersion: 1 as const, replayed: false }
  const attempt = await db.repository.insertPublicationAttempt({ ownerUserId: 1, clientId: client.id, entryId: entry.id, runId: 802, targetId: target.id,
    mode: 'execute', attemptNumber: 1, idempotencyKey: 'initial-ingest-0001', inputFingerprint: stableFingerprint({ entryId: entry.id, mode: 'execute', identityFingerprint: entry.publicationIdentityFingerprint, contentHash: CONTENT_HASH, publicationContentHash: BODY_HASH, evidenceSnapshotHash: entry.evidenceSnapshotHash }), publicationId: `publication-${entry.id}`,
    publicationSlug: 'fixture-article', publicationPath: 'journal/zh-hant/articles/fixture-article.md', contentHash: CONTENT_HASH, publicationContentHash: BODY_HASH,
    evidenceSnapshotHash: entry.evidenceSnapshotHash, artifactFingerprint: 'e'.repeat(64), status: 'draft_received', remoteState: 'draft_received',
    receiptLedger: [receipt], receiptFingerprint: null, publicationUrl: null, remoteRevision: null, errorCode: null, errorSummary: null, startedAt: new Date(NOW.getTime() - 3000), completedAt: new Date(NOW.getTime() - 2000) })
  db.runs.push({ id: 802, ownerUserId: 1, entryId: entry.id, stage: 'publication', state: 'succeeded' } as never)
  attempt.receiptFingerprint = singleDraftReceiptFingerprint(attempt, receipt)
  let counter = 0
  const nonce = () => `synthetic-check-nonce-${++counter}`
  const fetchImpl: FirstPartyFetch = vi.fn(async (url, init) => {
    expect(init.method).toBe('POST')
    const request = JSON.parse(init.body!)
    const requestedTarget = db.targets.find(row => row.targetId === request.targetId)!
    expect(url).toBe(`${requestedTarget.targetOrigin}/api/first-party/publication-status`)
    const observation = { version: request.version, targetId: request.targetId, targetOrigin: requestedTarget.targetOrigin, publicationId: request.publicationId,
      contentHash: request.contentHash, postId: request.postId, receiptScope: 'site_publication_observation', receiptIsCurrentState: false,
      state: 'published', postVersion: 2, publishedVersion: 2, receivedDocumentHash: DOC_HASH, publishedDocumentHash: DOC_HASH,
      hasUnpublishedChanges: false, publishedAt: new Date(NOW.getTime() - 1000).toISOString(), observedAt: request.timestamp, nonce: request.nonce, ...responsePatch }
    const response = JSON.stringify(observation)
    const signature = createHmac('sha256', SECRET).update([request.version, 'response', 'POST', '/api/first-party/publication-status', requestedTarget.targetOrigin,
      sha(init.body!), sha(response), request.timestamp, request.nonce].join('\n')).digest('hex')
    onRead?.()
    return { status: responseStatus, headers: { 'x-ds-status-signature': signature }, text: async () => response }
  })
  let responsePatch: Record<string, unknown> = {}, responseStatus = 200
  let onRead: (() => void) | undefined
  const dependencies = { fetchImpl, serverCredentialResolver: vi.fn(async () => ({ ok: true as const, value: SECRET })), nonceProvider: nonce, now: NOW }
  const run = (key = 'site-check-request-0001', extras: Record<string, unknown> = {}) => checkOwnerSitePublication({ ownerUserId: 1, entryId: entry.id, value: { targetRowId: target.id, idempotencyKey: key }, repository: db.repository, dependencies, ...extras })
  const projection = () => projectSitePublicationHistory(sitePublicationContext(entry, target, db.attempts, db.entryTargetBindings), db.events)
  return { db, client, entry, target, attempt, dependencies, fetchImpl, run, projection,
    patchResponse(value: Record<string, unknown>) { responsePatch = value }, status(value: number) { responseStatus = value }, onRead(value: () => void) { onRead = value } }
}

async function ready() {
  const f = await fixture()
  const options = { repository: f.db.repository, dependencies: f.dependencies, now: NOW }
  const project = () => projectSiteMeasurement(1, f.entry.id, f.target.id, options)
  await f.run()
  const state = await project()
  expect(state.state).toBe('available')
  const value = { targetRowId: f.target.id, expectedPublicationFingerprint: state.publicationFingerprint!, confirmed: true, idempotencyKey: 'site-measurement-confirm-0001' }
  const confirm = (patch: Record<string, unknown> = {}) => confirmOwnerSiteMeasurement({ ownerUserId: 1, entryId: f.entry.id, ...options, value, ...patch })
  const resolve = (fresh = false) => resolveConfirmedSiteMeasurementLineages(1, f.entry.id, { ...options, fresh })
  return { ...f, options, project, value, confirm, resolve }
}

describe('independent owner website measurement confirmation', () => {
  it('requires explicit confirmation, rechecks the signed public version, and never upgrades draft/workflow/training', async () => {
    const f = await ready(), original = structuredClone(f.attempt)
    expect(await f.resolve()).toEqual([])
    const result = await f.confirm()
    expect(result).toEqual({ status: 'confirmed', replayed: false, confirmedAt: NOW.toISOString(), workflowChanged: false, learningAuthorized: false, receiptIsCurrentAuthority: false })
    expect(f.attempt).toEqual(original); expect(f.entry.status).toBe('awaiting_site_review')
    expect(f.db.runs[0]!.state).toBe('succeeded'); expect(f.db.outcomes).toHaveLength(0)
    expect(await f.project()).toMatchObject({ state: 'confirmed', confirmedAt: NOW.toISOString() })
    const [lineage] = await f.resolve(true)
    expect(lineage).toMatchObject({ evidenceKind: 'site_publication_confirmation', targetId: f.target.id, canonicalPage: 'https://doalignment.com/journal/fixture-article/', publishedAt: new Date(NOW.getTime() - 1000) })
    expect(lineage!.publicationReceiptFingerprint).not.toBe(f.attempt.receiptFingerprint)
    expect(f.fetchImpl).toHaveBeenCalledTimes(3)
    expect(f.db.events.filter(row => row.eventType === 'site_measurement_confirmed')).toHaveLength(1)
    expect(f.db.events.find(row => row.eventType === 'site_measurement_confirmed')!.runId).toBeNull()
  })

  it('retains exact historical acknowledgement on uncertain replay without treating it as current public authority', async () => {
    const f = await ready(), first = await f.confirm()
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    f.patchResponse({ state: 'private', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null })
    expect(await f.confirm()).toEqual({ ...first, replayed: true })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(await f.resolve(true)).toEqual([])
    expect(f.db.events.filter(row => row.eventType === 'site_measurement_confirmed')).toHaveLength(1)
  })

  it('keeps the same public identity across fresh observation clocks/nonces and private draft edits', async () => {
    const f = await ready(); await f.confirm()
    const [original] = await f.resolve()
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    f.patchResponse({ postVersion: 3, hasUnpublishedChanges: true })
    const [fresh] = await f.resolve(true)
    expect(fresh!.publicationReceiptFingerprint).toBe(original!.publicationReceiptFingerprint)
  })

  it.each([
    { publishedDocumentHash: 'f'.repeat(64) },
    { receivedDocumentHash: null },
    { publishedVersion: 3, postVersion: 3, publishedAt: new Date(NOW.getTime() + 1000).toISOString() },
    { state: 'private', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null },
    { state: 'archived', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null },
  ])('blocks fresh collection of a changed or unavailable public version (%j)', async patch => {
    const f = await ready(); await f.confirm(); f.patchResponse(patch)
    expect(await f.resolve(true)).toEqual([])
    expect(f.entry.status).toBe('awaiting_site_review'); expect(f.attempt.status).toBe('draft_received')
  })

  it.each(['status', 'signature'])('does not substitute old evidence when the fresh remote response fails (%s)', async kind => {
    const f = await ready(); await f.confirm()
    if (kind === 'status') f.status(503)
    else f.dependencies.serverCredentialResolver = vi.fn(async () => ({ ok: true as const, value: 'different-synthetic-secret-00000000000000' }))
    expect(await f.resolve(true)).toEqual([])
  })

  it.each(['review', 'draft', 'target', 'source', 'machine', 'run'])('blocks authority drift before any further website call (%s)', async kind => {
    const f = await ready(); await f.confirm(); const calls = vi.mocked(f.fetchImpl).mock.calls.length
    if (kind === 'review') f.db.reviews.get(f.entry.id)!.decision = 'rejected'
    if (kind === 'draft') f.db.generated.get(f.entry.id)!.draft!.version = 2
    if (kind === 'target') f.target.status = 'paused'
    if (kind === 'source') f.db.evidenceApprovalAt = new Date(NOW.getTime() + 60_000).toISOString()
    if (kind === 'machine') f.attempt.authorityReference = 'f'.repeat(64)
    if (kind === 'run') f.db.runs[0]!.state = 'blocked'
    expect(await f.resolve(true)).toEqual([])
    expect((await f.project()).state).toBe('blocked')
    expect(vi.mocked(f.fetchImpl).mock.calls.length).toBe(calls)
  })

  it('rechecks review authority after the signed read, before writing a confirmation', async () => {
    const f = await ready(); f.onRead(() => { f.db.reviews.get(f.entry.id)!.decision = 'rejected' })
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 })
    expect(f.db.events.filter(row => row.eventType === 'site_measurement_confirmed')).toHaveLength(0)
  })

  it('requires a newly observed version after a public change and never uses an older positive observation', async () => {
    const f = await ready(); await f.confirm()
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    f.patchResponse({ publishedDocumentHash: 'f'.repeat(64) }); await f.run('newer-public-version-check')
    expect((await f.project()).reason).toBe('content_changed')
    expect(await f.resolve()).toEqual([])
  })

  it('expires the initial confirmation offer while retaining a confirmed historical opt-in for future fresh checks', async () => {
    const f = await ready()
    const late = { ...f.options, now: new Date(NOW.getTime() + 300_001) }
    expect(await projectSiteMeasurement(1, f.entry.id, f.target.id, late)).toMatchObject({ state: 'blocked', reason: 'observation_expired' })
    await f.confirm()
    expect(await projectSiteMeasurement(1, f.entry.id, f.target.id, late)).toMatchObject({ state: 'confirmed' })
  })

  it('rejects mismatched expected versions, other owners, opted-in clients with unavailable consent and injected production fallback', async () => {
    const f = await ready()
    await expect(f.confirm({ value: { ...f.value, expectedPublicationFingerprint: '0'.repeat(64) } })).rejects.toMatchObject({ statusCode: 409 })
    await expect(f.confirm({ ownerUserId: 2 })).rejects.toMatchObject({ statusCode: 404 })
    f.client.requireCustomerApproval = true
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 })
    const g = await ready()
    await expect(g.confirm({ dependencies: undefined })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('does not recover a corrupted latest confirmation behind an older valid event', async () => {
    const f = await ready(); await f.confirm()
    f.db.events.find(row => row.eventType === 'site_measurement_confirmed')!.metadata = { unexpected: true }
    expect(await f.resolve()).toEqual([])
    expect((await f.project()).state).toBe('blocked')
  })

  it('rejects authority-bearing/ambiguous inputs and overflowing histories', async () => {
    const f = await ready()
    for (const value of [{ ...f.value, confirmed: false }, { ...f.value, publishedAt: NOW.toISOString() }, { ...f.value, ownerUserId: 1 }, { ...f.value, targetRowId: 0 }]) {
      expect(() => parseSiteMeasurementConfirmInput(value)).toThrow()
    }
    f.db.repository.listSiteMeasurementEvents = async () => Array.from({ length: 501 }, () => ({ eventType: 'site_measurement_confirmed' })) as never
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 })
  })

  it('binds the public route to the original persisted identity and input, not a reconfigured target', async () => {
    const f = await ready(); await f.confirm(); const calls = vi.mocked(f.fetchImpl).mock.calls.length
    f.target.targetOrigin = 'https://replacement.doalignment.com'; f.client.canonicalSiteOrigin = f.target.targetOrigin
    f.target.configurationFingerprint = 'f'.repeat(64)
    expect((await f.project()).state).toBe('blocked'); expect(await f.resolve(true)).toEqual([])
    expect(vi.mocked(f.fetchImpl).mock.calls.length).toBe(calls)
  })

  it('rejects a repeated signed-status nonce across the observation and confirmation ledgers', async () => {
    const f = await ready(); f.dependencies.nonceProvider = () => 'synthetic-check-nonce-1'
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 })
    expect(f.db.events.filter(row => row.eventType === 'site_measurement_confirmed')).toHaveLength(0)
  })

  it('returns one durable winner and a replay for concurrent same-key acknowledgements at the same clock', async () => {
    const f = await ready()
    const results = await Promise.all([f.confirm(), f.confirm()])
    expect(results.map(result => result.replayed).sort()).toEqual([false, true])
    expect(f.db.events.filter(row => row.eventType === 'site_measurement_confirmed')).toHaveLength(1)
  })

  it('fails closed on partial dependency injection without constructing a real repository', async () => {
    const f = await ready()
    await expect(f.confirm({ repository: undefined })).rejects.toMatchObject({ statusCode: 503 })
    expect(await resolveConfirmedSiteMeasurementLineages(1, f.entry.id, { fresh: true, dependencies: f.dependencies })).toEqual([])
  })
})

function measurements(f: Awaited<ReturnType<typeof ready>>, now: Date) {
  const page = 'https://doalignment.com/journal/fixture-article/'
  const connection = { id: 1, ownerUserId: 1, clientId: f.client.id, publicationTargetId: f.target.id, source: 'google_search_console', activeSource: 'google_search_console', status: 'configured', credentialReference: 'ref-synthetic-google', googleSearchConsoleProperty: 'https://doalignment.com', ga4PropertyId: null, llmVisibilityProjectId: null, canonicalOrigin: 'https://doalignment.com', timeZone: 'UTC', allowedPageScope: [page], sourceAvailabilityLagDays: 0, providerTargets: null, idempotencyKey: 'synthetic-google-connection', configurationFingerprint: 'e'.repeat(64), connectedAt: now, revokedAt: null, websiteIdentity: `target:${f.target.id}`, createdAt: now, updatedAt: now } as MeasurementConnectionRow
  const runs: MeasurementRunRow[] = [], snapshots: MeasurementSnapshotRow[] = []
  const repository = {
    async listConnections() { return [connection] }, async listRuns() { return runs },
    async findRunByIdempotency(_owner: number, key: string) { return runs.find(run => run.idempotencyKey === key) ?? null },
    async insertRun(input: Omit<MeasurementRunRow, 'id' | 'createdAt' | 'updatedAt'>) { const row = { ...input, id: runs.length + 1, createdAt: now, updatedAt: now }; runs.push(row); return row },
    async findRun(_owner: number, id: number) { return runs.find(run => run.id === id) ?? null },
    async acquireRunLease(_owner: number, id: number) { const row = runs.find(run => run.id === id)!; row.state = 'processing'; row.attemptNumber++; return row },
    async releaseRunLease(_owner: number, id: number, _lease: string, state: MeasurementRunRow['state'], _now: Date, patch: Partial<MeasurementRunRow>) { const row = runs.find(run => run.id === id)!; Object.assign(row, patch, { state }); return row },
    async findConnection() { return connection }, async updateConnection(_owner: number, _id: number, patch: Partial<MeasurementConnectionRow>) { Object.assign(connection, patch); return connection },
    async findSnapshot(_owner: number, runId: number, phase: string) { return snapshots.find(row => row.runId === runId && row.phase === phase) ?? null },
    async listSnapshots(_owner: number, runId: number) { return snapshots.filter(row => row.runId === runId) },
    async insertSnapshot(input: Omit<MeasurementSnapshotRow, 'id' | 'createdAt'>) { const row = { ...input, id: snapshots.length + 1, createdAt: now }; snapshots.push(row); return row },
  } as unknown as MeasurementRepository
  f.dependencies.now = now
  const dependencies = { repository, contentOperations: f.db.repository, now,
    resolveSiteMeasurementLineages: (ownerUserId: number, entryId: number, opts: { fresh: boolean; repository?: typeof f.db.repository }) => resolveConfirmedSiteMeasurementLineages(ownerUserId, entryId, { ...f.options, repository: opts.repository ?? f.db.repository, now, fresh: opts.fresh }),
    googleCredentialResolver: vi.fn(async () => ({ accessToken: 'synthetic-token', expiresAt: '2099-01-01T00:00:00.000Z', grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'] })),
    fetcher: vi.fn(async () => new Response(JSON.stringify({ rows: [{ keys: [page], clicks: 10, impressions: 100, position: 4 }] }), { status: 200 })),
  }
  return { repository, runs, snapshots, connection, dependencies }
}

describe('real confirmation core to measurement service composition (synthetic I/O only)', () => {
  it('previews and schedules five checkpoints offline, then collects aggregate data under fresh signed revalidation', async () => {
    const f = await ready(); await f.confirm()
    const m = measurements(f, new Date('2026-10-20T09:00:00.000Z')), before = vi.mocked(f.fetchImpl).mock.calls.length
    expect((await dryRunMeasurementForEntry(1, f.entry.id, m.dependencies)).planned).toHaveLength(5)
    expect((await scheduleMeasurementForEntry(1, f.entry.id, m.dependencies)).scheduled).toBe(5)
    expect((await scheduleMeasurementForEntry(1, f.entry.id, m.dependencies)).runs.map(run => run.id)).toEqual(m.runs.map(run => run.id))
    expect(vi.mocked(f.fetchImpl).mock.calls.length).toBe(before); expect(m.dependencies.fetcher).not.toHaveBeenCalled(); expect(m.dependencies.googleCredentialResolver).not.toHaveBeenCalled()
    const result = await processMeasurementRun(1, m.runs[0]!.id, m.dependencies)
    expect(result.run.state).toBe('succeeded')
    expect(result.assessment).toMatchObject({ evidenceKind: 'site_publication_confirmation', assessment: { status: 'partial', validSourceCount: 1 }, learningCandidate: null })
    expect(m.snapshots).toHaveLength(2); expect(m.dependencies.fetcher).toHaveBeenCalledTimes(2)
    expect(f.db.outcomes).toHaveLength(1); expect(f.db.outcomes[0]).toMatchObject({ runId: null, assessmentStatus: 'partial', assessmentSnapshot: { evidenceKind: 'site_publication_confirmation', learningCandidate: false } })
    expect(f.entry.status).toBe('awaiting_site_review'); expect(f.attempt.status).toBe('draft_received')
    const manifest = await buildOwnerContentLearningDataset(1, f.db.repository)
    expect(JSON.stringify(manifest)).not.toContain(f.db.outcomes[0]!.publicationReceiptFingerprint!)
  })

  it('blocks actual collection with zero Google credential/provider calls after the website is withdrawn', async () => {
    const f = await ready(); await f.confirm()
    const m = measurements(f, new Date('2026-10-20T09:00:00.000Z'))
    await scheduleMeasurementForEntry(1, f.entry.id, m.dependencies)
    f.patchResponse({ state: 'private', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null })
    const result = await processMeasurementRun(1, m.runs[0]!.id, m.dependencies)
    expect(result.run).toMatchObject({ state: 'blocked', errorCode: 'STALE_SITE_PUBLICATION_CONFIRMATION' })
    expect(m.dependencies.googleCredentialResolver).not.toHaveBeenCalled(); expect(m.dependencies.fetcher).not.toHaveBeenCalled()
    expect(m.snapshots).toHaveLength(0); expect(f.db.outcomes).toHaveLength(0)
  })
})
