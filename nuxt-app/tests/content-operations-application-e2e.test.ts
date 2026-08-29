import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'
import { geoRules } from '../server/geo/rules'
import type { GeoRewriteAdapter } from '../server/geo/contracts'
import { bindOwnerEntryPublicationTargets, createOwnerPublicationTarget, runContentOperationsExecutionTick, runOwnerContentEntryWorkflow } from '../server/content-operations/orchestrator'
import type { ContentOperationOrchestratorDependencies } from '../server/content-operations/orchestrator'
import { enableOwnerAutopilot, revokeOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { saveOwnerEntityStrategyProfile, saveOwnerQueryOwnership } from '../server/content-operations/governance-service'
import { materializeOwnerDueContent } from '../server/content-operations/service'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
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

function createProviderBackedMockRuntime(options: { qwenFetch?: ReturnType<typeof vi.fn>; highRisk?: boolean; lowQuality?: boolean } = {}) {
  const baseBody = '# Fixture Brand 的 opportunity-1 內容策略\n\nFixture Brand 以 opportunity-1 回答 owner 的內容策略問題，以下只整理已核准資料與適用範圍。[cite:1]\n\n## 可核對的依據\n\n這份 mock 內容不新增外部事實，來源、語言與頁面路徑都維持在核准 evidence 邊界內。\n\n## 下一步\n\nOwner 可依 canonical pillar page 與 approved facts 再次核對內容，再由 policy-governed runtime 決定發布。'
  const responseBody = options.highRisk ? `${baseBody}\n\nApproved test evidence records ranked #1 as a prohibited measurement claim.` : options.lowQuality ? baseBody.replace('[cite:1]', '') : baseBody
  const qwenFetch = options.qwenFetch || vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: responseBody } }] }), { status: 200 }))
  const autoGeoProvider = vi.fn()
  const qwenRuntime = createGeoFlowQwenGenerationRuntime({ endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', credentialRef: 'ref-qwen-credential', resolveCredential: async () => 'mock-qwen-secret', fetchImpl: qwenFetch as typeof fetch, now: () => NOW.toISOString() })
  const optimizationAdapter: GeoRewriteAdapter = {
    id: 'custom',
    version: 'mock-autogeo-provider-v1',
    async rewrite(document, rules) {
      autoGeoProvider()
      return { provider: 'autogeo-bailian-qwen', providerVersion: 'qwen-plus', optimizedTitle: document.title, optimizedContent: document.content, appliedRuleIds: rules.map(rule => rule.id), safetyNotes: ['injected AutoGEO mock; no external call'], provenance: { execution: 'autogeo-framework-bailian-qwen', providerExecution: true, requestedProvider: 'autogeo-bailian-qwen', model: 'qwen-plus', upstreamRepository: 'cxcscmu/AutoGEO', upstreamRevision: 'injected-test-mock', rewriteMethod: 'autogeo_api', ruleset: 'Researchy-GEO / Gemini default rules' } }
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

async function createMultiAutopilotFixture(policyOverrides: Record<string, unknown> = {}) {
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
  const policyInput = { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'], cadenceDays: 3 as const, evidenceFreshnessHours: 720, maximumRiskLevel: 'general' as const, requiredQualityGateVersion: 'content-risk-gate-v1', allowedProviderModels: ['bailian:qwen-plus'], ...policyOverrides }
  const firstPolicy = await enableOwnerAutopilot(1, client.id, { ...policyInput, targetRowId: firstParty.id }, fixture.repository, NOW)
  const secondPolicy = await enableOwnerAutopilot(1, client.id, { ...policyInput, targetRowId: wordpress.id }, fixture.repository, NOW)
  return { fixture, client, calendar, entry, firstParty, wordpress, firstPolicy: firstPolicy.policy, secondPolicy: secondPolicy.policy }
}

async function createFormalV4GateFixture(label: string, options: { evidenceApprovalAt?: string; evidenceFreshnessHours?: number; allowedProviderModels?: readonly string[] } = {}) {
  const fixture = new ContentOperationsFixture()
  const client = fixture.addClient(1)
  client.canonicalSiteOrigin = `https://${label.replace(/[^a-z0-9-]/gu, '-')}.owner1-test.com`
  client.publicationTransport = 'first_party_git'
  const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
  calendar.updatedAt = NOW
  fixture.evidenceApprovalAt = options.evidenceApprovalAt || NOW.toISOString()
  const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
  const target = (await createOwnerPublicationTarget(1, client.id, { ...targetInput(`${label}-target`), targetOrigin: 'https://api.github.com' }, fixture.repository)).target
  await bindOwnerEntryPublicationTargets(1, entry.id, { targetRowIds: [target.id] }, fixture.repository)
  const profile = await saveOwnerEntityStrategyProfile(1, client.id, { targetRowId: target.id, idempotencyKey: `${label}-profile`, canonicalBrandName: 'Fixture Brand', brandAliases: [], canonicalWebsiteOrigin: client.canonicalSiteOrigin, businessType: 'services', primaryLocale: 'en', secondaryLocales: [], primaryLocations: [], serviceAreas: [], primaryServices: ['content strategy'], secondaryServices: [], targetAudience: ['owners'], primaryQueryClusters: [entry.topicCluster], supportingQueryClusters: [], canonicalPillarPages: [`${client.canonicalSiteOrigin}/pillar`], servicePageBindings: {}, approvedBrandFacts: ['Fixture Brand provides content strategy.'], approvedDifferentiators: [], prohibitedClaims: ['guaranteed results'], preferredTone: 'clear', requiredDisclosures: [], internalLinkPolicy: 'canonical links only', structuredDataIdentity: { name: 'Fixture Brand' }, evidenceSnapshotHash: entry.evidenceSnapshotHash }, fixture.repository, NOW)
  await saveOwnerQueryOwnership(1, client.id, { targetRowId: target.id, idempotencyKey: `${label}-query`, ownerPageId: `${client.canonicalSiteOrigin}/pillar`, normalizedQuery: entry.topicCluster, queryCluster: entry.topicCluster, supportingArticleIds: [], evidenceSnapshotHash: entry.evidenceSnapshotHash }, fixture.repository, NOW)
  await enableOwnerAutopilot(1, client.id, { policyVersion: 'governed-autopilot-policy-v4', targetRowId: target.id, entityStrategyProfileId: profile.profile.profileId, mode: 'balanced', expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'], allowedDestinations: [target.targetId], allowedCadences: [3], allowedRiskClasses: ['general'], allowedProviderModels: options.allowedProviderModels || ['bailian:qwen-plus'], evidenceFreshnessHours: options.evidenceFreshnessHours || 720, maximumRepairAttempts: 1, maximumTopicSubstitutions: 0, generationBudget: 1, publicationBudget: 1 }, fixture.repository, NOW)
  await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: `${label}-materialize` }, fixture.repository, { clock: { now: () => NOW, localDate: () => '2026-08-25' }, eligibleEntryIds: [entry.id] })
  return { fixture, client, calendar, entry, target }
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

  it('creates a fresh replacement entry and generation run when bounded topic substitution is selected', async () => {
    const context = await createMultiAutopilotFixture({ maximumRepairAttempts: 0, maximumTopicSubstitutions: 1 })
    const stuffed = '# Topic\n\nopportunity-1 opportunity-1 opportunity-1 opportunity-1. Evidence-bound owner content without external claims.'.repeat(3)
    const qwenFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: stuffed } }] }), { status: 200 }))
    const runtime = createProviderBackedMockRuntime({ qwenFetch })
    const result = await runOwnerContentEntryWorkflow({ ownerUserId: 1, entryId: context.entry.id, mode: 'execute', idempotencyKey: 'ref-topic-replacement', now: NOW, dependencies: { repository: context.fixture.repository, productionRuntime: productionRuntime(context.fixture, runtime), autopilotPolicy: context.firstPolicy, autopilotPoliciesByTarget: { [context.firstParty.id]: context.firstPolicy, [context.wordpress.id]: context.secondPolicy }, multiChannelRegistry: mockedMultiChannelRegistry().registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' } })
    expect(result.resultingStatus).toBe('skipped')
    expect(context.fixture.topicSubstitutions).toHaveLength(1)
    const replacement = context.fixture.entries.find(row => row.replacementOfEntryId === context.entry.id)
    expect(replacement).toMatchObject({ status: 'materialized', replacementFingerprint: context.fixture.topicSubstitutions[0]!.substitutionFingerprint })
    expect(replacement?.topicCluster).not.toBe(context.entry.topicCluster)
    expect(context.fixture.runs.some(run => run.entryId === replacement?.id && run.stage === 'generation' && run.state === 'queued')).toBe(true)
  })

  it('runs formal V4 across three independently authorized targets, preserves two receipts, and retries only the failed target', async () => {
    const fixture = new ContentOperationsFixture()
    fixture.evidenceApprovalAt = NOW.toISOString()
    const client = fixture.addClient(1)
    client.canonicalSiteOrigin = 'https://owner1-test.com'
    client.publicationTransport = 'first_party_git'
    const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)
    if (!entry) throw new Error('scheduler V4 fixture entry missing')
    const targetResult = await createOwnerPublicationTarget(1, client.id, {
      idempotencyKey: 'scheduler-v4-target', framework: 'nuxt', transport: 'first_party_git', targetOrigin: 'https://api.github.com',
      contentRoot: 'content', defaultBranch: 'main', repositoryOwner: 'mock-owner', repositoryName: 'mock-repository', endpointPath: null,
      credentialReference: 'ref-scheduler-v4', allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1000000, executionEnabled: true,
    }, fixture.repository)
    const target = targetResult.target
    const wordpress = (await createOwnerPublicationTarget(1, client.id, {
      idempotencyKey: 'scheduler-v4-wordpress', framework: 'wordpress', transport: 'wordpress_rest', targetOrigin: 'https://wordpress.owner1-test.com',
      contentRoot: 'wp-content', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/wp-json/wp/v2/posts',
      credentialReference: 'ref-scheduler-v4-wordpress', allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1000000, executionEnabled: true,
    }, fixture.repository)).target
    const generic = (await createOwnerPublicationTarget(1, client.id, {
      idempotencyKey: 'scheduler-v4-generic', framework: 'generic_http', transport: 'generic_http', targetOrigin: 'https://generic.owner1-test.com',
      contentRoot: 'content', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/content-ingest',
      credentialReference: 'ref-scheduler-v4-generic', allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1000000, executionEnabled: true,
    }, fixture.repository)).target
    await bindOwnerEntryPublicationTargets(1, entry.id, { targetRowIds: [target.id, wordpress.id, generic.id] }, fixture.repository)
    const evidenceSnapshotHash = entry.evidenceSnapshotHash
    const profile = await saveOwnerEntityStrategyProfile(1, client.id, {
      targetRowId: target.id, idempotencyKey: 'scheduler-v4-profile', canonicalBrandName: 'Fixture Brand', brandAliases: [],
      canonicalWebsiteOrigin: client.canonicalSiteOrigin, businessType: 'local service business', primaryLocale: 'en', secondaryLocales: [], primaryLocations: [], serviceAreas: [],
      primaryServices: ['content strategy'], secondaryServices: [], targetAudience: ['owners'], primaryQueryClusters: [entry.topicCluster], supportingQueryClusters: ['supporting topic'],
      canonicalPillarPages: ['https://owner1-test.com/pillar'], servicePageBindings: {}, approvedBrandFacts: ['Fixture Brand provides content strategy.'],
      approvedDifferentiators: ['evidence-bound guidance'], prohibitedClaims: ['guaranteed results'], preferredTone: 'clear and evidence-bound', requiredDisclosures: [],
      internalLinkPolicy: 'link to the canonical pillar page', structuredDataIdentity: { name: 'Fixture Brand' }, evidenceSnapshotHash,
    }, fixture.repository, NOW)
    await saveOwnerQueryOwnership(1, client.id, {
      targetRowId: target.id, idempotencyKey: 'scheduler-v4-query', ownerPageId: 'https://owner1-test.com/pillar', normalizedQuery: entry.topicCluster,
      queryCluster: entry.topicCluster, supportingArticleIds: ['supporting-article-1'], evidenceSnapshotHash,
    }, fixture.repository, NOW)
    for (const scopedTarget of [target, wordpress, generic]) {
      await enableOwnerAutopilot(1, client.id, {
        policyVersion: 'governed-autopilot-policy-v4', targetRowId: scopedTarget.id, entityStrategyProfileId: profile.profile.profileId, mode: 'balanced', expiresAt: '2026-12-31T23:59:59.000Z',
        allowedContentTypes: ['article'], allowedLanguages: ['en'], allowedDestinations: [scopedTarget.targetId], allowedCadences: [3], allowedRiskClasses: ['general'],
        maximumRepairAttempts: 3, maximumTopicSubstitutions: 2, generationBudget: 1, publicationBudget: 1,
      }, fixture.repository, NOW)
    }
    const clock = { now: () => NOW, localDate: () => '2026-08-25' }
    const materialized = await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: 'scheduler-v4-materialize' }, fixture.repository, { clock, eligibleEntryIds: [entry.id] })
    expect(materialized.entries.find(row => row.id === entry.id)?.status).toBe('materialized')
    expect(fixture.runs.some(run => run.entryId === entry.id && run.stage === 'generation' && run.state === 'queued')).toBe(true)

    const runtime = createProviderBackedMockRuntime()
    const mocked = mockedMultiChannelRegistry(callNumber => callNumber === 2)
    const publicationExecutor = vi.fn(async ({ publication }: { publication: { productionDeliverableId: string; contentHash: string } }) => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: publication.productionDeliverableId, contentHash: publication.contentHash, remoteRevision: 'scheduler-v4-revision', artifactFingerprint: hash('scheduler-v4-artifact'), idempotencyKey: 'scheduler-v4-executor' }))
    const dependencies = { productionRuntime: productionRuntime(fixture, runtime), publicationExecutor, multiChannelRegistry: mocked.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' }
    const generationTick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies })
    expect(generationTick.results.some(result => result.outcome === 'awaiting_review')).toBe(true)
    expect(fixture.entries.find(row => row.id === entry.id)?.status).toBe('awaiting_review')
    expect(fixture.reviews.size).toBe(0)

    const publicationTicks = await Promise.all([
      runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies }),
      runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies }),
    ])
    expect(publicationTicks.some(tick => tick.results.some(result => result.outcome === 'retry_wait'))).toBe(true)
    expect(publicationExecutor).toHaveBeenCalledTimes(0)
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(2)
    expect(runtime.qwenFetch).toHaveBeenCalledTimes(1)
    expect(runtime.autoGeoProvider).toHaveBeenCalledTimes(1)
    expect(fixture.reviews.size).toBe(0)
    expect(fixture.entries.find(row => row.id === entry.id)?.status).toBe('ready_to_publish')
    expect(fixture.machineAuthorizations).toHaveLength(3)
    expect(fixture.machineAuthorizations.map(row => row.status).sort()).toEqual(['authorized', 'published', 'published'])
    expect(fixture.machineAuthorizations.every(row => row.policyVersion === 'governed-autopilot-policy-v4')).toBe(true)
    expect(fixture.attempts).toHaveLength(3)
    expect(fixture.attempts.filter(row => row.status === 'delivered')).toHaveLength(2)
    expect(fixture.attempts.every(row => row.authorityReference?.match(/^[a-f0-9]{64}$/u))).toBe(true)
    const retry = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 6 * 60 * 1000), repository: fixture.repository, dependencies })
    expect(retry.results.some(result => result.outcome === 'delivered')).toBe(true)
    expect(publicationExecutor).toHaveBeenCalledTimes(0)
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(3)
    expect(fixture.attempts).toHaveLength(4)
    expect(fixture.attempts.filter(row => row.status === 'delivered')).toHaveLength(3)
    expect(fixture.machineAuthorizations.map(row => row.status).sort()).toEqual(['published', 'published', 'published'])
    expect(fixture.entries.find(row => row.id === entry.id)?.status).toBe('delivered')
    expect(fixture.events.some(event => event.eventType === 'autopilot_machine_authorized')).toBe(true)
    expect(fixture.events.filter(event => event.eventType === 'publication_route_delivered')).toHaveLength(3)
    expect(fixture.budgetReservations.map(row => row.kind).sort()).toEqual(['generation', 'generation', 'generation', 'publication', 'publication', 'publication'])
    const exhausted = await fixture.repository.reserveAutopilotBudget({ ownerUserId: 1, policyId: fixture.autopilotPolicies[0]!.policyId, publicationTargetId: target.id, entryId: entry.id, kind: 'publication', units: 1, idempotencyKey: 'publication-overflow', inputFingerprint: hash('publication-overflow') })
    expect(exhausted.reserved).toBe(false)
    const replayTick = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 7 * 60 * 1000), repository: fixture.repository, dependencies })
    expect(replayTick.processed).toBe(0)
    expect(publicationExecutor).toHaveBeenCalledTimes(0)
    expect(mocked.firstPartyCalls).toHaveBeenCalledTimes(1)
    expect(mocked.httpCalls).toHaveBeenCalledTimes(3)
    expect(runtime.qwenFetch).toHaveBeenCalledTimes(1)
    expect(runtime.autoGeoProvider).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['stale evidence', { evidenceApprovalAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), evidenceFreshnessHours: 1 }],
    ['disallowed provider/model', { allowedProviderModels: ['bailian:qwen-max'] }],
  ] as const)('formal V4 blocks %s before machine authorization, publication budget, or executor calls', async (label, options) => {
    const context = await createFormalV4GateFixture(label.replaceAll(' ', '-'), options)
    const runtime = createProviderBackedMockRuntime()
    const registry = mockedMultiChannelRegistry()
    const dependencies = { productionRuntime: productionRuntime(context.fixture, runtime), multiChannelRegistry: registry.registry, resolveMultiChannelCredential: async () => 'ref-mock-credential' }
    const generated = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: context.fixture.repository, dependencies })
    expect(generated.results.some(result => result.outcome === 'awaiting_review')).toBe(true)
    const providerCallsBeforeReview = runtime.qwenFetch.mock.calls.length + runtime.autoGeoProvider.mock.calls.length
    const reviewed = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: context.fixture.repository, dependencies })
    expect(reviewed.results.some(result => result.outcome === 'blocked')).toBe(true)
    expect(runtime.qwenFetch.mock.calls.length + runtime.autoGeoProvider.mock.calls.length).toBe(providerCallsBeforeReview)
    expect(registry.firstPartyCalls).not.toHaveBeenCalled()
    expect(registry.httpCalls).not.toHaveBeenCalled()
    expect(context.fixture.machineAuthorizations).toHaveLength(0)
    expect(context.fixture.budgetReservations.filter(row => row.kind === 'publication')).toHaveLength(0)
    expect(context.fixture.attempts).toHaveLength(0)
  })

  it('runs scheduler repair once, requeues the exact child, then authorizes and publishes on the next tick', async () => {
    const fixture = new ContentOperationsFixture()
    fixture.evidenceApprovalAt = NOW.toISOString()
    const client = fixture.addClient(1); client.canonicalSiteOrigin = 'https://owner1-repair.com'; client.publicationTransport = 'first_party_signed_api'
    const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
    const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
    const target = (await createOwnerPublicationTarget(1, client.id, { idempotencyKey: 'scheduler-repair-target', framework: 'nuxt', transport: 'first_party_signed_api', targetOrigin: client.canonicalSiteOrigin, contentRoot: 'content', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/api/first-party/content-ingest', credentialReference: 'server-ref-scheduler-repair', allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1_000_000, executionEnabled: true }, fixture.repository)).target
    const profile = await saveOwnerEntityStrategyProfile(1, client.id, { targetRowId: target.id, idempotencyKey: 'scheduler-repair-profile', canonicalBrandName: 'Fixture Brand', brandAliases: [], canonicalWebsiteOrigin: client.canonicalSiteOrigin, businessType: 'services', primaryLocale: 'en', secondaryLocales: [], primaryLocations: [], serviceAreas: [], primaryServices: ['content strategy'], secondaryServices: [], targetAudience: ['owners'], primaryQueryClusters: [entry.topicCluster], supportingQueryClusters: [], canonicalPillarPages: ['https://owner1-repair.com/pillar'], servicePageBindings: {}, approvedBrandFacts: ['Fixture Brand provides content strategy.'], approvedDifferentiators: [], prohibitedClaims: ['guaranteed results'], preferredTone: 'clear', requiredDisclosures: [], internalLinkPolicy: 'canonical links only', structuredDataIdentity: { name: 'Fixture Brand' }, evidenceSnapshotHash: entry.evidenceSnapshotHash }, fixture.repository, NOW)
    await saveOwnerQueryOwnership(1, client.id, { targetRowId: target.id, idempotencyKey: 'scheduler-repair-query', ownerPageId: 'https://owner1-repair.com/pillar', normalizedQuery: entry.topicCluster, queryCluster: entry.topicCluster, supportingArticleIds: [], evidenceSnapshotHash: entry.evidenceSnapshotHash }, fixture.repository, NOW)
    await enableOwnerAutopilot(1, client.id, { policyVersion: 'governed-autopilot-policy-v4', targetRowId: target.id, entityStrategyProfileId: profile.profile.profileId, mode: 'balanced', expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'], allowedDestinations: [target.targetId], allowedCadences: [3], allowedRiskClasses: ['general'], maximumRepairAttempts: 2, maximumTopicSubstitutions: 1, generationBudget: 1, publicationBudget: 1 }, fixture.repository, NOW)
    await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: 'scheduler-repair-materialize' }, fixture.repository, { clock: { now: () => NOW, localDate: () => '2026-08-25' }, eligibleEntryIds: [entry.id] })
    const runtime = createProviderBackedMockRuntime({ lowQuality: true })
    const publicationExecutor = vi.fn(async ({ publication }: { publication: { productionDeliverableId: string; contentHash: string } }) => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: publication.productionDeliverableId, contentHash: publication.contentHash, remoteRevision: 'repair-child-revision', artifactFingerprint: hash('repair-child-artifact'), idempotencyKey: 'repair-child-executor' }))
    const persistence = fixture.productionPersistence()
    const repairRunner = vi.fn(async (repair: Parameters<NonNullable<ContentOperationOrchestratorDependencies['repairRunner']>>[0]) => {
      const title = 'Fixture Brand opportunity-1 repaired guide'
      const body = '# Fixture Brand opportunity-1 repaired guide\n\nFixture Brand gives owners a bounded opportunity-1 answer using only approved evidence. [cite:1]\n\n## Evidence boundary\n\nThe repaired child preserves the approved source and makes no unsupported performance claim.'
      const childHash = contentFingerprint(title, body)
      const child = await persistence.saveContentCandidate({ jobId: repair.jobId, title, body, contentHash: childHash, sourceMode: 'provider_candidate', provenance: { provider: 'autogeo-bailian-qwen', providerVersion: 'mock-repair-v1', providerModel: 'bailian:qwen-plus', providerExecution: true, providerProvenance: { providerExecution: true, model: 'qwen-plus' }, stage: 'optimized', generationMode: 'repair_selected_rule_optimization', parentDraftId: repair.originalDraft.id, parentDraftHash: repair.originalDraft.contentHash, repairAttempt: repair.repairAttempt, repairContractFingerprint: repair.repairContractFingerprint, selectedRuleIds: ['direct-answer-first', 'semantic-sections'], appliedRuleIds: ['direct-answer-first', 'semantic-sections'], evidenceSnapshotHash: entry.evidenceSnapshotHash }, evidenceRefs: [{ sourceId: 1, artifactId: 1, reason: 'approved fixture evidence' }], safetyStatus: 'passed', safetyNotes: ['injected repair mock only'] })
      await persistence.saveRiskGate({ draftId: child.id, result: { gateVersion: 'content-risk-gate-v1', status: 'passed', riskLevel: 'low', findings: [] } as never, evidenceSnapshotHash: entry.evidenceSnapshotHash })
      return { draft: { id: child.id }, riskGate: { status: 'passed' } }
    })
    const dependencies = { productionRuntime: productionRuntime(fixture, runtime), publicationExecutor, repairRunner }
    await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies })
    const parentDraftId = fixture.entries.find(row => row.id === entry.id)!.draftId!
    const repairTicks = await Promise.all([runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies }), runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies })])
    expect(repairTicks.some(tick => tick.results.some(result => result.outcome === 'awaiting_review'))).toBe(true)
    expect(repairRunner).toHaveBeenCalledTimes(1); expect(publicationExecutor).toHaveBeenCalledTimes(0)
    const childEntry = fixture.entries.find(row => row.id === entry.id)!
    expect(childEntry.draftId).not.toBe(parentDraftId); expect(childEntry.status).toBe('awaiting_review')
    const child = fixture.generated.get(entry.id)?.draft as { provenance: Record<string, unknown>; contentHash: string }
    expect(child.provenance).toMatchObject({ parentDraftId, repairAttempt: 1, evidenceSnapshotHash: entry.evidenceSnapshotHash })
    const delivered = await runContentOperationsExecutionTick({ ownerUserId: 1, now: new Date(NOW.getTime() + 1), repository: fixture.repository, dependencies })
    expect(delivered.results.some(result => result.outcome === 'delivered')).toBe(true)
    expect(repairRunner).toHaveBeenCalledTimes(1); expect(publicationExecutor).toHaveBeenCalledTimes(1)
    expect(fixture.repairAttempts).toHaveLength(1); expect(fixture.repairAttempts[0]).toMatchObject({ status: 'succeeded', originalDraftId: String(parentDraftId), repairedDraftId: String(childEntry.draftId), repairedContentHash: child.contentHash })
  })

  it('creates a fresh replacement from the formal scheduler and skips safely when every bounded option is exhausted', async () => {
    async function setup(label: string, maximumTopicSubstitutions: number) {
      const fixture = new ContentOperationsFixture()
      fixture.evidenceApprovalAt = NOW.toISOString()
      const client = fixture.addClient(1); client.canonicalSiteOrigin = `https://owner1-${label}.com`; client.publicationTransport = 'first_party_signed_api'
      const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
      const entry = fixture.entries.find(row => row.calendarId === calendar.id)!
      const target = (await createOwnerPublicationTarget(1, client.id, { idempotencyKey: `scheduler-${label}-target`, framework: 'nuxt', transport: 'first_party_signed_api', targetOrigin: client.canonicalSiteOrigin, contentRoot: 'content', defaultBranch: null, repositoryOwner: null, repositoryName: null, endpointPath: '/api/first-party/content-ingest', credentialReference: `ref-scheduler-${label}`, allowedContentTypes: ['article'], allowedLanguages: ['en'], maximumPayloadBytes: 1_000_000, executionEnabled: true }, fixture.repository)).target
      const profile = await saveOwnerEntityStrategyProfile(1, client.id, { targetRowId: target.id, idempotencyKey: `scheduler-${label}-profile`, canonicalBrandName: 'Fixture Brand', brandAliases: [], canonicalWebsiteOrigin: client.canonicalSiteOrigin, businessType: 'services', primaryLocale: 'en', secondaryLocales: [], primaryLocations: [], serviceAreas: [], primaryServices: ['content strategy'], secondaryServices: [], targetAudience: ['owners'], primaryQueryClusters: [entry.topicCluster], supportingQueryClusters: [], canonicalPillarPages: [`${client.canonicalSiteOrigin}/pillar`], servicePageBindings: {}, approvedBrandFacts: ['Fixture Brand provides content strategy.'], approvedDifferentiators: [], prohibitedClaims: ['guaranteed results'], preferredTone: 'clear', requiredDisclosures: [], internalLinkPolicy: 'canonical links only', structuredDataIdentity: { name: 'Fixture Brand' }, evidenceSnapshotHash: entry.evidenceSnapshotHash }, fixture.repository, NOW)
      await saveOwnerQueryOwnership(1, client.id, { targetRowId: target.id, idempotencyKey: `scheduler-${label}-query`, ownerPageId: `${client.canonicalSiteOrigin}/pillar`, normalizedQuery: entry.topicCluster, queryCluster: entry.topicCluster, supportingArticleIds: [], evidenceSnapshotHash: entry.evidenceSnapshotHash }, fixture.repository, NOW)
      await enableOwnerAutopilot(1, client.id, { policyVersion: 'governed-autopilot-policy-v4', targetRowId: target.id, entityStrategyProfileId: profile.profile.profileId, mode: 'balanced', expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'], allowedDestinations: [target.targetId], allowedCadences: [3], allowedRiskClasses: ['general'], maximumRepairAttempts: 0, maximumTopicSubstitutions, generationBudget: 1, publicationBudget: 1 }, fixture.repository, NOW)
      await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey: `scheduler-${label}-materialize` }, fixture.repository, { clock: { now: () => NOW, localDate: () => '2026-08-25' }, eligibleEntryIds: [entry.id] })
      const runtime = createProviderBackedMockRuntime({ lowQuality: true })
      const publicationExecutor = vi.fn()
      const dependencies = { productionRuntime: productionRuntime(fixture, runtime), publicationExecutor }
      await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies })
      const review = await runContentOperationsExecutionTick({ ownerUserId: 1, now: NOW, repository: fixture.repository, dependencies })
      return { fixture, entry, runtime, publicationExecutor, review }
    }

    const substituted = await setup('substitute', 1)
    expect(substituted.review.results.map(result => result.outcome)).toEqual(['blocked'])
    expect(substituted.fixture.entries.find(row => row.id === substituted.entry.id)?.status).toBe('skipped')
    expect(substituted.fixture.topicSubstitutions).toHaveLength(1)
    const replacement = substituted.fixture.entries.find(row => row.replacementOfEntryId === substituted.entry.id)
    expect(replacement).toMatchObject({ status: 'materialized', replacementFingerprint: substituted.fixture.topicSubstitutions[0]!.substitutionFingerprint })
    expect(replacement?.topicCluster).not.toBe(substituted.entry.topicCluster)
    expect(substituted.fixture.runs.some(run => run.entryId === replacement?.id && run.stage === 'generation' && run.state === 'queued')).toBe(true)
    expect(substituted.publicationExecutor).not.toHaveBeenCalled()
    expect(substituted.runtime.qwenFetch).toHaveBeenCalledTimes(1); expect(substituted.runtime.autoGeoProvider).toHaveBeenCalledTimes(1)

    const exhausted = await setup('exhausted', 0)
    expect(exhausted.review.results.map(result => result.outcome)).toEqual(['blocked'])
    expect(exhausted.fixture.entries.find(row => row.id === exhausted.entry.id)?.status).toBe('skipped')
    expect(exhausted.fixture.topicSubstitutions).toHaveLength(0); expect(exhausted.fixture.repairAttempts).toHaveLength(0)
    expect(exhausted.fixture.entries.some(row => row.replacementOfEntryId === exhausted.entry.id)).toBe(false)
    expect(exhausted.publicationExecutor).not.toHaveBeenCalled()
    expect(exhausted.runtime.qwenFetch).toHaveBeenCalledTimes(1); expect(exhausted.runtime.autoGeoProvider).toHaveBeenCalledTimes(1)
  })
})
