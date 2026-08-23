import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ queue: [] as any[], insertedDraft: null as any, updateCount: 0 }))

vi.mock('../server/audit/repository', () => ({
  requireAuditDatabase: () => {
    const read = () => state.queue.shift() || []
    const select = () => {
      const builder: any = {
        from: () => builder,
        innerJoin: () => builder,
        leftJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => Promise.resolve(read()),
        then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(read()).then(resolve, reject),
      }
      return builder
    }
    const insert = () => ({ values: (row: any) => {
      if (row.jobId && row.version) state.insertedDraft = { id: 102, ...row }
      return { $returningId: async () => [{ id: 900 }] }
    } })
    const update = () => ({ set: () => ({ where: async () => { state.updateCount += 1 } }) })
    return { select, insert, update }
  },
}))

import { stableFingerprint, submitProductionDraftRevision } from '../server/seo-geo-core/repository'

const evidenceHash = stableFingerprint([{ sourceId: 20, artifactId: 21, locator: 'https://example.com/reviewed-artifact', artifactHash: 'artifact-hash' }])
const rule = { id: 'direct-answer-first', category: 'answerability', title: '先提供可驗證的直接摘要', instruction: '先回答主題。', rationale: '可掃讀。', priority: 'high' }
const parentDraft = { id: 101, jobId: 10, version: 1, title: '原 optimized', body: '原始 evidence bound draft', contentHash: 'parent-hash', sourceMode: 'reference_fallback', provenance: { stage: 'optimized' }, safetyStatus: 'passed' }
const basePlan = { id: 7, ownerUserId: 11, diagnosisId: 3, title: '內容計畫', language: 'zh-hant', status: 'in_progress', evidenceSnapshotHash: evidenceHash }
const baseSelection = { id: 9, ownerUserId: 11, planId: 7, strategyRecommendationId: 42, status: 'selected', evidenceSnapshotHash: evidenceHash }
const baseStrategy = { id: 42, diagnosisId: 3, status: 'selected', ruleSetVersion: 'autogeo-compatible-rules-v1', ruleIds: [rule.id], rules: [rule], evidenceRefs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash' }], evidenceSnapshotHash: evidenceHash, contentOpportunities: [{ key: 'article', deliverableType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'] }] }
const baseDeliverable = { id: 8, ownerUserId: 11, planId: 7, selectionId: 9, opportunityKey: '42:article', contentType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'], language: 'zh-hant', status: 'needs_human_review', evidenceSnapshotHash: evidenceHash, briefId: 12, jobId: 10, provenance: {} }
const baseBrief = { id: 12, productionPlanId: 7, productionDeliverableId: 8, strategyRecommendationId: 42, diagnosisId: 3, title: 'Evidence article', audience: '研究者', contentType: 'article', language: 'zh-hant', goals: ['回答主題'], constraints: ['只用 evidence'], evidenceRefs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash' }], evidenceSnapshotHash: evidenceHash, status: 'ready_for_generation' }
const baseJob = { id: 10, ownerUserId: 11, briefId: 12, productionPlanId: 7, productionDeliverableId: 8, strategyRecommendationId: 42, operation: 'content_draft', providerMode: 'reference_rules', status: 'needs_human_review', idempotencyKey: 'job-10', evidenceSnapshotHash: evidenceHash }
const diagnosis = { id: 3, ownerUserId: 11, sourceId: 20, status: 'completed', result: { status: 'completed', engine: 'deterministic-diagnosis-v1', findings: [], limitations: [] }, limitations: [] }
const evidenceRow = { approvalId: 1, approvalPurpose: 'recommendation', sourceId: 20, artifactId: 21, sourceName: 'Approved source', sourceUrl: 'https://example.com/', fallbackSourceUrl: null, artifactType: 'html', artifactText: '可核對的內容來源與方法說明。', artifactLocator: 'https://example.com/reviewed-artifact', artifactHash: 'artifact-hash', fieldData: null }

function queueContext(changeRequest = { id: 200, decision: 'changes_requested' }) {
  state.queue = [
    [basePlan], [baseSelection], [baseDeliverable], [baseStrategy], [diagnosis], [evidenceRow, { ...evidenceRow, approvalPurpose: 'content_draft' }], [baseBrief], [baseJob], [parentDraft], [changeRequest], [parentDraft], [{ id: 102, jobId: 10, version: 2, title: '更新後 Evidence article', body: '可核對的內容來源與方法說明。這是 owner 重新整理後的完整正文，保留 evidence 邊界並等待再次人工 review。', contentHash: 'revision-hash', provenance: { stage: 'optimized', generationMode: 'owner_revision', parentDraftId: 101, changeRequestReviewId: 200, evidenceSnapshotHash: evidenceHash }, safetyStatus: 'passed' }], [baseJob], [baseDeliverable], [basePlan], [{ status: 'needs_human_review' }],
  ]
}

describe('real revision service with mocked database', () => {
  beforeEach(() => { state.queue = []; state.insertedDraft = null; state.updateCount = 0 })

  it('creates a new optimized version after changes_requested and re-gates it', async () => {
    queueContext()
    const result = await submitProductionDraftRevision({ ownerUserId: 11, planId: 7, deliverableId: 8, title: '更新後 Evidence article', body: '可核對的內容來源與方法說明。這是 owner 重新整理後的完整正文，保留 evidence 邊界並等待再次人工 review。' })
    expect(result.draft.version).toBe(2)
    expect(result.draft.provenance).toMatchObject({ stage: 'optimized', generationMode: 'owner_revision', parentDraftId: 101, changeRequestReviewId: 200, evidenceSnapshotHash: evidenceHash })
    expect(result.draft.contentHash).not.toBe('parent-hash')
    expect(result.riskGate.status).not.toBe('blocked')
    expect(result.job.status).toBe('needs_human_review')
    expect(state.updateCount).toBe(2)
  })
})
