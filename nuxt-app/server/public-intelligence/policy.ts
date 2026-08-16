export type PublicUse = 'research_only' | 'evaluation_candidate' | 'training_candidate' | 'blocked'
export type TermsStatus = 'unreviewed' | 'allows_research' | 'allows_evaluation' | 'allows_training' | 'prohibits_automation' | 'prohibits_training' | 'unknown'
export type CopyrightRisk = 'unreviewed' | 'low' | 'medium' | 'high' | 'blocked'
export type PiiStatus = 'unreviewed' | 'none_detected' | 'possible' | 'restricted'

const rank: Record<PublicUse, number> = { blocked: 0, research_only: 1, evaluation_candidate: 2, training_candidate: 3 }

export class PublicUseViolation extends Error {
  constructor(message: string) { super(message); this.name = 'PublicUseViolation' }
}

export function maximumPermittedUse(input: { termsStatus: TermsStatus, copyrightRisk: CopyrightRisk, piiStatus: PiiStatus, reviewStatus: 'pending' | 'approved' | 'needs_policy_review' | 'rejected' | 'removed' }): PublicUse {
  if (input.reviewStatus === 'rejected' || input.reviewStatus === 'removed' || input.termsStatus === 'prohibits_automation' || input.termsStatus === 'prohibits_training' || input.copyrightRisk === 'blocked' || input.piiStatus === 'restricted') return 'blocked'
  if (input.reviewStatus !== 'approved') return 'research_only'
  if (input.termsStatus === 'allows_training' && input.copyrightRisk === 'low' && input.piiStatus === 'none_detected') return 'training_candidate'
  if ((input.termsStatus === 'allows_evaluation' || input.termsStatus === 'allows_training') && input.copyrightRisk !== 'high' && input.piiStatus === 'none_detected') return 'evaluation_candidate'
  return 'research_only'
}

export function assertPermittedPublicUse(input: { requestedUse: PublicUse, maximumUse: PublicUse }) {
  if (input.requestedUse === 'blocked') return
  if (rank[input.requestedUse] > rank[input.maximumUse]) throw new PublicUseViolation(`This source is currently limited to ${input.maximumUse}; it cannot be admitted as ${input.requestedUse}.`)
}
