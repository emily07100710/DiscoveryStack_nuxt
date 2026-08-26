import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { GEOFLOW_PROTOCOL_VERSION } from '../server/geoflow-integration'
import { createGeoFlowQwenGenerationRuntime } from '../server/geoflow-runtime/qwen'
import { createAutoGeoIsolatedWorkerAdapter } from '../server/geo/isolated-worker'
import { geoRules } from '../server/geo/rules'
import { buildRetrievalResult, evaluateContentQuality, qualityGateIsPublishApproval } from '../server/geo-content-quality'
import { syntheticInput, syntheticMarkdown, syntheticProviderOutput } from './fixtures/geo-content-quality/fixtures'
import { createOwnerPublicationTarget, executeContentOperationEntry, runContentOperationsExecutionTick } from '../server/content-operations/orchestrator'
import { enableOwnerAutopilot, revokeOwnerAutopilot } from '../server/content-operations/autopilot-service'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { ContentOperationPublicationTargetRow } from '../server/content-operations/types'
import { buildContentLearningDataset } from '../server/outcome-learning'
import { assessPublishedContentOutcome } from '../server/outcome-learning'
import { makeGrantedConsent, makeOutcomeRequest } from './fixtures/outcome-learning/measurements'
import { buildVisibilityProbePlan, executeAndPersistProviderObservations } from '../server/llm-visibility-probes'
import type { ProjectRecord, QueryRecord, VisibilityWorkflowRepository } from '../server/llm-visibility/service'
import { calculateVisibilityMetrics } from '../server/llm-visibility/metrics'
import { SyntheticRegistry, syntheticAdapter, syntheticPlanInput } from './fixtures/llm-visibility-probes/fixtures'
import { executeMultiChannelFanout, executeMultiChannelPublication, createMultiChannelExecutorRegistry } from '../server/publication-routing/multi-channel-executors'
import { FIXTURE_CONTENT, FIXTURE_NOW, LEGAL_TARGETS, makePlan } from './fixtures/publication-routing/fixtures'

const NOW = new Date('2026-08-25T04:00:00.000Z')
const EVIDENCE_HASH = 'a'.repeat(64)
const BASE_BODY = '這是只根據核准資料整理的 synthetic base draft。'

function hash(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }

function targetInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'e2e-target-1', framework: 'nuxt', transport: 'first_party_git', targetOrigin: 'https://api.github.com', contentRoot: 'content', defaultBranch: 'main', repositoryOwner: 'owner', repositoryName: 'repository', endpointPath: null, credentialReference: 'opaque:server-ref', allowedContentTypes: ['article'], allowedLanguages: ['en', 'zh-hant'], maximumPayloadBytes: 1000000, executionEnabled: true, ...overrides,
  }
}

function attachLineage(fixture: ContentOperationsFixture, entryId: number, target: ContentOperationPublicationTargetRow | null, body = 'Direct answer\n\nEvidence-bound body.') {
  const entry = fixture.entries.find(item => item.id === entryId)!
  const calendar = fixture.calendars.find(item => item.id === entry.calendarId)!
  const client = fixture.clients.find(item => item.id === calendar.clientId)!
  const contentHash = hash(body)
  entry.contentHash = contentHash
  let review: Record<string, unknown> | null = null
  const job = { id: 700, ownerUserId: entry.ownerUserId, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: entry.evidenceSnapshotHash, briefId: 701, status: 'approved' }
  const draft = { id: 702, jobId: job.id, version: 1, title: 'Verified synthetic draft', body, contentHash, provenance: { stage: 'optimized', selectedRuleIds: ['direct-answer-first'], appliedRuleIds: ['direct-answer-first'], providerExecution: true, provider: 'bailian', providerVersion: 'qwen-plus', model: 'bailian:qwen-plus', providerModel: 'bailian:qwen-plus', providerProvenance: { provider: 'bailian', model: 'qwen-plus', mode: 'provider', providerExecution: true }, evidenceSnapshotHash: entry.evidenceSnapshotHash, qualityGateVersion: 'content-risk-gate-v1' }, safetyStatus: 'passed', evidenceRefs: [] }
  const gate = { id: 703, draftId: draft.id, status: 'passed', gateVersion: 'content-risk-gate-v1', findings: [], riskLevel: 'general', evidenceSnapshotHash: entry.evidenceSnapshotHash }
  const repository = fixture.repository as ContentOperationsRepository
  repository.findLatestOptimizedDraft = async () => draft
  repository.findRiskGate = async () => gate
  repository.findLatestReview = async () => review as never
  repository.resolveWorkspaceEntry = async () => ({ entry, calendar, client, target, deliverable: { id: entry.productionDeliverableId, ownerUserId: entry.ownerUserId, planId: calendar.productionPlanId, briefId: job.briefId, jobId: job.id, selectionId: entry.strategyRecommendationId, contentType: entry.contentType, title: 'Verified synthetic draft', audience: 'owner audience', language: entry.language, evidenceSnapshotHash: entry.evidenceSnapshotHash, opportunityKey: '1:opportunity-1', provenance: {} }, job, draft, review: review as never, riskGate: gate })
  return { repository, entry, client, calendar, target, job, draft, gate, setReview(value: Record<string, unknown> | null) { review = value } }
}

