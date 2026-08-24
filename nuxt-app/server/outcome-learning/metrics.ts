import { OUTCOME_POSITION_DELTA_THRESHOLD, OUTCOME_SIGNAL_DELTA_THRESHOLD } from './policy-catalog'
import type { NormalizedOutcomeMeasurement, OutcomeMeasurementSource, OutcomeMetricComparison, OutcomeSignal } from './types'

function value(metrics: Record<string, number>, key: string): number {
  const numeric = metrics[key]
  if (typeof numeric !== 'number') throw new Error('MISSING_METRIC')
  return numeric
}

function dailyMetrics(measurement: NormalizedOutcomeMeasurement): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, numeric] of Object.entries(measurement.metrics)) result[key] = numeric / measurement.durationDays
  for (const [key, numeric] of Object.entries(measurement.derivedMetrics)) result[key] = numeric
  return result
}

function direction(delta: number, lowerIsBetter = false): OutcomeSignal {
  if (Math.abs(delta) < OUTCOME_SIGNAL_DELTA_THRESHOLD) return 'no_material_change'
  if (lowerIsBetter) return delta < 0 ? 'positive_signal' : 'negative_signal'
  return delta > 0 ? 'positive_signal' : 'negative_signal'
}

function sourceSignal(source: OutcomeMeasurementSource, baseline: Record<string, number>, followUp: Record<string, number>): OutcomeSignal {
  if (source === 'google_search_console') {
    const impressionsSignal = direction(value(followUp, 'impressionsPerDay') - value(baseline, 'impressionsPerDay'))
    const clicksSignal = direction(value(followUp, 'clicksPerDay') - value(baseline, 'clicksPerDay'))
    const ctrSignal = direction(value(followUp, 'ctr') - value(baseline, 'ctr'))
    const positionDelta = value(followUp, 'averagePosition') - value(baseline, 'averagePosition')
    const positionSignal: OutcomeSignal = Math.abs(positionDelta) < OUTCOME_POSITION_DELTA_THRESHOLD ? 'no_material_change' : positionDelta < 0 ? 'positive_signal' : 'negative_signal'
    return combineSignals([impressionsSignal, clicksSignal, ctrSignal, positionSignal])
  }
  if (source === 'llm_visibility') {
    return combineSignals([direction(value(followUp, 'queryCountPerDay') - value(baseline, 'queryCountPerDay')), direction(value(followUp, 'mentionRate') - value(baseline, 'mentionRate')), direction(value(followUp, 'citationRate') - value(baseline, 'citationRate'))])
  }
  if (source === 'first_party_analytics') return combineSignals([direction(value(followUp, 'sessionsPerDay') - value(baseline, 'sessionsPerDay')), direction(value(followUp, 'engagementRate') - value(baseline, 'engagementRate'))])
  return combineSignals([direction(value(followUp, 'qualifiedLeadsPerDay') - value(baseline, 'qualifiedLeadsPerDay')), direction(value(followUp, 'conversionRate') - value(baseline, 'conversionRate'))])
}

export function combineSignals(signals: readonly OutcomeSignal[]): OutcomeSignal {
  const useful = signals.filter((signal) => signal !== 'insufficient_data')
  if (useful.length === 0) return 'insufficient_data'
  const mixed = useful.some((signal) => signal === 'mixed_signal')
  const positive = useful.filter((signal) => signal === 'positive_signal').length
  const negative = useful.filter((signal) => signal === 'negative_signal').length
  if (mixed || (positive > 0 && negative > 0)) return 'mixed_signal'
  if (positive > 0) return 'positive_signal'
  if (negative > 0) return 'negative_signal'
  return 'no_material_change'
}

export function buildOutcomeMetricComparison(baseline: NormalizedOutcomeMeasurement, followUp: NormalizedOutcomeMeasurement): OutcomeMetricComparison {
  const baselineDaily = dailyMetrics(baseline)
  const followUpDaily = dailyMetrics(followUp)
  const baselineDerived = { ...baseline.derivedMetrics }
  const followUpDerived = { ...followUp.derivedMetrics }
  if (baseline.source === 'google_search_console') {
    baselineDaily.impressionsPerDay = value(baseline.metrics, 'impressions') / baseline.durationDays
    baselineDaily.clicksPerDay = value(baseline.metrics, 'clicks') / baseline.durationDays
    baselineDaily.averagePosition = value(baseline.metrics, 'averagePosition')
    followUpDaily.impressionsPerDay = value(followUp.metrics, 'impressions') / followUp.durationDays
    followUpDaily.clicksPerDay = value(followUp.metrics, 'clicks') / followUp.durationDays
    followUpDaily.averagePosition = value(followUp.metrics, 'averagePosition')
  } else if (baseline.source === 'llm_visibility') {
    baselineDaily.queryCountPerDay = value(baseline.metrics, 'queryCount') / baseline.durationDays
    followUpDaily.queryCountPerDay = value(followUp.metrics, 'queryCount') / followUp.durationDays
  } else if (baseline.source === 'first_party_analytics') {
    baselineDaily.sessionsPerDay = value(baseline.metrics, 'sessions') / baseline.durationDays
    followUpDaily.sessionsPerDay = value(followUp.metrics, 'sessions') / followUp.durationDays
  } else {
    baselineDaily.qualifiedLeadsPerDay = value(baseline.metrics, 'qualifiedLeads') / baseline.durationDays
    followUpDaily.qualifiedLeadsPerDay = value(followUp.metrics, 'qualifiedLeads') / followUp.durationDays
  }
  return {
    source: baseline.source,
    baselineWindow: { start: baseline.windowStart, end: baseline.windowEnd },
    followUpWindow: { start: followUp.windowStart, end: followUp.windowEnd },
    baselineDailyMetrics: baselineDaily,
    followUpDailyMetrics: followUpDaily,
    baselineDerivedMetrics: baselineDerived,
    followUpDerivedMetrics: followUpDerived,
    signal: sourceSignal(baseline.source, baselineDaily, followUpDaily),
    sourceHashes: [baseline.sourceHash, followUp.sourceHash].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  }
}
