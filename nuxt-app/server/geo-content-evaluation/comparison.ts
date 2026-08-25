import {
  canonicalizeQualityValue,
  codeUnitCompare,
  sha256Text,
} from '../geo-content-quality'
import { computeEvaluationFingerprint } from './canonical'
import { aggregateEvaluationMetrics, metricByName } from './metrics'
import {
  EVALUATION_METRIC_NAMES,
  EVALUATION_SUITE_VERSION,
  type EvaluationMetric,
  type EvaluationMetricComparison,
  type EvaluationReasonCode,
  type GeoContentCandidateComparison,
  type GeoContentEvaluationCase,
  type GeoContentRegressionReport,
} from './types'

const HIGHER_IS_BETTER = new Set(['unused-citation-count', 'unsupported-factual-claim-findings'])

function uniqueReasons(values: readonly EvaluationReasonCode[]): EvaluationReasonCode[] {
  return [...new Set(values)]
}

function baseline(value: GeoContentEvaluationCase): unknown {
  return {
    suiteVersion: value.suiteVersion,
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
  return left.applicable && right.applicable && left.denominator > 0 && right.denominator > 0
}

function compareMetric(left: EvaluationMetric, right: EvaluationMetric): EvaluationMetricComparison {
  const direction = HIGHER_IS_BETTER.has(left.metricName) ? 'lower_is_better' : 'higher_is_better'
  if (!metricComparable(left, right)) {
    return { metricName: left.metricName, direction, left, right, winner: 'not_comparable' }
  }

  const leftRatio = left.ratio
  const rightRatio = right.ratio
  if (leftRatio === null || rightRatio === null) {
    return { metricName: left.metricName, direction, left, right, winner: 'not_comparable' }
  }
  if (leftRatio === rightRatio) {
    return { metricName: left.metricName, direction, left, right, winner: 'tie' }
  }
  const leftWins = direction === 'higher_is_better' ? leftRatio > rightRatio : leftRatio < rightRatio
  return { metricName: left.metricName, direction, left, right, winner: leftWins ? 'left' : 'right' }
}

function insufficientStatus(left: GeoContentEvaluationCase, right: GeoContentEvaluationCase): 'blocked' | 'insufficient_data' {
  return left.status === 'blocked' || right.status === 'blocked' ? 'blocked' : 'insufficient_data'
}

export function compareGeoContentCandidates(left: unknown, right: unknown): GeoContentCandidateComparison {
  if (!isEvaluationCase(left) || !isEvaluationCase(right)) {
    return {
      status: 'blocked',
      baselineCompatible: false,
      leftCandidateId: isEvaluationCase(left) ? left.candidateId : '',
      rightCandidateId: isEvaluationCase(right) ? right.candidateId : '',
      winnerCandidateId: null,
      decision: 'blocked',
      metricComparisons: [],
      reasonCodes: ['EVALUATION_INVALID_INPUT'],
      limitations: ['Comparison requires server-created evaluation cases; no winner is computed for malformed input.'],
    }
  }

  const leftFingerprint = computeEvaluationFingerprint(baseline(left))
  const rightFingerprint = computeEvaluationFingerprint(baseline(right))
  const baselineCompatible = leftFingerprint.status === 'valid'
    && rightFingerprint.status === 'valid'
    && leftFingerprint.fingerprint === rightFingerprint.fingerprint

  if (!baselineCompatible) {
    return {
      status: 'blocked',
      baselineCompatible: false,
      leftCandidateId: left.candidateId,
      rightCandidateId: right.candidateId,
      winnerCandidateId: null,
      decision: 'blocked',
      metricComparisons: [],
      reasonCodes: ['EVALUATION_BASELINE_MISMATCH'],
      limitations: ['Candidates with different brief, prompt, retrieval, evidence, rules, locale, topic, content type, or suite context are not comparable.'],
    }
  }

  if (left.status !== 'review_ready' || right.status !== 'review_ready') {
    const status = insufficientStatus(left, right)
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
      ]),
      limitations: ['A blocked or insufficient-data candidate cannot be selected as a comparison winner.'],
    }
  }

  const metricComparisons = EVALUATION_METRIC_NAMES.map(metricName => compareMetric(metricByName(left, metricName), metricByName(right, metricName)))
  const leftWins = metricComparisons.filter(comparison => comparison.winner === 'left').length
  const rightWins = metricComparisons.filter(comparison => comparison.winner === 'right').length
  const decision = leftWins === rightWins ? 'tie' : leftWins > rightWins ? 'left' : 'right'
  return {
    status: 'review_ready',
    baselineCompatible: true,
    leftCandidateId: left.candidateId,
    rightCandidateId: right.candidateId,
    winnerCandidateId: decision === 'left' ? left.candidateId : decision === 'right' ? right.candidateId : null,
    decision,
    metricComparisons,
    reasonCodes: [],
    limitations: ['Metric comparisons are deterministic heuristic comparisons, not truth, ranking, traffic, conversion, revenue, or publication signals.'],
  }
}

