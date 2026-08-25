import type {
  EvaluationMetric,
  EvaluationMetricAggregate,
  EvaluationMetricName,
  EvaluationReasonCode,
  GeoContentEvaluationCase,
} from './types'
import { EVALUATION_METRIC_NAMES } from './types'

export function metricRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return numerator / denominator
}

export function makeEvaluationMetric(
  metricName: EvaluationMetricName,
  numerator: number,
  denominator: number,
  reasonCodes: EvaluationReasonCode[] = [],
  evidenceLocator: string[] = [],
): EvaluationMetric {
  const safeDenominator = Number.isFinite(denominator) ? Math.max(0, Math.trunc(denominator)) : 0
  const safeNumerator = Number.isFinite(numerator)
    ? Math.max(0, Math.min(safeDenominator, Math.trunc(numerator)))
    : 0
  return {
    metricName,
    applicable: safeDenominator > 0,
    numerator: safeNumerator,
    denominator: safeDenominator,
    ratio: metricRatio(safeNumerator, safeDenominator),
    reasonCodes: [...new Set(reasonCodes)],
    evidenceLocator: [...new Set(evidenceLocator)],
  }
}

export function emptyEvaluationMetric(metricName: EvaluationMetricName, reasonCode: EvaluationReasonCode = 'METRIC_NOT_APPLICABLE'): EvaluationMetric {
  return makeEvaluationMetric(metricName, 0, 0, [reasonCode], [`metric:${metricName}`])
}

export function metricByName(value: GeoContentEvaluationCase, metricName: EvaluationMetricName): EvaluationMetric {
  return value.metrics.find(metric => metric.metricName === metricName) ?? emptyEvaluationMetric(metricName)
}

export function aggregateEvaluationMetrics(cases: readonly GeoContentEvaluationCase[]): EvaluationMetricAggregate[] {
  return EVALUATION_METRIC_NAMES.map(metricName => {
    const metrics = cases.map(value => metricByName(value, metricName))
    const applicableMetrics = metrics.filter(metric => metric.applicable)
    const numerator = applicableMetrics.reduce((total, metric) => total + metric.numerator, 0)
    const denominator = applicableMetrics.reduce((total, metric) => total + metric.denominator, 0)
    const reasonCodes = metrics.flatMap(metric => metric.reasonCodes)
    const evidenceLocator = metrics.flatMap(metric => metric.evidenceLocator)
    return {
      metricName,
      applicableCases: applicableMetrics.length,
      numerator,
      denominator,
      ratio: metricRatio(numerator, denominator),
      reasonCodes: [...new Set(reasonCodes)],
      evidenceLocator: [...new Set(evidenceLocator)],
    }
  })
}

export function metricNames(): readonly EvaluationMetricName[] {
  return EVALUATION_METRIC_NAMES
}
