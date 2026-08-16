import { and, eq, isNull } from 'drizzle-orm'
import { classifyJourneyFriction } from './classifier'
import { manualContentHash } from './manual'
import { getDatabase } from '../database'
import { auditEvidenceLedger, auditObservations, auditPages, auditRuns, auditWorkspaces, frictionAssessments } from '../database/schema'
import { AUDIT_ANALYZER_VERSION, CLASSIFIER_VERSION, EXTRACTION_VERSION, type ClassifiableObservation } from './types'

type ManualSignal = { key: string, value: boolean, evidenceNote: string }

/** Records only explicitly supplied structural notes. It never fetches a target URL, saves raw HTML, or makes conversion claims. */
export async function completeManualAudit(input: { ownerUserId: number, workspaceId: number, targetUrl: string, signals: ManualSignal[] }) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Private Audit Lab is temporarily unavailable.' })
  const [workspace] = await database.select({ id: auditWorkspaces.id, language: auditWorkspaces.language, publicAuditAuthorization: auditWorkspaces.publicAuditAuthorization }).from(auditWorkspaces).where(and(eq(auditWorkspaces.id, input.workspaceId), eq(auditWorkspaces.ownerUserId, input.ownerUserId), isNull(auditWorkspaces.deletedAt))).limit(1)
  if (!workspace) throw createError({ statusCode: 404, statusMessage: 'Audit workspace was not found.' })
  if (!workspace.publicAuditAuthorization) throw createError({ statusCode: 422, statusMessage: 'Explicit public-audit authorisation is required before recording observations.' })
  const now = new Date()
  const runInsert = await database.insert(auditRuns).values({ workspaceId: workspace.id, provider: 'manual', status: 'completed', requestedUrl: input.targetUrl, scopePolicy: { mode: 'manual-structural-signals-only', rawPageStorage: false, externalRequests: false }, analyzerVersion: AUDIT_ANALYZER_VERSION, startedAt: now, completedAt: now })
  const auditRunId = Number(runInsert[0].insertId)
  const pageInsert = await database.insert(auditPages).values({ auditRunId, sourceUrl: input.targetUrl, finalUrl: input.targetUrl, canonicalUrl: input.targetUrl, pageType: 'other', contentHash: manualContentHash(input.signals), snapshotStorageKey: null, snapshotByteLength: null, fetchedAt: now })
  const auditPageId = Number(pageInsert[0].insertId)
  await database.insert(auditObservations).values(input.signals.map(signal => ({ auditRunId, auditPageId, observationKey: signal.key, valueText: String(signal.value), evidenceQuote: signal.evidenceNote || null, confidence: 100, extractionVersion: EXTRACTION_VERSION })))
  const rows = await database.select({ id: auditObservations.id, observationKey: auditObservations.observationKey, valueText: auditObservations.valueText, evidenceQuote: auditObservations.evidenceQuote, sourceUrl: auditPages.sourceUrl }).from(auditObservations).innerJoin(auditPages, eq(auditObservations.auditPageId, auditPages.id)).where(eq(auditObservations.auditRunId, auditRunId))
  const assessments = classifyJourneyFriction(rows as ClassifiableObservation[], workspace.language)
  for (const assessment of assessments) {
    const evidence = await database.insert(auditEvidenceLedger).values({ auditRunId, stage: 'classification', claimKey: `friction.${assessment.journeyStage}`, claimValue: assessment.summary, provenance: 'inferred', observationIds: assessment.observationIds, confidence: assessment.assessmentStatus === 'supported' ? 65 : 0 })
    await database.insert(frictionAssessments).values({ auditRunId, journeyStage: assessment.journeyStage, priorityRank: assessment.priorityRank, score: assessment.score.toFixed(2), assessmentStatus: assessment.assessmentStatus, summary: assessment.summary, evidenceLedgerIds: [Number(evidence[0].insertId)], classifierVersion: CLASSIFIER_VERSION, requiresHumanReview: true })
  }
  return {
    auditRunId,
    status: 'completed' as const,
    assessmentCount: assessments.length,
    assessments: assessments.map(item => ({ journeyStage: item.journeyStage, priorityRank: item.priorityRank, score: item.score, assessmentStatus: item.assessmentStatus, summary: item.summary, requiresHumanReview: item.requiresHumanReview })),
    notice: 'Manual structural signals were assessed. Every output requires strategist review; no conversion performance was inferred.',
  }
}
