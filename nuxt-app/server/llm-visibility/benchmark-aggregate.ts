import { citationMatchesDomain } from './guards'
import { calculateRegistryShareOfVoice, type MetricObservation, type VisibilityCompetitorRegistryEntry } from './metrics'
import { meanEstimate, proportionEstimate, sampleLimitations } from './statistics'
import type { CitationFreshnessRecord } from './citation-freshness'

export type BenchmarkAggregateObservation = {
  id?: number
  queryId: number
  promptVersionId: number | null
  versionNumber?: number | null
  provider: 'chatgpt' | 'gemini' | 'perplexity'
  modelLabel: string
  observedAt: Date | string
  brandMentioned: boolean
  exactMentionCount: number
  firstMentionPosition: number | null
  citationUrls: string[]
  competitorMentions: Record<string, number>
  citationFreshness: CitationFreshnessRecord[] | null
}

export type BenchmarkAggregateSample = {
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  queryId: number
  promptVersionId: number
  provider: 'chatgpt' | 'gemini' | 'perplexity'
  modelLabel: string
  failureCode?: string | null
}

function estimates(rows: BenchmarkAggregateObservation[], brandDomain: string) {
  return {
    brandMentionRate: proportionEstimate(rows.filter(row => row.brandMentioned).length, rows.length),
    citationRate: proportionEstimate(rows.filter(row => row.citationUrls.length > 0).length, rows.length),
    exactCitationRate: proportionEstimate(rows.filter(row => row.citationUrls.some(url => citationMatchesDomain(url, brandDomain))).length, rows.length),
  }
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function metricRows(rows: BenchmarkAggregateObservation[]): MetricObservation[] {
  return rows.map(row => ({ queryId: row.queryId, provider: row.provider, observationMode: 'provider_api_observation', observedAt: row.observedAt, brandMentioned: row.brandMentioned, exactMentionCount: row.exactMentionCount, firstMentionPosition: row.firstMentionPosition, citationUrls: row.citationUrls, competitorMentions: row.competitorMentions }))
}

export function computeBenchmarkAggregate(input: {
  benchmark: { requestedSamples: number, promptVersionIds?: Record<string, number> }
  samples: BenchmarkAggregateSample[]
  observations: BenchmarkAggregateObservation[]
  competitorSnapshot: VisibilityCompetitorRegistryEntry[]
  brandName: string
  brandDomain: string
}) {
  const observations = [...input.observations].sort((left, right) => left.queryId - right.queryId || left.provider.localeCompare(right.provider) || left.modelLabel.localeCompare(right.modelLabel) || String(left.observedAt).localeCompare(String(right.observedAt)))
  const succeededSamples = input.samples.filter(row => row.status === 'succeeded').length
  const failedSamples = input.samples.filter(row => row.status === 'failed').length
  const failureCounts = new Map<string, number>()
  for (const sample of input.samples.filter(row => row.status === 'failed')) {
    const code = sample.failureCode || 'unknown_failure'
    failureCounts.set(code, (failureCounts.get(code) || 0) + 1)
  }
  const positions = observations.map(row => row.firstMentionPosition).filter((value): value is number => value !== null)
  const citationFreshness = observations.flatMap(row => row.citationFreshness || [])
  const knownAges = citationFreshness.map(row => row.ageDays).filter((value): value is number => value !== null)
  const byDateSource = { provider_metadata: 0, url_pattern: 0, http_last_modified: 0, unknown: 0 }
  for (const row of citationFreshness) byDateSource[row.dateSource] += 1
  const groups = <T>(key: (row: BenchmarkAggregateObservation) => string, build: (group: BenchmarkAggregateObservation[]) => T) => {
    const map = new Map<string, BenchmarkAggregateObservation[]>()
    for (const row of observations) map.set(key(row), [...(map.get(key(row)) || []), row])
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, rows]) => build(rows))
  }
  const byProvider = groups(row => `${row.provider}\u0000${row.modelLabel}`, rows => ({ provider: rows[0]!.provider, modelLabel: rows[0]!.modelLabel, n: rows.length, estimates: estimates(rows, input.brandDomain) }))
  const byQuery = groups(row => String(row.queryId).padStart(12, '0'), rows => {
    const promptVersionId = rows[0]!.promptVersionId || input.benchmark.promptVersionIds?.[String(rows[0]!.queryId)] || null
    return { queryId: rows[0]!.queryId, promptVersionId, versionNumber: rows[0]!.versionNumber ?? null, n: rows.length, estimates: estimates(rows, input.brandDomain) }
  })
  return {
    n: observations.length,
    requestedSamples: input.benchmark.requestedSamples,
    succeededSamples,
    failedSamples,
    failureCodes: [...failureCounts].sort(([left], [right]) => left.localeCompare(right)).map(([code, count]) => ({ code, count })),
    estimates: estimates(observations, input.brandDomain),
    firstMentionPosition: meanEstimate(positions),
    shareOfVoice: calculateRegistryShareOfVoice(metricRows(observations), input.competitorSnapshot),
    citationFreshness: {
      citations: citationFreshness.length,
      known: citationFreshness.length - byDateSource.unknown,
      unknown: byDateSource.unknown,
      byDateSource,
      ageDays: meanEstimate(knownAges),
      medianAgeDays: median(knownAges),
    },
    byProvider,
    byQuery,
    promptVersions: byQuery.map(row => ({ queryId: row.queryId, promptVersionId: row.promptVersionId, versionNumber: row.versionNumber })),
    limitations: ['provider_api_not_consumer_surface', ...sampleLimitations(observations.length, input.benchmark.requestedSamples)],
  }
}
