import { normalizeApprovedEvidenceChunk, normalizeRetrievalPlan, normalizeSha256, codeUnitCompare, NormalizationIssue, isRecord, readField, hasExactKeys } from './normalization'
import { RETRIEVAL_VERSION, type ApprovedEvidenceChunk, type RetrievalCandidate, type RetrievalResult } from './types'
import type { ReasonCode } from './reason-codes'

const CANDIDATE_KEYS = ['chunk', 'scoreBasis', 'limitations'] as const

function blocked(reasonCode: ReasonCode): RetrievalResult {
  return { status: 'blocked', retrievalVersion: RETRIEVAL_VERSION, corpusSnapshotHash: '', evidenceSnapshotHash: '', chunks: [], reasonCodes: [reasonCode], limitations: ['Retrieval contract rejected the supplied shape; no fallback context was created.'] }
}

function normalizeCandidate(value: unknown, planEvidenceSnapshotHash: string): RetrievalCandidate {
  if (!hasExactKeys(value, CANDIDATE_KEYS)) throw new NormalizationIssue('UNKNOWN_FIELD')
  const chunk = normalizeApprovedEvidenceChunk(readField(value, 'chunk'), planEvidenceSnapshotHash)
  const scoreBasis = readField(value, 'scoreBasis')
  if (typeof scoreBasis !== 'string' || !scoreBasis || scoreBasis.length > 500 || /truth\s*score|ranking\s*score/iu.test(scoreBasis)) throw new NormalizationIssue('INVALID_INPUT')
  const limitations = readField(value, 'limitations')
  if (!Array.isArray(limitations) || limitations.length > 10 || limitations.some(item => typeof item !== 'string' || item.length > 500)) throw new NormalizationIssue('INVALID_INPUT')
  return { chunk, scoreBasis, limitations: [...limitations] }
}

export function buildRetrievalResult(planValue: unknown, candidateValues: unknown): RetrievalResult {
  try {
    const plan = normalizeRetrievalPlan(planValue)
    if (!Array.isArray(candidateValues)) return blocked('INVALID_INPUT')
    const candidates = candidateValues.map(value => normalizeCandidate(value, plan.evidenceSnapshotHash))
    const allowedSourceIds = new Set(plan.allowedSourceIds)
    const allowedArtifactIds = new Set(plan.allowedArtifactIds)
    const seen = new Set<string>()
    const chunks = candidates.map(candidate => {
      const chunk = candidate.chunk
      const identity = `${chunk.sourceId}|${chunk.artifactId}|${chunk.chunkId}`
      if (!allowedSourceIds.has(chunk.sourceId) || !allowedArtifactIds.has(chunk.artifactId)) throw new NormalizationIssue('RETRIEVAL_OUTSIDE_ALLOWLIST')
      if (chunk.corpusSnapshotHash !== plan.corpusSnapshotHash) throw new NormalizationIssue('RETRIEVAL_CORPUS_MISMATCH')
      if (chunk.evidenceSnapshotHash !== plan.evidenceSnapshotHash) throw new NormalizationIssue('EVIDENCE_SNAPSHOT_MISMATCH')
      if (seen.has(identity)) throw new NormalizationIssue('DUPLICATE_EVIDENCE')
      seen.add(identity)
      if (plan.requiredPurposes.some(purpose => !chunk.approvedPurposes.includes(purpose))) throw new NormalizationIssue('EVIDENCE_PURPOSE_NOT_ALLOWED')
      return { ...chunk, scoreBasis: candidate.scoreBasis, limitations: candidate.limitations }
    }).sort((left, right) => codeUnitCompare(`${left.sourceId}|${left.artifactId}|${left.chunkId}`, `${right.sourceId}|${right.artifactId}|${right.chunkId}`))
    if (chunks.length === 0) return { status: 'not_ready', retrievalVersion: RETRIEVAL_VERSION, corpusSnapshotHash: plan.corpusSnapshotHash, evidenceSnapshotHash: plan.evidenceSnapshotHash, chunks: [], reasonCodes: ['RETRIEVAL_NOT_READY'], limitations: ['No approved evidence chunk satisfied the retrieval contract; no generic fallback was used.'] }
    return { status: 'ready', retrievalVersion: RETRIEVAL_VERSION, corpusSnapshotHash: plan.corpusSnapshotHash, evidenceSnapshotHash: plan.evidenceSnapshotHash, chunks: chunks.slice(0, plan.topK), reasonCodes: [], limitations: ['scoreBasis is a retrieval heuristic label, not an evidence-veracity measure and not comparable across providers.'] }
  } catch (error: unknown) {
    if (error instanceof NormalizationIssue) return blocked(error.reasonCode)
    return blocked('INVALID_INPUT')
  }
}

export function isRetrievalResult(value: unknown): value is RetrievalResult {
  if (!isRecord(value)) return false
  try {
    const status = readField(value, 'status')
    return status === 'ready' || status === 'not_ready' || status === 'blocked'
  } catch {
    return false
  }
}

export function retrievalPlanSnapshotHash(value: unknown): string | null {
  try { return normalizeSha256(readField(normalizeRetrievalPlan(value), 'evidenceSnapshotHash')) } catch { return null }
}
