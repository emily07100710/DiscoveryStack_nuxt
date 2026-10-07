import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { executeFirstPartyPublication, planFirstPartyPublication, type FirstPartyFetch } from '../server/first-party-publishing'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { bindOwnerEntryPublicationTargets, createOwnerPublicationTarget, executeContentOperationEntry, runContentOperationsExecutionTick } from '../server/content-operations/orchestrator'
import { createMultiChannelExecutorRegistry, type MultiChannelExecutorRegistry } from '../server/publication-routing'
import { createLearningAuthorization, revokeLearningAuthorization } from '../server/learning-loop/service'
import { captureLiveActionBeforePublication, cleanInvalidLivePublicationActions, getLivePublicationActionWorkspace, reconcileLivePublicationAction, resolveReviewedLivePublicationAction, reviewLivePublicationAction, type LiveActionDependencies } from '../server/learning-loop/live-action-service'
import { resolveLiveActionContext } from '../server/learning-loop/live-action-context'
import { buildGovernedContentOutcomeRelease } from '../server/learning-loop/outcome-release'
import { assessPublishedContentOutcome } from '../server/outcome-learning/engine'
import { outcomeSha256 } from '../server/outcome-learning/normalization'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning/policy-catalog'
import { learningFixture } from './support/learning-loop-memory-repository'
import { LiveActionMemoryRepository } from './support/live-action-memory-repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'
import { projectLivePage, renderLiveContentArticle } from '../server/learning-loop/live-page-projection'
import { response } from './fixtures/first-party-publishing/fixtures'

const OWNER = 1
const NOW = new Date('2026-10-20T12:00:00.000Z')
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

