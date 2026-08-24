import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  job: { id: 10, ownerUserId: 11, evidenceSnapshotHash: 'evidence-hash', status: 'needs_human_review' as 'needs_human_review' | 'approved', productionDeliverableId: 8, productionPlanId: 7 },
  draft: { id: 101, jobId: 10, safetyStatus: 'passed' as 'passed' | 'needs_review' | 'blocked', provenance: { stage: 'optimized' } },
  plan: { id: 7, ownerUserId: 11, status: 'in_progress' as const },
  passedGate: { id: 301, draftId: 101, evidenceSnapshotHash: 'evidence-hash', status: 'passed' as 'passed' | 'needs_human_review' | 'blocked' },
  target: { id: 401, ownerUserId: 11, adapter: 'manual_export', targetOrigin: 'https://preview.example.com', status: 'disabled', allowPublish: false },
  reviews: [] as any[],
  deliveryAttempts: [] as any[],
  selectQueue: [] as any[][],
  updateCall: 0,
}))

vi.mock('../server/audit/repository', () => ({
  requireAuditDatabase: () => {
    const read = () => state.selectQueue.shift() || []
    const select = () => {
      const builder: any = {
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => Promise.resolve(read()),
        then: (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(read()).then(resolve, reject),
      }
      return builder
    }
    const update = () => ({ set: (patch: any) => ({ where: async () => {
      state.updateCall += 1
      if (patch.status) state.job.status = patch.status
    } }) })
    const insert = () => ({ values: (row: any) => {
      if (row.mode === 'preview') {
        state.deliveryAttempts.push({ id: 700 + state.deliveryAttempts.length, ...row })
        return {}
      }
      return { $returningId: async () => {
        const review = { ...row, id: 500 + state.reviews.length }
        state.reviews.push(review)
        return [{ id: review.id }]
      } }
    } })
    return { select, update, insert, transaction: async (callback: (tx: any) => Promise<unknown>) => callback({ select, update, insert }) }
  },
}))

import { createContentReview, prepareDeliveryPreview } from '../server/seo-geo-core/repository'

describe('repository review workflow with a mocked database', () => {
  beforeEach(() => {
    state.job.status = 'needs_human_review'
    state.draft.id = 101
    state.draft.provenance = { stage: 'optimized' }
    state.draft.safetyStatus = 'passed'
    state.passedGate = { id: 301, draftId: 101, evidenceSnapshotHash: 'evidence-hash', status: 'passed' }
    state.reviews.length = 0
    state.deliveryAttempts.length = 0
    state.selectQueue = []
    state.updateCall = 0
  })

  it('rejects approval of a base draft before opening a review transaction', async () => {
    state.draft.provenance = { stage: 'base_draft' }
    state.selectQueue = [[state.job], [state.draft]]
    await expect(createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_preview' })).rejects.toThrow(/optimized production draft/)
    expect(state.reviews).toHaveLength(0)
  })

  it('rejects approval when no matching risk gate exists and does not update review state', async () => {
    state.selectQueue = [[state.job], [state.draft], []]
    await expect(createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_preview' })).rejects.toThrow(/matching risk gate/)
    expect(state.reviews).toHaveLength(0)
    expect(state.updateCall).toBe(0)
  })

  it('rejects approval when the risk gate evidence snapshot does not match', async () => {
    state.selectQueue = [[state.job], [state.draft], []]
    await expect(createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_preview' })).rejects.toThrow(/matching risk gate/)
    expect(state.reviews).toHaveLength(0)
    expect(state.updateCall).toBe(0)
  })

  it('rejects approval when the matching risk gate is blocked', async () => {
    state.selectQueue = [[state.job], [state.draft], [{ ...state.passedGate, status: 'blocked' }]]
    await expect(createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_preview' })).rejects.toThrow(/blocked risk gate/)
    expect(state.reviews).toHaveLength(0)
    expect(state.updateCall).toBe(0)
  })

  it('requires a new revision after changes_requested instead of approving the old draft again', async () => {
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [{ id: 501 }]]
    await expect(createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_preview' })).rejects.toThrow(/new revision/)
    expect(state.reviews).toHaveLength(0)
    expect(state.updateCall).toBe(0)
  })

  it('allows approved preview to become changes_requested and returns the job to review', async () => {
    state.job.status = 'approved'
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [state.plan], [{ status: 'needs_human_review' }]]
    const result = await createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'changes_requested', reviewNote: '請補充可核對的段落。' })
    expect(result.nextStatus).toBe('needs_human_review')
    expect(state.reviews[0]).toMatchObject({ draftId: 101, decision: 'changes_requested' })
  })

  it('requires a new optimized draft before reapproval after preview approval changes_requested', async () => {
    state.job.status = 'approved'
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [state.plan], [{ status: 'needs_human_review' }]]
    const change = await createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'changes_requested', reviewNote: '請修改。' })
    expect(change.nextStatus).toBe('needs_human_review')

    state.job.status = 'needs_human_review'
    state.draft.id = 102
    state.selectQueue = [[state.job], [state.draft], [{ ...state.passedGate, draftId: 102 }], [], [state.plan], [{ status: 'needs_human_review' }]]
    const reapproval = await createContentReview({ ownerUserId: 11, jobId: 10, draftId: 102, decision: 'approved_for_preview' })
    expect(reapproval.nextStatus).toBe('approved')
    expect(state.reviews).toHaveLength(2)
    expect(state.reviews[0]).toMatchObject({ draftId: 101, decision: 'changes_requested' })
    expect(state.reviews[1]).toMatchObject({ draftId: 102, decision: 'approved_for_preview' })
  })

  it('rejects duplicate delivery approval for the same optimized draft', async () => {
    state.job.status = 'approved'
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [], [], [{ id: 502 }]]
    await expect(createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_delivery' })).rejects.toThrow(/already has approved_for_delivery/)
    expect(state.reviews).toHaveLength(0)
  })

  it('allows an explicit rejection on a gated optimized candidate', async () => {
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [state.plan], [{ status: 'blocked' }]]
    const result = await createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'rejected', reviewNote: '內容不符合目前需求。' })
    expect(result.nextStatus).toBe('blocked')
    expect(state.reviews[0]).toMatchObject({ draftId: 101, decision: 'rejected' })
  })

  it('rejects delivery preview when no matching risk gate exists without creating an attempt', async () => {
    state.selectQueue = [[state.target], [state.job], [state.draft], []]
    await expect(prepareDeliveryPreview({ ownerUserId: 11, jobId: 10, draftId: 101, targetId: 401, idempotencyKey: 'preview-missing-gate' })).rejects.toThrow(/passed risk gate/)
    expect(state.deliveryAttempts).toHaveLength(0)
  })

  it('rejects delivery preview when the matching risk gate is blocked without creating an attempt', async () => {
    state.selectQueue = [[state.target], [state.job], [state.draft], [{ ...state.passedGate, status: 'blocked' }]]
    await expect(prepareDeliveryPreview({ ownerUserId: 11, jobId: 10, draftId: 101, targetId: 401, idempotencyKey: 'preview-blocked-gate' })).rejects.toThrow(/passed risk gate/)
    expect(state.deliveryAttempts).toHaveLength(0)
  })

  it('creates a preview ledger only with a passed matching gate and records the real review ID', async () => {
    state.selectQueue = [[state.target], [state.job], [state.draft], [state.passedGate], [{ id: 601, decision: 'approved_for_preview' }], [], [state.plan], [{ status: 'approved' }]]
    await expect(prepareDeliveryPreview({ ownerUserId: 11, jobId: 10, draftId: 101, targetId: 401, idempotencyKey: 'preview-passed-gate' })).resolves.toMatchObject({ canPublish: false })
    expect(state.deliveryAttempts).toHaveLength(1)
    expect(state.deliveryAttempts[0]).toMatchObject({ draftId: 101, targetId: 401, approvalReviewId: 601, mode: 'preview', status: 'prepared' })
  })

  it('upgrades preview approval to delivery approval on the same optimized draft', async () => {
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [], [state.plan], [{ status: 'approved' }]]
    const preview = await createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_preview' })
    expect(preview.nextStatus).toBe('approved')
    expect(state.reviews[0]).toMatchObject({ draftId: 101, decision: 'approved_for_preview' })

    state.job.status = 'approved'
    state.selectQueue = [[state.job], [state.draft], [state.passedGate], [], [{ id: 601, decision: 'approved_for_preview' }], [], [state.plan], [{ status: 'approved' }]]
    const delivery = await createContentReview({ ownerUserId: 11, jobId: 10, draftId: 101, decision: 'approved_for_delivery' })
    expect(delivery.nextStatus).toBe('approved')
    expect(state.reviews[1]).toMatchObject({ draftId: 101, decision: 'approved_for_delivery' })
    expect(state.reviews).toHaveLength(2)
  })
})
