import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import { buildPublicationIdentity, validatePersistedPublicationIdentity } from '../server/content-operations/publication-identity'
import { createOwnerPublicationTarget, executeContentOperationEntry, runContentOperationsExecutionTick } from '../server/content-operations/orchestrator'
import { enableOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { BoundedFetchNetworkError, BoundedFetchTimeoutError, createBoundedFetch } from '../server/content-operations/bounded-fetch'
import { createSecureFirstPartyNonce } from '../server/content-operations/runtime-dependencies'
import { parseCredentialRegistryForTests, resolveServerCredential } from '../server/content-operations/credential-resolver'
import type { ContentOperationPublicationTargetRow, ContentOperationRunRow } from '../server/content-operations/types'
import { ContentOperationsFixture, fixtureClient, HASH } from './fixtures/content-operations/repository'

const NOW = new Date('2026-01-10T09:00:00.000Z')
const BODY = 'Direct answer\n\nEvidence-bound body.'
const BODY_HASH = createHash('sha256').update(BODY, 'utf8').digest('hex')

function targetInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'target-key-1', framework: 'nuxt', transport: 'first_party_git', targetOrigin: 'https://api.github.com', contentRoot: 'content', defaultBranch: 'main', repositoryOwner: 'owner', repositoryName: 'repository', endpointPath: null, credentialReference: 'server-ref-1', allowedContentTypes: ['article', 'faq', 'service_page'], allowedLanguages: ['en', 'zh-hant'], maximumPayloadBytes: 1000000, executionEnabled: true, ...overrides,
  }
}

function attachLineage(fixture: ContentOperationsFixture, entryId: number, target: ContentOperationPublicationTargetRow | null) {
  const entry = fixture.entries.find(item => item.id === entryId)!
  const calendar = fixture.calendars.find(item => item.id === entry.calendarId)!
  const client = fixture.clients.find(item => item.id === calendar.clientId)!
  let review: Record<string, unknown> | null = null
  const job = { id: 700, ownerUserId: entry.ownerUserId, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 701, status: 'approved' }
  const draft = { id: 702, jobId: job.id, version: 1, title: 'Verified draft', body: BODY, contentHash: BODY_HASH, provenance: { stage: 'optimized', providerExecution: true, provider: 'bailian', providerVersion: 'qwen-plus', model: 'bailian:qwen-plus', qualityGateVersion: 'content-risk-gate-v1', selectedRuleIds: ['rule-topic'], appliedRuleIds: ['rule-topic'] }, safetyStatus: 'passed', evidenceRefs: [] }
  let gate: Record<string, unknown> = { id: 703, draftId: draft.id, status: 'passed', evidenceSnapshotHash: entry.evidenceSnapshotHash }
  const repository = fixture.repository as ContentOperationsRepository
  repository.findLatestOptimizedDraft = async () => draft
  repository.findRiskGate = async () => gate as never
  repository.findLatestReview = async () => review as never
  const workspace = { entry, calendar, client, target, deliverable: { id: entry.productionDeliverableId, ownerUserId: entry.ownerUserId, planId: calendar.productionPlanId, briefId: job.briefId, jobId: job.id, selectionId: entry.strategyRecommendationId, contentType: entry.contentType, title: 'Verified draft', audience: 'owner audience', language: entry.language, evidenceSnapshotHash: entry.evidenceSnapshotHash, opportunityKey: '1:opportunity-1', provenance: {}, status: 'approved' }, job, draft, review: review as never, riskGate: gate as never }
  repository.resolveWorkspaceEntry = async (_owner, requestedEntryId) => requestedEntryId === entry.id ? workspace as never : null
  return { fixture, workspace, repository, entry, target, job, draft, setReview(value: Record<string, unknown> | null) { review = value; workspace.review = value as never }, setGate(value: Record<string, unknown>) { gate = value; workspace.riskGate = value as never } }
}

