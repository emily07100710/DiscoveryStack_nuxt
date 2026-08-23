import { describe, expect, it } from 'vitest'
import { buildOwnerRevisionInputProvenance, deriveDraftReviewEligibility } from '../server/seo-geo-core/repository'

describe('production review lifecycle', () => {
  it('never grants review, preview, or export eligibility to a base draft', () => {
    expect(deriveDraftReviewEligibility({ stage: 'base_draft', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: 'passed', approvedForPreview: false, approvedForDelivery: false })).toEqual({ canReview: false, canApprovePreview: false, canApproveDelivery: false, canPreview: false, canExport: false })
  })

  it('allows preview approval to be upgraded to delivery approval on the same optimized draft', () => {
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'approved', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: false })).toMatchObject({ canApprovePreview: false, canApproveDelivery: true, canPreview: true, canExport: false })
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'approved', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: true })).toMatchObject({ canApproveDelivery: false, canExport: true })
  })

  it('invalidates old-draft approval eligibility after changes_requested', () => {
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: false, pendingChangesRequested: true })).toMatchObject({ canReview: false, canApprovePreview: false, canApproveDelivery: false, canPreview: false, canExport: false })
  })

  it('records parent, change request review, and immutable evidence linkage for a new revision', () => {
    const provenance = buildOwnerRevisionInputProvenance({ parentDraftId: 100, parentDraftContentHash: 'parent-hash', changeRequestReviewId: 200, selectedRuleIds: ['faq-question-answer'], evidenceSnapshotHash: 'evidence-hash', revisionAuthor: 11 })
    expect(provenance).toMatchObject({ stage: 'owner_revision_input', generationMode: 'owner_revision_input', parentDraftId: 100, parentDraftContentHash: 'parent-hash', changeRequestReviewId: 200, selectedRuleIds: ['faq-question-answer'], evidenceSnapshotHash: 'evidence-hash', revisionAuthor: 11 })
    expect(provenance.appliedRuleIds).toEqual([])
  })
})