async function prepareLiveFixture(options: { enabled?: boolean; captureMode?: 'match' | 'stale'; revokeDuringBefore?: boolean; multiTarget?: boolean; revokeBusinessReviewDuringBefore?: boolean; changeDraftVersionDuringBefore?: boolean; changeTargetConfigDuringBefore?: boolean } = {}) {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(OWNER)
  client.canonicalSiteOrigin = 'https://live-action-fixture.acme.taipei'
  const calendar = await fixture.addCalendar(OWNER, '2026-10-20', 1)
  const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
  entry.scheduleKey = `live-action-${entry.id}`
  const targetResult = await createOwnerPublicationTarget(OWNER, client.id, {
    idempotencyKey: `live-action-target-${entry.id}`, framework: 'nuxt', transport: 'first_party_git',
    targetOrigin: 'https://api.github.com', contentRoot: 'content', defaultBranch: 'main',
    repositoryOwner: 'mock-owner', repositoryName: 'mock-live-action', endpointPath: null,
    credentialReference: 'ref-test-vault-slot-1', allowedContentTypes: ['article'],
    allowedLanguages: ['en'], maximumPayloadBytes: 1_000_000, executionEnabled: true,
  }, fixture.repository)
  const target = fixture.targets.find(row => row.id === targetResult.target.id)!
  let wordpressTarget: typeof target | null = null
  if (options.multiTarget) {
    const wordpressResult = await createOwnerPublicationTarget(OWNER, client.id, {
      idempotencyKey: `live-action-wordpress-target-${entry.id}`, framework: 'wordpress', transport: 'wordpress_rest',
      targetOrigin: 'https://wordpress-live-action-fixture.acme.taipei', contentRoot: 'wp-content', defaultBranch: null,
      repositoryOwner: null, repositoryName: null, endpointPath: '/wp-json/wp/v2/posts', credentialReference: 'ref-wp-slot-1',
      allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1_000_000, executionEnabled: true,
    }, fixture.repository)
    wordpressTarget = fixture.targets.find(row => row.id === wordpressResult.target.id)!
    await bindOwnerEntryPublicationTargets(OWNER, entry.id, { targetRowIds: [target.id, wordpressTarget.id] }, fixture.repository)
  }
  const title = 'Controlled live action fixture'
  const body = 'Reviewed fixture paragraph one.\n\nA second paragraph is retained exactly.'
  const contentHash = contentFingerprint(title, body)
  const bundle = fixture.bundles.get(`${OWNER}:11`)!
  const deliverable = bundle.deliverables.find(row => row.id === entry.productionDeliverableId)!
  const job = { id: 1701, ownerUserId: OWNER, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 1702, status: 'approved' }
  const draft = { id: 1703, ownerUserId: OWNER, jobId: job.id, version: 1, title, body, contentHash, provenance: { stage: 'optimized' }, safetyStatus: 'passed', evidenceRefs: [] }
  const riskGate = { id: 1704, ownerUserId: OWNER, draftId: draft.id, status: 'passed', gateVersion: 'content-risk-gate-v1', riskLevel: 'general', findings: [], evidenceSnapshotHash: entry.evidenceSnapshotHash }
  fixture.generated.set(entry.id, { deliverable: { ...deliverable, status: 'approved' }, job, draft, riskGate })
  entry.status = 'ready_to_publish'
  entry.jobId = job.id
  entry.draftId = draft.id
  entry.contentHash = contentHash
  fixture.recordOwnerReview(entry.id, { ownerUserId: OWNER, jobId: job.id, draftId: draft.id, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })

  const learning = learningFixture()
  learning.repository.clients[0]!.id = client.id
  learning.repository.clients[0]!.canonicalSiteOrigin = client.canonicalSiteOrigin
  learning.repository.sources[0]!.sourceUrl = `${client.canonicalSiteOrigin}/`
  learning.repository.sources[0]!.canonicalUrl = `${client.canonicalSiteOrigin}/`
  await createLearningAuthorization(OWNER, { ...learning.input, clientId: client.id, expiresAt: '2026-12-31T00:00:00.000Z' }, { repository: learning.repository, now: () => NOW })
  const grant = learning.repository.authorizations[0]!
  const actions = new LiveActionMemoryRepository()
  let clockNow = new Date(NOW)
  let captureCount = 0
  const capture: NonNullable<LiveActionDependencies['capture']> = async (input, acquisition) => {
    captureCount++
    const resolved = await acquisition.resolveCurrentAuthority(input.selector, clockNow)
    if (!resolved) return { status: 'blocked', projection: null, capturedAt: null, reasonCode: 'CURRENT_ACTION_AUTHORITY_REQUIRED', authorizationFingerprint: null, sourceFingerprint: null, consentReceiptHash: null }
    const call = captureCount
    const projection = call === 1
      ? projectLivePage({ html: '', status: 404, url: input.publicationUrl })
      : options.captureMode === 'stale'
        ? staleProjection(input.publicationUrl, entry.id, deliverable.id, draft.id, fixture, body)
        : await currentActualProjection(fixture, entry.id, OWNER, input.publicationUrl)
    if (call === 1 && options.revokeDuringBefore) await revokeLearningAuthorization(OWNER, grant.id, { repository: learning.repository, now: () => clockNow })
    if (call === 1 && options.revokeBusinessReviewDuringBefore) {
      const review = fixture.reviews.get(entry.id)
      if (review) review.decision = 'changes_requested'
    }
    if (call === 1 && options.changeDraftVersionDuringBefore) draft.version += 1
    if (call === 1 && options.changeTargetConfigDuringBefore) target.configurationFingerprint = sha256('changed-live-action-target-configuration')
    return {
      status: projection ? 'captured' : 'blocked', projection, capturedAt: clockNow.toISOString(), reasonCode: projection ? null : 'PROJECTION_NOT_VERIFIED',
      authorizationFingerprint: resolved.authorizationFingerprint, sourceFingerprint: resolved.authority.sourceFingerprint, consentReceiptHash: resolved.authority.consentReceiptHash,
    }
  }
  const liveActions: LiveActionDependencies = { enabled: options.enabled ?? true, actions, operations: fixture.repository, learning: learning.repository, capture, now: () => clockNow }
  const executor = vi.fn(async (input: Parameters<NonNullable<import('../server/content-operations/orchestrator').ContentOperationOrchestratorDependencies['publicationExecutor']>>[0]) => {
    const currentRows = actions.rows
    if (options.enabled !== false && input.mode === 'execute') expect(currentRows[0]?.status).toBe('dispatch_started')
    const currentPlan = planFirstPartyPublication(input.target, input.publication, input.now)
    if (currentPlan.status !== 'planned') throw new Error(`fixture publication planning failed: ${currentPlan.code}`)
    const priorPlan = planFirstPartyPublication(input.target, { ...input.publication, productionDeliverableId: 'previous-live-action', title: 'Previous fixture title', body: 'Previous fixture paragraph.', contentHash: sha256('Previous fixture paragraph.') }, input.now)
    if (priorPlan.status !== 'planned') throw new Error(`fixture baseline planning failed: ${priorPlan.code}`)
    const priorArtifact = `${priorPlan.artifact.frontmatter}\n${priorPlan.artifact.body}`
    const calls: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init: { method: string; body?: string }) => {
      calls.push(init.method)
      if (calls.length === 1) return response(200, {
        type: 'file', path: priorPlan.artifact.path, sha: 'abcdef1234567', encoding: 'base64',
        content: Buffer.from(priorArtifact, 'utf8').toString('base64'),
        repository: { owner: 'mock-owner', name: 'mock-live-action' }, branch: 'main',
        commit: { sha: '1234567890abcdef1234567890abcdef12345678' },
      })
      return response(200, {
        content: { path: currentPlan.artifact.path, sha: 'fedcba7654321' },
        commit: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
        repository: { owner: 'mock-owner', name: 'mock-live-action' }, branch: 'main',
      })
    }) as unknown as FirstPartyFetch
    const result = await executeFirstPartyPublication({ ...input, fetchImpl, serverCredentialResolver: () => ({ ok: true, value: 'synthetic-fixture-credential' }) })
    expect(calls).toEqual(input.mode === 'dry_run' ? [] : ['GET', 'PUT'])
    clockNow = new Date(NOW.getTime() + 1_000)
    return result
  })
  return { fixture, client, entry, target, wordpressTarget, title, body, draft, deliverable, learning, grant, actions, liveActions, executor, get now() { return clockNow }, setNow(value: Date) { clockNow = new Date(value) }, get captureCount() { return captureCount } }
}

