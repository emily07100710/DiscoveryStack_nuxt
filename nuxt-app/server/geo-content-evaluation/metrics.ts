import type {
  EvaluationMetric,
  EvaluationMetricAggregate,
  EvaluationMetricName,
  EvaluationReasonCode,
  GeoContentEvaluationCase,
} from './types'
import { EVALUATION_METRIC_NAMES } from './types'

export function metricRatio(numerator: number, denominator: number): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0 || numerator < 0 || numerator > denominator) return null
  return numerator / denominator
}

export function makeEvaluationMetric(
  metricName: EvaluationMetricName,
  numerator: number,
  denominator: number,
  reasonCodes: EvaluationReasonCode[] = [],
  evidenceLocator: string[] = [],
): EvaluationMetric {
  const reasons = [...reasonCodes]
  const finite = Number.isFinite(numerator) && Number.isFinite(denominator)
  if (!finite) reasons.push('EVALUATION_NON_FINITE_METRIC')

  const safeIntegers = Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
  const isZeroOverZero = finite && numerator === 0 && denominator === 0
  const valid = finite && safeIntegers && denominator > 0 && numerator >= 0 && numerator <= denominator
  if (!finite) {
    // The non-finite reason is the authoritative invalidity reason.
  } else if (isZeroOverZero) {
    reasons.push('METRIC_NOT_APPLICABLE')
  } else if (!valid) {
    reasons.push('EVALUATION_METRIC_BOUNDS')
  }

  const uniqueReasons = [...new Set(reasons)]
  return {
    metricName,
    applicable: valid,
    numerator: valid ? numerator : 0,
    denominator: valid ? denominator : 0,
    ratio: valid ? numerator / denominator : null,
    reasonCodes: uniqueReasons,
    evidenceLocator: [...new Set(evidenceLocator)],
  }
}

export function emptyEvaluationMetric(metricName: EvaluationMetricName, reasonCode: EvaluationReasonCode = 'METRIC_NOT_APPLICABLE'): EvaluationMetric {
  return makeEvaluationMetric(metricName, 0, 0, [reasonCode], [`metric:${metricName}`])
}

export function isValidApplicableMetric(metric: EvaluationMetric): boolean {
  return metric.applicable === true
    && Number.isSafeInteger(metric.numerator)
    && Number.isSafeInteger(metric.denominator)
    && metric.denominator > 0
    && metric.numerator >= 0
    && metric.numerator <= metric.denominator
    && metric.ratio === metric.numerator / metric.denominator
}

export function metricByName(value: GeoContentEvaluationCase, metricName: EvaluationMetricName): EvaluationMetric {
  return value.metrics.find(metric => metric.metricName === metricName) ?? emptyEvaluationMetric(metricName)
}

export function aggregateEvaluationMetrics(cases: readonly GeoContentEvaluationCase[]): EvaluationMetricAggregate[] {
  return EVALUATION_METRIC_NAMES.map(metricName => {
    const metrics = cases.map(value => metricByName(value, metricName))
    const applicableMetrics = metrics.filter(isValidApplicableMetric)
    const numerator = applicableMetrics.reduce((total, metric) => total + metric.numerator, 0)
    const denominator = applicableMetrics.reduce((total, metric) => total + metric.denominator, 0)
    return {
      metricName,
      applicableCases: applicableMetrics.length,
      numerator,
      denominator,
      ratio: metricRatio(numerator, denominator),
      reasonCodes: [...new Set(metrics.flatMap(metric => metric.reasonCodes))],
      evidenceLocator: [...new Set(metrics.flatMap(metric => metric.evidenceLocator))],
    }
  })
}

export function metricNames(): readonly EvaluationMetricName[] {
  return EVALUATION_METRIC_NAMES
}
