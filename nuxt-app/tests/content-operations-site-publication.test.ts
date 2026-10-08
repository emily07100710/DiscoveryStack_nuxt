import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createOwnerPublicationTarget } from '../server/content-operations/orchestrator'
import { singleDraftReceiptFingerprint } from '../server/content-operations/draft-receipt'
import { checkOwnerSitePublication, projectSitePublicationHistory, sitePublicationContext } from '../server/content-operations/site-publication'
import { getOwnerContentOperationsWorkspace, recordOwnerOutcomeAssessment } from '../server/content-operations/service'
import { ContentOperationsFixture, HASH } from './fixtures/content-operations/repository'
import type { FirstPartyFetch } from '../server/first-party-publishing/types'
import { normalizeFirstPartyDraftReceipt } from '../server/first-party-publishing/draft-receipt'

const NOW = new Date('2026-10-08T09:00:00.000Z')
const SECRET = 'synthetic-site-status-secret-000000000000'
const BODY_HASH = 'b'.repeat(64)
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
  Object.assign(entry, { status: 'awaiting_site_review', publicationTargetId: target.id, jobId: 800, draftId: 801, contentHash: HASH, language: 'zh-hant' })
  const receipt = { status: 'draft_received' as const, published: false as const, receiptScope: 'draft_ingest_outcome' as const, receiptIsCurrentState: false as const,
    publicationId: `deliverable-${entry.productionDeliverableId}`, contentHash: BODY_HASH, postId: '9b131e17-a5c2-45e1-a40f-44b6084de9b1', postVersion: 1 as const, replayed: false }
  const attempt = await db.repository.insertPublicationAttempt({ ownerUserId: 1, clientId: client.id, entryId: entry.id, runId: 802, targetId: target.id,
    mode: 'execute', attemptNumber: 1, idempotencyKey: 'initial-ingest-0001', inputFingerprint: 'd'.repeat(64), publicationId: `publication-${entry.id}`,
    publicationSlug: 'fixture-article', publicationPath: 'journal/zh-hant/articles/fixture-article.md', contentHash: HASH, publicationContentHash: BODY_HASH,
    evidenceSnapshotHash: entry.evidenceSnapshotHash, artifactFingerprint: 'e'.repeat(64), status: 'draft_received', remoteState: 'draft_received',
    receiptLedger: [receipt], receiptFingerprint: null, publicationUrl: null, remoteRevision: null, errorCode: null, errorSummary: null, startedAt: NOW, completedAt: NOW })
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

