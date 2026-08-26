import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  queue: [] as any[],
  savedDrafts: [] as any[],
  riskGates: [] as any[],
  transactionPendingStages: [] as string[],
  transactionCalls: 0,
  transactionCommits: 0,
  nextDraftId: 102,
  failRiskGateInsert: false,
  jobUpdates: [] as any[],
  deliverableUpdates: [] as any[],
}))

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
      if (row.gateVersion) {
        if (state.failRiskGateInsert) throw new Error('injected risk-gate insert failure')
        state.riskGates.push({ id: 301, ...row })
        return {}
      }
      const draft = { id: state.nextDraftId++, ...row }
      state.savedDrafts.push(draft)
      return { $returningId: async () => [{ id: draft.id }] }
    } })
    const update = () => ({ set: (patch: any) => ({ where: async () => {
      if (patch.provenance?.stage === 'optimized') {
        const draft = state.savedDrafts[state.savedDrafts.length - 1]
        if (draft) Object.assign(draft, patch)
      }
      if (patch.status) state.jobUpdates.push(patch)
      if (patch.briefId !== undefined || patch.jobId !== undefined) state.deliverableUpdates.push(patch)
    } }) })
    const transaction = async (callback: (tx: any) => Promise<unknown>) => {
      state.transactionCalls += 1
      const draft = state.savedDrafts[state.savedDrafts.length - 1]
      if (draft) state.transactionPendingStages.push(draft.provenance.stage)
      const result = await callback({ select, update, insert })
      state.transactionCommits += 1
      return result
    }
    return { select, insert, update, transaction }
  },
}))

import { stableFingerprint, submitProductionDraftRevision } from '../server/seo-geo-core/repository'

const evidenceHash = stableFingerprint([{ sourceId: 20, artifactId: 21, locator: 'https://example.com/reviewed-artifact', artifactHash: 'artifact-hash', approvedAt: '2026-01-10T08:00:00.000Z' }])
const rule = { id: 'direct-answer-first', category: 'answerability', title: '先提供可驗證的直接摘要', instruction: '先回答主題。', rationale: '可掃讀。', priority: 'high' }
const parentDraft = { id: 101, jobId: 10, version: 1, title: '原 optimized', body: '原始 evidence bound draft', contentHash: 'parent-hash', sourceMode: 'reference_fallback', provenance: { stage: 'optimized' }, safetyStatus: 'passed' }
const basePlan = { id: 7, ownerUserId: 11, diagnosisId: 3, title: '內容計畫', language: 'zh-hant', status: 'in_progress', evidenceSnapshotHash: evidenceHash }
const baseSelection = { id: 9, ownerUserId: 11, planId: 7, strategyRecommendationId: 42, status: 'selected', evidenceSnapshotHash: evidenceHash }
const baseStrategy = { id: 42, diagnosisId: 3, status: 'selected', ruleSetVersion: 'autogeo-compatible-rules-v1', ruleIds: [rule.id], rules: [rule], evidenceRefs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash' }], evidenceSnapshotHash: evidenceHash, contentOpportunities: [{ key: 'article', deliverableType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'] }] }
const baseDeliverable = { id: 8, ownerUserId: 11, planId: 7, selectionId: 9, opportunityKey: '42:article', contentType: 'article', title: 'Evidence article', audience: '研究者', goals: ['回答主題'], constraints: ['只用 evidence'], language: 'zh-hant', status: 'needs_human_review', evidenceSnapshotHash: evidenceHash, briefId: 12, jobId: 10, provenance: {} }
const baseBrief = { id: 12, productionPlanId: 7, productionDeliverableId: 8, strategyRecommendationId: 42, diagnosisId: 3, title: 'Evidence article', audience: '研究者', contentType: 'article', language: 'zh-hant', goals: ['回答主題'], constraints: ['只用 evidence'], evidenceRefs: [{ sourceId: 20, artifactId: 21, artifactHash: 'artifact-hash' }], evidenceSnapshotHash: evidenceHash, status: 'ready_for_generation' }
const baseJob = { id: 10, ownerUserId: 11, briefId: 12, productionPlanId: 7, productionDeliverableId: 8, strategyRecommendationId: 42, operation: 'content_draft', providerMode: 'reference_rules', status: 'needs_human_review', idempotencyKey: 'job-10', evidenceSnapshotHash: evidenceHash }
const diagnosis = { id: 3, ownerUserId: 11, sourceId: 20, status: 'completed', result: { status: 'completed', engine: 'deterministic-diagnosis-v1', findings: [], limitations: [] }, limitations: [] }
const evidenceRow = { approvalId: 1, approvalPurpose: 'recommendation', approvedAt: new Date('2026-01-10T08:00:00.000Z'), sourceId: 20, artifactId: 21, sourceName: 'Approved source', sourceUrl: 'https://example.com/', fallbackSourceUrl: null, artifactType: 'html', artifactText: '可核對的內容來源與方法說明。', artifactLocator: 'https://example.com/reviewed-artifact', artifactHash: 'artifact-hash', fieldData: null }
const ownerRevisionInput = { id: 102, jobId: 10, version: 2, title: '更新後 Evidence article', body: '可核對的內容來源與方法說明。這是 owner 重新整理後的完整正文，保留 evidence 邊界並等待再次人工 review。', contentHash: 'revision-input-hash', provenance: { stage: 'owner_revision_input', generationMode: 'owner_revision_input', parentDraftId: 101, changeRequestReviewId: 200, evidenceSnapshotHash: evidenceHash }, safetyStatus: 'needs_review' }
const optimizedRevision = { id: 103, jobId: 10, version: 3, title: '更新後 Evidence article｜重點與可驗證說明', body: '## 直接摘要\n可核對的內容來源與方法說明\n\n可核對的內容來源與方法說明。這是 owner 重新整理後的完整正文，保留 evidence 邊界並等待再次人工 review。\n\n## 驗證與補強\n本文未因格式調整而新增外部事實。上線前請由內容擁有者人工核對主張。', contentHash: 'optimized-revision-hash', provenance: { stage: 'optimized', generationMode: 'revision_selected_rule_optimization', ownerRevisionInputDraftId: 102, parentDraftId: 102, originalParentDraftId: 101, changeRequestReviewId: 200, selectedRuleIds: ['direct-answer-first'], appliedRuleIds: ['direct-answer-first'], evidenceSnapshotHash: evidenceHash }, safetyStatus: 'passed' }

