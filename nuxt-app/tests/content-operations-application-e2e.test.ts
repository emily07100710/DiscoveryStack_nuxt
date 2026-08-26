import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'
import { createAutoGeoIsolatedWorkerAdapter } from '../server/geo/isolated-worker'
import { geoRules } from '../server/geo/rules'
import type { GeoRewriteAdapter } from '../server/geo/contracts'
import { bindOwnerEntryPublicationTargets, createOwnerPublicationTarget, runContentOperationsExecutionTick, runOwnerContentEntryWorkflow } from '../server/content-operations/orchestrator'
import { enableOwnerAutopilot, revokeOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { buildOwnerContentLearningDataset, getOwnerContentOperationsWorkspace, recordOwnerOutcomeAssessment } from '../server/content-operations/service'
import type { ContentOperationPublicationTargetRow } from '../server/content-operations/types'
import { createMultiChannelExecutorRegistry, type MultiChannelExecutorRegistry } from '../server/publication-routing'
import { makeGrantedConsent, makeMeasurement } from './fixtures/outcome-learning/measurements'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const NOW = new Date('2026-08-25T04:00:00.000Z')
const EVIDENCE_HASH = 'a'.repeat(64)
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const OWNER_SUBJECT_KEY = hash('content-operations:1')

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

function createProviderBackedMockRuntime(options: { qwenFetch?: ReturnType<typeof vi.fn>; highRisk?: boolean } = {}) {
  const baseBody = '# 核准內容主題\\n\\n核准的 mock evidence：這是一段只供 owner 查核的內容。本文只整理已核准資料，不新增任何外部事實。發布前由 owner 逐項核對來源、範圍、語言與頁面路徑。'
  const responseBody = options.highRisk ? `${baseBody}\\n\\nApproved test evidence records ranked #1 as a prohibited measurement claim.` : baseBody.repeat(3)
  const qwenFetch = options.qwenFetch || vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: responseBody } }] }), { status: 200 }))
  const autoGeoProvider = vi.fn()
  const qwenRuntime = createGeoFlowQwenGenerationRuntime({ endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', credentialRef: 'ref-qwen-credential', resolveCredential: async () => 'mock-qwen-secret', fetchImpl: qwenFetch as typeof fetch, now: () => NOW.toISOString() })
  const isolated = createAutoGeoIsolatedWorkerAdapter()
  const optimizationAdapter: GeoRewriteAdapter = {
    id: 'custom',
    version: 'mock-autogeo-provider-v1',
    async rewrite(document: Parameters<typeof isolated.rewrite>[0], rules: Parameters<typeof isolated.rewrite>[1]) {
      const optimized = await isolated.rewrite(document, rules)
      autoGeoProvider()
      return { ...optimized, provider: 'autogeo-bailian-qwen', providerVersion: 'qwen-plus', provenance: { ...optimized.provenance, execution: 'autogeo-framework-bailian-qwen', providerExecution: true, requestedProvider: 'autogeo-bailian-qwen', model: 'qwen-plus' } }
    },
  }
  return { qwenRuntime, optimizationAdapter, qwenFetch, autoGeoProvider }
}

function productionRuntime(fixture: ContentOperationsFixture, runtime: ReturnType<typeof createProviderBackedMockRuntime>) {
  return { qwenRuntime: runtime.qwenRuntime, optimizationAdapter: runtime.optimizationAdapter, productionPersistence: fixture.productionPersistence() }
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
  fixture.evidenceApprovalAt = NOW.toISOString()
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
    const runtime = createProviderBackedMockRuntime()
    const publicationExecutor = vi.fn(async ({ publication }: { publication: { productionDeliverableId: string; contentHash: string } }) => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: publication.productionDeliverableId, contentHash: publication.contentHash, remoteRevision: 'ref-manual-revision', artifactFingerprint: hash('manual-artifact'), idempotencyKey: 'ref-manual-executor' }))
    const result = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: entry.id, mode: 'execute', idempotencyKey: 'ref-app-manual', now: NOW, reviewDecision: 'approved_for_delivery', dependencies: { repository: fixture.repository, productionRuntime: productionRuntime(fixture, runtime), reviewService: async input => fixture.recordOwnerReview(input.entryId, { ownerUserId: input.ownerUserId, jobId: input.jobId, draftId: input.draftId, decision: input.decision, evidenceSnapshotHash: entry.evidenceSnapshotHash }), publicationExecutor } })
    expect(result.outcome).toBe('delivered')
    expect(runtime.qwenFetch).toHaveBeenCalledTimes(1)
    expect(runtime.autoGeoProvider).toHaveBeenCalledTimes(1)
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
    const projectedEntry = workspace.entries.find(item => item.id === entry.id)
    expect(projectedEntry?.nextAction).toBe('learn')
    expect(projectedEntry?.publicationTargetBindings).toHaveLength(1)
    expect(projectedEntry?.publicationTargetBindings[0]).toMatchObject({ targetRowId: target.id, targetId: target.targetId, websiteId: target.websiteId, latestAttempt: { status: 'delivered', attemptNumber: 1, receiptFingerprint: expect.any(String) } })
    expect(workspace.publicationTargets[0]).toMatchObject({ websiteId: target.websiteId, credentialConfigured: true, destinationPublicationIdentityConfigured: true })
    expect(JSON.stringify(workspace)).not.toContain('credential-ref')
  })

  it('runs governed autopilot without a per-article review across two bound targets, with one durable attempt per target', async () => {
    const context = await createMultiAutopilotFixture()
    const runtime = createProviderBackedMockRuntime()
    const mocked = mockedMultiChannelRegistry()
    const result = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: context.entry.id, mode: 'execute', idempotencyKey: 'ref-app-autopilot', now: NOW, dependencies: { repository: context.fixture.repository, productionRuntime: productionRuntime(context.fixture, runtime), autopilotPolicy: context.firstPolicy, autopilotPoliciesByTarget: { [context.firstParty.id]: context.firstPolicy, [context.wordpress.id]: context.secondPolicy }, multiChannelRegistry: mocked.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
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
    const workspace = await getOwnerContentOperationsWorkspace(1, context.fixture.repository)
    const projectedEntry = workspace.entries.find(item => item.id === context.entry.id)
    expect(projectedEntry?.publicationTargetBindings).toHaveLength(2)
    expect(projectedEntry?.publicationTargetBindings.every(binding => binding.latestAttempt?.status === 'delivered' && binding.latestAttempt.receiptFingerprint)).toBe(true)
  })

  it('retries only the failed target, preserves the delivered target receipt, and replays without a second provider/site call', async () => {
    const context = await createMultiAutopilotFixture()
    const runtime = createProviderBackedMockRuntime()
    const mocked = mockedMultiChannelRegistry(callNumber => callNumber === 1)
    const dependencies = { repository: context.fixture.repository, productionRuntime: productionRuntime(context.fixture, runtime), autopilotPolicy: context.firstPolicy, autopilotPoliciesByTarget: { [context.firstParty.id]: context.firstPolicy, [context.wordpress.id]: context.secondPolicy }, multiChannelRegistry: mocked.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' }
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
    const workspace = await getOwnerContentOperationsWorkspace(1, context.fixture.repository)
    const projectedEntry = workspace.entries.find(item => item.id === context.entry.id)
    const projectedBindings = projectedEntry?.publicationTargetBindings || []
    expect(projectedBindings).toHaveLength(2)
    expect(projectedBindings.every(binding => binding.latestAttempt?.status === 'delivered')).toBe(true)
    expect(projectedBindings.find(binding => binding.targetRowId === context.firstParty.id)?.latestAttempt?.attemptNumber).toBe(1)
    expect(projectedBindings.find(binding => binding.targetRowId === context.wordpress.id)?.latestAttempt?.attemptNumber).toBe(2)
  })

  it('fails closed for missing credential, stale evidence, high-risk generation, and revoked authority without executor calls', async () => {
    const missing = await createMultiAutopilotFixture()
    const missingRuntime = createProviderBackedMockRuntime()
    const missingRegistry = mockedMultiChannelRegistry()
    const missingResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: missing.entry.id, mode: 'execute', idempotencyKey: 'ref-app-missing-credential', now: NOW, dependencies: { repository: missing.fixture.repository, productionRuntime: productionRuntime(missing.fixture, missingRuntime), autopilotPolicy: missing.firstPolicy, autopilotPoliciesByTarget: { [missing.firstParty.id]: missing.firstPolicy, [missing.wordpress.id]: missing.secondPolicy }, multiChannelRegistry: missingRegistry.registry, resolveMultiChannelCredential: async () => undefined } })
    expect(missingResult.outcome).toBe('blocked')
    expect(missingRegistry.firstPartyCalls).not.toHaveBeenCalled()
    expect(missingRegistry.httpCalls).not.toHaveBeenCalled()

    const stale = await createMultiAutopilotFixture()
    stale.fixture.evidenceApprovalAt = new Date(NOW.getTime() - 721 * 60 * 60 * 1000).toISOString()
    const staleRuntime = createProviderBackedMockRuntime()
    const staleResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: stale.entry.id, mode: 'execute', idempotencyKey: 'ref-app-stale', now: NOW, dependencies: { repository: stale.fixture.repository, productionRuntime: productionRuntime(stale.fixture, staleRuntime), autopilotPolicy: stale.firstPolicy, autopilotPoliciesByTarget: { [stale.firstParty.id]: stale.firstPolicy, [stale.wordpress.id]: stale.secondPolicy }, multiChannelRegistry: mockedMultiChannelRegistry().registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(staleResult.outcome).toBe('blocked')

    const highRisk = await createMultiAutopilotFixture()
    const highRiskRuntime = createProviderBackedMockRuntime({ highRisk: true })
    const highRiskRegistry = mockedMultiChannelRegistry()
    const highRiskResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: highRisk.entry.id, mode: 'execute', idempotencyKey: 'ref-app-high-risk', now: NOW, dependencies: { repository: highRisk.fixture.repository, productionRuntime: productionRuntime(highRisk.fixture, highRiskRuntime), autopilotPolicy: highRisk.firstPolicy, autopilotPoliciesByTarget: { [highRisk.firstParty.id]: highRisk.firstPolicy, [highRisk.wordpress.id]: highRisk.secondPolicy }, multiChannelRegistry: highRiskRegistry.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(highRiskResult.outcome).toBe('blocked')
    expect(highRiskRegistry.firstPartyCalls).not.toHaveBeenCalled()
    expect(highRiskRegistry.httpCalls).not.toHaveBeenCalled()

    const revoked = await createMultiAutopilotFixture()
    const revokedPolicy = await revokeOwnerAutopilot(1, revoked.client.id, revoked.fixture.repository)
    const revokedRuntime = createProviderBackedMockRuntime()
    const revokedRegistry = mockedMultiChannelRegistry()
    const revokedResult = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: revoked.entry.id, mode: 'execute', idempotencyKey: 'ref-app-revoked', now: NOW, dependencies: { repository: revoked.fixture.repository, productionRuntime: productionRuntime(revoked.fixture, revokedRuntime), autopilotPolicy: revokedPolicy.policy, autopilotPoliciesByTarget: { [revoked.firstParty.id]: revokedPolicy.policy, [revoked.wordpress.id]: revokedPolicy.policy }, multiChannelRegistry: revokedRegistry.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(revokedResult.outcome).toBe('blocked')
    expect(revokedRegistry.firstPartyCalls).not.toHaveBeenCalled()
    expect(revokedRegistry.httpCalls).not.toHaveBeenCalled()
  })
})