describe('owner site-publication observation ledger', () => {
  it('records a signed matching publication without upgrading the ingest attempt, entry, authorization or learning', async () => {
    const f = await fixture(), before = structuredClone(f.attempt)
    const updateEntry = vi.spyOn(f.db.repository, 'updateEntry'), updateAttempt = vi.spyOn(f.db.repository, 'finalizePublicationAttempt'), authorize = vi.spyOn(f.db.repository, 'transitionMachineAuthorization')
    const result = await f.run()
    expect(result).toMatchObject({ status: 'verified', replayed: false, workflowChanged: false, learningAuthorized: false, observation: { state: 'published', contentMatch: 'matched', receiptIsCurrentState: false } })
    expect(f.entry.status).toBe('awaiting_site_review')
    expect(f.attempt).toEqual(before)
    expect(updateEntry).not.toHaveBeenCalled(); expect(updateAttempt).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled()
    expect(f.db.events).toHaveLength(1); expect(f.db.outcomes).toHaveLength(0)
    expect(f.projection()).toEqual(result.observation)
    expect(JSON.stringify(result)).not.toContain(f.attempt.receiptFingerprint!)
    const workspace = await getOwnerContentOperationsWorkspace(1, f.db.repository)
    expect(workspace.entries.find(row => row.id === f.entry.id)).toMatchObject({ latestSitePublication: result.observation, sitePublicationCheckAvailable: true, nextAction: 'wait' })
    await expect(recordOwnerOutcomeAssessment(1, { entryId: f.entry.id, idempotencyKey: 'outcome-fixture-0001', baselineMeasurements: [], followUpMeasurements: [], consent: {}, dataContractVersion: 'synthetic-v1', learningCandidate: true }, f.db.repository)).rejects.toBeDefined()
  })

  it('replays the original receipt without another remote query or a fresh observation timestamp', async () => {
    const f = await fixture(), original = await f.run()
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    expect(await f.run()).toEqual({ ...original, replayed: true })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(f.db.events).toHaveLength(1)
  })

  it('isolates two bound target observations and rejects reusing one command key for another target', async () => {
    const f = await fixture()
    const second = { ...f.target, id: 10001, targetId: 'synthetic-second-target', targetOrigin: 'https://second.doalignment.com', configurationFingerprint: 'f'.repeat(64) }
    f.db.targets.push(second)
    for (const [index, target] of [f.target, second].entries()) {
      await f.db.repository.insertEntryTargetBinding({ ownerUserId: 1, clientId: f.client.id, entryId: f.entry.id, targetId: target.id, slot: index + 1, bindingFingerprint: sha(`synthetic-binding-${target.id}`) })
    }
    if (!Array.isArray(f.attempt.receiptLedger)) throw new Error('Synthetic receipt ledger must be an array')
    const originalReceipt = normalizeFirstPartyDraftReceipt(f.attempt.receiptLedger[0])
    if (!originalReceipt) throw new Error('Synthetic original draft receipt must be valid')
    const receipt = { ...originalReceipt, postId: 'ab131e17-a5c2-45e1-a40f-44b6084de9b1' }
    const secondAttempt = { ...f.attempt, id: 10002, targetId: second.id, idempotencyKey: 'second-target-ingest', receiptLedger: [receipt] }
    secondAttempt.receiptFingerprint = singleDraftReceiptFingerprint(secondAttempt, receipt)
    f.db.attempts.push(secondAttempt)
    await f.run('first-target-status-key')
    const secondValue = { targetRowId: second.id, idempotencyKey: 'first-target-status-key' }
    await expect(f.run('ignored-external-key', { value: secondValue })).rejects.toMatchObject({ statusCode: 409 })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    f.patchResponse({ state: 'private', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null })
    await f.run('ignored-external-key', { value: { ...secondValue, idempotencyKey: 'second-target-status-key' } })
    const workspace = await getOwnerContentOperationsWorkspace(1, f.db.repository)
    const projected = workspace.entries.find(row => row.id === f.entry.id)!
    expect(projected.latestSitePublication).toBeNull()
    expect(projected.publicationTargetBindings).toHaveLength(2)
    expect(projected.publicationTargetBindings[0]?.latestAttempt).toMatchObject({ sitePublication: { state: 'published', contentMatch: 'matched' }, sitePublicationCheckAvailable: true })
    expect(projected.publicationTargetBindings[1]?.latestAttempt).toMatchObject({ sitePublication: { state: 'private', contentMatch: 'not_published' }, sitePublicationCheckAvailable: true })
    expect(f.entry.status).toBe('awaiting_site_review')
    expect(f.db.events).toHaveLength(2)
  })

  it.each([
    [{ publishedDocumentHash: 'f'.repeat(64) }, 'changed'],
    [{ receivedDocumentHash: null }, 'unverifiable'],
    [{ postVersion: 3, hasUnpublishedChanges: true }, 'matched'],
    [{ state: 'private', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null }, 'not_published'],
    [{ state: 'archived', postVersion: 4, publishedVersion: null, publishedDocumentHash: null, publishedAt: null }, 'not_published'],
  ])('keeps remote state separate from DS consent and workflow (%s)', async (patch, match) => {
    const f = await fixture(); f.patchResponse(patch)
    expect((await f.run()).observation.contentMatch).toBe(match)
    expect(f.entry.status).toBe('awaiting_site_review'); expect(f.attempt.status).toBe('draft_received')
  })

  it('uses the most recent observation even if the remote version regresses, and retains historical records', async () => {
    const f = await fixture(); f.patchResponse({ postVersion: 5, publishedVersion: 5 })
    await f.run('site-check-high-version')
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    f.patchResponse({ state: 'private', postVersion: 1, publishedVersion: null, publishedDocumentHash: null, publishedAt: null })
    await f.run('site-check-after-rollback')
    expect(f.projection()).toMatchObject({ state: 'private', observedAt: f.dependencies.now.toISOString() })
    expect(f.db.events).toHaveLength(2)
  })

  it('refuses nonce reuse with a different owner command key', async () => {
    const f = await fixture(); f.dependencies.nonceProvider = () => 'fixed-synthetic-nonce'
    await f.run()
    await expect(f.run('new-key-same-nonce')).rejects.toMatchObject({ statusCode: 409 })
    expect(f.db.events).toHaveLength(1)
  })

  it('revalidates target configuration after the read and rolls back storage on drift', async () => {
    const f = await fixture(); f.onRead(() => { f.target.configurationFingerprint = 'f'.repeat(64) })
    await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
    expect(f.db.events).toHaveLength(0)
  })

  it('fails closed on receipt corruption, target pause and cross-owner lookup before any remote request', async () => {
    const f = await fixture(); f.attempt.receiptFingerprint = '0'.repeat(64)
    await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
    expect(f.fetchImpl).not.toHaveBeenCalled()
    const g = await fixture(); g.target.status = 'paused'
    await expect(g.run()).rejects.toMatchObject({ statusCode: 409 }); expect(g.fetchImpl).not.toHaveBeenCalled()
    const h = await fixture()
    await expect(h.run('cross-owner-query', { ownerUserId: 2 })).rejects.toMatchObject({ statusCode: 404 }); expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it('does not turn a 404/503/invalid signature into deletion or unpublished state', async () => {
    const f = await fixture(); await f.run(); const original = f.projection()
    f.status(404)
    await expect(f.run('site-check-missing-0001')).rejects.toMatchObject({ statusCode: 503 })
    expect(f.projection()).toEqual(original); expect(f.db.events).toHaveLength(1)
  })

  it('does not hide corrupted latest metadata behind an older published record', async () => {
    const f = await fixture(); await f.run()
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    await f.run('site-check-second-0001')
    const latest = f.db.events[1]!
    latest.metadata = { ...(latest.metadata as Record<string, unknown>), contextFingerprint: '0'.repeat(64) }
    expect(f.projection()).toBeNull()
  })

  it('checks a new target context without reusing its prior-context positive observation', async () => {
    const f = await fixture(); await f.run()
    f.target.configurationFingerprint = 'f'.repeat(64)
    expect(f.projection()).toBeNull()
    await expect(f.run()).rejects.toMatchObject({ statusCode: 409 })
    f.dependencies.now = new Date(NOW.getTime() + 60_000)
    f.patchResponse({ state: 'private', postVersion: 3, publishedVersion: null, publishedDocumentHash: null, publishedAt: null })
    await f.run('site-check-new-context')
    expect(f.projection()).toMatchObject({ state: 'private' })
  })

  it('rejects incomplete bounded history and unknown authority fields', async () => {
    const f = await fixture()
    f.db.repository.listSitePublicationEvents = async () => Array.from({ length: 501 }, () => ({ eventType: 'site_publication_observed' })) as never
    await expect(f.run()).rejects.toMatchObject({ statusCode: 409 }); expect(f.fetchImpl).not.toHaveBeenCalled()
    const g = await fixture()
    await expect(g.run('authority-injection', { value: { targetRowId: g.target.id, idempotencyKey: 'fixture-command-key', published: true, ownerUserId: 1 } })).rejects.toMatchObject({ statusCode: 422 })
    expect(g.fetchImpl).not.toHaveBeenCalled()
  })
})
