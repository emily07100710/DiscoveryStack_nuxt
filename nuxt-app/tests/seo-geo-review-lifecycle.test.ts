import { describe, expect, it } from 'vitest'
import { buildRevisionProvenance, deriveDraftReviewEligibility } from '../server/seo-geo-core/repository'

describe('production review lifecycle', () => {
  it('never grants review, preview, or export eligibility to a base draft', () => {
    expect(deriveDraftReviewEligibility({ stage: 'base_draft', safetyStatus: 'passed', jobStatus: 'needs_human_review', gateStatus: 'passed', approvedForPreview: false, approvedForDelivery: false })).toEqual({ canReview: false, canApprovePreview: false, canApproveDelivery: false, canPreview: false, canExport: false })
  })

  it('allows preview approval to be upgraded to delivery approval on the same optimized draft', () => {
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'approved', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: false })).toMatchObject({ canApprovePreview: false, canApproveDelivery: true, canPreview: true, canExport: false })
    expect(deriveDraftReviewEligibility({ stage: 'optimized', safetyStatus: 'passed', jobStatus: 'approved', gateStatus: 'passed', approvedForPreview: true, approvedForDelivery: true })).toMatchObject({ canApproveDelivery: true, canExport: true })
  })

  it('records parent, change request review, and immutable evidence linkage for a new revision', () => {
    const provenance = buildRevisionProvenance({ parentDraftId: 100, parentDraftContentHash: 'parent-hash', changeRequestReviewId: 200, selectedRuleIds: ['faq-question-answer'], evidenceSnapshotHash: 'evidence-hash', revisionAuthor: 11 })
    expect(provenance).toMatchObject({ stage: 'optimized', generationMode: 'owner_revision', parentDraftId: 100, parentDraftContentHash: 'parent-hash', changeRequestReviewId: 200, selectedRuleIds: ['faq-question-answer'], evidenceSnapshotHash: 'evidence-hash', revisionAuthor: 11 })
    expect(provenance.appliedRuleIds).toEqual([])
  })
})
