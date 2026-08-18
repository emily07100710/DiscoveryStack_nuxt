export type TrainingManifestMember = {
  artifactType: string
  qualityStatus: string
  piiStatus: string
  sourceUse: string
  sourceReviewStatus: string
  sourceRemovedAt: Date | null
  artifactRemovedAt: Date | null
}

/** A fetched structural artifact can inform an owner review but can never directly enter a training manifest. */
export function trainingMemberAdmissionError(member: TrainingManifestMember) {
  if (member.artifactType !== 'human_annotation') return 'human_annotation_required'
  if (member.qualityStatus !== 'passed') return 'quality_review_required'
  if (member.piiStatus !== 'none_detected') return 'pii_clearance_required'
  if (member.sourceUse !== 'training_candidate') return 'training_use_not_approved'
  if (member.sourceReviewStatus !== 'approved') return 'source_review_required'
  if (member.sourceRemovedAt || member.artifactRemovedAt) return 'revoked_content_cannot_train'
  return null
}
