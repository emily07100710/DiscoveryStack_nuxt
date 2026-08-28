import { stableFingerprint } from './normalization'

export const GEO_CONTENT_QUALITY_EVALUATION_VERSION = 'geo-content-quality-evaluation-v1' as const

export function evaluateCanonicalGeoContentQuality(input: { content: string; contentHash: string; evidenceSnapshotHash: string; riskGateStatus: string | null; riskGateVersion: string | null; riskFindings: unknown[]; entityProfileFingerprint: string | null; queryOwnershipFingerprint: string | null }) {
  const normalized = input.content.normalize('NFKC').trim()
  const metrics = {
    characterCount: normalized.length,
    hasHeading: /^#{1,3}\s+\S+/mu.test(normalized),
    hasDirectAnswer: normalized.replace(/^#{1,3}[^\n]*\n*/u, '').trim().length >= 80,
    evidenceAuthorityBound: /^[a-f0-9]{64}$/u.test(input.evidenceSnapshotHash),
    entityAuthorityBound: Boolean(input.entityProfileFingerprint),
    queryAuthorityBound: Boolean(input.queryOwnershipFingerprint),
  }
  const reasonCodes = [
    ...(input.riskGateStatus === 'passed' ? [] : ['RISK_GATE_NOT_PASSED']),
    ...(metrics.evidenceAuthorityBound ? [] : ['EVIDENCE_AUTHORITY_MISSING']),
    ...(metrics.entityAuthorityBound ? [] : ['ENTITY_AUTHORITY_MISSING']),
    ...(metrics.queryAuthorityBound ? [] : ['QUERY_AUTHORITY_MISSING']),
  ]
  const base = { evaluationVersion: GEO_CONTENT_QUALITY_EVALUATION_VERSION, status: reasonCodes.length ? 'needs_repair' as const : 'passed' as const, reasonCodes, metrics, contentHash: input.contentHash, evidenceSnapshotHash: input.evidenceSnapshotHash, riskGateVersion: input.riskGateVersion, riskFindingsFingerprint: stableFingerprint(input.riskFindings) }
  return { ...base, evaluationFingerprint: stableFingerprint(base) }
}
