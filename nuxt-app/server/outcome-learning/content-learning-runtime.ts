import { buildOutcomeDatasetManifest, buildOutcomeLearningCandidate } from './engine'
import { OUTCOME_DATA_CONTRACT_VERSION, OUTCOME_MAX_DATASET_CANDIDATES } from './policy-catalog'
import type { OutcomeLearningCandidate, OutcomeLearningCandidateResult, OutcomeDatasetManifest } from './types'
import { outcomeSha256 } from './normalization'

const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\b(?:\+?\d[\d .()\-]{7,}\d)\b/u,
  /\b(?:ssn|social security|passport|credit card|api[_ -]?key|access[_ -]?token|password)\b/iu,
]

export type LearningPiiScan = { status: 'none_detected' | 'detected' | 'unknown', reasonCode?: 'PII_PATTERN_DETECTED' | 'PAYLOAD_TOO_LARGE' | 'UNSERIALIZABLE_PAYLOAD' }
export type ContentLearningDatasetResult = {
  status: 'ready_for_dataset_review' | 'gate_blocked'
  candidateResults: OutcomeLearningCandidateResult[]
  eligibleCandidates: OutcomeLearningCandidate[]
  manifest: OutcomeDatasetManifest
  piiScans: LearningPiiScan[]
  datasetDigest: string
  limitations: readonly string[]
}

export function scanOutcomeLearningPii(value: unknown): LearningPiiScan {
  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string' || serialized.length > 500_000) return { status: 'unknown', reasonCode: 'PAYLOAD_TOO_LARGE' }
    const scanText = serialized.replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu, '<timestamp>')
    if (PII_PATTERNS.some(pattern => pattern.test(scanText))) return { status: 'detected', reasonCode: 'PII_PATTERN_DETECTED' }
    return { status: 'none_detected' }
  } catch {
    return { status: 'unknown', reasonCode: 'UNSERIALIZABLE_PAYLOAD' }
  }
}

function blockedManifest(reasonCode: string): OutcomeDatasetManifest {
  const result = buildOutcomeDatasetManifest({ candidates: [] })
  return { ...result, reasonCodes: [...new Set([...result.reasonCodes, reasonCode])].sort(), manifestFingerprint: outcomeSha256({ ...result, reasonCodes: [...new Set([...result.reasonCodes, reasonCode])].sort() }) }
}

export function buildContentLearningDataset(input: {
  records: Array<{ outcomeRequest: unknown, assessment: unknown, consent: unknown, piiScanStatus?: 'none_detected' | 'detected' | 'unknown' }>
  candidateLimit?: number
}): ContentLearningDatasetResult {
  const limit = Math.min(input.candidateLimit ?? OUTCOME_MAX_DATASET_CANDIDATES, OUTCOME_MAX_DATASET_CANDIDATES)
  const records = input.records.slice(0, limit)
  const piiScans = records.map(record => record.piiScanStatus ? { status: record.piiScanStatus } : scanOutcomeLearningPii({ outcomeRequest: record.outcomeRequest, assessment: record.assessment, consent: record.consent }))
  const candidateResults = records.map((record, index) => buildOutcomeLearningCandidate({ outcomeRequest: record.outcomeRequest, assessment: record.assessment, consent: record.consent, piiScanStatus: piiScans[index]!.status, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }))
  const eligibleCandidates = candidateResults.filter((candidate): candidate is OutcomeLearningCandidate => candidate.candidateStatus === 'eligible')
  const manifest = input.records.length > limit ? blockedManifest('TOO_MANY_DATASET_CANDIDATES') : buildOutcomeDatasetManifest({ candidates: eligibleCandidates })
  const datasetDigest = outcomeSha256({ manifestFingerprint: manifest.manifestFingerprint, candidateFingerprints: eligibleCandidates.map(candidate => candidate.candidateFingerprint).sort(), policy: 'secondary_hash_only_dataset_review_v1' })
  return { status: manifest.status, candidateResults, eligibleCandidates, manifest, piiScans, datasetDigest, limitations: [...manifest.limitations, 'This runtime creates a dataset review artifact only; it does not submit, train, promote, or upload a model.', 'Provider API observations remain excluded from this outcome-learning candidate path unless separately owner-reviewed and admitted by the outcome contract.'] }
}
