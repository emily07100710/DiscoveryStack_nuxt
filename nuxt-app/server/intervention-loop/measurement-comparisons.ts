import { aggregateMeasurements, classifyMeasurementPhases } from './assessment'
import { fingerprint } from './normalization'
import type { Intervention, InterventionMeasurement } from './types'

const DAY = 86_400_000

function overlaps(rows: InterventionMeasurement[]) {
  const sorted = [...rows].sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime() || a.id - b.id)
  return sorted.some((row, index) => index > 0 && row.windowStart < sorted[index - 1]!.windowEnd)
}

function rowProblems(intervention: Intervention, row: InterventionMeasurement): string[] {
  const reasons: string[] = []
  if (row.ownerUserId !== intervention.ownerUserId || row.interventionId !== intervention.id) reasons.push('measurement_lineage_mismatch')
  const dates = [row.windowStart, row.windowEnd, row.capturedAt]
  if (dates.some(date => !(date instanceof Date) || !Number.isFinite(date.getTime())) || !(row.windowStart < row.windowEnd)) reasons.push('measurement_window_invalid')
  else if (row.capturedAt < row.windowEnd) reasons.push('measurement_captured_before_window_end')
  if (!Number.isSafeInteger(row.sampleSize) || row.sampleSize < 0) reasons.push('measurement_sample_invalid')
  if (row.source === 'google_search_console') {
    const { clicks, impressions, ctr, averagePosition } = row.metrics
    if (!Number.isSafeInteger(clicks) || !Number.isSafeInteger(impressions) || clicks! < 0 || impressions! < clicks! || row.sampleSize > impressions!
      || (ctr !== undefined && (!Number.isFinite(ctr) || ctr < 0 || ctr > 1))
      || (averagePosition !== undefined && (!Number.isFinite(averagePosition) || averagePosition < 0))) reasons.push('measurement_metrics_invalid')
  }
  const expectedHash = fingerprint({ source: row.source, origin: row.origin, windowStart: row.windowStart, windowEnd: row.windowEnd, metrics: row.metrics })
  if (row.sourceHash !== expectedHash) reasons.push('measurement_source_hash_mismatch')
  return reasons
}

export function compareInterventionMeasurements(intervention: Intervention, measurements: InterventionMeasurement[]) {
  const groups = new Map<string, InterventionMeasurement[]>()
  for (const row of measurements) {
    // A property, collection mode, or source change is a different measurement scope.
    const key = fingerprint({ source: row.source, origin: row.origin, property: row.property })
    groups.set(key, [...(groups.get(key) || []), row])
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([scopeKey, rows]) => {
    const first = rows[0]!
    const phases = classifyMeasurementPhases(intervention, rows)
    const reasons = [...new Set(rows.flatMap(row => rowProblems(intervention, row)))].sort()
    if (first.source !== 'google_search_console') reasons.push('measurement_source_not_supported_by_click_contract')
    if (overlaps(phases.baseline) || overlaps(phases.followUp)) reasons.push('measurement_windows_overlap')
    if (!phases.baseline.length) reasons.push('baseline_measurements_missing')
    if (!phases.followUp.length) reasons.push('follow_up_measurements_missing')
    const supported = first.source === 'google_search_console'
    const invalid = reasons.some(reason => !['measurement_source_not_supported_by_click_contract', 'baseline_measurements_missing', 'follow_up_measurements_missing'].includes(reason))
    const phase = (items: InterventionMeasurement[]) => ({
      rows: items.length,
      sampleSize: items.length && supported && !invalid ? items.reduce((sum, row) => sum + row.sampleSize, 0) : null,
      observedDays: items.length && supported && !invalid ? items.reduce((sum, row) => sum + (row.windowEnd.getTime() - row.windowStart.getTime()) / DAY, 0) : null,
      windowStart: items.length ? new Date(Math.min(...items.map(row => row.windowStart.getTime()))) : null,
      windowEnd: items.length ? new Date(Math.max(...items.map(row => row.windowEnd.getTime()))) : null,
      aggregates: items.length && supported && !invalid ? (() => {
        const aggregate = aggregateMeasurements(items)
        return { ...aggregate, ctr: aggregate.impressions > 0 ? aggregate.ctr : null }
      })() : null,
      references: [...items].sort((a, b) => a.id - b.id).map(row => ({ id: row.id, sourceHash: row.sourceHash, capturedAt: row.capturedAt })),
    })
    const baseline = phase(phases.baseline)
    const followUp = phase(phases.followUp)
    const status = !supported ? 'unsupported' as const : invalid ? 'blocked' as const : baseline.rows && followUp.rows ? 'comparable' as const : 'insufficient_data' as const
    const body = {
      scopeKey,
      source: first.source,
      origin: first.origin,
      // Hash-only scope: property strings and arbitrary notes do not enter the learning/export view.
      propertyKey: first.property === null ? null : fingerprint({ property: first.property }),
      status,
      baseline,
      followUp,
      excludedRows: phases.excluded.length,
      reasons: [...new Set(reasons)].sort(),
    }
    return { ...body, comparisonFingerprint: fingerprint(body), phases }
  })
}

export type InterventionMeasurementComparison = ReturnType<typeof compareInterventionMeasurements>[number]