async function currentActualProjection(fixture: ContentOperationsFixture, entryId: number, ownerUserId: number, url: string) {
  const attempts = await fixture.repository.listPublicationAttempts(ownerUserId, entryId)
  const delivered = attempts.find(attempt => attempt.status === 'delivered')
  if (!delivered) return null
  const context = await resolveLiveActionContext(ownerUserId, entryId, delivered.id, fixture.repository)
  if (!context || context.publicationUrl !== url) return null
  const deliverable = context.lineage.deliverable
  const draft = context.lineage.draft
  const reviewId = delivered.authorityReference || (context.lineage.review ? `review-${context.lineage.review.id}` : null)
  if (!deliverable || !draft || !reviewId || typeof delivered.publicationContentHash !== 'string' || typeof delivered.evidenceSnapshotHash !== 'string' || typeof draft.title !== 'string' || typeof draft.body !== 'string') return null
  const html = renderLiveContentArticle({
    publicationId: `deliverable-${deliverable.id}`,
    draftId: `draft-${draft.id}`,
    reviewId,
    contentHash: delivered.publicationContentHash,
    evidenceSnapshotHash: delivered.evidenceSnapshotHash,
    title: draft.title,
    body: draft.body,
  })
  return html ? projectLivePage({ html: `<html><head><link rel="canonical" href="${url}"></head><body><main>${html}</main></body></html>`, status: 200, url }) : null
}

function staleProjection(url: string, entryId: number, deliverableId: number, draftId: number, fixture: ContentOperationsFixture, body: string) {
  const entry = fixture.entries.find(row => row.id === entryId)!
  const draft = fixture.generated.get(entryId)!.draft!
  const review = fixture.reviews.get(entryId)!
  const altered = body.replace('second paragraph', 'different stale paragraph')
  const page = `<html><head><link rel="canonical" href="${url}"></head><body><main><article data-ds-live-content="v1" data-ds-publication-id="deliverable-${deliverableId}" data-ds-draft-id="draft-${draftId}" data-ds-review-id="review-${review.id}" data-ds-content-hash="${sha256(body)}" data-ds-evidence-hash="${entry.evidenceSnapshotHash}"><h1 data-ds-live-title>${draft.title}</h1><section data-ds-live-body><p>${altered.split('\n\n')[0]}</p><p>${altered.split('\n\n')[1]}</p></section></article></main></body></html>`
  return projectLivePage({ html: page, status: 200, url })
}

function repositorySafeJson(actions: LiveActionMemoryRepository) { return JSON.stringify(actions.rows) }

