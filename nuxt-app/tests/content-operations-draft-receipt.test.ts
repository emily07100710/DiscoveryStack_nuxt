import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createContentOperationsRepositoryFromDatabase, type ContentOperationsRepository } from '../server/content-operations/repository'
import { createOwnerPublicationTarget, bindOwnerEntryPublicationTargets, executeContentOperationEntry, runContentOperationsExecutionTick } from '../server/content-operations/orchestrator'
import { getOwnerContentOperationsWorkspace, materializeOwnerDueContent } from '../server/content-operations/service'
import { enableOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { saveOwnerEntityStrategyProfile, saveOwnerQueryOwnership } from '../server/content-operations/governance-service'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'
import type { GeoRewriteAdapter } from '../server/geo/contracts'
import type { ContentOperationPublicationTargetRow } from '../server/content-operations/types'
import type { ContentOperationMachineAuthorizationRow } from '../server/content-operations/types'
import { executeFirstPartyPublication, planFirstPartyPublication, type FirstPartyFetch, type FirstPartyFetchResponse } from '../server/first-party-publishing'
import type { FirstPartyDraftReceipt } from '../server/first-party-publishing/draft-receipt'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { ContentOperationsFixture, HASH } from './fixtures/content-operations/repository'
import { FIXTURE_NOW, makePublication, makeSignedTarget } from './fixtures/first-party-publishing/fixtures'

const NOW = new Date('2026-10-08T01:00:00.000Z')
const BODY = '這是一篇供本機合成驗收的文章。\n\n## 練習\n\n記錄練習後的感受。'
const BODY_HASH = createHash('sha256').update(BODY, 'utf8').digest('hex')
const DRAFT_HASH = contentFingerprint('合成驗收文章', BODY)
const SECRET = 'fixture-only-nextjs-secret-000000000000'

type Lineage = {
  fixture: ContentOperationsFixture
  repository: ContentOperationsRepository
  entry: ContentOperationsFixture['entries'][number]
  targets: ContentOperationPublicationTargetRow[]
  job: Record<string, unknown>
  draft: Record<string, unknown>
  setReview(value: Record<string, unknown> | null): void
}

function receipt(publicationId: string, contentHash = BODY_HASH, replayed = false): FirstPartyDraftReceipt {
  return { status: 'draft_received', published: false, receiptScope: 'draft_ingest_outcome', receiptIsCurrentState: false, publicationId, contentHash, postId: '9b131e17-a5c2-45e1-a40f-44b6084de9b1', postVersion: 1, replayed }
}

async function readyFixture(targetCount = 1): Promise<Lineage> {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(1)
  Object.assign(client, { framework: 'nextjs', publicationTransport: 'first_party_signed_api', canonicalSiteOrigin: 'https://doalignment.test', requireCustomerApproval: false })
  const calendar = await fixture.addCalendar(1, '2026-10-08', 1)
  const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
  Object.assign(entry, { status: 'planned', language: 'zh-hant', jobId: 700, draftId: 702, contentHash: DRAFT_HASH })

  const targets: ContentOperationPublicationTargetRow[] = []
  for (let index = 0; index < targetCount; index += 1) {
    const created = await createOwnerPublicationTarget(1, client.id, {
      idempotencyKey: `synthetic-nextjs-target-${index + 1}`,
      framework: 'nextjs', transport: 'first_party_signed_api',
      targetOrigin: `https://site-${index + 1}.doalignment.com`, contentRoot: 'journal',
      repositoryOwner: null, repositoryName: null, endpointPath: '/api/first-party/content-ingest',
      credentialReference: `ref-doalignment-target-${index + 1}`,
      allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], maximumPayloadBytes: 100_000, executionEnabled: true,
    }, fixture.repository)
    targets.push(fixture.targets.find(row => row.id === created.target.id)!)
  }
  if (targetCount > 1) await bindOwnerEntryPublicationTargets(1, entry.id, { targetRowIds: targets.map(row => row.id) }, fixture.repository)

  const repository = fixture.repository as ContentOperationsRepository
  const job = { id: 700, ownerUserId: 1, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 701, status: 'approved' }
  const draft = { id: 702, jobId: job.id, version: 1, title: '合成驗收文章', body: BODY, contentHash: DRAFT_HASH, provenance: { stage: 'optimized', providerExecution: true, provider: 'synthetic', providerVersion: 'test', model: 'synthetic:test', providerModel: 'synthetic:test', providerProvenance: { provider: 'synthetic', model: 'test', mode: 'provider', providerExecution: true }, evidenceSnapshotHash: entry.evidenceSnapshotHash, qualityGateVersion: 'content-risk-gate-v1', selectedRuleIds: ['rule-topic'], appliedRuleIds: ['rule-topic'] }, safetyStatus: 'passed', evidenceRefs: [] }
  const gate = { id: 703, draftId: draft.id, status: 'passed', gateVersion: 'content-risk-gate-v1', findings: [], riskLevel: 'general', evidenceSnapshotHash: entry.evidenceSnapshotHash }
  let review: Record<string, unknown> | null = { id: 704, jobId: job.id, draftId: draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash }
  fixture.reviews.set(entry.id, { ...review, ownerUserId: 1 })
  const workspace = {
    entry, calendar, client, target: targets[0] || null,
    deliverable: { id: entry.productionDeliverableId, ownerUserId: 1, planId: calendar.productionPlanId, briefId: job.briefId, jobId: job.id, selectionId: entry.strategyRecommendationId, contentType: 'article', title: draft.title, audience: 'owner audience', language: 'zh-hant', evidenceSnapshotHash: entry.evidenceSnapshotHash, opportunityKey: '1:opportunity-1', provenance: {}, status: 'approved' },
    job, draft, review, riskGate: gate,
  }
  repository.findLatestOptimizedDraft = async () => draft as never
  repository.findRiskGate = async () => gate as never
  repository.findLatestReview = async () => review as never
  repository.resolveWorkspaceEntry = async (_owner, requestedId) => requestedId === entry.id ? workspace as never : null
  entry.status = 'ready_to_publish'
  return { fixture, repository, entry, targets, job, draft, setReview(value) { review = value; workspace.review = value as never } }
}

