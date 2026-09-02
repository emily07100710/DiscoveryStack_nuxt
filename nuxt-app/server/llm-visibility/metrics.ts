import type { VisibilityMode, VisibilityProvider } from './contracts'
import { citationMatchesDomain } from './guards'
import { normalizeMatchText } from './matching'
import { INSUFFICIENT_SAMPLE, SINGLE_SAMPLE_NOT_TREND, meanEstimate, proportionEstimate, sampleLimitations } from './statistics'

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
export type VisibilityCompetitorRegistryEntry = { id: number, name: string, canonicalKey: string, aliases: string[], active?: boolean }

type MetricSlice = {
  status: 'ready' | 'not_ready'
  totalQueries: number
  observedQueries: number
  n: number
  brandMentionRate: number | null
  citationRate: number | null
  exactCitationRate: number | null
  competitorShareOfVoice: number | null
  averageFirstMentionPosition: number | null
  estimates: {
    brandMentionRate: ReturnType<typeof proportionEstimate>
    citationRate: ReturnType<typeof proportionEstimate>
    exactCitationRate: ReturnType<typeof proportionEstimate>
    competitorShareOfVoice: ReturnType<typeof proportionEstimate>
  }
  firstMentionPosition: ReturnType<typeof meanEstimate>
  limitations: string[]
  shareOfVoice: RegistryShareOfVoice
}

export type RegistryShareOfVoice = {
  status: 'ready' | 'not_ready'
  n: number
  brandMentions: number
  brandShare: number | null
  listed: Array<{ competitorId: number, name: string, mentions: number, share: number | null }>
  unlistedMentions: number
  unlistedShare: number | null
  unlistedNames: string[]
}

function ratio(numerator: number, denominator: number) { return denominator === 0 ? null : numerator / denominator }
const round = (value: number | null) => value === null ? null : Math.round(value * 10000) / 10000

export function calculateRegistryShareOfVoice(observations: MetricObservation[], registry: VisibilityCompetitorRegistryEntry[]): RegistryShareOfVoice {
  const aliasOwners = new Map<string, VisibilityCompetitorRegistryEntry>()
  for (const competitor of registry) {
    for (const key of [competitor.canonicalKey, competitor.name, ...competitor.aliases].map(normalizeMatchText).filter(Boolean)) {
      if (!aliasOwners.has(key)) aliasOwners.set(key, competitor)
    }
  }
  const listedMentions = new Map(registry.map(competitor => [competitor.id, 0]))
  const unlisted = new Map<string, { name: string, mentions: number }>()
  for (const observation of observations) {
    for (const [name, mentions] of Object.entries(observation.competitorMentions)) {
      if (!Number.isFinite(mentions) || mentions <= 0) continue
      const key = normalizeMatchText(name)
      const listed = aliasOwners.get(key)
      if (listed) listedMentions.set(listed.id, (listedMentions.get(listed.id) || 0) + mentions)
      else {
        const current = unlisted.get(key)
        unlisted.set(key, { name: current?.name || name.trim(), mentions: (current?.mentions || 0) + mentions })
      }
    }
  }
  const brandMentions = observations.reduce((sum, observation) => sum + observation.exactMentionCount, 0)
  const competitorMentions = [...listedMentions.values()].reduce((sum, count) => sum + count, 0)
  const unlistedMentions = [...unlisted.values()].reduce((sum, item) => sum + item.mentions, 0)
  const n = brandMentions + competitorMentions + unlistedMentions
  return {
    status: n > 0 ? 'ready' : 'not_ready',
    n,
    brandMentions,
    brandShare: round(ratio(brandMentions, n)),
    listed: registry.map(competitor => {
      const mentions = listedMentions.get(competitor.id) || 0
      return { competitorId: competitor.id, name: competitor.name, mentions, share: round(ratio(mentions, n)) }
    }),
    unlistedMentions,
    unlistedShare: round(ratio(unlistedMentions, n)),
    unlistedNames: [...unlisted.values()].sort((left, right) => normalizeMatchText(left.name).localeCompare(normalizeMatchText(right.name))).slice(0, 20).map(item => item.name),
  }
}

