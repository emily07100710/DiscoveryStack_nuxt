import { TRAINING_FEATURE_CONTRACT_VERSION, type ClassifiableObservation, type FrictionAssessmentDraft, type JourneyStage, type TrainingFeatureVector } from './types'

export type ReviewTeachingInput = { decision: 'confirmed' | 'amended' | 'rejected', correctedPrimaryStage: JourneyStage | null, reviewNote: string | null, approvedForTraining: boolean, qualityCheckStatus: 'pending' | 'passed' | 'needs_revision' | 'rejected' }
export type TrainingExampleDraft = { featureContractVersion: typeof TRAINING_FEATURE_CONTRACT_VERSION, labelStage: JourneyStage, labelDecision: 'confirmed' | 'amended', labelRationale: string, featureVector: TrainingFeatureVector }

/** Emits only de-identified feature aggregates from a human-approved review; URLs, raw text, identity and performance data are intentionally omitted. */
export function buildApprovedTrainingExample(input: { language: 'en' | 'zh-hant', observations: ClassifiableObservation[], assessments: FrictionAssessmentDraft[], review: ReviewTeachingInput, workspaceTrainingConsent: boolean }): TrainingExampleDraft | null {
  if (!input.workspaceTrainingConsent || !input.review.approvedForTraining || input.review.qualityCheckStatus !== 'passed' || input.review.decision === 'rejected' || !input.review.correctedPrimaryStage || !input.review.reviewNote?.trim()) return null
  const binarySignalCounts: TrainingFeatureVector['binarySignalCounts'] = {}
  for (const observation of input.observations) {
    const count = binarySignalCounts[observation.observationKey] || { true: 0, false: 0, other: 0 }
    if (observation.valueText === 'true') count.true += 1
    else if (observation.valueText === 'false') count.false += 1
    else count.other += 1
    binarySignalCounts[observation.observationKey] = count
  }
  return { featureContractVersion: TRAINING_FEATURE_CONTRACT_VERSION, labelStage: input.review.correctedPrimaryStage, labelDecision: input.review.decision, labelRationale: input.review.reviewNote.trim(), featureVector: { contractVersion: TRAINING_FEATURE_CONTRACT_VERSION, language: input.language, observationCount: input.observations.length, distinctPageCount: new Set(input.observations.map(observation => observation.sourceUrl)).size, binarySignalCounts, assessmentSnapshot: input.assessments.map(assessment => ({ stage: assessment.journeyStage, status: assessment.assessmentStatus, score: assessment.score })) } }
}
