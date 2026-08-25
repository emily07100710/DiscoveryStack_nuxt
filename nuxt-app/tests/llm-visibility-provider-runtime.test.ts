import { describe, expect, it, vi } from 'vitest'
import { buildVisibilityProbePlan, executeAndPersistProviderObservations } from '../server/llm-visibility-probes'
import type { VisibilityWorkflowRepository, ProjectRecord, QueryRecord } from '../server/llm-visibility/service'
import { persistProviderObservationCandidate } from '../server/llm-visibility/service'
import { calculateVisibilityMetrics } from '../server/llm-visibility/metrics'
import { SyntheticRegistry, syntheticAdapter, syntheticPlanInput, syntheticProject, syntheticQuery } from './fixtures/llm-visibility-probes/fixtures'

const project: ProjectRecord = { id: 10, ownerUserId: 7, name: 'Acme monitor', canonicalWebsiteUrl: 'https://example.com/', canonicalDomain: 'example.com', locale: 'en', brandName: 'Acme', brandAliases: ['Acme Inc'], competitorBrands: ['Rival'], status: 'active' }
const query: QueryRecord = { id: 20, ownerUserId: 7, projectId: 10, promptText: 'Which product fits?', promptHash: 'a'.repeat(64), intent: 'discovery', locale: 'en', active: true }

function repository(overrides: Partial<VisibilityWorkflowRepository> = {}): VisibilityWorkflowRepository {
  return {
    getProject: vi.fn(async owner => owner === 7 ? project : null),
    getQuery: vi.fn(async owner => owner === 7 ? query : null),
    getRun: vi.fn(async () => null),
    findRunByFingerprint: vi.fn(async () => null),
    hasObservation: vi.fn(async () => false),
    commitObservation: vi.fn(async () => ({ runId: 30, observationId: 40 })),
    ...overrides,
  }
}

function numericPlan() {
  const result = buildVisibilityProbePlan(syntheticPlanInput({ ownerScopeKey: 'owner-7-visibility', project: { ...syntheticProject(), projectId: '10' }, activeQuerySnapshots: [syntheticQuery({ projectId: '10', queryId: '20' })] }))
  if (result.status !== 'planned') throw new Error('expected planned synthetic visibility plan')
  return result.plan
}

describe('provider observation runtime bridge', () => {
  it('executes an injected provider adapter and persists only a secondary-only observation', async () => {
    const plan = numericPlan()
    const repo = repository()
    const result = await executeAndPersistProviderObservations({ ownerUserId: 7, ownerScopeKey: plan.ownerScopeKey, plan, adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: new SyntheticRegistry(), repository: repo, now: new Date('2026-08-24T01:00:00.000Z') })
    expect(result.batch.status).toBe('completed')
    expect(result.batch.counts.completed).toBe(1)
    expect(result.persisted).toEqual([{ probeId: plan.probes[0]!.probeId, requestFingerprint: plan.probes[0]!.requestFingerprint, runId: 30, observationId: 40 }])
    expect(result.persistenceFailures).toEqual([])
    expect(repo.commitObservation).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 7, projectId: 10, queryId: 20, observationMode: 'provider_api_observation', verifiedByOwner: false, limitationCode: 'provider_api_not_consumer_surface', reviewerNote: expect.stringContaining('secondary-only') }))
  })

  it('blocks a mismatched server owner scope before provider execution', async () => {
    const plan = numericPlan()
    const adapter = syntheticAdapter({ onCall: () => { throw new Error('provider must not be called') } })
    const result = await executeAndPersistProviderObservations({ ownerUserId: 7, ownerScopeKey: 'different-owner-scope', plan, adapters: { 'synthetic-adapter-1': adapter }, idempotencyRegistry: new SyntheticRegistry(), repository: repository() })
    expect(result.batch).toMatchObject({ status: 'blocked', reasonCodes: ['OWNER_SCOPE_MISMATCH'] })
    expect(result.persisted).toEqual([])
  })

  it('fails closed when opaque probe identities cannot map to durable owner rows', async () => {
    const plan = buildVisibilityProbePlan(syntheticPlanInput())
    if (plan.status !== 'planned') throw new Error('expected planned synthetic visibility plan')
    const result = await executeAndPersistProviderObservations({ ownerUserId: 7, ownerScopeKey: plan.plan.ownerScopeKey, plan: plan.plan, adapters: { 'synthetic-adapter-1': syntheticAdapter() }, idempotencyRegistry: new SyntheticRegistry(), repository: repository() })
    expect(result.batch.counts.completed).toBe(1)
    expect(result.persisted).toEqual([])
    expect(result.persistenceFailures).toEqual([{ probeId: plan.plan.probes[0]!.probeId, requestFingerprint: plan.plan.probes[0]!.requestFingerprint, code: 'PERSISTENCE_FAILED' }])
  })

  it('keeps provider observations out of manual primary metrics while exposing a secondary byMode slice', () => {
    const metrics = calculateVisibilityMetrics({ queries: [{ id: 20, locale: 'en', active: true }], observations: [{ queryId: 20, provider: 'chatgpt', observationMode: 'provider_api_observation', observedAt: '2026-08-24T00:00:00.000Z', brandMentioned: true, exactMentionCount: 1, firstMentionPosition: 1, citationUrls: ['https://example.com/source'], competitorMentions: {} }], canonicalDomain: 'example.com', currentStart: new Date('2026-08-23T00:00:00.000Z'), currentEnd: new Date('2026-08-25T00:00:00.000Z') })
    expect(metrics.current.status).toBe('not_ready')
    expect(metrics.byMode.provider_api_observation.status).toBe('ready')
    expect(metrics.byMode.provider_api_observation.brandMentionRate).toBe(1)
  })

  it('does not let the provider persistence helper accept manual-verified or raw-response fields', async () => {
    const candidate = {
      probeId: 'probe-1', requestFingerprint: 'b'.repeat(64), planFingerprint: 'c'.repeat(64), ownerScopeKey: 'owner-7-visibility', projectId: 10, queryId: 20, provider: 'chatgpt' as const, modelLabel: 'model', observationWindowKey: 'window', observationMode: 'provider_api_observation' as const, verifiedByOwner: false as const, status: 'completed' as const, metricEligibility: 'secondary_only' as const, consumerSurfaceEquivalent: false as const, limitationCode: 'provider_api_not_consumer_surface' as const, persistenceStatus: 'not_persisted_v1' as const, responseHash: 'd'.repeat(64), boundedExcerpt: 'Acme appears.', brandMentioned: true, exactMentionCount: 1, firstMentionPosition: 1, competitorMentions: { Rival: 0 }, citationUrls: ['https://example.com/source'], citedDomain: 'example.com', evidenceLocator: 'provider:chatgpt:probe-1', observedAt: '2026-08-24T00:00:00.000Z', provenance: { adapterKey: 'adapter', engineVersion: 'engine' }, rawResponse: 'must not persist', reviewerNote: 'attacker note' } as never
    const repo = repository()
    await expect(persistProviderObservationCandidate(repo, 7, candidate, new Date('2026-08-24T01:00:00.000Z'))).rejects.toMatchObject({ statusCode: 422 })
    expect(repo.commitObservation).not.toHaveBeenCalled()
  })
})
