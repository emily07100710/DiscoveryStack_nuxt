import { describe, expect, it, vi } from 'vitest'
import { collectAuthorizedLearningEvidence, createLearningAuthorization, expireLearningEvidenceCollections, exportStructuralLearningEvidence, getLearningLoopWorkspace, reviewLearningCollection, revokeLearningAuthorization } from '../server/learning-loop/service'
import { resolveLearningAuthority } from '../server/learning-loop/authority'
import { runLearningAcquisitionTick, runLearningClientCycle } from '../server/learning-loop/runtime'
import { learningFixture } from './support/learning-loop-memory-repository'
import type { LearningCrawlerDependencies, LearningCrawlerResult } from '../server/site-evidence/learning-crawler'

function crawlerProjection(authority: NonNullable<Awaited<ReturnType<LearningCrawlerDependencies['resolveCurrentAuthority']>>>): LearningCrawlerResult {
  return { contractVersion: 'learning-crawl-projection-v1', ownerUserId: 1, clientId: 2, sourceId: 3, consentReceiptHash: authority.consentReceiptHash, sourceFingerprint: authority.sourceFingerprint, status: 'completed', reasonCode: null, pagesAttempted: 1, pagesCaptured: 1, duplicatePagesSkipped: 0, pageCap: 20, maxDepth: 2, labels: { aiCitation: 'unknown', searchVisibility: 'unknown', businessOutcome: 'unknown' }, requiresHumanReview: true, pages: [{ urlHash: 'a'.repeat(64), contentHash: 'e'.repeat(64), depth: 0, httpStatus: 200, bytesFetched: 300, structural: { titlePresent: true, h1Present: true, canonicalPresent: true, metaRobotsPresent: false, textLengthBucket: '1-499', anchorCountBucket: '1-4', internalAnchorCountBucket: '1-4' }, evidenceLabel: 'unknown' }] }
}
async function fixture() {
  const f = learningFixture(), deps = { repository: f.repository, now: () => f.now, crawlEnabled: true }
  const created = await createLearningAuthorization(1, f.input, deps)
  const collect = vi.fn(async (selector, dependencies: LearningCrawlerDependencies) => crawlerProjection((await dependencies.resolveCurrentAuthority(selector, f.now))!))
  const body = { authorizationId: created.authorization.id, idempotencyKey: 'crawl-1' }
  return { ...f, deps: { ...deps, collect }, collect, created, body }
}
const review = { decision: 'approved', piiReviewConfirmed: true, structuralOnlyAcknowledged: true }

