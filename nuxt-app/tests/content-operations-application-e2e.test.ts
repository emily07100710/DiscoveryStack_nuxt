import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { GEOFLOW_PROTOCOL_VERSION } from '../server/geoflow-integration'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'
import { createAutoGeoIsolatedWorkerAdapter } from '../server/geo/isolated-worker'
import { geoRules } from '../server/geo/rules'
import { evaluateContentRisk } from '../server/seo-geo-core/riskGate'
import { bindOwnerEntryPublicationTargets, createOwnerPublicationTarget, runContentOperationsExecutionTick, runOwnerContentEntryWorkflow } from '../server/content-operations/orchestrator'
import { enableOwnerAutopilot, revokeOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { buildOwnerContentLearningDataset, getOwnerContentOperationsWorkspace, recordOwnerOutcomeAssessment } from '../server/content-operations/service'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { ContentOperationPublicationTargetRow } from '../server/content-operations/types'
import { createMultiChannelExecutorRegistry, type MultiChannelExecutorRegistry } from '../server/publication-routing'
import { makeGrantedConsent, makeMeasurement } from './fixtures/outcome-learning/measurements'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const NOW = new Date('2026-08-25T04:00:00.000Z')
const EVIDENCE_HASH = 'a'.repeat(64)
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const OWNER_SUBJECT_KEY = hash('content-operations:1')

function qwenRequest(entryId: number) {
  const reviewedText = '核准的 mock evidence：這是一段只供 owner 查核的內容。'
  return {
    protocolVersion: GEOFLOW_PROTOCOL_VERSION,
    requestId: `ref-qwen-request-${entryId}`,
    idempotencyKey: `ref-qwen-idempotency-${entryId}`,
    ownerUserId: 1,
    clientId: 101,
    calendarEntryId: entryId,
    productionPlanId: 11,
    deliverableId: 1,
    briefId: 701,
    jobId: 700 + entryId,
    evidenceSnapshotHash: EVIDENCE_HASH,
    brief: { title: '核准內容主題', audience: '內容 owner', goals: ['回答核心問題'], constraints: ['不得新增未核准主張'] },
    contentType: 'article',
    language: 'en',
    generationMode: 'draft',
    revisionContext: null,
    requestedCapabilities: ['qwen_generation', 'knowledge_rag', 'human_review'],
    selectedRuleIds: [],
    authoritySourceIds: ['source-1'],
    evidenceChunks: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash: hash(reviewedText.normalize('NFKC').trim().replace(/\s+/gu, ' ')), reviewedText, locator: 'https://evidence.routing.discoverystack.dev/section-1' }],
    createdAt: NOW.toISOString(),
  }
}

function targetInput(idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey,
    framework: 'nuxt',
    transport: 'first_party_git',
    targetOrigin: 'https://api.github.com',
    serviceReference: null,
    contentRoot: 'content',
    defaultBranch: 'main',
    repositoryOwner: 'mock-owner',
    repositoryName: 'mock-repository',
    endpointPath: null,
    credentialReference: 'ref-vault-slot-1',
    allowedContentTypes: ['article'],
    allowedLanguages: ['en', 'zh-hant'],
    maximumPayloadBytes: 1_000_000,
    executionEnabled: true,
    ...overrides,
  }
}

async function addTarget(fixture: ContentOperationsFixture, clientId: number, key: string, overrides: Record<string, unknown> = {}) {
  const result = await createOwnerPublicationTarget(1, clientId, targetInput(key, overrides), fixture.repository)
  return fixture.targets.find(target => target.id === result.target.id)!
}

