import type {
  GoogleTrendsSnapshot,
  MetaAdRecord,
  MetaAdSnapshot,
  MetaMetrics,
  TrendMetrics,
} from './types'

const DIRECTION_CHANGE_THRESHOLD_PERCENT = 5
const DIRECTION_SLOPE_THRESHOLD = 0.5
const MS_PER_DAY = 86_400_000

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function daysBetween(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00.000Z`)
  const endMs = Date.parse(`${end}T00:00:00.000Z`)
  return Math.max(0, Math.floor((endMs - startMs) / MS_PER_DAY))
}

function regressionSlope(values: number[]): number {
  if (values.length < 2) return 0
  const xMean = (values.length - 1) / 2
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length
  const numerator = values.reduce((sum, value, index) => sum + (index - xMean) * (value - yMean), 0)
  const denominator = values.reduce((sum, _value, index) => sum + (index - xMean) ** 2, 0)
  return denominator === 0 ? 0 : numerator / denominator
}

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean * 100
}

export function calculateTrendMetrics(snapshots: readonly GoogleTrendsSnapshot[]): TrendMetrics | null {
  const byDate = new Map<string, number[]>()
  snapshots.slice().sort((left, right) => left.snapshotId.localeCompare(right.snapshotId)).forEach((snapshot) => {
    snapshot.observations.slice().sort((left, right) => left.date.localeCompare(right.date)).forEach((observation) => {
      const values = byDate.get(observation.date) ?? []
      values.push(observation.value)
      byDate.set(observation.date, values)
    })
  })
  const points = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => ({
    date,
    value: values.reduce((sum, value) => sum + value, 0) / values.length,
  }))
  if (points.length === 0) return null

  const values = points.map((point) => point.value)
  const firstValue = values[0]!
  const latestValue = values[values.length - 1]!
  const changePercent = firstValue === 0 ? null : round((latestValue - firstValue) / firstValue * 100)
  const slopePerObservation = round(regressionSlope(values))
  const volatilityPercent = round(coefficientOfVariation(values))
  const declaredStart = snapshots.map((snapshot) => snapshot.window.start).sort()[0] ?? points[0]!.date
  const declaredEnd = snapshots.map((snapshot) => snapshot.window.end).sort().at(-1) ?? points.at(-1)!.date
  const declaredDays = daysBetween(declaredStart, declaredEnd) + 1
  const coverageRatio = round(Math.min(1, points.length / Math.max(1, declaredDays)), 4)
  const direction: TrendMetrics['direction'] = points.length < 2
    ? 'insufficient_data'
    : Math.abs(changePercent ?? 0) >= DIRECTION_CHANGE_THRESHOLD_PERCENT || Math.abs(slopePerObservation) >= DIRECTION_SLOPE_THRESHOLD
      ? (latestValue > firstValue ? 'rising' : 'falling')
      : 'stable'
  const peak = points.reduce((best, point) => point.value > best.value ? point : best, points[0]!)
  return {
    pointCount: points.length,
    firstValue: round(firstValue),
    latestValue: round(latestValue),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    minimum: round(Math.min(...values)),
    maximum: round(Math.max(...values)),
    changePercent,
    slopePerObservation,
    volatilityPercent,
    peakDate: peak.date,
    peakValue: round(peak.value),
    direction,
    coverageRatio,
  }
}

interface EnrichedAd extends MetaAdRecord {
  publisherIdentity: string
  snapshotId: string
  windowEnd: string
}

function latestSnapshot(snapshots: readonly MetaAdSnapshot[]): MetaAdSnapshot | null {
  return snapshots.slice().sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.snapshotId.localeCompare(right.snapshotId)).at(-1) ?? null
}

export function calculateMetaMetrics(snapshots: readonly MetaAdSnapshot[]): MetaMetrics | null {
  if (snapshots.length === 0) return null
  const orderedSnapshots = snapshots.slice().sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.snapshotId.localeCompare(right.snapshotId))
  const enrichedAds: EnrichedAd[] = []
  orderedSnapshots.forEach((snapshot) => snapshot.ads.forEach((ad) => enrichedAds.push({ ...ad, publisherIdentity: snapshot.publisherIdentity, snapshotId: snapshot.snapshotId, windowEnd: snapshot.window.end })))
  const uniqueAds = new Map<string, EnrichedAd>()
  enrichedAds.forEach((ad) => {
    const existing = uniqueAds.get(`${ad.publisherIdentity}:${ad.adId}`)
    if (!existing || ad.windowEnd > existing.windowEnd || (ad.windowEnd === existing.windowEnd && ad.snapshotId > existing.snapshotId)) uniqueAds.set(`${ad.publisherIdentity}:${ad.adId}`, ad)
  })
  const latest = latestSnapshot(orderedSnapshots)!
  const activeAdCount = latest.ads.filter((ad) => ad.status === 'active').length
  const newAdCount = [...uniqueAds.values()].filter((ad) => ad.startedAt >= orderedSnapshots[0]!.window.start && ad.startedAt <= orderedSnapshots.at(-1)!.window.end).length
  const averageAdAgeDays = uniqueAds.size === 0 ? null : round([...uniqueAds.values()].reduce((sum, ad) => sum + daysBetween(ad.startedAt, latest.window.end), 0) / uniqueAds.size)
  const activeCounts = orderedSnapshots.map((snapshot) => snapshot.ads.filter((ad) => ad.status === 'active').length)
  const firstActive = activeCounts[0]!
  const lastActive = activeCounts.at(-1)!
  const activityDirection: MetaMetrics['activityDirection'] = orderedSnapshots.length < 2
    ? 'insufficient_data'
    : lastActive > firstActive ? 'increasing' : lastActive < firstActive ? 'decreasing' : 'stable'
  return {
    snapshotCount: orderedSnapshots.length,
    publisherCount: new Set(orderedSnapshots.map((snapshot) => snapshot.publisherIdentity)).size,
    totalAdCount: enrichedAds.length,
    uniqueAdCount: uniqueAds.size,
    activeAdCount,
    uniqueCreativeCount: new Set([...uniqueAds.values()].map((ad) => ad.creativeHash)).size,
    newAdCount,
    averageAdAgeDays,
    activityDirection,
  }
}