async function readyFixture(): Promise<ReturnType<typeof attachLineage>> {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(1)
  const calendar = await fixture.addCalendar(1, '2026-01-10', 1)
  const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
  entry.status = 'ready_to_publish'
  entry.jobId = 700
  entry.draftId = 702
  entry.contentHash = BODY_HASH
  const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
  const target = fixture.targets.find(item => item.id === targetResult.target.id)!
  const lineage = attachLineage(fixture, entry.id, target)
  lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
  return lineage
}

async function queuePublicationFixture() {
  const lineage = await readyFixture()
  lineage.entry.status = 'awaiting_review'
  const synced = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'queue-review', mode: 'dry_run' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => ({ status: 'dry_run', preview: { mode: 'dry_run', method: 'PUT', url: 'https://api.github.com', targetOrigin: 'https://api.github.com', path: 'content/en/articles/verified.md', branch: 'main', bodyBytes: 10, bodyIncluded: false, headerNames: [], includesAuthorization: false, includesSecret: false, redirect: 'manual' } }) } })
  expect(synced.outcome).toBe('ready_to_publish')
  return lineage
}

function schedulerKey(runId: number, attemptNumber: number): string {
  return `scheduler:publication:${runId}:attempt:${attemptNumber}`
}

describe('content operations execution adversarial hardening', () => {
  it('runs the real tick through execute attempts 1, 2, and 3 with due backoff and no fourth publisher call', async () => {
    const lineage = await queuePublicationFixture()
    await enableOwnerAutopilot(1, lineage.workspace.client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, lineage.repository, NOW)
    let calls = 0
    const publisher = async () => { calls += 1; return { status: 'retryable_failure' as const, code: 'REMOTE_RATE_LIMITED' as const, reasons: ['synthetic rate limit'], httpStatus: 429 } }
    const dependencies = { repository: lineage.repository, publicationExecutor: publisher }
    const run = lineage.repository['listRuns'] ? (await lineage.repository.listRuns(1, lineage.entry.id)).find(item => item.stage === 'publication')! : null
    expect(run).toBeTruthy()
    const firstTick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: lineage.repository, dependencies: { publicationExecutor: publisher } })
    expect(firstTick.processed).toBe(1)
    expect(firstTick.results[0]?.outcome).toBe('retry_wait')
    expect(calls).toBe(1)
    expect(lineage.repository).toBe(dependencies.repository)
    const publicationRun = (await lineage.repository.listRuns(1, lineage.entry.id)).find(item => item.stage === 'publication')!
    expect(publicationRun.attemptNumber).toBe(1)
    expect(lineage.repository['listPublicationAttempts']).toBeTypeOf('function')
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id)).map(attempt => attempt.idempotencyKey)).toContain(schedulerKey(publicationRun.id, 1))

    const early = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 4 * 60 * 1000), repository: lineage.repository, dependencies: { publicationExecutor: publisher } })
    expect(early.processed).toBe(0)
    expect(calls).toBe(1)

    const secondTick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 6 * 60 * 1000), repository: lineage.repository, dependencies: { publicationExecutor: publisher } })
    expect(secondTick.processed).toBe(1)
    expect(calls).toBe(2)
    expect((await lineage.repository.listRuns(1, lineage.entry.id)).find(item => item.stage === 'publication')?.attemptNumber).toBe(2)

    const thirdTick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 37 * 60 * 1000), repository: lineage.repository, dependencies: { publicationExecutor: publisher } })
    expect(thirdTick.processed).toBe(1)
    expect(calls).toBe(3)
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id)).filter(attempt => attempt.mode === 'execute').map(attempt => attempt.attemptNumber).sort((left, right) => left - right)).toEqual([1, 2, 3])
    const afterLimit = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 90 * 60 * 1000), repository: lineage.repository, dependencies: { publicationExecutor: publisher } })
    expect(afterLimit.processed).toBe(0)
    expect(calls).toBe(3)
  })

  it('does not count repeated dry-runs against the three execute attempts', async () => {
    const lineage = await readyFixture()
    const dryPublisher = async () => ({ status: 'dry_run' as const, preview: { mode: 'dry_run' as const, method: 'PUT' as const, url: 'https://api.github.com', targetOrigin: 'https://api.github.com', path: 'content/en/articles/verified.md', branch: 'main', bodyBytes: 10, bodyIncluded: false as const, headerNames: [] as string[], includesAuthorization: false as const, includesSecret: false as const, redirect: 'manual' as const } })
    for (const key of ['dry-1', 'dry-2', 'dry-3']) {
      const result = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: key, mode: 'dry_run' }, dependencies: { repository: lineage.repository, publicationExecutor: dryPublisher } })
      expect(result.outcome).toBe('dry_run_succeeded')
    }
    let executeCalls = 0
    const execute = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'execute-after-dry', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => { executeCalls += 1; return { status: 'retryable_failure' as const, code: 'REMOTE_RATE_LIMITED' as const, reasons: ['synthetic'] } } } })
    expect(execute.outcome).toBe('retry_wait')
    expect(executeCalls).toBe(1)
    const attempts = await lineage.repository.listPublicationAttempts(1, lineage.entry.id)
    expect(attempts.filter(attempt => attempt.mode === 'dry_run').map(attempt => attempt.attemptNumber).sort((left, right) => left - right)).toEqual([1, 2, 3])
    expect(attempts.filter(attempt => attempt.mode === 'execute').map(attempt => attempt.attemptNumber)).toEqual([1])
  })

  it('records a dry-run block without consuming execute attempts or creating retry_wait', async () => {
    const lineage = await readyFixture()
    const result = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'dry-blocked', mode: 'dry_run' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => ({ status: 'blocked' as const, code: 'CREDENTIAL_MISSING' as const, reasons: ['synthetic missing credential'] }) } })
    expect(result.outcome).toBe('blocked')
    expect(result.retryAt).toBeNull()
    expect(lineage.entry.status).not.toBe('delivered')
    expect((await lineage.repository.listRuns(1, lineage.entry.id)).find(run => run.stage === 'publication')?.state).toBe('queued')
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id)).at(-1)?.status).toBe('blocked')
  })

  it('invalidates old delivery approval when the latest review is changes_requested or rejected', async () => {
    for (const decision of ['changes_requested', 'rejected'] as const) {
      const lineage = await readyFixture()
      lineage.setReview({ id: decision === 'changes_requested' ? 705 : 706, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision, evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash })
      lineage.job.status = decision === 'changes_requested' ? 'needs_human_review' : 'blocked'
      lineage.workspace.deliverable.status = decision === 'changes_requested' ? 'needs_human_review' : 'blocked'
      let calls = 0
      const result = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: `latest-${decision}`, mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => { calls += 1; return { status: 'delivered' as const, remoteState: 'created' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic', artifactFingerprint: HASH, idempotencyKey: 'synthetic' } } } })
      expect(calls).toBe(0)
      expect(result.outcome).toBe(decision === 'changes_requested' ? 'awaiting_review' : 'blocked')
      expect(lineage.entry.status).toBe(decision === 'changes_requested' ? 'awaiting_review' : 'blocked')
      expect(decision === 'changes_requested' ? lineage.entry.reviewId : lineage.entry.reviewId).toBe(decision === 'changes_requested' ? null : 706)
    }
  })

  it('rebinds review_wait to a newer optimized draft and clears old review without approval', async () => {
    const lineage = await readyFixture()
    lineage.entry.status = 'awaiting_review'
    lineage.entry.reviewId = 704
    const newerDraft = { ...lineage.draft, id: 709, version: 2, title: 'Newer optimized draft', contentHash: createHash('sha256').update('new body', 'utf8').digest('hex') }
    lineage.repository.findLatestOptimizedDraft = async () => newerDraft as never
    lineage.repository.findLatestReview = async () => null
    const result = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'revision-rebind', mode: 'dry_run' }, dependencies: { repository: lineage.repository } })
    expect(result.outcome).toBe('awaiting_review')
    expect(lineage.entry.draftId).toBe(709)
    expect(lineage.entry.contentHash).toBe(newerDraft.contentHash)
    expect(lineage.entry.reviewId).toBeNull()
    expect((await lineage.repository.listRuns(1, lineage.entry.id)).filter(item => item.stage === 'review_wait')).toHaveLength(2)
  })

  it('cancels a queued publication run when a newer changes_requested review wins the race', async () => {
    const lineage = await readyFixture()
    const publicationRun: ContentOperationRunRow = { id: 812, ownerUserId: 1, entryId: lineage.entry.id, stage: 'publication', state: 'queued', attemptNumber: 1, idempotencyKey: 'race-publication-run', inputFingerprint: 'a'.repeat(64), outputFingerprint: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: NOW, completedAt: null, createdAt: NOW, updatedAt: NOW }
    lineage.fixture.runs.push(publicationRun)
    lineage.fixture.attempts.push({ id: 813, ownerUserId: 1, clientId: lineage.workspace.client.id, entryId: lineage.entry.id, runId: publicationRun.id, targetId: lineage.target!.id, attemptNumber: 1, mode: 'execute', idempotencyKey: 'race-attempt', inputFingerprint: 'b'.repeat(64), publicationId: `publication-${lineage.entry.id}`, publicationSlug: lineage.entry.publicationSlug || 'verified', publicationPath: lineage.entry.publicationPath || 'content/en/articles/verified.md', contentHash: BODY_HASH, evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash, artifactFingerprint: null, status: 'planned', remoteState: null, remoteRevision: null, errorCode: null, errorSummary: null, startedAt: NOW, completedAt: null, createdAt: NOW })
    lineage.setReview({ id: 814, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'changes_requested', evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash })
    let calls = 0
    const result = await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'race-review', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => { calls += 1; return { status: 'delivered' as const, remoteState: 'created' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic', artifactFingerprint: HASH, idempotencyKey: 'synthetic' } } } })
    expect(calls).toBe(0)
    expect(result.outcome).toBe('awaiting_review')
    expect(lineage.entry.status).toBe('awaiting_review')
    expect(publicationRun.state).toBe('cancelled')
    expect(lineage.fixture.attempts.find(attempt => attempt.id === 813)?.status).toBe('planned')
  })

  it('uses the newest blocked risk gate instead of an older passed gate', async () => {
    const lineage = await readyFixture()
    lineage.setGate({ id: 710, draftId: lineage.draft.id, status: 'blocked', evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash })
    let calls = 0
    await expect(executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'blocked-latest-gate', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => { calls += 1; return { status: 'delivered' as const, remoteState: 'created' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic', artifactFingerprint: HASH, idempotencyKey: 'synthetic' } } } })).rejects.toMatchObject({ statusCode: 422 })
    expect(calls).toBe(0)
  })

  it('parses credential registry absent, malformed, and valid without exposing values', () => {
    const original = process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON
    try {
      delete process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON
      expect(resolveServerCredential('server-ref-1')).toEqual({ ok: false, reason: 'unavailable' })
      expect(parseCredentialRegistryForTests('{')).toEqual({ ok: false })
      process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON = JSON.stringify({ 'server-ref-1': 'synthetic-value' })
      expect(resolveServerCredential('server-ref-1')).toEqual({ ok: true, value: 'synthetic-value' })
      expect(parseCredentialRegistryForTests(process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON)).toEqual({ ok: true, references: ['server-ref-1'] })
      expect(JSON.stringify(parseCredentialRegistryForTests(process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON))).not.toContain('synthetic-value')
      process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON = JSON.stringify({ constructor: 'synthetic-value' })
      expect(resolveServerCredential('constructor')).toEqual({ ok: false, reason: 'unavailable' })
    } finally {
      if (original === undefined) delete process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON
      else process.env.DISCOVERYSTACK_FIRST_PARTY_CREDENTIALS_JSON = original
    }
  })

  it('uses a cryptographically secure nonce that satisfies the existing opaque nonce policy', () => {
    const nonce = createSecureFirstPartyNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/)
    expect(readFileSync(new URL('../server/content-operations/runtime-dependencies.ts', import.meta.url), 'utf8')).not.toContain('Math.random')
  })

  it('aborts a pending mocked native fetch and does not pass timeoutMs to native fetch', async () => {
    let observed: Record<string, unknown> | undefined
    const nativeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      observed = init as Record<string, unknown>
      return await new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true }))
    })
    const bounded = createBoundedFetch({ nativeFetch: nativeFetch as unknown as typeof fetch })
    await expect(bounded('https://synthetic.example', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual', timeoutMs: 20 })).rejects.toBeInstanceOf(BoundedFetchTimeoutError)
    expect(nativeFetch).toHaveBeenCalledTimes(1)
    expect(observed).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual' })
    expect(observed).not.toHaveProperty('timeoutMs')
    expect(observed?.signal).toBeDefined()
  })

  it('stops reading a response stream as soon as the configured body limit is exceeded', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new TextEncoder().encode('abcd'))
        if (pulls >= 100) controller.close()
      },
    })
    const nativeFetch = vi.fn(async () => new Response(body, { status: 200 }))
    const bounded = createBoundedFetch({ nativeFetch: nativeFetch as unknown as typeof fetch, maxResponseBodyBytes: 7 })
    await expect(bounded('https://synthetic.example', { method: 'GET', headers: {}, redirect: 'manual', timeoutMs: 1000 })).rejects.toBeInstanceOf(BoundedFetchNetworkError)
    expect(pulls).toBeLessThan(10)
  })

  it('passes the exact review and risk-gate lineage into the atomic execute reservation', async () => {
    const lineage = await readyFixture()
    const originalReserve = lineage.repository.reservePublicationAttempt
    let reservationInput: Record<string, unknown> | null = null
    lineage.repository.reservePublicationAttempt = async input => {
      reservationInput = input as unknown as Record<string, unknown>
      return originalReserve(input)
    }
    await executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'bound-reservation', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async input => ({ status: 'delivered', remoteState: 'created', publicationId: input.publication.productionDeliverableId, contentHash: input.publication.contentHash, remoteRevision: 'commit-bound', artifactFingerprint: HASH, idempotencyKey: 'bound-reservation' }) } })
    expect(reservationInput).toMatchObject({ jobId: lineage.job.id, draftId: lineage.draft.id, reviewId: 704, riskGateId: 703 })
  })

  it('enforces the active target slot under concurrent create and includes credential reference in collision fingerprint', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const results = await Promise.allSettled([
      createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'parallel-a' }), fixture.repository),
      createOwnerPublicationTarget(1, client.id, targetInput({ idempotencyKey: 'parallel-b' }), fixture.repository),
    ])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(item => item.status === 'rejected' && /active publication target|active slot/i.test(String(item.reason))).length).toBe(1)
    const replayFixture = new ContentOperationsFixture()
    const replayClient = replayFixture.addClient(1)
    await createOwnerPublicationTarget(1, replayClient.id, targetInput({ idempotencyKey: 'same-target', credentialReference: 'server-ref-a' }), replayFixture.repository)
    await expect(createOwnerPublicationTarget(1, replayClient.id, targetInput({ idempotencyKey: 'same-target', credentialReference: 'server-ref-b' }), replayFixture.repository)).rejects.toThrow(/idempotency|configuration/i)
  })

  it('revalidates persisted publication identity against entry, target, origin, root, path, slug, and fingerprint', () => {
    const base = { clientId: 1, entryId: 11, targetId: 'target-1', targetOrigin: 'https://api.github.com', contentRoot: 'content', contentType: 'article' as const, language: 'en' as const, title: 'Identity test', ownerScopeKey: 'owner-1' }
    const built = buildPublicationIdentity(base)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(validatePersistedPublicationIdentity({ ...base, existingIdentity: built.identity }).ok).toBe(true)
    for (const mutated of [
      { ...built.identity, publicationId: 'publication-12' },
      { ...built.identity, path: 'content/en/articles/tampered.md' },
      { ...built.identity, slug: 'tampered-slug' },
      { ...built.identity, identityFingerprint: 'b'.repeat(64) },
    ]) expect(validatePersistedPublicationIdentity({ ...base, existingIdentity: mutated }).ok).toBe(false)
    expect(validatePersistedPublicationIdentity({ ...base, targetId: 'target-2', existingIdentity: built.identity }).ok).toBe(false)
    expect(validatePersistedPublicationIdentity({ ...base, targetOrigin: 'https://other.example', existingIdentity: built.identity }).ok).toBe(false)
    expect(validatePersistedPublicationIdentity({ ...base, contentRoot: 'docs', existingIdentity: built.identity }).ok).toBe(false)
  })

  it('reserves planned attempt before publisher, allows one shared-key winner, recovers planned row, and never rewrites terminal row', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-01-10', 2)
    const first = fixture.entries.find(item => item.calendarId === calendar.id && item.productionDeliverableId === 1)!
    const second = fixture.entries.find(item => item.calendarId === calendar.id && item.productionDeliverableId === 2)!
    first.status = 'ready_to_publish'; second.status = 'ready_to_publish'
    first.jobId = 700; first.draftId = 702; second.jobId = 700; second.draftId = 702
    const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(item => item.id === targetResult.target.id)!
    const firstLineage = attachLineage(fixture, first.id, target)
    const secondLineage = attachLineage(fixture, second.id, target)
    fixture.repository.resolveWorkspaceEntry = async (_owner, requestedEntryId) => requestedEntryId === first.id ? firstLineage.workspace as never : secondLineage.workspace as never
    firstLineage.setReview({ id: 704, jobId: firstLineage.job.id, draftId: firstLineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: first.evidenceSnapshotHash })
    secondLineage.setReview({ id: 705, jobId: secondLineage.job.id, draftId: secondLineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: second.evidenceSnapshotHash })
    let calls = 0
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const publisher = async () => { calls += 1; await hold; return { status: 'delivered' as const, remoteState: 'idempotent_replay' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic-revision', artifactFingerprint: HASH, idempotencyKey: 'formal-command-key' } }
    const firstPromise = executeContentOperationEntry({ ownerUserId: 1, entryId: first.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'shared-key', mode: 'execute' }, dependencies: { repository: fixture.repository, publicationExecutor: publisher } })
    await new Promise(resolve => setTimeout(resolve, 0))
    const secondResult = await executeContentOperationEntry({ ownerUserId: 1, entryId: second.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'shared-key', mode: 'execute' }, dependencies: { repository: fixture.repository, publicationExecutor: publisher } }).catch(error => error)
    expect(secondResult).toMatchObject({ statusCode: 409 })
    expect(calls).toBe(1)
    const firstAttempt = fixture.attempts.find(attempt => attempt.entryId === first.id)!
    expect(firstAttempt.status).toBe('planned')
    expect(firstAttempt.attemptNumber).toBe(1)
    release()
    const delivered = await firstPromise
    expect(delivered.outcome).toBe('delivered')
    expect(await fixture.repository.finalizePublicationAttempt(1, firstAttempt.id, { status: 'blocked', artifactFingerprint: null, remoteState: null, remoteRevision: null, errorCode: 'late', errorSummary: 'late', completedAt: NOW })).toBeNull()

    const recovery = await readyFixture()
    let failFinalize = true
    const originalFinalize = recovery.repository.finalizePublicationAttempt
    recovery.repository.finalizePublicationAttempt = async (...args) => {
      if (failFinalize) throw new Error('synthetic finalize failure')
      return originalFinalize(...args)
    }
    const firstExternal = executeContentOperationEntry({ ownerUserId: 1, entryId: recovery.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'recover-key', mode: 'execute' }, dependencies: { repository: recovery.repository, publicationExecutor: async () => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic-revision', artifactFingerprint: HASH, idempotencyKey: 'formal-command-key' }) } }).catch(error => error)
    const firstError = await firstExternal
    expect(firstError).toBeInstanceOf(Error)
    expect(recovery.repository['listPublicationAttempts']).toBeTypeOf('function')
    const planned = (await recovery.repository.listPublicationAttempts(1, recovery.entry.id)).find(attempt => attempt.status === 'planned')!
    expect(planned).toBeTruthy()
    const recoveryRun = (await recovery.repository.listRuns(1, recovery.entry.id)).find(item => item.stage === 'publication')!
    expect(recoveryRun.attemptNumber).toBe(1)
    recoveryRun.leaseExpiresAt = new Date(NOW.getTime() - 1)
    failFinalize = false
    const recovered = await executeContentOperationEntry({ ownerUserId: 1, entryId: recovery.entry.id, trigger: 'owner_manual', now: new Date(NOW.getTime() + 1), value: { idempotencyKey: 'recover-key', mode: 'execute' }, dependencies: { repository: recovery.repository, publicationExecutor: async () => ({ status: 'delivered' as const, remoteState: 'idempotent_replay' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic-revision', artifactFingerprint: HASH, idempotencyKey: 'formal-command-key' }) } })
    expect(recovered.outcome).toBe('delivered')
    expect((await recovery.repository.listPublicationAttempts(1, recovery.entry.id)).filter(attempt => attempt.status === 'delivered')).toHaveLength(1)
    expect((await recovery.repository.listRuns(1, recovery.entry.id)).find(item => item.stage === 'publication')?.attemptNumber).toBe(1)
  })

  it('is stage-aware and blocks stale generation/review runs without cross-stage publisher calls', async () => {
    const lineage = await readyFixture()
    let calls = 0
    const publicationRun: ContentOperationRunRow = { id: 900, ownerUserId: 1, entryId: lineage.entry.id, stage: 'generation', state: 'queued', attemptNumber: 0, idempotencyKey: 'stale-generation', inputFingerprint: 'a'.repeat(64), outputFingerprint: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: null, completedAt: null, createdAt: NOW, updatedAt: NOW }
    lineage.fixture.runs.push(publicationRun as never)
    const tick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: lineage.repository, dependencies: { publicationExecutor: async () => { calls += 1; return { status: 'delivered' as const, remoteState: 'created' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic', artifactFingerprint: HASH, idempotencyKey: 'synthetic' } } } })
    expect(calls).toBe(0)
    expect(tick.results.find(result => result.runId === 900)?.status).toBe('blocked')
    expect(publicationRun.errorCode).toBe('STALE_STAGE_RUN')

    const reviewRun: ContentOperationRunRow = { ...publicationRun, id: 901, stage: 'review_wait', idempotencyKey: 'stale-review', state: 'queued' }
    lineage.fixture.runs.push(reviewRun as never)
    lineage.entry.status = 'delivered'
    const secondTick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: lineage.repository, dependencies: { publicationExecutor: async () => { calls += 1; return { status: 'delivered' as const, remoteState: 'created' as const, publicationId: 'deliverable-1', contentHash: BODY_HASH, remoteRevision: 'synthetic', artifactFingerprint: HASH, idempotencyKey: 'synthetic' } } } })
    expect(calls).toBe(0)
    expect(secondTick.results.find(result => result.runId === 901)?.status).toBe('blocked')
  })

  it('documents the publication governance race check and production runtime wiring contracts', () => {
    const seoRepository = readFileSync(new URL('../server/seo-geo-core/repository.ts', import.meta.url), 'utf8')
    const executeRoute = readFileSync(new URL('../server/api/content-operations/entries/[id]/execute.post.ts', import.meta.url), 'utf8')
    const task = readFileSync(new URL('../server/tasks/content-operations-execution-tick.ts', import.meta.url), 'utf8')
    expect(seoRepository).toContain("eq(contentOperationPublicationAttempts.status, 'planned')")
    expect(seoRepository).toContain('Publication has already started')
    expect(executeRoute).toContain('getContentOperationsRuntimeDependencies')
    expect(task).toContain('getContentOperationsRuntimeDependencies')
  })
})
