import { and, eq, isNull } from 'drizzle-orm'
import { buildApprovedTrainingExample, type ReviewTeachingInput } from './training'
import { DATASET_VERSION, LABEL_CONTRACT_VERSION, LABEL_TAXONOMY_VERSION, SPLIT_VERSION, type ClassifiableObservation, type FrictionAssessmentDraft } from './types'
import { getDatabase } from '../database'
import { auditObservations, auditPages, auditReviews, auditRuns, auditTrainingExamples, auditWorkspaces, frictionAssessments } from '../database/schema'

export async function recordAuditReview(input: { ownerUserId: number, auditRunId: number, review: ReviewTeachingInput }) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Private Audit Lab is temporarily unavailable.' })
  const [run] = await database.select({ id: auditRuns.id, workspaceId: auditWorkspaces.id, language: auditWorkspaces.language, trainingConsent: auditWorkspaces.trainingConsent, consentRevokedAt: auditWorkspaces.consentRevokedAt }).from(auditRuns).innerJoin(auditWorkspaces, eq(auditRuns.workspaceId, auditWorkspaces.id)).where(and(eq(auditRuns.id, input.auditRunId), eq(auditWorkspaces.ownerUserId, input.ownerUserId), isNull(auditWorkspaces.deletedAt))).limit(1)
  if (!run) throw createError({ statusCode: 404, statusMessage: 'Audit run was not found.' })
  const reviewInsert = await database.insert(auditReviews).values({ auditRunId: run.id, reviewerUserId: input.ownerUserId, decision: input.review.decision, correctedPrimaryStage: input.review.correctedPrimaryStage, reviewNote: input.review.reviewNote, labelTaxonomyVersion: LABEL_TAXONOMY_VERSION, labelContractVersion: LABEL_CONTRACT_VERSION, qualityCheckStatus: input.review.qualityCheckStatus, approvedForTraining: input.review.approvedForTraining })
  const reviewId = Number(reviewInsert[0].insertId)
  const observations = await database.select({ id: auditObservations.id, observationKey: auditObservations.observationKey, valueText: auditObservations.valueText, evidenceQuote: auditObservations.evidenceQuote, sourceUrl: auditPages.sourceUrl }).from(auditObservations).innerJoin(auditPages, eq(auditObservations.auditPageId, auditPages.id)).where(eq(auditObservations.auditRunId, run.id))
  const assessments = await database.select({ journeyStage: frictionAssessments.journeyStage, priorityRank: frictionAssessments.priorityRank, score: frictionAssessments.score, assessmentStatus: frictionAssessments.assessmentStatus, summary: frictionAssessments.summary, evidenceLedgerIds: frictionAssessments.evidenceLedgerIds, requiresHumanReview: frictionAssessments.requiresHumanReview }).from(frictionAssessments).where(eq(frictionAssessments.auditRunId, run.id))
  const draft = buildApprovedTrainingExample({ language: run.language, observations: observations as ClassifiableObservation[], assessments: assessments.map(item => ({ ...item, score: Number(item.score), evidence: [], observationIds: [] })) as FrictionAssessmentDraft[], review: input.review, workspaceTrainingConsent: run.trainingConsent && !run.consentRevokedAt })
  if (!draft) return { reviewId, trainingExampleCreated: false, reason: 'Review retained, but it is not eligible for a training candidate.' }
  await database.insert(auditTrainingExamples).values({ workspaceId: run.workspaceId, auditRunId: run.id, reviewId, featureContractVersion: draft.featureContractVersion, labelTaxonomyVersion: LABEL_TAXONOMY_VERSION, datasetVersion: DATASET_VERSION, splitVersion: SPLIT_VERSION, dataSplit: 'unassigned', labelStage: draft.labelStage, labelDecision: draft.labelDecision, labelRationale: draft.labelRationale, featureVector: draft.featureVector, trainingConsent: true, datasetStatus: 'candidate', qualityCheckStatus: 'passed' })
  return { reviewId, trainingExampleCreated: true, reason: 'Human-approved, de-identified training candidate created.' }
}