function syntheticFetch(options: { respond?: (url: string, body: Record<string, unknown>, call: number) => { status: number; body: unknown }; onPost?: (url: string, body: Record<string, unknown>, call: number) => void } = {}) {
  const posts: Array<{ url: string; body: Record<string, unknown>; response: { status: number; body: unknown } }> = []
  const fetchImpl: FirstPartyFetch = vi.fn(async (url, request) => {
    const body = JSON.parse(request.body || '{}') as Record<string, unknown>
    const call = posts.length + 1
    const result = options.respond?.(url, body, call) || { status: 202, body: receipt(String(body.publicationId), String(body.contentHash)) }
    posts.push({ url, body, response: result })
    options.onPost?.(url, body, call)
    return { status: result.status, headers: {}, text: async () => JSON.stringify(result.body) } as FirstPartyFetchResponse
  }) as FirstPartyFetch
  return { fetchImpl, posts }
}

function dependencies(lineage: Lineage, fetchImpl: FirstPartyFetch, extras: Record<string, unknown> = {}) {
  return {
    repository: lineage.repository,
    fetchImpl,
    serverCredentialResolver: async () => ({ ok: true as const, value: SECRET }),
    resolveMultiChannelCredential: async () => SECRET,
    nonceProvider: () => 'synthetic-nonce-00000001',
    ...extras,
  }
}