function createProviderBackedMockRunner(fixture: ContentOperationsFixture, options: { qwenFetch?: ReturnType<typeof vi.fn>; riskStatus?: 'passed' | 'needs_human_review' } = {}) {
  const qwenFetch = options.qwenFetch || vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: '# 核准內容主題\n\n核准的 mock evidence：這是一段只供 owner 查核的內容。本文只整理已核准資料，不新增任何外部事實。發布前由 owner 逐項核對來源、範圍、語言與頁面路徑。'.repeat(3) } }] }), { status: 200 }))
  const autoGeoProvider = vi.fn()
  const qwenRuntime = createGeoFlowQwenGenerationRuntime({     endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', credentialRef: 'ref-qwen-credential', resolveCredential: async () => 'mock-qwen-secret', fetchImpl: qwenFetch as typeof fetch, now: () => NOW.toISOString() })
  const isolated = createAutoGeoIsolatedWorkerAdapter()
  const runner = async ({ ownerUserId, deliverableId }: { ownerUserId: number; planId: number; deliverableId: number; dependencies?: unknown }) => {
    const entry = fixture.entries.find(row => row.ownerUserId === ownerUserId && row.productionDeliverableId === deliverableId)
    if (!entry) throw new Error('fixture entry not found')
    const generated = await qwenRuntime.generate(qwenRequest(entry.id))
    if (!generated.ok || generated.value.status !== 'review_required') return { job: { id: 700 + entry.id, status: 'blocked' } }
    const selectedRules = geoRules.filter(rule => ['direct-answer-first', 'semantic-sections'].includes(rule.id))
    const autoGeo = await isolated.rewrite({ title: '核准內容主題', content: generated.value.contentArtifact.bodyMarkdown, language: 'en' }, selectedRules)
    autoGeoProvider()
    const body = autoGeo.optimizedContent
    const risk = evaluateContentRisk({ source: { title: '核准內容主題', content: generated.value.contentArtifact.bodyMarkdown, language: 'en' }, candidateTitle: autoGeo.optimizedTitle, candidateBody: body, evidenceCount: 1 })
    const riskStatus = options.riskStatus || (risk.status === 'passed' ? 'passed' : 'needs_human_review')
    const jobId = 700 + entry.id
    const draftId = 800 + entry.id
    const draft = {
      id: draftId,
      ownerUserId,
      jobId,
      version: 1,
      title: autoGeo.optimizedTitle,
      body,
      contentHash: hash(body),
      provenance: {
        stage: 'optimized',
        provider: 'bailian',
        providerVersion: 'qwen-plus',
        providerExecution: true,
        model: 'bailian:qwen-plus',
        qualityGateVersion: 'content-risk-gate-v1',
        evidenceSnapshotHash: entry.evidenceSnapshotHash,
        promptFingerprint: hash(JSON.stringify(qwenRequest(entry.id))),
        retrievalSnapshotHash: entry.evidenceSnapshotHash,
        selectedRuleIds: selectedRules.map(rule => rule.id),
        appliedRuleIds: autoGeo.appliedRuleIds,
        providerProvenance: { providerExecution: true, provider: 'bailian', model: 'bailian:qwen-plus', execution: 'mock-provider' },
      },
      safetyStatus: riskStatus === 'passed' ? 'passed' : 'needs_review',
      evidenceRefs: [{ sourceId: 'source-1', artifactId: 'artifact-1' }],
    }
    const job = { id: jobId, ownerUserId, productionPlanId: 11, productionDeliverableId: deliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 701, status: 'approved' }
    const deliverable = { id: deliverableId, ownerUserId, planId: 11, briefId: 701, jobId, selectionId: entry.strategyRecommendationId, contentType: entry.contentType, title: autoGeo.optimizedTitle, audience: '內容 owner', language: entry.language, evidenceSnapshotHash: entry.evidenceSnapshotHash, opportunityKey: `1:opportunity-1`, provenance: { authoritySourceIds: ['source-1'], promptFingerprint: hash(JSON.stringify(qwenRequest(entry.id))), retrievalSnapshotHash: entry.evidenceSnapshotHash, selectedRuleIds: selectedRules.map(rule => rule.id), appliedRuleIds: autoGeo.appliedRuleIds } }
    const riskGate = { id: 900 + entry.id, ownerUserId, draftId, status: riskStatus, evidenceSnapshotHash: entry.evidenceSnapshotHash, gateVersion: 'content-risk-gate-v1', findings: risk.findings }
    fixture.persistGeneratedLineage(entry.id, { deliverable, job, draft, riskGate })
    return { job, draft, riskGate }
  }
  return { runner, qwenFetch, autoGeoProvider }
}

function mockedMultiChannelRegistry(failureOnHttpCall?: (callNumber: number) => boolean): { registry: MultiChannelExecutorRegistry; httpCalls: ReturnType<typeof vi.fn>; firstPartyCalls: ReturnType<typeof vi.fn> } {
  const httpCalls = vi.fn()
  const firstPartyCalls = vi.fn()
  const registry = createMultiChannelExecutorRegistry({
    httpTransport: async (_url, init) => {
      httpCalls()
      const payload = JSON.parse(init.body) as { destinationPublicationIdentity: string; contentHash: string }
      const callNumber = httpCalls.mock.calls.length
      if (failureOnHttpCall?.(callNumber)) return { status: 503, text: async () => '' }
      return { status: 200, text: async () => JSON.stringify({ publicationId: payload.destinationPublicationIdentity, contentHash: payload.contentHash, remoteRevision: `ref-http-revision-${callNumber}` }) }
    },
  })
  registry.first_party_git = async ({ route }) => {
    firstPartyCalls()
    return { status: 'delivered', remote: { publicationId: route.destinationPublicationIdentity, contentHash: route.contentHash, remoteRevision: `ref-git-revision-${firstPartyCalls.mock.calls.length}` } }
  }
  return { registry, httpCalls, firstPartyCalls }
}

async function createSingleManualFixture() {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(1)
  const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
  const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
  entry.status = 'materialized'
  const target = await addTarget(fixture, client.id, 'ref-target-manual')
  await bindOwnerEntryPublicationTargets(1, entry.id, { targetRowIds: [target.id] }, fixture.repository)
  return { fixture, client, calendar, entry, target }
}

async function createMultiAutopilotFixture() {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(1)
  const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
  calendar.updatedAt = NOW
  const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
  entry.status = 'materialized'
  const firstParty = await addTarget(fixture, client.id, 'ref-target-git')
  const wordpress = await addTarget(fixture, client.id, 'ref-target-wordpress', { framework: 'wordpress', transport: 'wordpress_rest', targetOrigin: 'https://wordpress-customer.discoverystack.dev', contentRoot: 'wp-content', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/wp-json/wp/v2/posts' })
  await bindOwnerEntryPublicationTargets(1, entry.id, { targetRowIds: [firstParty.id, wordpress.id] }, fixture.repository)
  const policyInput = { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'], cadenceDays: 3 as const, evidenceFreshnessHours: 720, maximumRiskLevel: 'general' as const, requiredQualityGateVersion: 'content-risk-gate-v1', allowedProviderModels: ['bailian:qwen-plus'] }
  const firstPolicy = await enableOwnerAutopilot(1, client.id, { ...policyInput, targetRowId: firstParty.id }, fixture.repository, NOW)
  const secondPolicy = await enableOwnerAutopilot(1, client.id, { ...policyInput, targetRowId: wordpress.id }, fixture.repository, NOW)
  return { fixture, client, calendar, entry, firstParty, wordpress, firstPolicy: firstPolicy.policy, secondPolicy: secondPolicy.policy }
}

describe('Content Operations application-level lifecycle V1', () => {
  it('runs manual generation→owner review→publication and derives outcome/learning from the verified receipt', async () => {
    const { fixture, entry, target } = await createSingleManualFixture()
    const mock = createProviderBackedMockRunner(fixture)
    const publicationExecutor = vi.fn(async ({ publication }: { publication: { productionDeliverableId: string; contentHash: string } }) => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: publication.productionDeliverableId, contentHash: publication.contentHash, remoteRevision: 'ref-manual-revision', artifactFingerprint: hash('manual-artifact'), idempotencyKey: 'ref-manual-executor' }))
    const result = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: entry.id, mode: 'execute', idempotencyKey: 'ref-app-manual', now: NOW, reviewDecision: 'approved_for_delivery', dependencies: { repository: fixture.repository, productionDeliverableRunner: mock.runner, reviewService: async input => fixture.recordOwnerReview(input.entryId, { ownerUserId: input.ownerUserId, jobId: input.jobId, draftId: input.draftId, decision: input.decision, evidenceSnapshotHash: entry.evidenceSnapshotHash }), publicationExecutor } })
    expect(result.outcome).toBe('delivered')
    expect(mock.qwenFetch).toHaveBeenCalledTimes(1)
    expect(mock.autoGeoProvider).toHaveBeenCalledTimes(1)
    expect(fixture.reviews.size).toBe(1)
    expect(fixture.attempts).toHaveLength(1)
    expect(fixture.attempts[0]).toMatchObject({ targetId: target.id, status: 'delivered', contentHash: fixture.entries.find(row => row.id === entry.id)?.contentHash })
    expect(fixture.events.some(event => event.eventType === 'publication_delivered')).toBe(true)

    const outcome = await recordOwnerOutcomeAssessment(1, { entryId: entry.id, idempotencyKey: 'ref-app-manual-outcome', baselineMeasurements: [makeMeasurement({ deidentifiedSubjectKey: OWNER_SUBJECT_KEY, windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-08T00:00:00.000Z', capturedAt: '2026-08-09T00:00:00.000Z' })], followUpMeasurements: [makeMeasurement({ phase: 'follow_up', deidentifiedSubjectKey: OWNER_SUBJECT_KEY, windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-08T00:00:00.000Z', capturedAt: '2026-09-09T00:00:00.000Z', metrics: { impressions: 1400, clicks: 210, averagePosition: 8 } })], consent: makeGrantedConsent(), learningCandidate: true, dataContractVersion: 'outcome-contract-v1', measuredAt: '2026-09-09T12:00:00.000Z' }, fixture.repository)
    expect(outcome.persisted.targetId).toBe(target.id)
    expect(typeof outcome.persisted.publicationReceiptFingerprint).toBe('string')
    expect(outcome.persisted.publicationReceiptFingerprint).toHaveLength(64)
    expect(outcome.persisted.publishedUrl).toBeNull()
    const dataset = await buildOwnerContentLearningDataset(1, fixture.repository)
    expect(dataset.candidateResults[0]?.candidateStatus).toBe('eligible')
    expect(dataset.datasetDigest).toMatch(/^[a-f0-9]{64}$/)
    const workspace = await getOwnerContentOperationsWorkspace(1, fixture.repository)
    expect(workspace.entries.find(item => item.id === entry.id)?.nextAction).toBe('learn')
  })

  it('runs governed autopilot without a per-article review across two bound targets, with one durable attempt per target', async () => {
    const context = await createMultiAutopilotFixture()
    const mock = createProviderBackedMockRunner(context.fixture)
    const mocked = mockedMultiChannelRegistry()
    const result = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: context.entry.id, mode: 'execute', idempotencyKey: 'ref-app-autopilot', now: NOW, dependencies: { repository: context.fixture.repository, productionDeliverableRunner: mock.runner, autopilotPolicy: context.firstPolicy, autopilotPoliciesByTarget: { [context.firstParty.id]: context.firstPolicy, [context.wordpress.id]: context.secondPolicy }, multiChannelRegistry: mocked.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(result.outcome).toBe('delivered')
    expect(context.fixture.reviews.size).toBe(0)
    expect(context.fixture.attempts).toHaveLength(2)
    expect(context.fixture.attempts.map(attempt => attempt.targetId).sort()).toEqual([context.firstParty.id, context.wordpress.id].sort())
    expect(context.fixture.attempts.every(attempt => attempt.status === 'delivered' && attempt.authorityReference?.startsWith('ref-autopilot-'))).toBe(true)
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(1)
    const routeEvents = context.fixture.events.filter(event => event.eventType.startsWith('publication_route_'))
    expect(routeEvents).toHaveLength(2)
    expect(routeEvents.every(event => event.websiteId && event.draftId && event.routingPlanId && event.routeId && event.executorRunId && event.contentHash && event.evidenceSnapshotHash && event.authorityReference)).toBe(true)
  })

  it('retries only the failed target, preserves the delivered target receipt, and replays without a second provider/site call', async () => {
    const context = await createMultiAutopilotFixture()
    const mock = createProviderBackedMockRunner(context.fixture)
    const mocked = mockedMultiChannelRegistry(callNumber => callNumber === 1)
    const dependencies = { repository: context.fixture.repository, productionDeliverableRunner: mock.runner, autopilotPolicy: context.firstPolicy, autopilotPoliciesByTarget: { [context.firstParty.id]: context.firstPolicy, [context.wordpress.id]: context.secondPolicy }, multiChannelRegistry: mocked.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' }
    const first = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: context.entry.id, mode: 'execute', idempotencyKey: 'ref-app-partial', now: NOW, dependencies })
    expect(first.outcome).toBe('retry_wait')
    expect(context.fixture.attempts).toHaveLength(2)
    expect(context.fixture.attempts.filter(attempt => attempt.status === 'delivered')).toHaveLength(1)
    expect(context.fixture.attempts.filter(attempt => attempt.status === 'retryable_failure')).toHaveLength(1)
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(1)

    const retry = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 6 * 60 * 1000), repository: context.fixture.repository, dependencies: { autopilotPolicy: context.firstPolicy, autopilotPoliciesByTarget: { [context.firstParty.id]: context.firstPolicy, [context.wordpress.id]: context.secondPolicy }, multiChannelRegistry: mocked.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(retry.results.some(result => result.outcome === 'delivered')).toBe(true)
    expect(context.fixture.attempts).toHaveLength(3)
    expect(context.fixture.attempts.filter(attempt => attempt.status === 'delivered')).toHaveLength(2)
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(2)
    const replay = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: context.entry.id, mode: 'execute', idempotencyKey: 'ref-app-partial-replay', now: new Date(NOW.getTime() + 7 * 60 * 1000), dependencies })
    expect(replay.outcome).toBe('replayed')
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(2)
  })

  it('fails closed for missing credential, stale evidence, high-risk generation, and revoked authority without executor calls', async () => {
    const missing = await createMultiAutopilotFixture()
    const missingMock = createProviderBackedMockRunner(missing.fixture)
    const missingRegistry = mockedMultiChannelRegistry()
    const missingResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: missing.entry.id, mode: 'execute', idempotencyKey: 'ref-app-missing-credential', now: NOW, dependencies: { repository: missing.fixture.repository, productionDeliverableRunner: missingMock.runner, autopilotPolicy: missing.firstPolicy, autopilotPoliciesByTarget: { [missing.firstParty.id]: missing.firstPolicy, [missing.wordpress.id]: missing.secondPolicy }, multiChannelRegistry: missingRegistry.registry, resolveMultiChannelCredential: async () => undefined } })
    expect(missingResult.outcome).toBe('blocked')
    expect(missingRegistry.firstPartyCalls).not.toHaveBeenCalled()
    expect(missingRegistry.httpCalls).not.toHaveBeenCalled()

    const stale = await createMultiAutopilotFixture()
    stale.calendar.updatedAt = new Date(NOW.getTime() - 721 * 60 * 60 * 1000)
    const staleMock = createProviderBackedMockRunner(stale.fixture)
    const staleResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: stale.entry.id, mode: 'execute', idempotencyKey: 'ref-app-stale', now: NOW, dependencies: { repository: stale.fixture.repository, productionDeliverableRunner: staleMock.runner, autopilotPolicy: stale.firstPolicy, autopilotPoliciesByTarget: { [stale.firstParty.id]: stale.firstPolicy, [stale.wordpress.id]: stale.secondPolicy }, multiChannelRegistry: mockedMultiChannelRegistry().registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(staleResult.outcome).toBe('blocked')

    const highRisk = await createMultiAutopilotFixture()
    const highRiskMock = createProviderBackedMockRunner(highRisk.fixture, { riskStatus: 'needs_human_review' })
    const highRiskRegistry = mockedMultiChannelRegistry()
    const highRiskResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: highRisk.entry.id, mode: 'execute', idempotencyKey: 'ref-app-high-risk', now: NOW, dependencies: { repository: highRisk.fixture.repository, productionDeliverableRunner: highRiskMock.runner, autopilotPolicy: highRisk.firstPolicy, autopilotPoliciesByTarget: { [highRisk.firstParty.id]: highRisk.firstPolicy, [highRisk.wordpress.id]: highRisk.secondPolicy }, multiChannelRegistry: highRiskRegistry.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(highRiskResult.outcome).toBe('blocked')
    expect(highRiskRegistry.firstPartyCalls).not.toHaveBeenCalled()
    expect(highRiskRegistry.httpCalls).not.toHaveBeenCalled()

    const revoked = await createMultiAutopilotFixture()
    const revokedPolicy = await revokeOwnerAutopilot(1, revoked.client.id, revoked.fixture.repository)
    const revokedMock = createProviderBackedMockRunner(revoked.fixture)
    const revokedRegistry = mockedMultiChannelRegistry()
    const revokedResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: revoked.entry.id, mode: 'execute', idempotencyKey: 'ref-app-revoked', now: NOW, dependencies: { repository: revoked.fixture.repository, productionDeliverableRunner: revokedMock.runner, autopilotPolicy: revokedPolicy.policy, autopilotPoliciesByTarget: { [revoked.firstParty.id]: revokedPolicy.policy, [revoked.wordpress.id]: revokedPolicy.policy }, multiChannelRegistry: revokedRegistry.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(revokedResult.outcome).toBe('blocked')
    expect(revokedRegistry.firstPartyCalls).not.toHaveBeenCalled()
    expect(revokedRegistry.httpCalls).not.toHaveBeenCalled()
  })
})
