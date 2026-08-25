import {
  canonicalizeQualityValue,
  codeUnitCompare,
  sha256Text,
} from '../geo-content-quality'
import {
  computeEvaluationFingerprint,
  createGeoContentEvaluationCase,
  createGeoContentEvaluationCaseWithCache,
  evaluationCaseFingerprint,
  type CanonicalEvaluationCache,
} from './canonical'
import { aggregateEvaluationMetrics, isValidApplicableMetric, metricByName } from './metrics'
import { rawCandidateIdentityTuple, validateRawCandidateEnvelope, type NormalizedRawCandidateEnvelope } from './raw-candidate'
import {
  EVALUATION_METRIC_NAMES,
  EVALUATION_SUITE_VERSION,
  type EvaluationMetric,
  type EvaluationMetricComparison,
  type EvaluationReasonCode,
  type GeoContentCandidateComparison,
  type GeoContentEvaluationCase,
  type GeoContentRegressionCase,
  type GeoContentRegressionReport,
} from './types'

const LOWER_IS_BETTER = new Set(['unused-citation-count', 'unsupported-factual-claim-findings'])
const GOVERNANCE_METRICS = new Set(['provider-provenance-integrity', 'human-review-requirement'])
const MAX_REPORT_CASES = 500

function uniqueReasons(values: readonly EvaluationReasonCode[]): EvaluationReasonCode[] {
  return [...new Set(values)]
}

function baseline(value: GeoContentEvaluationCase): unknown {
  return {
    suiteVersion: value.suiteVersion,
    caseId: value.caseId,
    contentType: value.contentType,
    locale: value.locale,
    topic: value.topic,
    briefFingerprint: value.briefFingerprint,
    promptPackFingerprint: value.promptPackFingerprint,
    retrievalFingerprint: value.retrievalFingerprint,
    evidenceSnapshotHash: value.evidenceSnapshotHash,
    selectedRuleIds: value.selectedRuleIds,
  }
}

function stableCaseCompare(left: GeoContentEvaluationCase, right: GeoContentEvaluationCase): number {
  for (const [leftValue, rightValue] of [
    [left.caseId, right.caseId],
    [left.candidateId, right.candidateId],
    [left.variantLabel, right.variantLabel],
  ] as const) {
    const comparison = codeUnitCompare(leftValue, rightValue)
    if (comparison !== 0) return comparison
  }
  return 0
}

function metricComparable(left: EvaluationMetric, right: EvaluationMetric): boolean {
  return isValidApplicableMetric(left) && isValidApplicableMetric(right)
}

function metricDirection(metricName: EvaluationMetric['metricName']): 'higher_is_better' | 'lower_is_better' {
  return LOWER_IS_BETTER.has(metricName) ? 'lower_is_better' : 'higher_is_better'
}

function compareMetric(left: EvaluationMetric, right: EvaluationMetric): EvaluationMetricComparison {
  const direction = metricDirection(left.metricName)
  if (GOVERNANCE_METRICS.has(left.metricName) || !metricComparable(left, right) || left.ratio === null || right.ratio === null) {
    return { metricName: left.metricName, direction, left, right, winner: 'not_comparable' }
  }
  const leftRatio = left.ratio
  const rightRatio = right.ratio
  if (leftRatio === rightRatio) return { metricName: left.metricName, direction, left, right, winner: 'tie' }
  const leftWins = direction === 'higher_is_better' ? leftRatio > rightRatio : leftRatio < rightRatio
  return { metricName: left.metricName, direction, left, right, winner: leftWins ? 'left' : 'right' }
}

function statusForCases(left: GeoContentEvaluationCase, right: GeoContentEvaluationCase): 'blocked' | 'insufficient_data' {
  return left.status === 'blocked' || right.status === 'blocked' ? 'blocked' : 'insufficient_data'
}

function invalidComparison(leftCandidateId: string, rightCandidateId: string, reasonCodes: EvaluationReasonCode[]): GeoContentCandidateComparison {
  return {
    status: 'blocked',
    baselineCompatible: false,
    leftCandidateId,
    rightCandidateId,
    winnerCandidateId: null,
    decision: 'blocked',
    metricComparisons: [],
    reasonCodes: uniqueReasons(reasonCodes),
    limitations: ['Comparison requires exact raw candidate envelopes, unique candidate identities, and server-side re-evaluation; no winner is computed for malformed or output-only input.'],
  }
}

