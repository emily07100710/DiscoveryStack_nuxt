import { MIN_META_SNAPSHOTS_FOR_DIRECTION } from './policy-catalog'
import type {
  ActivityDirection,
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

function epoch(value: string): number {
  return Date.parse(value)
}

function daysBetween(start: string, end: string): number {
  const startMs = epoch(`${start}T00:00:00.000Z`)
  const endMs = epoch(`${end}T00:00:00.000Z`)
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

function directionForSeries(first: number, latest: number, slope: number, count: number, changePercent: number | null): ActivityDirection | TrendMetrics['direction'] {
  if (count < 2) return 'insufficient_data'
  const changeIsSignificant = changePercent === null ? false : Math.abs(changePercent) >= DIRECTION_CHANGE_THRESHOLD_PERCENT
  const slopeIsSignificant = Math.abs(slope) >= DIRECTION_SLOPE_THRESHOLD
  if (!changeIsSignificant && !slopeIsSignificant) return 'stable'
  if (latest > first) return 'rising'
  if (latest < first) return 'falling'
  return 'stable'
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
  const trendDirection = directionForSeries(firstValue, latestValue, slopePerObservation, points.length, changePercent) as TrendMetrics['direction']
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
    direction: trendDirection,
    coverageRatio,
  }
}

interface EnrichedAd extends MetaAdRecord {
  publisherIdentity: string
  snapshotId: string
  capturedAt: string
  windowEnd: string
}

function compareSnapshots(left: MetaAdSnapshot, right: MetaAdSnapshot): number {
  return epoch(left.capturedAt) - epoch(right.capturedAt) || left.snapshotId.localeCompare(right.snapshotId)
}

function directionForActiveCounts(counts: number[]): ActivityDirection {
  if (counts.length < MIN_META_SNAPSHOTS_FOR_DIRECTION) return 'insufficient_data'
  const first = counts[0]!
  const latest = counts.at(-1)!
  if (latest > first) return 'increasing'
  if (latest < first) return 'decreasing'
  return 'stable'
}

export function calculateMetaMetrics(snapshots: readonly MetaAdSnapshot[]): MetaMetrics | null {
  if (snapshots.length === 0) return null
  const orderedSnapshots = snapshots.slice().sort(compareSnapshots)
  const enrichedAds: EnrichedAd[] = []
  orderedSnapshots.forEach((snapshot) => snapshot.ads.forEach((ad) => enrichedAds.push({ ...ad, publisherIdentity: snapshot.publisherIdentity, snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, windowEnd: snapshot.window.end })))
  const uniqueAds = new Map<string, EnrichedAd>()
  enrichedAds.forEach((ad) => {
    const existing = uniqueAds.get(`${ad.publisherIdentity}:${ad.adId}`)
    if (!existing || epoch(ad.capturedAt) > epoch(existing.capturedAt) || (ad.capturedAt === existing.capturedAt && ad.snapshotId > existing.snapshotId)) uniqueAds.set(`${ad.publisherIdentity}:${ad.adId}`, ad)
  })

  const byPublisher = new Map<string, MetaAdSnapshot[]>()
  orderedSnapshots.forEach((snapshot) => {
    const publisherSnapshots = byPublisher.get(snapshot.publisherIdentity) ?? []
    publisherSnapshots.push(snapshot)
    byPublisher.set(snapshot.publisherIdentity, publisherSnapshots)
  })
  const publisherDirections: Record<string, ActivityDirection> = {}
  const latestByPublisher = new Map<string, MetaAdSnapshot>()
  const firstActiveByPublisher = new Map<string, number>()
  const latestActiveByPublisher = new Map<string, number>()
  for (const publisher of [...byPublisher.keys()].sort()) {
    const publisherSnapshots = byPublisher.get(publisher)!.slice().sort(compareSnapshots)
    const counts = publisherSnapshots.map((snapshot) => snapshot.ads.filter((ad) => ad.status === 'active').length)
    publisherDirections[publisher] = directionForActiveCounts(counts)
    firstActiveByPublisher.set(publisher, counts[0] ?? 0)
    latestActiveByPublisher.set(publisher, counts.at(-1) ?? 0)
    latestByPublisher.set(publisher, publisherSnapshots.at(-1)!)
  }
  const directions = Object.values(publisherDirections)
  const activityDirection: ActivityDirection = directions.length === 0 || directions.some((direction) => direction === 'insufficient_data')
    ? 'insufficient_data'
    : (() => {
        const publishers = [...byPublisher.keys()].sort()
        const firstTotal = publishers.reduce((sum, publisher) => sum + (firstActiveByPublisher.get(publisher) ?? 0), 0)
        const latestTotal = publishers.reduce((sum, publisher) => sum + (latestActiveByPublisher.get(publisher) ?? 0), 0)
        return latestTotal > firstTotal ? 'increasing' : latestTotal < firstTotal ? 'decreasing' : 'stable'
      })()
  const latestGlobalEnd = [...latestByPublisher.values()].map((snapshot) => snapshot.window.end).sort().at(-1) ?? orderedSnapshots.at(-1)!.window.end
  const newAdCount = [...uniqueAds.values()].filter((ad) => ad.startedAt >= orderedSnapshots[0]!.window.start && ad.startedAt <= latestGlobalEnd).length
  const averageAdAgeDays = uniqueAds.size === 0 ? null : round([...uniqueAds.values()].reduce((sum, ad) => sum + daysBetween(ad.startedAt, latestGlobalEnd), 0) / uniqueAds.size)
  const activeAdCount = [...latestByPublisher.values()].reduce((sum, snapshot) => sum + snapshot.ads.filter((ad) => ad.status === 'active').length, 0)
  return {
    snapshotCount: orderedSnapshots.length,
    publisherCount: byPublisher.size,
    totalAdCount: enrichedAds.length,
    uniqueAdCount: uniqueAds.size,
    activeAdCount,
    uniqueCreativeCount: new Set([...uniqueAds.values()].map((ad) => ad.creativeHash)).size,
    newAdCount,
    averageAdAgeDays,
    activityDirection,
    publisherDirections,
  }
}