function qwenRequest(overrides: Record<string, unknown> = {}) {
  const reviewedText = '核准的 synthetic evidence：這是一段可由 owner 查核的內容。'
  return {
    protocolVersion: GEOFLOW_PROTOCOL_VERSION, requestId: 'e2e-qwen-request', idempotencyKey: 'e2e-qwen-idempotency', ownerUserId: 1, clientId: 101, calendarEntryId: 1001, productionPlanId: 11, deliverableId: 1, briefId: 701, jobId: 700, evidenceSnapshotHash: EVIDENCE_HASH,
    brief: { title: '核准內容主題', audience: '內容 owner', goals: ['回答核心問題'], constraints: ['不得新增未核准主張'] }, contentType: 'article', language: 'zh-hant', generationMode: 'draft', revisionContext: null, requestedCapabilities: ['qwen_generation', 'knowledge_rag', 'human_review'], selectedRuleIds: [], authoritySourceIds: ['source-1'], evidenceChunks: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash: hash(reviewedText.normalize('NFKC').trim().replace(/\s+/gu, ' ')), reviewedText, locator: 'https://evidence.routing.discoverystack.dev/section-1' }], createdAt: NOW.toISOString(), ...overrides,
  }
}

function qwenRuntime(fetchImpl: typeof fetch, resolveCredential: (ref: string) => string | undefined | Promise<string | undefined> = async () => 'fake-placeholder-secret') {
  return createGeoFlowQwenGenerationRuntime({ endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', credentialRef: 'opaque:qwen-ref', resolveCredential, fetchImpl, now: () => NOW.toISOString() })
}

describe('DiscoveryStack End-to-End Platform V1 mocked acceptance', () => {
  it('composes approved evidence → Qwen base draft → isolated AutoGEO → quality/risk → manual review → mocked receipt → outcome/learning lineage', async () => {
    const qwenFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'qwen-plus', choices: [{ message: { content: `# 核准內容主題\n\n${BASE_BODY}` } }] }), { status: 200 }))
    const qwen = await qwenRuntime(qwenFetch).generate(qwenRequest())
    expect(qwen.ok).toBe(true)
    if (!qwen.ok || qwen.value.status !== 'review_required') throw new Error('Qwen mock did not return a review-required base draft')
    expect(qwen.value.contentArtifact.bodyHash).toBe(hash(qwen.value.contentArtifact.bodyMarkdown))
    expect(qwen.value.providerProvenance.provider).toBe('bailian')

    const selectedRules = geoRules.filter(rule => ['direct-answer-first', 'semantic-sections'].includes(rule.id))
    const optimized = await createAutoGeoIsolatedWorkerAdapter().rewrite({ title: '核准內容主題', content: qwen.value.contentArtifact.bodyMarkdown, language: 'zh-hant' }, selectedRules)
    expect(optimized.appliedRuleIds).toEqual(selectedRules.map(rule => rule.id))
    expect(optimized.provenance.providerExecution).toBe(false)
    expect(optimized.safetyNotes.join(' ')).toContain('不能在 governed_autopilot')
    const optimizedHash = hash(optimized.optimizedContent)
    expect(optimizedHash).toMatch(/^[a-f0-9]{64}$/)

    const qualityInput = syntheticInput({ ownerUserId: 'owner-1', clientId: 'client-101', briefId: 'brief-701', jobId: 'job-700', evidenceSnapshotHash: EVIDENCE_HASH })
    const qualityOutput = syntheticProviderOutput(qualityInput)
    const quality = evaluateContentQuality({ qualityInput, providerOutput: qualityOutput, markdown: syntheticMarkdown(qualityInput), retrievalResult: buildRetrievalResult(qualityInput.retrievalPlan, qualityInput.approvedEvidenceChunks.map(chunk => ({ chunk })), qualityInput) })
    expect(quality.status).toBe('passed')
    expect(qualityGateIsPublishApproval(quality)).toBe(false)
    expect(evaluateContentQuality({ qualityInput: syntheticInput({ industryRisk: 'medical' }), providerOutput: syntheticProviderOutput(syntheticInput({ industryRisk: 'medical' })), markdown: syntheticMarkdown(syntheticInput({ industryRisk: 'medical' })), retrievalResult: buildRetrievalResult(syntheticInput({ industryRisk: 'medical' }).retrievalPlan, syntheticInput({ industryRisk: 'medical' }).approvedEvidenceChunks.map(chunk => ({ chunk })), syntheticInput({ industryRisk: 'medical' })) }).reasonCodes).toContain('HIGH_RISK_REVIEW_REQUIRED')

    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    entry.status = 'materialized'
    const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(item => item.id === targetResult.target.id)!
    const lineage = attachLineage(fixture, entry.id, target, 'Direct answer\n\nEvidence-bound body.')
    const first = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'manual-review-1', mode: 'dry_run' }, dependencies: { repository: lineage.repository, productionDeliverableRunner: async () => ({ job: { id: lineage.job.id } }) } })
    expect(first.outcome).toBe('awaiting_review')
    lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
    const ready = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'manual-review-2', mode: 'dry_run' }, dependencies: { repository: lineage.repository, productionDeliverableRunner: async () => ({ job: { id: lineage.job.id } }) } })
    expect(ready.outcome).toBe('ready_to_publish')
    const delivered = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'manual-delivery-1', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: async input => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: input.publication.productionDeliverableId, contentHash: input.publication.contentHash, remoteRevision: 'mock-revision-1', artifactFingerprint: 'd'.repeat(64), idempotencyKey: 'manual-delivery-1' }) } })
    expect(delivered.outcome).toBe('delivered')
    expect(fixture.attempts[0]?.inputFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fixture.events.some(event => event.eventType === 'publication_delivered')).toBe(true)

    const outcomeRequest = makeOutcomeRequest({ publication: { ...makeOutcomeRequest().publication, contentHash: lineage.draft.contentHash, evidenceSnapshotHash: entry.evidenceSnapshotHash, jobId: String(lineage.job.id), draftId: String(lineage.draft.id) } })
    const assessment = assessPublishedContentOutcome(outcomeRequest)
    const dataset = buildContentLearningDataset({ records: [{ outcomeRequest, assessment, consent: makeGrantedConsent() }] })
    expect(dataset.candidateResults[0]?.candidateStatus).toBe('eligible')
    expect(dataset.manifest.status).toBe('gate_blocked')
    expect(dataset.datasetDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(dataset.limitations.join(' ')).toContain('does not submit, train, promote, or upload')
  })

  it('uses durable autopilot only for a matching approved owner policy, and blocks revoked policy', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    const calendar = await fixture.addCalendar(1, '2026-08-25', 1)
    calendar.updatedAt = NOW
    fixture.evidenceApprovalAt = NOW.toISOString()
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    entry.status = 'ready_to_publish'; entry.jobId = 700; entry.draftId = 702
    const targetResult = await createOwnerPublicationTarget(1, client.id, targetInput(), fixture.repository)
    const target = fixture.targets.find(item => item.id === targetResult.target.id)!
    const lineage = attachLineage(fixture, entry.id, target)
    lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
    const policy = await enableOwnerAutopilot(1, client.id, { expiresAt: '2026-12-31T23:59:59.000Z', allowedContentTypes: ['article'], allowedLanguages: ['en'] }, fixture.repository, NOW)
    expect(policy.policy.status).toBe('enabled')
    expect(policy.policy.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const seeded = await executeContentOperationEntry({ ownerUserId: 1, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'autopilot-dry-run', mode: 'dry_run' }, dependencies: { repository: lineage.repository, publicationExecutor: async () => ({ status: 'dry_run' as const, preview: { mode: 'dry_run' as const, method: 'PUT' as const, url: 'https://api.github.com', targetOrigin: 'https://api.github.com', path: 'content/en/articles/verified.md', branch: 'main', bodyBytes: 10, bodyIncluded: false as const, headerNames: [], includesAuthorization: false as const, includesSecret: false as const, redirect: 'manual' as const } }) } })
    expect(seeded.outcome).toBe('dry_run_succeeded')
    const tick = await runContentOperationsExecutionTick({ ownerUserId: 1, repository: lineage.repository, now: new Date(NOW.getTime() + 60_000), dependencies: { publicationExecutor: async input => ({ status: 'delivered' as const, remoteState: 'created' as const, publicationId: input.publication.productionDeliverableId, contentHash: input.publication.contentHash, remoteRevision: 'autopilot-mock', artifactFingerprint: 'e'.repeat(64), idempotencyKey: 'autopilot-1' }) } })
    expect(tick.results.some(result => result.outcome === 'delivered')).toBe(true)
    const revoked = await revokeOwnerAutopilot(1, client.id, fixture.repository)
    expect(revoked.policy.status).toBe('revoked')
    expect(fixture.events.some(event => event.eventType === 'autopilot_policy_enabled')).toBe(true)
    expect(fixture.events.some(event => event.eventType === 'autopilot_policy_revoked')).toBe(true)
  })

  it('fails closed for missing Qwen credential, stale evidence, high risk, and owner scope mismatch', async () => {
    const fetchMock = vi.fn()
    const missing = await qwenRuntime(fetchMock, async () => undefined).generate(qwenRequest())
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value.status).toBe('blocked')
    expect(fetchMock).not.toHaveBeenCalled()

    const staleInput = syntheticInput({ approvedEvidenceChunks: [syntheticInput().approvedEvidenceChunks[0]!] .map(chunk => ({ ...chunk, reviewStatus: 'stale' as never })) })
    expect(evaluateContentQuality({ qualityInput: staleInput, providerOutput: syntheticProviderOutput(staleInput), markdown: syntheticMarkdown(staleInput), retrievalResult: buildRetrievalResult(staleInput.retrievalPlan, staleInput.approvedEvidenceChunks.map(chunk => ({ chunk })), staleInput) }).status).toBe('blocked')
    const highRiskInput = syntheticInput({ industryRisk: 'legal' })
    expect(evaluateContentQuality({ qualityInput: highRiskInput, providerOutput: syntheticProviderOutput(highRiskInput), markdown: syntheticMarkdown(highRiskInput), retrievalResult: buildRetrievalResult(highRiskInput.retrievalPlan, highRiskInput.approvedEvidenceChunks.map(chunk => ({ chunk })), highRiskInput) }).status).toBe('needs_human_review')

    const fixture = new ContentOperationsFixture(); fixture.addClient(1); const calendar = await fixture.addCalendar(1, '2026-08-25', 1); const entry = fixture.entries[0]!; entry.status = 'ready_to_publish'; entry.jobId = 700; entry.draftId = 702
    const lineage = attachLineage(fixture, entry.id, null)
    lineage.setReview({ id: 704, jobId: lineage.job.id, draftId: lineage.draft.id, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: entry.evidenceSnapshotHash })
    const otherExecutor = vi.fn()
    await expect(executeContentOperationEntry({ ownerUserId: 2, entryId: entry.id, trigger: 'owner_manual', now: NOW, value: { idempotencyKey: 'other-owner', mode: 'execute' }, dependencies: { repository: lineage.repository, publicationExecutor: otherExecutor } })).rejects.toMatchObject({ statusCode: 404 })
    expect(otherExecutor).not.toHaveBeenCalled()
  })

  it('keeps publication retry/replay and multisite partial failure truthful with exact content hash', async () => {
    const onePlan = makePlan([LEGAL_TARGETS.wordpress])
    const route = onePlan.routes[0]!
    let calls = 0
    const retryTransport = vi.fn().mockImplementation(async () => { calls += 1; return calls === 1 ? { status: 429, text: async () => '' } : { status: 200, text: async () => JSON.stringify({ publicationId: route.destinationPublicationIdentity, contentHash: route.contentHash, remoteRevision: 'retry-revision' }) } })
    const retryInput = { plan: onePlan, routeId: route.routeId, content: FIXTURE_CONTENT, idempotencyKey: 'e2e-retry', executorRunId: 'ref-e2e-run', attempt: 1, now: FIXTURE_NOW + 100, mode: 'execute' as const, registry: createMultiChannelExecutorRegistry({ httpTransport: retryTransport }), resolveCredential: async () => 'fake-placeholder-secret' }
    const first = await executeMultiChannelPublication(retryInput)
    expect(first.status).toBe('retry_wait')
    const second = await executeMultiChannelPublication({ ...retryInput, attempt: 2, idempotencyKey: 'e2e-retry-2', executorRunId: 'ref-e2e-run-2', knownReceipts: [first.receipt!] })
    expect(second.status).toBe('delivered')
    const replay = await executeMultiChannelPublication({ ...retryInput, attempt: 2, knownReceipts: [first.receipt!, second.receipt!], idempotencyKey: 'e2e-retry-2', executorRunId: 'ref-e2e-run-2' })
    expect(replay.replay).toBe(true)
    expect(calls).toBe(2)

    const multiPlan = makePlan([LEGAL_TARGETS.wordpress, LEGAL_TARGETS.phpAgent])
    const fanout = await executeMultiChannelFanout({ plan: multiPlan, routeIds: multiPlan.routes.map(candidate => candidate.routeId), content: FIXTURE_CONTENT, idempotencyKey: 'e2e-fanout', executorRunIdPrefix: 'ref-e2e-fanout-run', attempt: 1, now: FIXTURE_NOW + 100, mode: 'execute', registry: createMultiChannelExecutorRegistry({ httpTransport: async (_url, init) => { const payload = JSON.parse(init.body); return { status: payload.transport === 'geoflow_agent' ? 503 : 200, text: async () => JSON.stringify({ publicationId: payload.destinationPublicationIdentity, contentHash: multiPlan.routes.find(candidate => candidate.routeId === payload.routeId)?.contentHash, remoteRevision: 'fanout-revision' }) } } }), resolveCredential: async () => 'fake-placeholder-secret' })
    expect(fanout.status).toBe('partial_failure')
    expect(fanout.results.map(item => item.status)).toEqual(expect.arrayContaining(['delivered', 'retry_wait']))
    expect((await executeMultiChannelPublication({ ...retryInput, content: `${FIXTURE_CONTENT}\n`, idempotencyKey: 'e2e-wrong-bytes' })).status).toBe('blocked')
  })

  it('keeps provider visibility secondary-only and owner scoped, then preserves outcome/visibility separation', async () => {
    const planResult = buildVisibilityProbePlan(syntheticPlanInput({ ownerScopeKey: 'owner-7-visibility', project: { ...syntheticPlanInput().project, projectId: '10' }, activeQuerySnapshots: [{ ...syntheticPlanInput().activeQuerySnapshots[0]!, projectId: '10', queryId: '20' }] }))
    if (planResult.status !== 'planned') throw new Error('expected synthetic visibility plan')
    const visibilityPlan = planResult.plan
    const visibilityProject: ProjectRecord = { id: 10, ownerUserId: 7, name: 'Acme', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en', brandName: 'Acme', brandAliases: [], competitorBrands: [], status: 'active' }
    const visibilityQuery: QueryRecord = { id: 20, ownerUserId: 7, projectId: 10, promptText: 'Which product fits?', promptHash: 'a'.repeat(64), intent: 'discovery', locale: 'en', active: true }
    const repository: VisibilityWorkflowRepository = { getProject: vi.fn(async owner => owner === 7 ? visibilityProject : null), getQuery: vi.fn(async owner => owner === 7 ? visibilityQuery : null), getRun: vi.fn(async () => null), findRunByFingerprint: vi.fn(async () => null), hasObservation: vi.fn(async () => false), commitObservation: vi.fn(async () => ({ runId: 30, observationId: 40 })) }
    const observation = await executeAndPersistProviderObservations({ ownerUserId: 7, ownerScopeKey: visibilityPlan.ownerScopeKey, plan: visibilityPlan, adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: new SyntheticRegistry(), repository, now: NOW })
    expect(observation.batch.status).toBe('completed')
    expect(repository.commitObservation).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 7, observationMode: 'provider_api_observation', verifiedByOwner: false, limitationCode: 'provider_api_not_consumer_surface', reviewerNote: expect.stringContaining('secondary-only') }))
    const mismatched = await executeAndPersistProviderObservations({ ownerUserId: 7, ownerScopeKey: 'owner-8', plan: visibilityPlan, adapters: { 'synthetic-adapter-1': syntheticAdapter({ onCall: () => { throw new Error('must not call provider') } }) }, idempotencyRegistry: new SyntheticRegistry(), repository, now: NOW })
    expect(mismatched.batch.status).toBe('blocked')
    expect(calculateVisibilityMetrics({ queries: [{ id: 20, locale: 'en', active: true }], observations: [{ queryId: 20, provider: 'chatgpt', observationMode: 'provider_api_observation', observedAt: NOW.toISOString(), brandMentioned: true, exactMentionCount: 1, firstMentionPosition: 1, citationUrls: ['https://example.com/source'], competitorMentions: {} }], canonicalDomain: 'example.com', currentStart: new Date(NOW.getTime() - 86_400_000), currentEnd: new Date(NOW.getTime() + 86_400_000) }).current.status).toBe('not_ready')
  })
})