describe('durable learning consent and bounded acquisition', () => {
  it('hashes dates at actual MySQL timestamp precision and replays subsecond inputs consistently', async () => {
    const f = learningFixture(), now = new Date('2026-10-01T00:00:00.987Z'), input = { ...f.input, expiresAt: '2026-10-31T00:00:00.456Z' }, deps = { repository: f.repository, now: () => now }
    const first = await createLearningAuthorization(1, input, deps)
    expect(first.replayed).toBe(false); expect(first.authorization.usable).toBe(true)
    expect(first.authorization.approvedAt).toBe('2026-10-01T00:00:00.000Z')
    expect(first.authorization.expiresAt).toBe('2026-10-31T00:00:00.000Z')
    expect((await createLearningAuthorization(1, input, deps)).replayed).toBe(true)
  })
  it('purges only expired feature projections, preserves review/consent history and fences stale workers', async () => {
    const f = await fixture(), result = await collectAuthorizedLearningEvidence(1, f.body, f.deps)
    await reviewLearningCollection(1, result.collection.id, review, f.deps)
    const row = f.repository.collections[0]!, reviewHash = row.reviewFingerprint
    expect((await expireLearningEvidenceCollections(99, { ...f.deps, now: () => new Date('2026-11-02T00:00:00Z') })).purgedProjections).toBe(0)
    expect((await expireLearningEvidenceCollections(1, f.deps)).purgedProjections).toBe(0)
    row.status = 'collecting'; row.leaseToken = 'stale-worker'; row.leaseVersion = 2; row.leaseExpiresAt = new Date('2026-12-01T00:00:00Z')
    const after = new Date('2026-11-02T00:00:00Z')
    expect((await expireLearningEvidenceCollections(1, { ...f.deps, now: () => after })).purgedProjections).toBe(1)
    expect(row).toMatchObject({ projection: null, projectionFingerprint: null, errorCode: 'RETENTION_EXPIRED', reviewFingerprint: reviewHash })
    expect(await f.repository.finalizeCollection({ id: row.id, ownerUserId: 1, leaseToken: 'stale-worker', leaseVersion: 2 }, after, { status: 'completed', projection: {}, projectionFingerprint: 'e'.repeat(64), errorCode: null })).toBeNull()
    expect(f.repository.authorizations).toHaveLength(1)
    expect((await expireLearningEvidenceCollections(1, { ...f.deps, now: () => after })).purgedProjections).toBe(0)
  })
  it('keeps publication approval separate and fails closed before any storage when crawl is off', async () => {
    const repository = { getScope: vi.fn(() => { throw new Error('must not construct storage') }) } as any
    await expect(collectAuthorizedLearningEvidence(1, {}, { repository, crawlEnabled: false })).rejects.toMatchObject({ data: { code: 'LEARNING_CRAWL_DISABLED' } })
    expect(repository.getScope).not.toHaveBeenCalled()
    const f = learningFixture()
    await expect(createLearningAuthorization(1, { ...f.input, modelImprovementConsentConfirmed: false }, { repository: f.repository, now: () => f.now })).rejects.toMatchObject({ statusCode: 422 })
    expect(f.repository.authorizations).toHaveLength(0)
  })
  it('derives URL and owner from current storage; browser cannot send URL or owner', async () => {
    const f = await fixture()
    await expect(collectAuthorizedLearningEvidence(1, { ...f.body, url: 'https://other.example.org', ownerUserId: 99 }, f.deps)).rejects.toMatchObject({ statusCode: 422 })
    expect(f.collect).not.toHaveBeenCalled()
    await expect(collectAuthorizedLearningEvidence(99, f.body, f.deps)).rejects.toMatchObject({ data: { code: 'CURRENT_AUTHORIZATION_REQUIRED' } })
  })
  it.each(['terms', 'robots', 'pii', 'origin', 'rights', 'removal', 'source_owner', 'client_paused'])('rejects unready %s before creating authority', async kind => {
    const f = learningFixture(), source = f.repository.sources[0]!, client = f.repository.clients[0]!
    if (kind === 'terms') source.termsStatus = 'prohibits_training'
    if (kind === 'robots') source.robotsStatus = 'unreviewed'
    if (kind === 'pii') source.piiStatus = 'restricted'
    if (kind === 'origin') source.canonicalUrl = 'https://other.example.org/'
    if (kind === 'rights') source.copyrightRisk = 'high'
    if (kind === 'removal') source.removalRequestedAt = f.now
    if (kind === 'source_owner') source.ownerUserId = 99
    if (kind === 'client_paused') client.status = 'paused'
    await expect(createLearningAuthorization(1, f.input, { repository: f.repository, now: () => f.now })).rejects.toMatchObject({ data: { code: 'SOURCE_POLICY_NOT_READY' } })
  })
  it('is replay-safe and rejects changed fields under the same grant/collection key', async () => {
    const f = await fixture()
    expect((await createLearningAuthorization(1, f.input, f.deps)).replayed).toBe(true)
    await expect(createLearningAuthorization(1, { ...f.input, consentReceiptHash: 'e'.repeat(64) }, f.deps)).rejects.toMatchObject({ data: { code: 'IDEMPOTENCY_COLLISION' } })
    const first = await collectAuthorizedLearningEvidence(1, f.body, f.deps)
    const replay = await collectAuthorizedLearningEvidence(1, f.body, f.deps)
    expect(first.collection.status).toBe('completed'); expect(replay.collection.id).toBe(first.collection.id); expect(f.collect).toHaveBeenCalledTimes(1)
    expect(first.collection.usable).toBe(false)
    expect(first.collection.projection?.labels.aiCitation).toBe('unknown')
  })
  it('revalidates revocation during network work and discards the stale projection', async () => {
    const f = await fixture()
    f.collect.mockImplementationOnce(async (selected, dependencies) => { const projection = crawlerProjection((await dependencies.resolveCurrentAuthority(selected, f.now))!); await f.repository.revokeAuthorization(1, 1, f.now); return projection })
    expect((await collectAuthorizedLearningEvidence(1, f.body, f.deps)).collection).toMatchObject({ status: 'failed', projection: null, errorCode: 'AUTHORIZATION_CHANGED_DURING_COLLECTION' })
  })
  it('rejects raw payloads and caller-authored positive citation labels at persistence', async () => {
    const f = await fixture()
    f.collect.mockImplementationOnce(async (selected, dependencies) => ({ ...crawlerProjection((await dependencies.resolveCurrentAuthority(selected, f.now))!), rawHtml: 'secret customer contact', labels: { aiCitation: 'cited', searchVisibility: 'unknown', businessOutcome: 'unknown' } } as any))
    expect((await collectAuthorizedLearningEvidence(1, f.body, f.deps)).collection).toMatchObject({ status: 'failed', projection: null })
    expect(JSON.stringify(f.repository.collections)).not.toContain('secret customer')
  })
  it('requires immutable owner review and excludes revoked/expired/source-drift evidence from releases', async () => {
    const f = await fixture(); const collected = await collectAuthorizedLearningEvidence(1, f.body, f.deps)
    expect((await exportStructuralLearningEvidence(1, f.deps)).rowCount).toBe(0)
    expect((await reviewLearningCollection(1, collected.collection.id, review, f.deps)).collection.usable).toBe(true)
    expect((await exportStructuralLearningEvidence(1, f.deps))).toMatchObject({ rowCount: 1, citationTrainingEligible: false, labels: 'unknown' })
    await expect(reviewLearningCollection(1, collected.collection.id, { ...review, decision: 'rejected' }, f.deps)).rejects.toMatchObject({ data: { code: 'COLLECTION_REVIEW_CONFLICT' } })
    f.repository.sources[0]!.sourceFingerprint = 'f'.repeat(64)
    expect((await exportStructuralLearningEvidence(1, f.deps)).rowCount).toBe(0)
    f.repository.sources[0]!.sourceFingerprint = 'd'.repeat(64)
    await revokeLearningAuthorization(1, 1, f.deps)
    expect((await exportStructuralLearningEvidence(1, f.deps)).rowCount).toBe(0)
    expect((await getLearningLoopWorkspace(1, f.deps)).collections[0]?.usable).toBe(false)
  })
  it('does not reuse a stored grant that was tampered, future-dated or expired', async () => {
    const f = await fixture(), scope = await f.repository.getScope(1, 1)
    expect(resolveLearningAuthority(scope, { ownerUserId: 1, clientId: 2, sourceId: 3 }, f.now)).not.toBeNull()
    scope!.authorization.consentReceiptHash = 'f'.repeat(64)
    expect(resolveLearningAuthority(scope, { ownerUserId: 1, clientId: 2, sourceId: 3 }, f.now)).toBeNull()
    const fresh = await f.repository.getScope(1, 1)
    expect(resolveLearningAuthority(fresh, { ownerUserId: 1, clientId: 2, sourceId: 3 }, new Date('2026-11-01T00:00:00Z'))).toBeNull()
  })
  it('prevents concurrent collection workers from double-fetching', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 8 }, () => collectAuthorizedLearningEvidence(1, f.body, f.deps)))
    expect(f.collect).toHaveBeenCalledTimes(1); expect(new Set(results.map(result => result.collection.id)).size).toBe(1)
  })
  it('acquires at most once per grant/day and never silently reviews or trains the result', async () => {
    const f = await fixture(), deps = { ...f.deps, enabled: true }
    expect(await runLearningAcquisitionTick(1, deps)).toMatchObject({ collected: 1, reviewStatus: 'pending' })
    expect(await runLearningAcquisitionTick(1, deps)).toMatchObject({ status: 'daily_acquisition_complete', collected: 0 })
    expect(f.collect).toHaveBeenCalledTimes(1)
  })
  it('recovers an expired daily acquisition lease after a worker crash instead of starving until tomorrow', async () => {
    const f = await fixture(), deps = { ...f.deps, enabled: true }
    await runLearningAcquisitionTick(1, deps)
    const row = f.repository.collections[0]!
    Object.assign(row, { status: 'collecting', projection: null, projectionFingerprint: null, leaseToken: 'crashed-worker', leaseExpiresAt: new Date(f.now.getTime() - 1000) })
    const version = row.leaseVersion
    expect(await runLearningAcquisitionTick(1, deps)).toMatchObject({ status: 'completed', collected: 1 })
    expect(f.collect).toHaveBeenCalledTimes(2)
    expect(row.leaseVersion).toBe(version + 1)
    expect((await runLearningAcquisitionTick(1, deps)).collected).toBe(0)
  })
  it('a selected customer cycle never advances another customer or bypasses deployment flags', async () => {
    const f = await fixture(), weekly = vi.fn(async (_input: unknown) => ({ status: 'disabled' } as any)), reconcile = vi.fn(async (_owner: number, _operations: unknown, _deps: unknown, _clientId?: number) => ({ status: 'completed' } as any))
    await expect(runLearningClientCycle(1, { clientId: 2 }, { ...f.deps, enabled: false, weekly })).rejects.toMatchObject({ data: { code: 'LEARNING_LOOP_DISABLED' } })
    expect(weekly).not.toHaveBeenCalled()
    await runLearningClientCycle(1, { clientId: 2 }, { ...f.deps, enabled: true, operations: {} as any, weekly, reconcile })
    expect(weekly).toHaveBeenCalledExactlyOnceWith({ ownerUserId: 1, clientId: 2, maxClients: 1 })
    expect(reconcile.mock.calls[0]?.[3]).toBe(2)
    await expect(runLearningClientCycle(99, { clientId: 2 }, { ...f.deps, enabled: true, weekly })).rejects.toMatchObject({ data: { code: 'CURRENT_CLIENT_REQUIRED' } })
  })
})