function queueContext() {
  state.queue = [
    [basePlan], [baseSelection], [baseDeliverable], [baseStrategy], [diagnosis], [evidenceRow, { ...evidenceRow, approvalPurpose: 'content_draft' }], [baseBrief], [baseJob], [parentDraft], [{ id: 200, decision: 'changes_requested' }], [{ version: 1 }], [ownerRevisionInput], [{ version: 2 }], [optimizedRevision], [basePlan], [{ status: 'needs_human_review' }],
  ]
}

describe('real revision service with mocked database', () => {
  beforeEach(() => {
    state.queue = []
    state.savedDrafts = []
    state.riskGates = []
    state.transactionPendingStages = []
    state.transactionCalls = 0
    state.transactionCommits = 0
    state.nextDraftId = 102
    state.failRiskGateInsert = false
    state.jobUpdates = []
    state.deliverableUpdates = []
  })

  it('creates a pending child, gates it in a transaction, and promotes it to optimized', async () => {
    queueContext()
    const result = await submitProductionDraftRevision({ ownerUserId: 11, planId: 7, deliverableId: 8, title: ownerRevisionInput.title, body: ownerRevisionInput.body })
    expect(result.ownerRevisionInput.version).toBe(2)
    expect(result.ownerRevisionInput.provenance).toMatchObject({ stage: 'owner_revision_input', generationMode: 'owner_revision_input', parentDraftId: 101, changeRequestReviewId: 200, evidenceSnapshotHash: evidenceHash })
    expect(state.savedDrafts[0].provenance.stage).toBe('owner_revision_input')
    expect(state.savedDrafts[1].provenance.stage).toBe('optimized')
    expect(state.transactionPendingStages).toEqual(['optimized_pending_gate'])
    expect(state.transactionCalls).toBe(1)
    expect(state.transactionCommits).toBe(1)
    expect(state.riskGates).toHaveLength(1)
    expect(state.riskGates[0]).toMatchObject({ draftId: 103, evidenceSnapshotHash: evidenceHash, status: result.riskGate.status })
    expect(result.draft.version).toBe(3)
    expect(result.draft.provenance).toMatchObject({ stage: 'optimized', generationMode: 'revision_selected_rule_optimization', ownerRevisionInputDraftId: 102, parentDraftId: 102, originalParentDraftId: 101, changeRequestReviewId: 200, selectedRuleIds: ['direct-answer-first'], appliedRuleIds: ['direct-answer-first'], evidenceSnapshotHash: evidenceHash })
    expect((result.draft.provenance as { appliedRuleIds?: string[] }).appliedRuleIds).toEqual(['direct-answer-first'])
    expect(result.draft.body).toContain('直接摘要')
    expect(result.draft.body).not.toBe(ownerRevisionInput.body)
    expect(result.draft.contentHash).not.toBe('parent-hash')
    expect(result.riskGate.status).not.toBe('blocked')
    expect(result.job.status).toBe('needs_human_review')
    expect(state.jobUpdates[0]).toMatchObject({ status: 'needs_human_review' })
    expect(state.deliverableUpdates[0]).toMatchObject({ status: 'needs_human_review', briefId: 12, jobId: 10 })
  })

  it('leaves the child pending and performs no completion updates when risk-gate insert fails', async () => {
    queueContext()
    state.failRiskGateInsert = true
    await expect(submitProductionDraftRevision({ ownerUserId: 11, planId: 7, deliverableId: 8, title: ownerRevisionInput.title, body: ownerRevisionInput.body })).rejects.toThrow(/injected risk-gate insert failure/)
    expect(state.savedDrafts[0].provenance.stage).toBe('owner_revision_input')
    expect(state.savedDrafts[1].provenance.stage).toBe('optimized_pending_gate')
    expect(state.transactionPendingStages).toEqual(['optimized_pending_gate'])
    expect(state.transactionCalls).toBe(1)
    expect(state.transactionCommits).toBe(0)
    expect(state.riskGates).toHaveLength(0)
    expect(state.jobUpdates).toHaveLength(0)
    expect(state.deliverableUpdates).toHaveLength(0)
    expect(state.queue).toHaveLength(2)
  })
})
