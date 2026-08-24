import { describe, expect, it } from 'vitest'
import { buildOwnerRevisionInputProvenance, deriveDraftReviewEligibility } from '../server/seo-geo-core/repository'

const eligibilityKeys = ['canReview', 'canApprovePreview', 'canApproveDelivery', 'canPreview', 'canExport'] as const

function expectAllIneligible(input: Parameters<typeof deriveDraftReviewEligibility>[0]) {
  const result = deriveDraftReviewEligibility(input)
  for (const key of eligibilityKeys) expect(result[key]).toBe(false)
}

describe('production review lifecycle', () => {
  it('never grants review, preview, or export eligibility to a base draft', () => {
    expectAllIneligible({ stage: 'base_draft', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: 'passed', approvedForPreview: false, approvedForDelivery: false })
  })

  it('fails closed when draft safety status is missing', () => {
    expectAllIneligible({ stage: 'optimized', safetyStatus: undefined, jobStatus: 'needs_human_review', gateStatus: 'passed', approvedForPreview: false, approvedForDelivery: false })
  })

  it('fails closed when risk gate status is missing', () => {
    expectAllIneligible({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: undefined, approvedForPreview: false, approvedForDelivery: false })
  })

  it('fails closed when the risk gate is blocked', () => {
    expectAllIneligible({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: 'blocked', approvedForPreview: false, approvedForDelivery: false })
  })

  it('allows owner review but not approval, preview, or export while both safety and gate require human review', () => {
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'needs_review', jobStatus: 'needs_human_review', gateStatus: 'needs_human_review', approvedForPreview: false, approvedForDelivery: false })).toEqual({ canReview: true, canApprovePreview: false, canApproveDelivery: false, canPreview: false, canExport: false })
  })

  it('allows preview approval to be upgraded to delivery approval on the same optimized draft', () => {
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'approved', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: false })).toMatchObject({ canApprovePreview: false, canApproveDelivery: true, canPreview: true, canExport: false })
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'approved', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: true })).toMatchObject({ canApproveDelivery: false, canExport: true })
  })

  it('invalidates old-draft approval eligibility after changes_requested', () => {
    expectAllIneligible({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: false, pendingChangesRequested: true })
  })

  it('records parent, change request review, and immutable evidence linkage for a new revision', () => {
    const provenance = buildOwnerRevisionInputProvenance({ parentDraftId: 100, parentDraftContentHash: 'parent-hash', changeRequestReviewId: 200, selectedRuleIds: ['faq-question-answer'], evidenceSnapshotHash: 'evidence-hash', revisionAuthor: 11 })
    expect(provenance).toMatchObject({ stage: 'owner_revision_input', generationMode: 'owner_revision_input', parentDraftId: 100, parentDraftContentHash: 'parent-hash', changeRequestReviewId: 200, selectedRuleIds: ['faq-question-answer'], evidenceSnapshotHash: 'evidence-hash', revisionAuthor: 11 })
    expect(provenance.appliedRuleIds).toEqual([])
  })
})