export function buildGeoContentRegressionReport(values: unknown): GeoContentRegressionReport {
  if (!Array.isArray(values)) {
    return emptyReport(['EVALUATION_INVALID_INPUT'])
  }

  const cases = values.filter(isEvaluationCase).sort(stableCaseCompare)
  if (cases.length !== values.length) {
    return emptyReport(['EVALUATION_INVALID_INPUT', 'EVALUATION_UNKNOWN_FIELD'])
  }
  if (cases.length === 0) {
    return emptyReport(['EVALUATION_DATA_INSUFFICIENT'])
  }

  const reviewReadyCount = cases.filter(value => value.status === 'review_ready').length
  const blockedCount = cases.filter(value => value.status === 'blocked').length
  const insufficientDataCount = cases.filter(value => value.status === 'insufficient_data').length
  const status = blockedCount > 0 ? 'blocked' : insufficientDataCount > 0 ? 'insufficient_data' : 'review_ready'
  const metricAggregates = aggregateEvaluationMetrics(cases)
  const fingerprintPayload = {
    suiteVersion: EVALUATION_SUITE_VERSION,
    cases: cases.map(value => ({
      caseId: value.caseId,
      candidateId: value.candidateId,
      variantLabel: value.variantLabel,
      status: value.status,
      reasonCodes: value.reasonCodes,
      metrics: value.metrics,
    })),
    metricAggregates,
  }
  const regressionFingerprint = (() => {
    try {
      return sha256Text(canonicalizeQualityValue(fingerprintPayload))
    } catch {
      return null
    }
  })()
  const reasonCodes = uniqueReasons(cases.flatMap(value => value.reasonCodes))
  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    status,
    caseCount: cases.length,
    reviewReadyCount,
    blockedCount,
    insufficientDataCount,
    cases: cases.map(value => ({ caseId: value.caseId, candidateId: value.candidateId, variantLabel: value.variantLabel, status: value.status, reasonCodes: value.reasonCodes, metrics: value.metrics })),
    metricAggregates,
    regressionFingerprint,
    reasonCodes,
    limitations: ['This regression report is for human review and deterministic contract regression only; it is not a publication approval or factual truth score.'],
  }
}

function isEvaluationCase(value: unknown): value is GeoContentEvaluationCase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<GeoContentEvaluationCase>
  return candidate.suiteVersion === EVALUATION_SUITE_VERSION
    && typeof candidate.caseId === 'string'
    && typeof candidate.candidateId === 'string'
    && typeof candidate.variantLabel === 'string'
    && (candidate.status === 'review_ready' || candidate.status === 'blocked' || candidate.status === 'insufficient_data')
    && Array.isArray(candidate.metrics)
}

function emptyReport(reasonCodes: EvaluationReasonCode[]): GeoContentRegressionReport {
  return {
    suiteVersion: EVALUATION_SUITE_VERSION,
    status: reasonCodes.includes('EVALUATION_DATA_INSUFFICIENT') ? 'insufficient_data' : 'blocked',
    caseCount: 0,
    reviewReadyCount: 0,
    blockedCount: reasonCodes.includes('EVALUATION_DATA_INSUFFICIENT') ? 0 : 1,
    insufficientDataCount: reasonCodes.includes('EVALUATION_DATA_INSUFFICIENT') ? 1 : 0,
    cases: [],
    metricAggregates: aggregateEvaluationMetrics([]),
    regressionFingerprint: null,
    reasonCodes: uniqueReasons(reasonCodes),
    limitations: ['No valid evaluation cases were available; no metric summary or winner is produced.'],
  }
}