async function insertExactSyntheticOutcome(f: Awaited<ReturnType<typeof prepareLiveFixture>>) {
  const attempt = (await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)).find(row => row.status === 'delivered')
  const context = attempt ? await resolveLiveActionContext(OWNER, f.entry.id, attempt.id, f.fixture.repository) : null
  if (!attempt || !context || !attempt.completedAt || !context.lineage.draft || !context.lineage.job) throw new Error('Synthetic exact publication receipt is unavailable.')
  const publishedAt = attempt.completedAt, publishedMs = publishedAt.getTime()
  const subject = sha256('live-action-outcome-synthetic-subject')
  const publication = {
    deidentifiedSubjectKey: subject,
    scheduleEntryId: String(f.entry.id), scheduleKey: f.entry.scheduleKey,
    productionPlanId: String(context.lineage.calendar.productionPlanId), jobId: String(context.lineage.job.id),
    draftId: String(context.lineage.draft.id), draftVersion: String(context.lineage.draft.version),
    contentHash: context.lineage.draft.contentHash, evidenceSnapshotHash: context.lineage.entry.evidenceSnapshotHash,
    publishedAt: publishedAt.toISOString(), contentType: context.lineage.entry.contentType, language: context.lineage.entry.language,
    appliedRuleIds: ['direct-answer-first'], topicClusterCode: 'live-action-fixture',
  }
  const measurement = (phase: 'baseline' | 'follow_up', offsetDays: number, metrics: Record<string, number>) => {
    const body = phase === 'baseline'
      ? { source: 'google_search_console', deidentifiedSubjectKey: subject, scopeFingerprint: sha256('live-action-gsc-scope'), phase, windowStart: new Date(publishedMs - 30 * 86400000).toISOString(), windowEnd: new Date(publishedMs - 2 * 86400000).toISOString(), capturedAt: new Date(publishedMs - 86400000).toISOString(), metrics }
      : { source: 'google_search_console', deidentifiedSubjectKey: subject, scopeFingerprint: sha256('live-action-gsc-scope'), phase, windowStart: new Date(publishedMs + 86400000).toISOString(), windowEnd: new Date(publishedMs + offsetDays * 86400000).toISOString(), capturedAt: new Date(publishedMs + (offsetDays + 1) * 86400000).toISOString(), metrics }
    return { ...body, sourceHash: outcomeSha256(body) }
  }
  const baseline = measurement('baseline', 0, { impressions: 280, clicks: 28, averagePosition: 12 })
  const followUp = measurement('follow_up', 15, { impressions: 560, clicks: 112, averagePosition: 6 })
  const request = { publication, baselineMeasurements: [baseline], followUpMeasurements: [followUp], dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
  const assessment = assessPublishedContentOutcome(request)
  expect(assessPublishedContentOutcome({ publication: assessment.publication, baselineMeasurements: [baseline], followUpMeasurements: [followUp], dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION })).toEqual(assessment)
  const releaseNow = new Date(publishedMs + 17 * 86400000)
  f.setNow(releaseNow)
  await f.fixture.repository.insertOutcome({
    ownerUserId: OWNER, entryId: f.entry.id, runId: attempt.runId, targetId: attempt.targetId, draftId: context.lineage.draft.id,
    publicationReceiptFingerprint: attempt.receiptFingerprint || null, publishedUrl: context.publicationUrl,
    contentHash: context.lineage.entry.contentHash, evidenceSnapshotHash: context.lineage.entry.evidenceSnapshotHash,
    assessmentStatus: assessment.status, assessmentFingerprint: assessment.assessmentFingerprint,
    baselineSnapshot: [baseline], followUpSnapshot: [followUp], assessmentSnapshot: assessment,
    consentLineageSnapshot: {}, idempotencyKey: `live-action-outcome-${attempt.id}`,
    measuredAt: new Date(followUp.capturedAt),
  })
  return { attempt, context, assessment, releaseNow }
}

async function readRealActionRelease(f: Awaited<ReturnType<typeof prepareLiveFixture>>) {
  return buildGovernedContentOutcomeRelease(OWNER, {
    operations: f.fixture.repository, repository: f.learning.repository, liveActions: f.actions, includeLiveActions: true, now: () => f.now,
  })
}

async function deliverAndObserve(f: Awaited<ReturnType<typeof prepareLiveFixture>>, key: string) {
  const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: key, mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor: f.executor, liveActions: f.liveActions } })
  expect(result.outcome).toBe('delivered')
  const action = f.actions.rows[0]
  if (!action) throw new Error('Synthetic live action was not reserved.')
  const observed = await reconcileLivePublicationAction(OWNER, action.id, f.liveActions)
  expect(observed.status).toBe('observed')
  return action
}

