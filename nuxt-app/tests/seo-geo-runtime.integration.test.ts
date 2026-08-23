import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoRewriteAdapter } from '../server/geo/contracts'
import { geoRules } from '../server/geo/rules'

const state = vi.hoisted(() => ({
  plan: { id: 7, ownerUserId: 11, diagnosisId: 3, title: '內容計畫', language: 'zh-hant', status: 'ready', evidenceSnapshotHash: 'evidence-hash' },
  deliverable: { id: 8, ownerUserId: 11, planId: 7, selectionId: 9, opportunityKey: '42:article', contentType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'], language: 'zh-hant', status: 'planned', evidenceSnapshotHash: 'evidence-hash', briefId: null, jobId: 10 },
  brief: { id: 12, productionPlanId: 7, productionDeliverableId: 8, strategyRecommendationId: 42, diagnosisId: 3, title: 'Evidence article', audience: '研究者', contentType: 'article', language: 'zh-hant', goals: ['回答主題'], constraints: ['只用 evidence'], evidenceRefs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash', reason: 'approved' }], evidenceSnapshotHash: 'evidence-hash', status: 'ready_for_generation' },
  job: { id: 10, ownerUserId: 11, briefId: 12, productionPlanId: 7, productionDeliverableId: 8, strategyRecommendationId: 42, operation: 'content_draft', providerMode: 'reference_rules', status: 'queued', idempotencyKey: 'plan-7-job-8', evidenceSnapshotHash: 'evidence-hash' },
  drafts: [] as any[],
  transitions: [] as string[],
  appliedRuleIds: [] as string[],
}))

vi.mock('../server/seo-geo-core/repository', () => ({
  getProductionPlanBundle: vi.fn(async () => ({ plan: { ...state.plan }, selections: [{ id: 9, strategyRecommendationId: 42, status: 'selected', evidenceSnapshotHash: 'evidence-hash' }], strategies: [], deliverables: [{ ...state.deliverable, status: state.plan.status === 'ready' ? 'planned' : state.deliverable.status }] })),
  prepareProductionPlanGeneration: vi.fn(async () => ({ plan: { ...state.plan }, selections: [], strategies: [], deliverables: [{ ...state.deliverable }], prepared: [{ deliverableId: 8, briefId: 12, jobId: 10, idempotencyKey: 'plan-7-job-8' }] })),
  resolveProductionContext: vi.fn(async () => ({ plan: { ...state.plan, status: 'in_progress' }, deliverable: { ...state.deliverable }, selection: { id: 9, strategyRecommendationId: 42, status: 'selected', evidenceSnapshotHash: 'evidence-hash' }, strategy: { id: 42, diagnosisId: 3, issueCode: 'content.topic_clarity', recommendationKey: 'clarify_page_topic', ruleSetVersion: 'autogeo-compatible-rules-v1', ruleIds: ['direct-answer-first', 'semantic-sections'], rules: geoRules.filter(rule => ['direct-answer-first', 'semantic-sections'].includes(rule.id)), evidenceRefs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash', reason: 'approved' }], evidenceSnapshotHash: 'evidence-hash', contentOpportunities: [{ key: 'article', deliverableType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'] }], status: 'selected' }, diagnosis: { id: 3 }, diagnosisResult: { status: 'completed', findings: [], limitations: [] }, opportunity: { key: 'article', deliverableType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'] }, rules: geoRules.filter(rule => ['direct-answer-first', 'semantic-sections'].includes(rule.id)), evidenceSnapshot: { refs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash', reason: 'approved' }], context: 'Approved reviewed artifact: 可核對的內容來源與方法說明。', hash: 'evidence-hash', materials: [{ sourceId: 20, artifactId: 21, sourceName: 'Approved source', artifactType: 'html', artifactHash: 'artifact-hash', reviewedText: '可核對的內容來源與方法說明。' }] } })),
  createCanonicalProductionBrief: vi.fn(async () => ({ ...state.brief })),
  getOwnerContentJob: vi.fn(async () => ({ ...state.job })),
  transitionContentJob: vi.fn(async ({ to }: { to: string }) => { state.job.status = to; state.transitions.push(to); return { ...state.job } }),
  saveContentCandidate: vi.fn(async (input: any) => { const draft = { id: 100 + state.drafts.length, version: state.drafts.length + 1, ...input }; state.drafts.push(draft); return draft }),
  saveRiskGate: vi.fn(async () => undefined),
  updateProductionDeliverable: vi.fn(async (_owner: number, _id: number, patch: any) => { Object.assign(state.deliverable, patch); return { ...state.deliverable } }),
  recalculateProductionPlanStatus: vi.fn(async () => { state.plan.status = 'in_progress'; return state.plan.status }),
  resolveApprovedEvidenceSnapshot: vi.fn(),
  saveDiagnosis: vi.fn(),
  createStrategyRecommendations: vi.fn(),
  createContentBrief: vi.fn(),
  createContentJob: vi.fn(),
  findOwnerBriefForDeliverable: vi.fn(),
  getOwnerContentBrief: vi.fn(),
}))

import { runOwnerProductionPlan } from '../server/seo-geo-core/service'

describe('governed three-layer production runtime', () => {
  beforeEach(() => {
    state.plan.status = 'ready'
    state.deliverable.status = 'planned'
    state.drafts.length = 0
    state.transitions.length = 0
    state.appliedRuleIds.length = 0
    state.job.status = 'queued'
  })

  it('runs the mocked happy path through base draft, selected-rule optimization, risk gate, and human review state', async () => {
    const adapter: GeoRewriteAdapter = {
      id: 'custom', version: 'mock-provider-v1',
      async rewrite(document, rules) {
        state.appliedRuleIds = rules.map(rule => rule.id)
        return {
          provider: 'custom', providerVersion: 'mock-provider-v1', optimizedTitle: document.title, optimizedContent: `${document.content}\n\n## Selected rule optimization\n${rules.map(rule => rule.title).join('、')}`,
          appliedRuleIds: rules.map(rule => rule.id), safetyNotes: ['mocked provider only'],
          provenance: { requestedProvider: 'autogeo-api', execution: 'reference-fallback', upstreamRepository: 'cxcscmu/AutoGEO', upstreamRevision: 'mock', rewriteMethod: 'autogeo_api', ruleset: 'Researchy-GEO / Gemini default rules', model: 'mock' },
        }
      },
    }
    const result = await runOwnerProductionPlan({ ownerUserId: 11, planId: 7, dependencies: { optimizationAdapter: adapter } })
    expect(result.generated[0]).toMatchObject({ deliverableId: 8, jobId: 10, status: 'needs_human_review' })
    expect(state.drafts).toHaveLength(2)
    expect(state.drafts[0].provenance.stage).toBe('base_draft')
    expect(state.drafts[0].body).toContain('可核對的內容來源與方法說明')
    expect(state.drafts[0].provenance.generationMode).toBe('deterministic_scaffold')
    expect(state.drafts[1].provenance.stage).toBe('optimized')
    expect(state.drafts[1].provenance.parentDraftId).toBe(state.drafts[0].id)
    expect(state.drafts[1].provenance.selectedRuleIds).toEqual(['direct-answer-first', 'semantic-sections'])
    expect(state.drafts[1].provenance.appliedRuleIds).toEqual(['direct-answer-first', 'semantic-sections'])
    expect(state.appliedRuleIds).toEqual(['direct-answer-first', 'semantic-sections'])
    expect(state.transitions).toEqual(['processing', 'needs_human_review'])
    expect(state.deliverable.status).toBe('needs_human_review')
    expect(state.plan.status).toBe('in_progress')
  })
})
