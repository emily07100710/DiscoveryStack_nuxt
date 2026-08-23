import { createError } from 'h3'
import { analysePublicHomepage } from '../utils/publicSiteAnalysis'
import { optimiseGeoDocument } from '../geo/optimise'
import type { GeoDocumentInput } from '../geo/contracts'
import { createDeterministicDiagnosis } from './diagnosis'
import { contentFingerprint, evaluateContentRisk } from './riskGate'
import {
  createContentJob,
  getOwnerContentBrief,
  saveContentCandidate,
  saveDiagnosis,
  saveRiskGate,
  transitionContentJob,
} from './repository'

export async function runOwnerPublicDiagnosis(input: { ownerUserId: number, homepageUrl: string, sourceId?: number, auditRunId?: number }) {
  const analysis = await analysePublicHomepage(input.homepageUrl)
  const diagnosis = createDeterministicDiagnosis(analysis, input.sourceId)
  const stored = await saveDiagnosis({ ownerUserId: input.ownerUserId, sourceId: input.sourceId, auditRunId: input.auditRunId, diagnosis })
  return { diagnosisId: stored.id, diagnosis, analysis: { finalUrl: analysis.finalUrl, snapshotFingerprint: analysis.snapshotFingerprint, analysisVersion: analysis.analysisVersion } }
}

/**
 * Executes one foreground owner-requested candidate generation. This is intentionally
 * not a background queue and never performs a delivery request. Autoscale retries are
 * represented as separate idempotent requests in the persisted job ledger.
 */
export async function runOwnerAutoGeoContentJob(input: { ownerUserId: number, briefId: number, document: GeoDocumentInput, idempotencyKey: string }) {
  const brief = await getOwnerContentBrief(input.ownerUserId, input.briefId)
  if (brief.language !== input.document.language) throw createError({ statusCode: 422, statusMessage: 'Document language must match the approved Content Brief.' })
  const job = await createContentJob({ ownerUserId: input.ownerUserId, briefId: brief.id, operation: 'autogeo_recommendation', providerMode: 'autogeo_bailian_qwen', idempotencyKey: input.idempotencyKey })
  if (job.status === 'candidate_ready' || job.status === 'needs_human_review' || job.status === 'approved' || job.status === 'blocked') return { job, replayed: true }
  await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'processing' })
  try {
    const result = await optimiseGeoDocument(input.document)
    const candidate = result.candidate
    const riskGate = evaluateContentRisk({ source: result.original, candidateTitle: candidate.optimizedTitle, candidateBody: candidate.optimizedContent, evidenceCount: Array.isArray(brief.evidenceRefs) ? brief.evidenceRefs.length : 0 })
    const draft = await saveContentCandidate({
      jobId: job.id,
      title: candidate.optimizedTitle,
      body: candidate.optimizedContent,
      contentHash: contentFingerprint(candidate.optimizedTitle, candidate.optimizedContent),
      sourceMode: candidate.provider === 'reference-rules-v1' ? 'reference_fallback' : 'provider_candidate',
      provenance: { provider: candidate.provider, providerVersion: candidate.providerVersion, provenance: candidate.provenance, rulesetVersion: result.rulesetVersion, workbenchVersion: result.version },
      evidenceRefs: Array.isArray(brief.evidenceRefs) ? brief.evidenceRefs : [],
      safetyStatus: riskGate.status === 'blocked' ? 'blocked' : riskGate.status === 'needs_human_review' ? 'needs_review' : 'passed',
      safetyNotes: candidate.safetyNotes,
    })
    await saveRiskGate({ draftId: draft.id, result: riskGate, evidenceSnapshotHash: brief.evidenceSnapshotHash })
    const finalStatus = riskGate.status === 'blocked' ? 'blocked' : 'needs_human_review'
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: finalStatus, providerProvenance: { provider: candidate.provider, providerVersion: candidate.providerVersion, execution: candidate.provenance.execution, fallbackReason: candidate.provenance.fallbackReason ?? null } })
    return { job: { ...job, status: finalStatus }, result, draft: { id: draft.id, version: draft.version, sourceMode: draft.sourceMode }, riskGate, replayed: false }
  } catch (error) {
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'failed', errorCode: 'candidate_generation_failed', errorSummary: error instanceof Error ? error.message.slice(0, 500) : 'Unknown candidate generation error' })
    throw error
  }
}