async function execute(lineage: Lineage, fetchImpl: FirstPartyFetch, idempotencyKey: string, trigger: 'owner_manual' | 'scheduler' = 'owner_manual', extras: Record<string, unknown> = {}, now = NOW) {
  return executeContentOperationEntry({ ownerUserId: 1, entryId: lineage.entry.id, trigger, now, value: { idempotencyKey, mode: 'execute' }, dependencies: dependencies(lineage, fetchImpl, extras) })
}

async function exactV4Fixture(targetCount: number) {
  const fixture = new ContentOperationsFixture()
  fixture.evidenceApprovalAt = NOW.toISOString()
  const client = fixture.addClient(1)
  client.canonicalSiteOrigin = 'https://doalignment.com'
  client.framework = 'nextjs'
  client.publicationTransport = 'first_party_signed_api'
  const calendar = await fixture.addCalendar(1, '2026-10-08', 1)
  calendar.updatedAt = NOW
  const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
  entry.language = 'zh-hant'
  const bundle = fixture.bundles.get(`1:${calendar.productionPlanId}`)
  if (bundle?.deliverables[0]) bundle.deliverables[0].language = 'zh-hant'
  const targets: ContentOperationPublicationTargetRow[] = []
  for (let index = 0; index < targetCount; index += 1) {
    const created = await createOwnerPublicationTarget(1, client.id, {
      idempotencyKey: `v4-signed-target-${index + 1}`, framework: 'nextjs', transport: 'first_party_signed_api', targetOrigin: `https://v4-site-${index + 1}.doalignment.com`,
      contentRoot: 'journal', endpointPath: '/api/first-party/content-ingest', credentialReference: `ref-v4-signed-target-${index + 1}`,
      allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], maximumPayloadBytes: 100_000, executionEnabled: true,
    }, fixture.repository)
    const storedTarget = fixture.targets.find(row => row.id === created.target.id)
    if (!storedTarget) throw new Error('synthetic V4 target was not persisted')
    targets.push(storedTarget)
  }
  const profile = await saveOwnerEntityStrategyProfile(1, client.id, {
    targetRowId: targets[0]!.id, idempotencyKey: 'v4-signed-profile', canonicalBrandName: 'Fixture Brand', brandAliases: [], canonicalWebsiteOrigin: client.canonicalSiteOrigin,
    businessType: 'services', primaryLocale: 'zh-hant', secondaryLocales: [], primaryLocations: [], serviceAreas: [], primaryServices: ['內容策略'], secondaryServices: [],
    targetAudience: ['owners'], primaryQueryClusters: [entry.topicCluster], supportingQueryClusters: [], canonicalPillarPages: ['https://doalignment.com/pillar'], servicePageBindings: {},
    approvedBrandFacts: ['Fixture Brand 提供內容策略服務。'], approvedDifferentiators: [], prohibitedClaims: ['保證結果'], preferredTone: '清楚且以證據為本', requiredDisclosures: [],
    internalLinkPolicy: 'canonical links only', structuredDataIdentity: { name: 'Fixture Brand' }, evidenceSnapshotHash: entry.evidenceSnapshotHash,
  }, fixture.repository, NOW)
  await saveOwnerQueryOwnership(1, client.id, {
    targetRowId: targets[0]!.id, idempotencyKey: 'v4-signed-query', ownerPageId: 'https://doalignment.com/pillar', normalizedQuery: entry.topicCluster,
    queryCluster: entry.topicCluster, supportingArticleIds: [], evidenceSnapshotHash: entry.evidenceSnapshotHash,
  }, fixture.repository, NOW)
  const policies: Record<number, Awaited<ReturnType<typeof enableOwnerAutopilot>>['policy']> = {}
  for (const target of targets) {
    policies[target.id] = (await enableOwnerAutopilot(1, client.id, {
      policyVersion: 'governed-autopilot-policy-v4', targetRowId: target.id, entityStrategyProfileId: profile.profile.profileId, mode: 'balanced',
      expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['zh-hant'], allowedDestinations: [target.targetId], allowedCadences: [3],
      allowedRiskClasses: ['general'], maximumRepairAttempts: 1, maximumTopicSubstitutions: 0, generationBudget: 1, publicationBudget: 1,
    }, fixture.repository, NOW)).policy
  }
  if (targetCount > 1) await bindOwnerEntryPublicationTargets(1, entry.id, { targetRowIds: targets.map(target => target.id) }, fixture.repository)
  await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: 'v4-signed-materialize' }, fixture.repository, { clock: { now: () => NOW, localDate: () => '2026-10-08' }, eligibleEntryIds: [entry.id] })

  const body = '# Fixture Brand 的 opportunity-1 內容策略\n\nFixture Brand 依已核准資料整理內容策略服務與適用範圍。[cite:1]\n\n## 可核對的依據\n\n本文只整理已核准事實，不承諾排名或商業成果；網站負責人可先對照 canonical pillar page 再確認。\n\n## 下一步\n\n依照目前服務資訊檢查文章主題、頁面結構與內部連結。'
  const qwenFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: body } }] }), { status: 200 }))
  const qwenRuntime = createGeoFlowQwenGenerationRuntime({ endpoint: 'https://ws-fixture1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', credentialRef: 'ref-v4-mock-qwen', resolveCredential: async () => 'mock-qwen-secret', fetchImpl: qwenFetch as typeof fetch, now: () => NOW.toISOString() })
  const optimizationAdapter: GeoRewriteAdapter = {
    id: 'custom', version: 'mock-autogeo-provider-v1',
    async rewrite(document, rules) { return { provider: 'autogeo-bailian-qwen', providerVersion: 'qwen-plus', optimizedTitle: document.title, optimizedContent: document.content, appliedRuleIds: rules.map(rule => rule.id), safetyNotes: ['synthetic fixture'], provenance: { execution: 'autogeo-framework-bailian-qwen', providerExecution: true, requestedProvider: 'autogeo-bailian-qwen', model: 'qwen-plus', upstreamRepository: 'cxcscmu/AutoGEO', upstreamRevision: 'injected-test-mock', rewriteMethod: 'autogeo_api', ruleset: 'Researchy-GEO / Gemini default rules' } } },
  }
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl: FirstPartyFetch = vi.fn(async (url, request) => {
    const payload = JSON.parse(request.body || '{}') as Record<string, unknown>
    requests.push({ url, body: payload })
    return { status: 202, headers: {}, text: async () => JSON.stringify(receipt(String(payload.publicationId), String(payload.contentHash))) } as FirstPartyFetchResponse
  }) as FirstPartyFetch
  const dependencies = { productionRuntime: { qwenRuntime, optimizationAdapter, productionPersistence: fixture.productionPersistence() }, fetchImpl, serverCredentialResolver: async () => ({ ok: true as const, value: SECRET }), resolveMultiChannelCredential: async () => SECRET, nonceProvider: () => 'v4-synthetic-nonce-000001' }
  return { fixture, entry, targets, policies, qwenFetch, requests, fetchImpl, dependencies }
}