describe('live publication action service lifecycle', () => {
  it('joins only the delivered first-party target in a partial multi-target run and recovery never republishes it', async () => {
    const f = await prepareLiveFixture({ multiTarget: true })
    if (!f.wordpressTarget) throw new Error('Expected the synthetic WordPress target.')
    let wordpressCalls = 0
    const firstPartyCalls = vi.fn()
    const registry: MultiChannelExecutorRegistry = createMultiChannelExecutorRegistry({
      httpTransport: async (_url, init) => {
        wordpressCalls++
        if (wordpressCalls === 1) return { status: 503, text: async () => '' }
        const payload = JSON.parse(init.body) as { destinationPublicationIdentity: string; contentHash: string }
        return { status: 200, text: async () => JSON.stringify({ publicationId: payload.destinationPublicationIdentity, contentHash: payload.contentHash, remoteRevision: `fixture-wp-revision-${wordpressCalls}` }) }
      },
    })
    registry.first_party_git = async ({ route }) => {
      firstPartyCalls()
      return { status: 'delivered', remote: { publicationId: route.destinationPublicationIdentity, contentHash: route.contentHash, remoteRevision: `fixture-git-revision-${firstPartyCalls.mock.calls.length}` } }
    }
    const dependencies = { repository: f.fixture.repository, liveActions: f.liveActions, multiChannelRegistry: registry, resolveMultiChannelCredential: async () => 'synthetic-multi-target-credential' }
    const first = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-multi-partial', mode: 'execute' }, dependencies })
    expect(first.outcome).toBe('retry_wait')
    const attemptsAfterFirst = await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)
    const firstPartyAttempt = attemptsAfterFirst.find(row => row.targetId === f.target.id)
    const wordpressAttempt = attemptsAfterFirst.find(row => row.targetId === f.wordpressTarget!.id)
    expect(firstPartyAttempt?.status, JSON.stringify({ first, attemptsAfterFirst: attemptsAfterFirst.map(row => ({ targetId: row.targetId, status: row.status, errorCode: row.errorCode, errorSummary: row.errorSummary, remoteState: row.remoteState })) })).toBe('delivered')
    expect(wordpressAttempt?.status).toBe('retryable_failure')
    expect(firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(wordpressCalls).toBe(1)
    expect(f.actions.rows).toHaveLength(1)
    const action = f.actions.rows[0]!
    expect(action.attemptId).toBe(firstPartyAttempt?.id)
    expect(action.status).toBe('observed')
    expect(action.receiptFingerprint).toBe(firstPartyAttempt?.receiptFingerprint)
    expect(action.afterProjection).toMatchObject({ kind: 'controlled_document' })

    const recoveryAt = first.retryAt || new Date(NOW.getTime() + 6 * 60 * 1000)
    f.setNow(recoveryAt)
    const recovery = await runContentOperationsExecutionTick({ ownerUserId: OWNER, now: recoveryAt, repository: f.fixture.repository, dependencies: { publicationExecutor: f.executor, liveActions: f.liveActions, multiChannelRegistry: registry, resolveMultiChannelCredential: async () => 'synthetic-multi-target-credential' } })
    expect(recovery.results.some(result => result.outcome === 'delivered' || result.status === 'succeeded'), JSON.stringify({ recovery, first: attemptsAfterFirst.map(row => ({ targetId: row.targetId, status: row.status, completedAt: row.completedAt?.toISOString(), errorSummary: row.errorSummary })), wordpressCalls })).toBe(true)
    const attemptsAfterRecovery = await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)
    expect(attemptsAfterRecovery.filter(row => row.targetId === f.target.id && row.status === 'delivered')).toHaveLength(1)
    expect(attemptsAfterRecovery.filter(row => row.targetId === f.wordpressTarget!.id && row.status === 'delivered')).toHaveLength(1)
    expect(firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(wordpressCalls).toBe(2)
    expect(f.actions.rows[0]?.id).toBe(action.id)
    expect(f.actions.rows[0]?.receiptFingerprint).toBe(firstPartyAttempt?.receiptFingerprint)

    const workspace = await getLivePublicationActionWorkspace(OWNER, f.liveActions)
    const evidenceFingerprint = workspace.items.find(item => item.id === action.id)?.evidenceFingerprint
    if (!evidenceFingerprint) throw new Error(`Expected current evidence for the exact delivered first-party attempt: ${JSON.stringify({ workspace, action: f.actions.rows[0], attempts: (await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)).map(row => ({ id: row.id, status: row.status, targetId: row.targetId, receiptFingerprint: row.receiptFingerprint, publicationUrl: row.publicationUrl })) })}`)
    const approved = await reviewLivePublicationAction(OWNER, { actionId: action.id, evidenceFingerprint, decision: 'approved', piiReviewConfirmed: true, rightsConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Synthetic multi-target review confirms the exact first-party receipt.' }, f.liveActions)
    expect(approved.reviewStatus).toBe('approved')
    const { attempt } = await insertExactSyntheticOutcome(f)
    const release = await readRealActionRelease(f)
    const actionEntries = release.liveActionMetadataEntries ?? []
    expect(actionEntries).toHaveLength(1)
    expect(actionEntries[0]).toMatchObject({ receiptFingerprint: attempt.receiptFingerprint, actionReviewFingerprint: approved.reviewFingerprint })
  })

  it.each([
    ['business review', { revokeBusinessReviewDuringBefore: true }],
    ['draft version', { changeDraftVersionDuringBefore: true }],
    ['target configuration', { changeTargetConfigDuringBefore: true }],
  ] as const)('rechecks exact business authority after capture when %s changes and never invokes the publisher', async (_label, drift) => {
    const f = await prepareLiveFixture(drift)
    const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: `live-action-authority-drift-${_label.replaceAll(' ', '-')}`, mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor: f.executor, liveActions: f.liveActions } }).catch(error => error)
    expect(result).not.toMatchObject({ outcome: 'delivered' })
    expect(f.captureCount).toBe(1)
    expect(f.executor).not.toHaveBeenCalled()
    expect((await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)).every(attempt => attempt.status !== 'delivered')).toBe(true)
  })

  it('captures before under publication lease, dispatches only after durable boundary, then binds the formal receipt and reviews immutable evidence', async () => {
    const f = await prepareLiveFixture()
    const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-service-smoke', mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor: f.executor, liveActions: f.liveActions } })
    expect(result.outcome, JSON.stringify({ result, action: f.actions.rows[0], captures: f.captureCount })).toBe('delivered')
    expect(f.captureCount).toBeGreaterThanOrEqual(1)
    expect(f.actions.rows).toHaveLength(1)
    const row = f.actions.rows[0]!
    expect(['awaiting_after', 'observed']).toContain(row.status)
    expect(row.beforeProjection).toMatchObject({ kind: 'not_found' })
    expect(row.dispatchStartedAt).toBeTruthy()
    const attempts = await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)
    const attempt = attempts.find(item => item.status === 'delivered')
    expect(attempt?.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(f.fixture.events.some(event => event.eventType === 'publication_delivered' && event.entryId === f.entry.id)).toBe(true)
    expect(row.receiptFingerprint).toMatch(/^[a-f0-9]{64}$/u)

    const reconciled = await reconcileLivePublicationAction(OWNER, row.id, f.liveActions)
    expect(reconciled.status, JSON.stringify({ reconciled, action: f.actions.rows[0], captures: f.captureCount })).toBe('observed')
    expect(f.captureCount).toBeGreaterThanOrEqual(2)
    const observed = f.actions.rows[0]!
    expect(observed.receiptFingerprint).toBe(attempt?.receiptFingerprint)
    expect(observed.deliveredAt?.getTime()).toBe(attempt?.completedAt?.getTime())
    expect(observed.afterCapturedAt?.getTime()).toBeGreaterThanOrEqual(observed.deliveredAt!.getTime())
    expect(JSON.stringify(observed)).not.toContain(f.body)
    expect(JSON.stringify(observed)).not.toContain(f.title)
    expect(JSON.stringify(observed)).not.toContain(f.entry.publicationPath || 'unpersisted-path-placeholder')
    expect(repositorySafeJson(f.actions)).not.toContain('https://live-action-fixture.acme.taipei')

    const workspace = await getLivePublicationActionWorkspace(OWNER, f.liveActions)
    const evidenceFingerprint = workspace.items[0]?.evidenceFingerprint
    expect(evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    const reviewInput = { actionId: row.id, evidenceFingerprint, decision: 'approved', piiReviewConfirmed: true, rightsConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Verified privacy, rights, and observational limits.' }
    for (const ack of ['piiReviewConfirmed', 'rightsConfirmed', 'observationalOnlyAcknowledged'] as const) {
      await expect(reviewLivePublicationAction(OWNER, { ...reviewInput, [ack]: false }, f.liveActions)).rejects.toMatchObject({ data: { code: 'INVALID_LIVE_ACTION_REVIEW' } })
    }
    await expect(reviewLivePublicationAction(OWNER, { ...reviewInput, evidenceFingerprint: 'a'.repeat(64) }, f.liveActions)).rejects.toMatchObject({ data: { code: 'CURRENT_LIVE_ACTION_EVIDENCE_REQUIRED' } })
    await expect(reviewLivePublicationAction(OWNER, { ...reviewInput, rightsConfirmed: false }, f.liveActions)).rejects.toThrow()
    const reviewed = await reviewLivePublicationAction(OWNER, reviewInput, f.liveActions)
    expect(reviewed).toMatchObject({ reviewStatus: 'approved', trainingPerformed: false, publicationPerformed: false })
    expect(await reviewLivePublicationAction(OWNER, reviewInput, f.liveActions)).toEqual(reviewed)
    expect(await resolveReviewedLivePublicationAction(OWNER + 1, row.id, f.liveActions)).toBeNull()
    const approvedAction = await resolveReviewedLivePublicationAction(OWNER, row.id, f.liveActions)
    expect(approvedAction).toMatchObject({ actionId: row.id, causalEligibility: false, primaryCitationLabelAllowed: false })
    await expect(reviewLivePublicationAction(OWNER, { ...reviewInput, decision: 'rejected' }, f.liveActions)).rejects.toThrow()
    const { attempt: joinedAttempt } = await insertExactSyntheticOutcome(f)
    const actionRelease = await readRealActionRelease(f)
    expect(actionRelease.dataset.eligibleCandidates.map(candidate => candidate.candidateFingerprint), JSON.stringify({ blocked: actionRelease.blocked, manifest: actionRelease.dataset.manifest, candidates: actionRelease.dataset.candidateResults })).toHaveLength(1)
    const actionEntries = actionRelease.liveActionMetadataEntries ?? []
    expect(actionEntries).toHaveLength(1)
    const candidate = actionRelease.dataset.eligibleCandidates[0]!
    const live = actionEntries[0]!
    expect(live.candidateFingerprint).toBe(candidate.candidateFingerprint)
    expect(live).toMatchObject({
      actionEvidenceFingerprint: approvedAction?.evidenceFingerprint,
      actionReviewFingerprint: approvedAction?.reviewFingerprint,
      actionReleaseFingerprint: approvedAction?.releaseFingerprint,
      receiptFingerprint: joinedAttempt.receiptFingerprint,
      authorizationFingerprint: approvedAction?.authorizationFingerprint,
      sourceFingerprint: approvedAction?.sourceFingerprint,
      publishedAt: joinedAttempt.completedAt?.toISOString(),
    })
    await revokeLearningAuthorization(OWNER, f.grant.id, { repository: f.learning.repository, now: () => f.now })
    expect(await resolveReviewedLivePublicationAction(OWNER, row.id, f.liveActions)).toBeNull()
    expect((await readRealActionRelease(f)).liveActionMetadataEntries).toEqual([])
  })

  it('never releases a rejected reviewed action and does not allow immutable review reversal', async () => {
    const f = await prepareLiveFixture()
    const action = await deliverAndObserve(f, 'live-action-rejected-release')
    const workspace = await getLivePublicationActionWorkspace(OWNER, f.liveActions)
    const evidenceFingerprint = workspace.items[0]?.evidenceFingerprint
    if (!evidenceFingerprint) throw new Error('Expected current synthetic evidence fingerprint.')
    const rejectInput = { actionId: action.id, evidenceFingerprint, decision: 'rejected', piiReviewConfirmed: true, rightsConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Synthetic reviewer rejects this proposed change.' }
    const rejected = await reviewLivePublicationAction(OWNER, rejectInput, f.liveActions)
    expect(rejected.reviewStatus).toBe('rejected')
    expect(await reviewLivePublicationAction(OWNER, rejectInput, f.liveActions)).toEqual(rejected)
    await expect(reviewLivePublicationAction(OWNER, { ...rejectInput, decision: 'approved' }, f.liveActions)).rejects.toThrow()
    await insertExactSyntheticOutcome(f)
    const release = await readRealActionRelease(f)
    expect(release.liveActionMetadataEntries).toEqual([])
    expect(release.liveActionBlocked).toMatchObject([{ reasonCode: 'CURRENT_REVIEWED_LIVE_ACTION_REQUIRED' }])
  })

  it('keeps the formal publication successful but creates no action/capture when disabled or dry-run', async () => {
    const disabled = await prepareLiveFixture({ enabled: false })
    const disabledReserve = vi.spyOn(disabled.actions, 'reserve')
    const disabledList = vi.spyOn(disabled.actions, 'list')
    const disabledActionCalls = [
      vi.spyOn(disabled.actions, 'get'), vi.spyOn(disabled.actions, 'findByAttempt'), vi.spyOn(disabled.actions, 'saveBefore'), vi.spyOn(disabled.actions, 'markDispatch'),
      vi.spyOn(disabled.actions, 'attachReceipt'), vi.spyOn(disabled.actions, 'claimAfter'), vi.spyOn(disabled.actions, 'finishAfter'), vi.spyOn(disabled.actions, 'review'),
      vi.spyOn(disabled.actions, 'clear'), vi.spyOn(disabled.actions, 'purgeExpired'), vi.spyOn(disabled.actions, 'listLive'), vi.spyOn(disabled.actions, 'countLive'),
    ]
    const disabledResult = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: disabled.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-disabled', mode: 'execute' }, dependencies: { repository: disabled.fixture.repository, publicationExecutor: disabled.executor, liveActions: disabled.liveActions } })
    expect(disabledResult.outcome).toBe('delivered')
    expect(disabled.actions.rows).toHaveLength(0)
    expect(disabled.captureCount).toBe(0)
    expect(disabledReserve).not.toHaveBeenCalled()
    expect(disabledList).not.toHaveBeenCalled()
    expect(disabledActionCalls.every(spy => spy.mock.calls.length === 0)).toBe(true)

    const dryRun = await prepareLiveFixture({ enabled: true })
    const dryRunReserve = vi.spyOn(dryRun.actions, 'reserve')
    const dryRunActionCalls = [
      vi.spyOn(dryRun.actions, 'get'), vi.spyOn(dryRun.actions, 'findByAttempt'), vi.spyOn(dryRun.actions, 'list'), vi.spyOn(dryRun.actions, 'saveBefore'),
      vi.spyOn(dryRun.actions, 'markDispatch'), vi.spyOn(dryRun.actions, 'attachReceipt'), vi.spyOn(dryRun.actions, 'claimAfter'), vi.spyOn(dryRun.actions, 'finishAfter'),
      vi.spyOn(dryRun.actions, 'review'), vi.spyOn(dryRun.actions, 'clear'), vi.spyOn(dryRun.actions, 'purgeExpired'), vi.spyOn(dryRun.actions, 'listLive'), vi.spyOn(dryRun.actions, 'countLive'),
    ]
    const dryResult = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: dryRun.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-dry-run', mode: 'dry_run' }, dependencies: { repository: dryRun.fixture.repository, publicationExecutor: dryRun.executor, liveActions: dryRun.liveActions } })
    expect(dryResult.outcome).toBe('dry_run_succeeded')
    expect(dryRun.actions.rows).toHaveLength(0)
    expect(dryRun.captureCount).toBe(0)
    expect(dryRunReserve).not.toHaveBeenCalled()
    expect(dryRunActionCalls.every(spy => spy.mock.calls.length === 0)).toBe(true)
  })

  it('does not let revoked current learning authority pass the post-fetch guard or alter publication success', async () => {
    const f = await prepareLiveFixture({ revokeDuringBefore: true })
    const publicationExecutor: NonNullable<import('../server/content-operations/orchestrator').ContentOperationOrchestratorDependencies['publicationExecutor']> = async ({ publication }) => ({
      status: 'delivered', remoteState: 'created', publicationId: publication.productionDeliverableId, contentHash: publication.contentHash,
      remoteRevision: 'fixture-revoked-grant-delivery', artifactFingerprint: sha256('fixture-revoked-grant-artifact'), idempotencyKey: 'fixture-revoked-grant-idempotency',
    })
    const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-revoke-race', mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor, liveActions: f.liveActions } })
    expect(result.outcome, JSON.stringify({ result, action: f.actions.rows[0] })).toBe('delivered')
    expect(f.captureCount).toBe(1)
    expect(f.actions.rows[0]).toMatchObject({ status: 'expired', beforeProjection: null, expectedProjection: null })
    expect(f.fixture.events.some(event => event.eventType === 'publication_delivered' && event.entryId === f.entry.id)).toBe(true)
  })

  it('defers forged but structurally valid stale actual text with bounded retries and never treats markers as proof', async () => {
    const f = await prepareLiveFixture({ captureMode: 'stale' })
    const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-forged-content', mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor: f.executor, liveActions: f.liveActions } })
    expect(result.outcome).toBe('delivered')
    const row = f.actions.rows[0]!
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = f.actions.rows[0]!
      if (current.status === 'blocked') break
      if (current.nextAttemptAt) f.setNow(new Date(current.nextAttemptAt))
      const reconciled = await reconcileLivePublicationAction(OWNER, row.id, f.liveActions)
      if (attempt === 5) expect(reconciled.status, JSON.stringify({ reconciled, action: f.actions.rows[0], captures: f.captureCount })).not.toBe('busy_or_not_due')
    }
    expect(f.actions.rows[0]?.status).toBe('blocked')
    expect(f.actions.rows[0]?.afterAttemptCount).toBeLessThanOrEqual(6)
    expect(f.actions.rows[0]?.afterProjection).toBeNull()
    expect(f.actions.rows[0]?.evidenceFingerprint).toBeNull()
  })

  it('refuses to invent a before projection for a replayed dispatched reservation', async () => {
    const f = await prepareLiveFixture()
    const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-replayed-before', mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor: f.executor, liveActions: f.liveActions } })
    expect(result.outcome).toBe('delivered')
    const attempt = (await f.fixture.repository.listPublicationAttempts(OWNER, f.entry.id)).find(row => row.status === 'delivered')!
    const run = (await f.fixture.repository.listRuns(OWNER, f.entry.id)).find(row => row.id === attempt.runId)!
    const capturesBeforeReplay = f.captureCount
    const replay = await captureLiveActionBeforePublication(OWNER, f.entry.id, { attempt, run, replayed: true }, { runId: run.id, leaseToken: 'synthetic-replayed-lease' }, f.liveActions)
    expect(replay).toMatchObject({ status: 'skipped', actionId: f.actions.rows[0]?.id, reasonCode: 'RESUMED_ATTEMPT_BEFORE_CAPTURE_FORBIDDEN' })
    expect(f.captureCount).toBe(capturesBeforeReplay)
    expect(f.actions.rows).toHaveLength(1)
  })

  it('invalidates a stale capture completion after retention cleanup advances the lease version', async () => {
    const f = await prepareLiveFixture({ captureMode: 'stale' })
    const result = await executeContentOperationEntry({ ownerUserId: OWNER, entryId: f.entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'live-action-expiry-lease', mode: 'execute' }, dependencies: { repository: f.fixture.repository, publicationExecutor: f.executor, liveActions: f.liveActions } })
    expect(result.outcome).toBe('delivered')
    const row = f.actions.rows[0]!
    expect(row.status).toBe('awaiting_after')
    f.setNow(row.nextAttemptAt!)
    const token = 'synthetic-worker-lease'
    const claimed = await f.actions.claimAfter(OWNER, row.id, row.leaseVersion, token, f.now, new Date(Math.min(f.now.getTime() + 60_000, row.expiresAt.getTime())))
    expect(claimed?.status).toBe('capturing_after')
    if (!claimed) throw new Error('Expected synthetic after-capture lease to be claimed.')
    const lease = { ownerUserId: OWNER, id: row.id, leaseToken: token, leaseVersion: claimed.leaseVersion }
    const staleCaptureAt = new Date(f.now.getTime() + 1_000)
    f.setNow(row.expiresAt)
    const cleanup = await cleanInvalidLivePublicationActions(OWNER, f.liveActions)
    expect(cleanup.cleared).toBeGreaterThanOrEqual(1)
    expect(f.actions.rows[0]).toMatchObject({ status: 'expired', afterProjection: null, expectedProjection: null, leaseToken: null })
    expect(await f.actions.finishAfter(lease, staleCaptureAt, { status: 'blocked', afterProjection: null, afterCapturedAt: null, evidenceFingerprint: null, reasonCode: 'LATE_CAPTURE', nextAttemptAt: null })).toBeNull()
  })
})