function normalizedRaw(value: unknown): { value: NormalizedRawCandidateEnvelope } | { reasonCodes: EvaluationReasonCode[], caseId: string, candidateId: string, variantLabel: string } {
  const result = validateRawCandidateEnvelope(value)
  if (result.status === 'valid') return { value: result.value }
  return { reasonCodes: result.reasonCodes, caseId: result.caseId, candidateId: result.candidateId, variantLabel: result.variantLabel }
}

export function compareGeoContentCandidates(leftInput: unknown, rightInput: unknown): GeoContentCandidateComparison {
  try {
    const leftRaw = normalizedRaw(leftInput)
    const rightRaw = normalizedRaw(rightInput)
    if (!('value' in leftRaw) || !('value' in rightRaw)) {
      return invalidComparison('value' in leftRaw ? leftRaw.value.candidateId : leftRaw.candidateId, 'value' in rightRaw ? rightRaw.value.candidateId : rightRaw.candidateId, uniqueReasons([
        ...('value' in leftRaw ? [] : leftRaw.reasonCodes),
        ...('value' in rightRaw ? [] : rightRaw.reasonCodes),
      ]))
    }

    const left = createGeoContentEvaluationCase(leftRaw.value)
    const right = createGeoContentEvaluationCase(rightRaw.value)
    if (left.caseId === right.caseId && left.candidateId === right.candidateId) {
      return invalidComparison(left.candidateId, right.candidateId, ['EVALUATION_DUPLICATE_COMPARISON_IDENTITY'])
    }

    const leftFingerprint = computeEvaluationFingerprint(baseline(left))
    const rightFingerprint = computeEvaluationFingerprint(baseline(right))
    const baselineCompatible = leftFingerprint.status === 'valid'
      && rightFingerprint.status === 'valid'
      && leftFingerprint.fingerprint === rightFingerprint.fingerprint

    if (!baselineCompatible) return invalidComparison(left.candidateId, right.candidateId, ['EVALUATION_BASELINE_MISMATCH'])
    if (left.status !== 'review_ready' || right.status !== 'review_ready') {
      const status = statusForCases(left, right)
      return {
        status,
        baselineCompatible: true,
        leftCandidateId: left.candidateId,
        rightCandidateId: right.candidateId,
        winnerCandidateId: null,
        decision: status,
        metricComparisons: [],
        reasonCodes: uniqueReasons([
          ...(left.status === 'blocked' ? ['EVALUATION_CASE_BLOCKED' as const] : []),
          ...(right.status === 'blocked' ? ['EVALUATION_CASE_BLOCKED' as const] : []),
          ...(left.status === 'insufficient_data' || right.status === 'insufficient_data' ? ['EVALUATION_DATA_INSUFFICIENT' as const] : []),
          ...left.reasonCodes,
          ...right.reasonCodes,
        ]),
        limitations: ['A blocked or insufficient-data candidate cannot be selected as a comparison winner.'],
      }
    }

    const metricComparisons = EVALUATION_METRIC_NAMES.map(metricName => compareMetric(metricByName(left, metricName), metricByName(right, metricName)))
    const comparable = metricComparisons.filter(comparison => !GOVERNANCE_METRICS.has(comparison.metricName) && comparison.winner !== 'not_comparable')
    if (comparable.length === 0) {
      return {
        status: 'insufficient_data',
        baselineCompatible: true,
        leftCandidateId: left.candidateId,
        rightCandidateId: right.candidateId,
        winnerCandidateId: null,
        decision: 'insufficient_data',
        metricComparisons,
        reasonCodes: ['EVALUATION_METRIC_NOT_COMPARABLE'],
        limitations: ['No positive content metrics were comparable; governance metrics never select a content winner.'],
      }
    }

    const leftBetter = comparable.some(comparison => comparison.winner === 'left')
    const rightBetter = comparable.some(comparison => comparison.winner === 'right')
    const decision = leftBetter && !rightBetter
      ? 'left'
      : rightBetter && !leftBetter
        ? 'right'
        : leftBetter || rightBetter
          ? 'inconclusive'
          : 'tie'

    return {
      status: 'review_ready',
      baselineCompatible: true,
      leftCandidateId: left.candidateId,
      rightCandidateId: right.candidateId,
      winnerCandidateId: decision === 'left' ? left.candidateId : decision === 'right' ? right.candidateId : null,
      decision,
      metricComparisons,
      reasonCodes: [],
      limitations: ['Pareto dominance compares deterministic heuristic metrics only; provider provenance and human-review governance metrics are excluded from winner selection.'],
    }
  } catch {
    return invalidComparison('', '', ['EVALUATION_INVALID_INPUT'])
  }
}

