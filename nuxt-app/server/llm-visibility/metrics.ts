import type { VisibilityMode, VisibilityProvider } from './contracts'
import { citationMatchesDomain } from './guards'

export type MetricQuery = { id: number, locale: 'en' | 'zh-hant', active: boolean }
export type MetricObservation = {
  queryId: number
  provider: VisibilityProvider
  observationMode: VisibilityMode
  observedAt: Date | string
  brandMentioned: boolean
  exactMentionCount: number
  firstMentionPosition: number | null
  citationUrls: string[]
  competitorMentions: Record<string, number>
}
type MetricSlice = {
  status: 'ready' | 'not_ready'
  totalQueries: number
  observedQueries: number
  brandMentionRate: number | null
  citationRate: number | null
  exactCitationRate: number | null
  competitorShareOfVoice: number | null
  averageFirstMentionPosition: number | null
}

function ratio(numerator: number, denominator: number) { return denominator === 0 ? null : numerator / denominator }
const round = (value: number | null) => value === null ? null : Math.round(value * 10000) / 10000

function sliceMetrics(queries: MetricQuery[], observations: MetricObservation[], canonicalDomain: string): MetricSlice {
  const activeIds = new Set(queries.filter(query => query.active).map(query => query.id))
  const relevant = observations.filter(observation => activeIds.has(observation.queryId))
  const observedQueryIds = new Set(relevant.map(observation => observation.queryId))
  const brandMentioned = relevant.filter(observation => observation.brandMentioned).length
  const cited = relevant.filter(observation => observation.citationUrls.length > 0).length
  const exactCited = relevant.filter(observation => observation.citationUrls.some(url => citationMatchesDomain(url, canonicalDomain))).length
  const brandMentions = relevant.reduce((sum, observation) => sum + observation.exactMentionCount, 0)
  const competitorMentions = relevant.reduce((sum, observation) => sum + Object.values(observation.competitorMentions).reduce((inner, count) => inner + count, 0), 0)
  const positions = relevant.map(observation => observation.firstMentionPosition).filter((position): position is number => position !== null)
  return {
    status: relevant.length ? 'ready' : 'not_ready',
    totalQueries: activeIds.size,
    observedQueries: observedQueryIds.size,
    brandMentionRate: round(ratio(brandMentioned, relevant.length)),
    citationRate: round(ratio(cited, relevant.length)),
    exactCitationRate: round(ratio(exactCited, relevant.length)),
    competitorShareOfVoice: round(ratio(brandMentions, brandMentions + competitorMentions)),
    averageFirstMentionPosition: round(positions.length ? positions.reduce((sum, position) => sum + position, 0) / positions.length : null),
  }
}

function breakdown<T extends string>(keys: readonly T[], queries: MetricQuery[], observations: MetricObservation[], canonicalDomain: string, select: (row: MetricObservation) => T) {
  return Object.fromEntries(keys.map(key => [key, sliceMetrics(queries, observations.filter(row => select(row) === key), canonicalDomain)])) as Record<T, MetricSlice>
}

export function calculateVisibilityMetrics(input: { queries: MetricQuery[], observations: MetricObservation[], canonicalDomain: string, currentStart: Date, currentEnd: Date }) {
  const duration = input.currentEnd.getTime() - input.currentStart.getTime()
  const previousStart = new Date(input.currentStart.getTime() - duration)
  const inRange = (row: MetricObservation, start: Date, end: Date) => {
    const timestamp = new Date(row.observedAt).getTime()
    return timestamp >= start.getTime() && timestamp < end.getTime()
  }
  const allCurrentRows = input.observations.filter(row => inRange(row, input.currentStart, input.currentEnd))
  const allPreviousRows = input.observations.filter(row => inRange(row, previousStart, input.currentStart))
  const currentRows = allCurrentRows.filter(row => row.observationMode === 'manual_verified')
  const previousRows = allPreviousRows.filter(row => row.observationMode === 'manual_verified')
  const current = sliceMetrics(input.queries, currentRows, input.canonicalDomain)
  const previous = sliceMetrics(input.queries, previousRows, input.canonicalDomain)
  const delta = Object.fromEntries((['brandMentionRate', 'citationRate', 'exactCitationRate', 'competitorShareOfVoice', 'averageFirstMentionPosition'] as const).map(key => [key, current[key] === null || previous[key] === null ? null : round(current[key]! - previous[key]!)]))
  const withLocale = (locale: 'en' | 'zh-hant') => sliceMetrics(input.queries.filter(query => query.locale === locale), currentRows, input.canonicalDomain)
  return {
    current,
    previous,
    delta,
    byMode: breakdown(['manual_verified', 'provider_api_observation'] as const, input.queries, allCurrentRows, input.canonicalDomain, row => row.observationMode),
    byProvider: breakdown(['chatgpt', 'gemini', 'perplexity', 'google_ai_overview', 'manual_other'] as const, input.queries, currentRows, input.canonicalDomain, row => row.provider),
    byLocale: { en: withLocale('en'), 'zh-hant': withLocale('zh-hant') },
    period: { currentStart: input.currentStart.toISOString(), currentEnd: input.currentEnd.toISOString(), previousStart: previousStart.toISOString() },
  }
}