function sliceMetrics(queries: MetricQuery[], observations: MetricObservation[], canonicalDomain: string, competitorRegistry: VisibilityCompetitorRegistryEntry[]): MetricSlice {
  const activeIds = new Set(queries.filter(query => query.active).map(query => query.id))
  const relevant = observations.filter(observation => activeIds.has(observation.queryId))
  const observedQueryIds = new Set(relevant.map(observation => observation.queryId))
  const brandMentioned = relevant.filter(observation => observation.brandMentioned).length
  const cited = relevant.filter(observation => observation.citationUrls.length > 0).length
  const exactCited = relevant.filter(observation => observation.citationUrls.some(url => citationMatchesDomain(url, canonicalDomain))).length
  const brandMentions = relevant.reduce((sum, observation) => sum + observation.exactMentionCount, 0)
  const competitorMentions = relevant.reduce((sum, observation) => sum + Object.values(observation.competitorMentions).reduce((inner, count) => inner + count, 0), 0)
  const positions = relevant.map(observation => observation.firstMentionPosition).filter((position): position is number => position !== null)
  const firstMentionPosition = meanEstimate(positions)
  return {
    status: relevant.length ? 'ready' : 'not_ready',
    totalQueries: activeIds.size,
    observedQueries: observedQueryIds.size,
    n: relevant.length,
    brandMentionRate: round(ratio(brandMentioned, relevant.length)),
    citationRate: round(ratio(cited, relevant.length)),
    exactCitationRate: round(ratio(exactCited, relevant.length)),
    competitorShareOfVoice: round(ratio(brandMentions, brandMentions + competitorMentions)),
    averageFirstMentionPosition: round(firstMentionPosition?.mean ?? null),
    estimates: {
      brandMentionRate: proportionEstimate(brandMentioned, relevant.length),
      citationRate: proportionEstimate(cited, relevant.length),
      exactCitationRate: proportionEstimate(exactCited, relevant.length),
      competitorShareOfVoice: proportionEstimate(brandMentions, brandMentions + competitorMentions),
    },
    firstMentionPosition,
    limitations: sampleLimitations(relevant.length, relevant.length),
    shareOfVoice: calculateRegistryShareOfVoice(relevant, competitorRegistry),
  }
}

function breakdown<T extends string>(keys: readonly T[], queries: MetricQuery[], observations: MetricObservation[], canonicalDomain: string, competitorRegistry: VisibilityCompetitorRegistryEntry[], select: (row: MetricObservation) => T) {
  return Object.fromEntries(keys.map(key => [key, sliceMetrics(queries, observations.filter(row => select(row) === key), canonicalDomain, competitorRegistry)])) as Record<T, MetricSlice>
}

export function calculateVisibilityMetrics(input: { queries: MetricQuery[], observations: MetricObservation[], canonicalDomain: string, currentStart: Date, currentEnd: Date, competitorRegistry?: VisibilityCompetitorRegistryEntry[] }) {
  const competitorRegistry = input.competitorRegistry || []
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
  const current = sliceMetrics(input.queries, currentRows, input.canonicalDomain, competitorRegistry)
  const previous = sliceMetrics(input.queries, previousRows, input.canonicalDomain, competitorRegistry)
  const deltaLimitations = [...new Set([
    ...(current.n === 0 || previous.n === 0 ? [INSUFFICIENT_SAMPLE] : []),
    ...(current.n === 1 || previous.n === 1 ? [SINGLE_SAMPLE_NOT_TREND] : []),
  ])]
  const delta = Object.fromEntries((['brandMentionRate', 'citationRate', 'exactCitationRate', 'competitorShareOfVoice', 'averageFirstMentionPosition'] as const).map(key => [key, current.n < 2 || previous.n < 2 || current[key] === null || previous[key] === null ? null : round(current[key]! - previous[key]!)]))
  const withLocale = (locale: 'en' | 'zh-hant') => sliceMetrics(input.queries.filter(query => query.locale === locale), currentRows, input.canonicalDomain, competitorRegistry)
  return {
    current,
    previous,
    delta,
    deltaLimitations,
    byMode: breakdown(['manual_verified', 'provider_api_observation'] as const, input.queries, allCurrentRows, input.canonicalDomain, competitorRegistry, row => row.observationMode),
    byProvider: breakdown(['chatgpt', 'gemini', 'perplexity', 'google_ai_overview', 'manual_other'] as const, input.queries, currentRows, input.canonicalDomain, competitorRegistry, row => row.provider),
    byLocale: { en: withLocale('en'), 'zh-hant': withLocale('zh-hant') },
    period: { currentStart: input.currentStart.toISOString(), currentEnd: input.currentEnd.toISOString(), previousStart: previousStart.toISOString() },
  }
}
