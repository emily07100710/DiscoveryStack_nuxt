import { createError } from 'h3'
import { analysePublicHomepage } from '../utils/publicSiteAnalysis'
import { createAutoGeoApiAdapter } from '../geo/autogeo-api'
import { optimiseGeoDocument, referenceRulesAdapter } from '../geo/optimise'
import type { GeoDocumentInput } from '../geo/contracts'
import type { EvidenceRef } from './contracts'
import { createDeterministicDiagnosis } from './diagnosis'
import { contentFingerprint, evaluateContentRisk } from './riskGate'
import {
  createContentJob,
  getOwnerContentBrief,
  getOwnerContentJob,
  resolveApprovedEvidenceSnapshot,
  saveContentCandidate,
  saveDiagnosis,
  saveRiskGate,
  transitionContentJob,
} from './repository'

export async function runOwnerPublicDiagnosis(input: { ownerUserId: number, homepageUrl: string, sourceId?: number, auditRunId?: number }) {
  const analysis = await analysePublicHomepage(input.homepageUrl)
  const approvedEvidence = input.sourceId ? await resolveApprovedEvidenceSnapshot(input.ownerUserId, [{ sourceId: input.sourceId, reason: 'Owner supplied source for diagnosis' }], 'diagnosis', { requireArtifact: false }) : { refs: [], context: '', hash: '' }
  const diagnosis = createDeterministicDiagnosis(analysis, input.sourceId, approvedEvidence.refs)
  const stored = await saveDiagnosis({ ownerUserId: input.ownerUserId, sourceId: input.sourceId, auditRunId: input.auditRunId, diagnosis })
  return { diagnosisId: stored.id, diagnosis, analysis: { finalUrl: analysis.finalUrl, snapshotFingerprint: analysis.snapshotFingerprint, analysisVersion: analysis.analysisVersion } }
}

/**
 * Executes one foreground owner-requested candidate generation. This is intentionally
 * not a background queue and never performs a delivery request. Autoscale retries are
 * represented as separate idempotent requests in the persisted job ledger.
 */
export async function runOwnerAutoGeoContentJob(input: { ownerUserId: number, briefId: number, document: GeoDocumentInput, idempotencyKey: string, jobId?: number }) {
  const brief = await getOwnerContentBrief(input.ownerUserId, input.briefId)
  if (brief.status !== 'ready_for_generation') throw createError({ statusCode: 422, statusMessage: 'Content Brief is not ready for generation.' })
  if (brief.language !== input.document.language) throw createError({ statusCode: 422, statusMessage: 'Document language must match the approved Content Brief.' })
  const briefEvidenceRefs = Array.isArray(brief.evidenceRefs) ? brief.evidenceRefs as EvidenceRef[] : []
  const approvedEvidence = await resolveApprovedEvidenceSnapshot(input.ownerUserId, briefEvidenceRefs, ['recommendation', 'content_draft'], { requireArtifact: true })
  if (approvedEvidence.hash !== brief.evidenceSnapshotHash) throw createError({ statusCode: 409, statusMessage: 'Content Brief evidence snapshot is stale; create a new Brief before generating.' })
  const approvedBriefGoals = Array.isArray(brief.goals) ? brief.goals.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
  const approvedBriefConstraints = Array.isArray(brief.constraints) ? brief.constraints.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
  const document = { ...input.document, approvedEvidenceContext: approvedEvidence.context, approvedBriefGoals, approvedBriefConstraints }
  const job = input.jobId
    ? await getOwnerContentJob(input.ownerUserId, input.jobId)
    : await createContentJob({ ownerUserId: input.ownerUserId, briefId: brief.id, operation: 'autogeo_recommendation', providerMode: 'autogeo_bailian_qwen', idempotencyKey: input.idempotencyKey })
  if (job.briefId !== brief.id || job.operation !== 'autogeo_recommendation') throw createError({ statusCode: 422, statusMessage: 'Job must belong to this Brief and use the AutoGEO recommendation operation.' })
  if (input.jobId && job.idempotencyKey !== input.idempotencyKey) throw createError({ statusCode: 409, statusMessage: 'The supplied idempotency key does not match this content job.' })
  if (job.providerMode === 'manual') throw createError({ statusCode: 422, statusMessage: 'Manual jobs require a separately submitted draft and cannot run AutoGEO generation.' })
  if (job.status === 'candidate_ready' || job.status === 'needs_human_review' || job.status === 'approved' || job.status === 'blocked') return { job, replayed: true }
  if (job.status !== 'queued') throw createError({ statusCode: 409, statusMessage: `Content job is not executable from status ${job.status}.` })
  await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'processing' })
  try {
    const result = await optimiseGeoDocument(document, job.providerMode === 'reference_rules' ? referenceRulesAdapter : job.providerMode === 'autogeo_api' ? createAutoGeoApiAdapter() : undefined)
    const candidate = result.candidate
    const riskGate = evaluateContentRisk({ source: result.original, candidateTitle: candidate.optimizedTitle, candidateBody: candidate.optimizedContent, evidenceCount: approvedEvidence.refs.length })
    const draft = await saveContentCandidate({
      jobId: job.id,
      title: candidate.optimizedTitle,
      body: candidate.optimizedContent,
      contentHash: contentFingerprint(candidate.optimizedTitle, candidate.optimizedContent),
      sourceMode: candidate.provider === 'reference-rules-v1' ? 'reference_fallback' : 'provider_candidate',
      provenance: { provider: candidate.provider, providerVersion: candidate.providerVersion, provenance: candidate.provenance, rulesetVersion: result.rulesetVersion, workbenchVersion: result.version },
      evidenceRefs: approvedEvidence.refs,
      safetyStatus: riskGate.status === 'blocked' ? 'blocked' : riskGate.status === 'needs_human_review' ? 'needs_review' : 'passed',
      safetyNotes: candidate.safetyNotes,
    })
    await saveRiskGate({ draftId: draft.id, result: riskGate, evidenceSnapshotHash: approvedEvidence.hash })
    const finalStatus = riskGate.status === 'blocked' ? 'blocked' : 'needs_human_review'
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: finalStatus, providerProvenance: { provider: candidate.provider, providerVersion: candidate.providerVersion, execution: candidate.provenance.execution, fallbackReason: candidate.provenance.fallbackReason ?? null } })
    return { job: { ...job, status: finalStatus }, result, draft: { id: draft.id, version: draft.version, sourceMode: draft.sourceMode }, riskGate, replayed: false }
  } catch (error) {
    await transitionContentJob({ ownerUserId: input.ownerUserId, jobId: job.id, to: 'failed', errorCode: 'candidate_generation_failed', errorSummary: error instanceof Error ? error.message.slice(0, 500) : 'Unknown candidate generation error' })
    throw error
  }
}