export function buildGeoContentRegressionReport(values: unknown): GeoContentRegressionReport {
  try {
    if (!Array.isArray(values)) return emptyReport(['EVALUATION_INVALID_INPUT'])
    if (values.length === 0) return emptyReport(['EVALUATION_DATA_INSUFFICIENT'])
    if (values.length > MAX_REPORT_CASES) return emptyReport(['EVALUATION_LIMIT_EXCEEDED'])

    const rawCandidates: NormalizedRawCandidateEnvelope[] = []
    const identities = new Set<string>()
    for (const value of values) {
      const raw = validateRawCandidateEnvelope(value)
      if (raw.status !== 'valid') return emptyReport(raw.reasonCodes)
      const identity = rawCandidateIdentityTuple(raw.value)
      if (identities.has(identity)) return emptyReport(['EVALUATION_DUPLICATE_IDENTITY'])
      identities.add(identity)
      rawCandidates.push(raw.value)
    }

    const cache: CanonicalEvaluationCache = new WeakMap()
    const cases = rawCandidates.map(value => createGeoContentEvaluationCaseWithCache(value, cache)).sort(stableCaseCompare)
    const reviewReadyCount = cases.filter(value => value.status === 'review_ready').length
    const blockedCount = cases.filter(value => value.status === 'blocked').length
    const insufficientDataCount = cases.filter(value => value.status === 'insufficient_data').length
    const status = blockedCount > 0 ? 'blocked' : insufficientDataCount > 0 ? 'insufficient_data' : 'review_ready'
    const metricAggregates = aggregateEvaluationMetrics(cases)
    const reportCases: GeoContentRegressionCase[] = cases.map(value => {
      const fingerprint = evaluationCaseFingerprint(value)
      return {
        caseId: value.caseId,
        candidateId: value.candidateId,
        variantLabel: value.variantLabel,
        status: value.status,
        reasonCodes: value.reasonCodes,
        metrics: value.metrics,
        evaluationFingerprint: fingerprint.status === 'valid' ? fingerprint.fingerprint : null,
      }
    })
    const regressionFingerprint = sha256Text(canonicalizeQualityValue({ suiteVersion: EVALUATION_SUITE_VERSION, cases: reportCases, metricAggregates }))
    return {
      suiteVersion: EVALUATION_SUITE_VERSION,
      status,
      caseCount: cases.length,
      reviewReadyCount,
      blockedCount,
      insufficientDataCount,
      cases: reportCases,
      metricAggregates,
      regressionFingerprint,
      reasonCodes: uniqueReasons(cases.flatMap(value => value.reasonCodes)),
      limitations: ['This regression report is for human review and deterministic contract regression only; it is not a publication approval, cryptographic authenticity proof, or factual truth score.'],
    }
  } catch {
    return emptyReport(['EVALUATION_INVALID_INPUT'])
  }
}

function emptyReport(reasonCodes: EvaluationReasonCode[]): GeoContentRegressionReport {
  const insufficient = reasonCodes.includes('EVALUATION_DATA_INSUFFICIENT')
  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    status: insufficient ? 'insufficient_data' : 'blocked',
    caseCount: 0,
    reviewReadyCount: 0,
    blockedCount: 0,
    insufficientDataCount: 0,
    cases: [],
    metricAggregates: aggregateEvaluationMetrics([]),
    regressionFingerprint: null,
    reasonCodes: uniqueReasons(reasonCodes),
    limitations: ['No valid evaluation cases were available; no metric summary or winner is produced.'],
  }
}