describe('Content Operations Do Alignment draft receipt', () => {
  it.each([1, 2])('sends exact V4 authorization through real signed API for %s bound target(s)', async targetCount => {
    const context = await exactV4Fixture(targetCount)
    const generated = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: context.fixture.repository, dependencies: context.dependencies })
    expect(generated.results.some(result => result.outcome === 'awaiting_review')).toBe(true)
    expect(context.qwenFetch).toHaveBeenCalledTimes(1)

    const published = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: context.fixture.repository, dependencies: context.dependencies })
    expect(published.results.some(result => result.outcome === 'draft_received')).toBe(true)
    expect(context.fetchImpl).toHaveBeenCalledTimes(targetCount)
    expect(context.fixture.reviews.size).toBe(0)
    expect(context.fixture.machineAuthorizations.every(row => row.status === 'draft_received' && row.revokedAt === null)).toBe(true)
    const byTarget = new Map(context.fixture.machineAuthorizations.map(row => [row.publicationTargetId, row]))
    for (const attempt of context.fixture.attempts) {
      const authorization = byTarget.get(attempt.targetId)!
      expect(attempt.authorityReference).toBe(authorization.authorizationFingerprint)
      const request = context.requests.find(item => item.url.startsWith(context.targets.find(target => target.id === attempt.targetId)!.targetOrigin))!
      expect((request.body.identity as Record<string, unknown>).reviewId).toBe(`ref-autopilot-v4-${authorization.authorizationFingerprint}`)
    }

    await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 60_000), repository: context.fixture.repository, dependencies: context.dependencies })
    expect(context.fetchImpl).toHaveBeenCalledTimes(targetCount)
    expect(context.fixture.machineAuthorizations.every(row => row.status === 'draft_received' && row.revokedAt === null)).toBe(true)
  })

  it('uses a prefixed review reference at the real signed sender boundary for governed V4', async () => {
    const target = makeSignedTarget({ framework: 'nextjs', targetOrigin: 'https://doalignment.com', allowedLanguages: ['zh-hant'] })
    const rawAuthorizationFingerprint = HASH
    const rawPublication = makePublication({ reviewId: rawAuthorizationFingerprint, reviewDecision: 'governed_autopilot' })
    expect(planFirstPartyPublication(target, rawPublication, FIXTURE_NOW)).toMatchObject({ status: 'blocked', code: 'PUBLICATION_NOT_APPROVED' })

    const publication = makePublication({ reviewId: `ref-autopilot-v4-${rawAuthorizationFingerprint}`, reviewDecision: 'governed_autopilot' })
    expect(planFirstPartyPublication(target, publication, FIXTURE_NOW).status).toBe('planned')
    const fetchImpl: FirstPartyFetch = vi.fn(async (_url, request) => {
      const payload = JSON.parse(request.body || '{}') as Record<string, unknown>
      return { status: 202, headers: {}, text: async () => JSON.stringify(receipt(String(payload.publicationId), String(payload.contentHash))) } as FirstPartyFetchResponse
    }) as FirstPartyFetch
    const result = await executeFirstPartyPublication({ target, publication, now: FIXTURE_NOW, mode: 'execute', fetchImpl, serverCredentialResolver: async () => ({ ok: true, value: SECRET }), nonceProvider: () => 'synthetic-v4-nonce-00001' })
    expect(result.status).toBe('draft_received')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('persists a single private draft receipt as terminal review-pending, not delivery or learning', async () => {
    const lineage = await readyFixture()
    const { fetchImpl, posts } = syntheticFetch()
    const captureBefore = vi.fn()
    const registerLearning = vi.fn()
    const scheduleMeasurement = vi.fn()
    const result = await execute(lineage, fetchImpl, 'single-draft-key', 'owner_manual', {
      liveActions: { enabled: true, capture: captureBefore, now: () => NOW },
      publicationBridge: { enabled: true, register: registerLearning, schedule: scheduleMeasurement },
    })
    expect(result).toMatchObject({ outcome: 'draft_received', resultingStatus: 'awaiting_site_review', retryAt: null })
    expect(lineage.entry.status).toBe('awaiting_site_review')
    expect((await lineage.repository.listRuns(1, lineage.entry.id)).find(row => row.stage === 'publication')).toMatchObject({ state: 'succeeded', retryEligibleAt: null })
    const [attempt] = await lineage.repository.listPublicationAttempts(1, lineage.entry.id)
    expect(attempt).toMatchObject({ status: 'draft_received', remoteState: 'draft_received', remoteRevision: null, publicationUrl: null, errorCode: null, errorSummary: null, idempotencyKey: 'single-draft-key' })
    expect(attempt!.receiptLedger).toEqual([receipt(String(posts[0]!.body.publicationId), String(posts[0]!.body.contentHash))])
    expect(lineage.fixture.events.some(event => ['publication_delivered', 'publication_route_delivered'].includes(event.eventType))).toBe(false)
    expect(captureBefore).not.toHaveBeenCalled()
    expect(registerLearning).not.toHaveBeenCalled()
    expect(scheduleMeasurement).not.toHaveBeenCalled()

    const repeatedSame = await execute(lineage, fetchImpl, 'single-draft-key')
    const repeatedNew = await execute(lineage, fetchImpl, 'different-key')
    const scheduler = await execute(lineage, fetchImpl, 'scheduler-revisit-key', 'scheduler')
    expect([repeatedSame.outcome, repeatedNew.outcome, scheduler.outcome]).toEqual(['draft_received', 'draft_received', 'draft_received'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id))).toHaveLength(1)

    const workspace = await getOwnerContentOperationsWorkspace(1, lineage.repository)
    expect(workspace.entries.find(row => row.id === lineage.entry.id)).toMatchObject({ status: 'awaiting_site_review', nextAction: 'wait', latestDraftReceipt: receipt(String(posts[0]!.body.publicationId), String(posts[0]!.body.contentHash)) })
    const savedAttempt = lineage.fixture.attempts[0]!
    savedAttempt.receiptFingerprint = '0'.repeat(64)
    expect((await getOwnerContentOperationsWorkspace(1, lineage.repository)).entries.find(row => row.id === lineage.entry.id)?.latestDraftReceipt).toBeNull()
    savedAttempt.receiptFingerprint = (await lineage.repository.listPublicationAttempts(1, lineage.entry.id))[0]!.receiptFingerprint
    savedAttempt.ownerUserId = 2
    expect((await getOwnerContentOperationsWorkspace(1, lineage.repository)).entries.find(row => row.id === lineage.entry.id)?.latestDraftReceipt).toBeNull()
  })

  it('blocks invalid receiver identity without storing a receipt or reporting a wait outcome', async () => {
    const lineage = await readyFixture()
    const { fetchImpl } = syntheticFetch({ respond: (_url, body) => ({ status: 202, body: receipt(String(body.publicationId), 'f'.repeat(64)) }) })
    const result = await execute(lineage, fetchImpl, 'invalid-draft-key')
    expect(result.outcome).toBe('blocked')
    expect(lineage.entry.status).toBe('blocked')
    const [attempt] = await lineage.repository.listPublicationAttempts(1, lineage.entry.id)
    expect(attempt).toMatchObject({ status: 'blocked', remoteRevision: null, publicationUrl: null })
    expect(attempt!.receiptLedger).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'draft_received' })]))
    expect(lineage.fixture.events.some(event => event.eventType === 'publication_delivered')).toBe(false)
  })

  it('recovers a lost finalization with the same idempotency key and receiver replay, without creating a second post', async () => {
    const lineage = await readyFixture()
    const { fetchImpl, posts } = syntheticFetch({ respond: (_url, body, call) => ({ status: 202, body: receipt(String(body.publicationId), String(body.contentHash), call > 1) }) })
    const append = lineage.repository.appendEvent
    let failOnce = true
    lineage.repository.appendEvent = async input => {
      if (failOnce && input.eventType === 'publication_draft_received') { failOnce = false; throw new Error('synthetic transaction failure') }
      return append(input)
    }
    await expect(execute(lineage, fetchImpl, 'recover-same-key')).rejects.toThrow('synthetic transaction failure')
    expect((await lineage.repository.findEntry(1, lineage.entry.id))?.status).toBe('publishing')
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id))).toHaveLength(1)
    lineage.repository.appendEvent = append
    const recovered = await execute(lineage, fetchImpl, 'recover-same-key', 'owner_manual', {}, new Date(NOW.getTime() + 6 * 60 * 1000))
    expect(recovered.outcome).toBe('draft_received')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(posts.map(row => row.body.publicationId)).toEqual([posts[0]!.body.publicationId, posts[0]!.body.publicationId])
    expect(posts[1]!.response.body).toMatchObject({ replayed: true, postId: '9b131e17-a5c2-45e1-a40f-44b6084de9b1' })
    expect(posts[1]!.body.idempotencyKey).toBe(posts[0]!.body.idempotencyKey)
    expect(posts[1]!.body.artifactFingerprint).toBe(posts[0]!.body.artifactFingerprint)
    expect((posts[1]!.body.publication as Record<string, unknown>).scheduledAt).toBe((posts[0]!.body.publication as Record<string, unknown>).scheduledAt)
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id))).toHaveLength(1)
    expect((await lineage.repository.listPublicationAttempts(1, lineage.entry.id))[0]).toMatchObject({ status: 'draft_received', idempotencyKey: 'recover-same-key' })
  })

  it('persists all multi-channel draft receipts and exposes only validated per-target projections', async () => {
    const lineage = await readyFixture(2)
    const { fetchImpl } = syntheticFetch()
    const result = await execute(lineage, fetchImpl, 'multi-draft-key')
    expect(result).toMatchObject({ outcome: 'draft_received', resultingStatus: 'awaiting_site_review' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const attempts = await lineage.repository.listPublicationAttempts(1, lineage.entry.id)
    expect(attempts).toHaveLength(2)
    expect(attempts.every(attempt => attempt.status === 'draft_received' && attempt.remoteRevision === null && attempt.publicationUrl === null)).toBe(true)
    expect(lineage.fixture.events.some(event => event.eventType === 'publication_route_delivered')).toBe(false)
    const workspace = await getOwnerContentOperationsWorkspace(1, lineage.repository)
    const projection = workspace.entries.find(row => row.id === lineage.entry.id)!
    expect(projection).toMatchObject({ status: 'awaiting_site_review', nextAction: 'wait' })
    expect(projection.publicationTargetBindings).toHaveLength(2)
    expect(projection.publicationTargetBindings.every(binding => binding.latestAttempt?.draftReceipt?.status === 'draft_received')).toBe(true)

    const corrupted = lineage.fixture.attempts[0]!
    corrupted.receiptFingerprint = '0'.repeat(64)
    const corruptProjection = await getOwnerContentOperationsWorkspace(1, lineage.repository)
    expect(corruptProjection.entries.find(row => row.id === lineage.entry.id)?.publicationTargetBindings.find(binding => binding.targetRowId === corrupted.targetId)?.latestAttempt?.draftReceipt).toBeNull()
  })

  it('retries only unresolved multi-channel routes and does not claim overall delivery for draft plus delivered', async () => {
    const retryFixture = await readyFixture(2)
    const perTargetCalls = new Map<string, number>()
    const retry = syntheticFetch({ respond: (url, body) => {
      const count = (perTargetCalls.get(url) || 0) + 1
      perTargetCalls.set(url, count)
      return url.includes('site-1.')
        ? { status: 202, body: receipt(String(body.publicationId), String(body.contentHash), count > 1) }
        : count === 1 ? { status: 503, body: { error: 'synthetic retry' } } : { status: 202, body: receipt(String(body.publicationId), String(body.contentHash)) }
    } })
    const first = await execute(retryFixture, retry.fetchImpl, 'multi-retry-key')
    expect(first.outcome).toBe('retry_wait')
    expect(retry.fetchImpl).toHaveBeenCalledTimes(2)
    const second = await execute(retryFixture, retry.fetchImpl, 'multi-retry-key', 'owner_manual', {}, new Date(NOW.getTime() + 6 * 60 * 1000))
    expect(second.outcome).toBe('draft_received')
    expect(second.resultingStatus).toBe('awaiting_site_review')
    expect(retry.fetchImpl).toHaveBeenCalledTimes(3)
    expect(perTargetCalls.get('https://site-1.doalignment.com/api/first-party/content-ingest')).toBe(1)
    expect(perTargetCalls.get('https://site-2.doalignment.com/api/first-party/content-ingest')).toBe(2)
    expect((await retryFixture.repository.listPublicationAttempts(1, retryFixture.entry.id)).filter(row => row.status === 'draft_received')).toHaveLength(2)

    const mixedFixture = await readyFixture(2)
    const mixed = syntheticFetch({ respond: (_url, body, call) => call === 1
      ? { status: 202, body: receipt(String(body.publicationId), String(body.contentHash)) }
      : { status: 200, body: { publicationId: String(body.publicationId), contentHash: String(body.contentHash), remoteRevision: 'synthetic-real-published-revision' } } })
    const mixedResult = await execute(mixedFixture, mixed.fetchImpl, 'multi-draft-delivered-key')
    expect(mixedResult.outcome).toBe('draft_received')
    expect(mixedResult.resultingStatus).toBe('awaiting_site_review')
    expect(mixedFixture.entry.status).not.toBe('delivered')
    const mixedAttempts = await mixedFixture.repository.listPublicationAttempts(1, mixedFixture.entry.id)
    expect(mixedAttempts.map(row => row.status).sort()).toEqual(['delivered', 'draft_received'])
  })

  it('records the V4 draft-received authorization transition without rewriting the teacher review', async () => {
    const lineage = await readyFixture()
    const target = lineage.targets[0]!
    const teacherReview = lineage.fixture.recordOwnerReview(lineage.entry.id, { ownerUserId: 1, jobId: 700, draftId: 702, decision: 'approved_for_delivery', evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash })
    const authorization: ContentOperationMachineAuthorizationRow = {
      id: 900, authorizationId: 'synthetic-v4-authorization', ownerUserId: 1, clientId: 1, websiteId: target.websiteId || 'website-fixture', entryId: lineage.entry.id,
      jobId: 700, draftId: 702, publicationTargetId: target.id, policyId: 'synthetic-v4-policy', policyVersion: 'governed-autopilot-policy-v4',
      candidateId: `entry-${lineage.entry.id}:draft-702`, contentHash: DRAFT_HASH, evidenceSnapshotHash: lineage.entry.evidenceSnapshotHash,
      policyFingerprint: HASH, entityProfileFingerprint: HASH, queryOwnershipFingerprint: HASH, riskClass: 'general', riskFingerprint: HASH,
      qualityStatus: 'passed', qualityFingerprint: HASH, targetId: target.targetId, authorizationPayload: { policyVersion: 'governed-autopilot-policy-v4', authorizationFingerprint: HASH },
      authorizationFingerprint: HASH, status: 'executing', decidedAt: NOW, authorizationExpiresAt: new Date(NOW.getTime() + 15 * 60_000), claimedAt: NOW, revokedAt: null, createdAt: NOW,
    }
    lineage.fixture.machineAuthorizations.push(authorization)
    const consentBefore = structuredClone(teacherReview)

    const consumed = await lineage.repository.transaction(transaction => transaction.transitionMachineAuthorization(1, HASH, 'executing', 'draft_received', NOW))
    expect(consumed).toMatchObject({ status: 'draft_received', revokedAt: null, authorizationFingerprint: HASH })
    expect(lineage.fixture.reviews.get(lineage.entry.id)).toEqual(consentBefore)
  })

  it('rejects recycling a consumed V4 authorization before issuing a database update', async () => {
    const update = vi.fn()
    const repository = createContentOperationsRepositoryFromDatabase({ update } as never)
    const forbiddenTransitions = [
      ['draft_received', 'authorized'],
      ['draft_received', 'executing'],
      ['draft_received', 'published'],
      ['authorized', 'draft_received'],
    ] as const

    for (const [from, to] of forbiddenTransitions) {
      await expect(repository.transitionMachineAuthorization(1, HASH, from, to, NOW)).resolves.toBeNull()
    }
    expect(update).not.toHaveBeenCalled()
  })
})
