import { OUTCOME_POSITION_DELTA_THRESHOLD, OUTCOME_SIGNAL_DELTA_THRESHOLD } from '../outcome-learning/policy-catalog'
import { fingerprint } from './normalization'
import type { ExperimentResult, Intervention, InterventionMeasurement, InterventionSignal, MeasurementAggregates, PrePostEffect } from './types'

export const PRE_POST_CAUSAL_STATEMENT = '這是同一頁面的前後比較，不是對照實驗。季節、同時期的其他改動、搜尋演算法更新、競爭者變化都可能影響結果；只能視為相關，不能視為因果。'
export const GROUPED_CAUSAL_STATEMENT = '這是分組比較，不是隨機分派的實驗；兩組頁面本來就可能不同，結果只能視為相關。'

export function classifyMeasurementPhases(intervention: Intervention, measurements: InterventionMeasurement[]) {
  const baseline: InterventionMeasurement[] = []
  const followUp: InterventionMeasurement[] = []
  const excluded: InterventionMeasurement[] = []
  for (const row of measurements) {
    if (intervention.deployedAt && row.windowEnd <= intervention.deployedAt) baseline.push(row)
    else if (intervention.recrawlConfirmedAt && row.windowStart >= intervention.recrawlConfirmedAt) followUp.push(row)
    else excluded.push(row)
  }
  return { baseline, followUp, excluded }
}

export function aggregateMeasurements(rows: InterventionMeasurement[]): MeasurementAggregates {
  let clicks = 0
  let impressions = 0
  let positionWeighted = 0
  let positionWeight = 0
  let days = 0
  for (const row of rows) {
    const rowClicks = row.metrics.clicks || 0
    const rowImpressions = row.metrics.impressions || 0
    clicks += rowClicks
    impressions += rowImpressions
    days += Math.max(0, row.windowEnd.getTime() - row.windowStart.getTime()) / 86_400_000
    if (typeof row.metrics.averagePosition === 'number' && rowImpressions > 0) {
      positionWeighted += row.metrics.averagePosition * rowImpressions
      positionWeight += rowImpressions
    }
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    averagePosition: positionWeight > 0 ? positionWeighted / positionWeight : null,
    days,
    clicksPerDay: days > 0 ? clicks / days : 0,
    impressionsPerDay: days > 0 ? impressions / days : 0,
  }
}

function relativeDelta(before: number, after: number): number | null { return before === 0 ? null : (after - before) / before }

function direction(delta: number | null, lowerIsBetter = false, threshold = OUTCOME_SIGNAL_DELTA_THRESHOLD): InterventionSignal {
  if (delta === null || Math.abs(delta) < threshold) return 'no_material_change'
  return lowerIsBetter ? delta < 0 ? 'positive_signal' : 'negative_signal' : delta > 0 ? 'positive_signal' : 'negative_signal'
}

function combinedSignal(effect: PrePostEffect): InterventionSignal {
  const signals = [
    direction(effect.deltas.clicksPerDay),
    direction(effect.deltas.impressionsPerDay),
    direction(effect.deltas.ctrPercentagePoints / 100),
    direction(effect.deltas.averagePosition, true, OUTCOME_POSITION_DELTA_THRESHOLD),
  ]
  const positive = signals.includes('positive_signal')
  const negative = signals.includes('negative_signal')
  if (positive && negative) return 'mixed_signal'
  if (positive) return 'positive_signal'
  if (negative) return 'negative_signal'
  return 'no_material_change'
}

export function computePrePostResult(intervention: Intervention, measurements: InterventionMeasurement[], policy: { minimumSampleSize: number }, computedAt = new Date()) {
  const phases = classifyMeasurementPhases(intervention, measurements)
  const baseline = aggregateMeasurements(phases.baseline)
  const followUp = aggregateMeasurements(phases.followUp)
  const sampleSizeBaseline = phases.baseline.reduce((sum, row) => sum + row.sampleSize, 0)
  const sampleSizeFollowUp = phases.followUp.reduce((sum, row) => sum + row.sampleSize, 0)
  const effect: PrePostEffect = {
    baseline,
    followUp,
    deltas: {
      clicksPerDay: relativeDelta(baseline.clicksPerDay, followUp.clicksPerDay),
      impressionsPerDay: relativeDelta(baseline.impressionsPerDay, followUp.impressionsPerDay),
      ctrPercentagePoints: (followUp.ctr - baseline.ctr) * 100,
      averagePosition: baseline.averagePosition === null || followUp.averagePosition === null ? null : followUp.averagePosition - baseline.averagePosition,
    },
    primaryMetric: 'clicks',
  }
  const limitations = ['pre_post_not_experiment', 'no_control_group']
  if (sampleSizeBaseline < policy.minimumSampleSize || sampleSizeFollowUp < policy.minimumSampleSize) limitations.push('sample_below_minimum')
  if (followUp.days < 14) limitations.push('short_follow_up_window')
  if (intervention.deployEvidenceLevel === 'weak') limitations.push('deployment_weak_evidence')
  if (intervention.recrawlSource === 'manual') limitations.push('recrawl_manual_confirmation')
  if (new Set(measurements.map(row => row.origin)).size > 1) limitations.push('mixed_measurement_origins')
  if (phases.excluded.length) limitations.push('transition_rows_excluded')
  if (!intervention.baselineContentHash) limitations.push('baseline_unknown')
  const signal: InterventionSignal = limitations.includes('sample_below_minimum') ? 'insufficient_data' : combinedSignal(effect)
  const metric = 'clicksPerDay'
  const resultFingerprint = fingerprint({ interventionId: intervention.id, resultKind: 'pre_post', metric, sampleSizeBaseline, sampleSizeFollowUp, effect, signal, limitations })
  return { resultKind: 'pre_post' as const, metric, sampleSizeBaseline, sampleSizeFollowUp, effect: effect as unknown as Record<string, unknown>, signal, limitations, causalStatement: PRE_POST_CAUSAL_STATEMENT, computedAt, resultFingerprint, phases }
}

export function latestRelativeClicksDelta(result: ExperimentResult): number | null {
  const effect = result.effect as { deltas?: { clicksPerDay?: unknown } }
  return typeof effect.deltas?.clicksPerDay === 'number' ? effect.deltas.clicksPerDay : null
}
