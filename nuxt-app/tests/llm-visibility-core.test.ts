import { describe, expect, it } from 'vitest'
import { canonicalizePublicHttps, citationMatchesDomain, normalizedPromptHash } from '../server/llm-visibility/guards'
import { countBrandMentions, countCompetitorMentions } from '../server/llm-visibility/matching'
import { calculateVisibilityMetrics, type MetricObservation } from '../server/llm-visibility/metrics'
import { prepareProject } from '../server/llm-visibility/service'

describe('LLM visibility deterministic core', () => {
  it('matches aliases with Unicode/case normalization and exact English token boundaries', () => {
    expect(countBrandMentions('ＳＡＧＥ and Sage are named.', 'sage', []).exactMentionCount).toBe(2)
    expect(countBrandMentions('chair has letters but AI and AI-powered are tokens', 'AI', []).exactMentionCount).toBe(2)
    expect(countBrandMentions('DiscoveryStacker is unrelated', 'DiscoveryStack', []).mentioned).toBe(false)
  })

  it('deduplicates overlapping aliases and counts competitors deterministically', () => {
    expect(countBrandMentions('Sage Song', 'Sage Song', ['Sage']).exactMentionCount).toBe(1)
    expect(countCompetitorMentions('Alpha, alpha; Beta.', ['Alpha', 'Beta'])).toEqual({ Alpha: 2, Beta: 1 })
  })

  it('uses parsed exact hostnames instead of substring domain matching', () => {
    expect(citationMatchesDomain('https://example.com/path', 'example.com')).toBe(true)
    expect(citationMatchesDomain('https://notexample.com/path', 'example.com')).toBe(false)
    expect(citationMatchesDomain('https://example.com.evil.test/', 'example.com')).toBe(false)
  })

  it.each(['http://example.com', 'https://localhost/a', 'https://internal/', 'https://127.0.0.1/', 'https://10.0.0.1/', 'https://198.51.100.2/', 'https://[::ffff:127.0.0.1]/', 'https://user:pass@example.com/', 'javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/a'])(
    'rejects invalid or private URL %s', value => expect(() => canonicalizePublicHttps(value)).toThrow(),
  )

  it('canonicalizes public HTTPS and normalizes prompt identity', () => {
    expect(canonicalizePublicHttps('https://EXAMPLE.com:443//a#fragment')).toEqual({ url: 'https://example.com/a', hostname: 'example.com' })
    expect(normalizedPromptHash('  Best   café? ')).toBe(normalizedPromptHash('best café?'))
  })
})

describe('LLM visibility canonical project names', () => {
  const projectInput = { name: 'Monitor', canonicalWebsiteUrl: 'https://example.com/', locale: 'en' as const, brandName: ' Acme   Labs ', brandAliases: [] as string[], competitorBrands: [] as string[] }

  it('normalizes the saved brand name and canonical-dedupes aliases while preserving the first display spelling', () => {
    const prepared = prepareProject({ ...projectInput, brandName: ' Ａｃｍｅ　Ｌａｂｓ ', brandAliases: ['Acme Labs', 'Sage AI', 'sage ai', 'Ｓａｇｅ　ＡＩ'] })
    expect(prepared.brandName).toBe('Acme Labs')
    expect(prepared.brandAliases).toEqual(['Sage AI'])
  })

  it('keeps only the first canonical-equivalent competitor spelling', () => {
    const prepared = prepareProject({ ...projectInput, competitorBrands: ['OpenAI', 'openai', 'ＯｐｅｎＡＩ'] })
    expect(prepared.competitorBrands).toEqual(['OpenAI'])
  })

  it('fails closed when a competitor collides with the brand or an alias', () => {
    expect(() => prepareProject({ ...projectInput, brandAliases: ['Sage AI'], competitorBrands: ['Ｓａｇｅ　ＡＩ'] })).toThrow(expect.objectContaining({ statusCode: 422 }))
    expect(() => prepareProject({ ...projectInput, competitorBrands: ['ＡＣＭＥ　ＬＡＢＳ'] })).toThrow(expect.objectContaining({ statusCode: 422 }))
  })

  it('prevents casing variants from double-counting one competitor mention after preparation', () => {
    const prepared = prepareProject({ ...projectInput, competitorBrands: ['OpenAI', 'openai', 'ＯｐｅｎＡＩ'] })
    expect(countCompetitorMentions('OpenAI appears once.', prepared.competitorBrands)).toEqual({ OpenAI: 1 })
  })
})

describe('LLM visibility metrics', () => {
  const queries = [{ id: 1, locale: 'en' as const, active: true }, { id: 2, locale: 'zh-hant' as const, active: true }]
  const base = { queryId: 1, provider: 'chatgpt' as const, observationMode: 'manual_verified' as const, brandMentioned: true, exactMentionCount: 2, firstMentionPosition: 3, citationUrls: ['https://example.com/a'], competitorMentions: { Rival: 2 } }

  it('returns null and not_ready for every zero denominator rather than invented zero percent', () => {
    const result = calculateVisibilityMetrics({ queries, observations: [], canonicalDomain: 'example.com', currentStart: new Date('2026-08-01T00:00:00Z'), currentEnd: new Date('2026-09-01T00:00:00Z') })
    expect(result.current).toMatchObject({ status: 'not_ready', observedQueries: 0, n: 0, brandMentionRate: null, citationRate: null, exactCitationRate: null, competitorShareOfVoice: null, averageFirstMentionPosition: null, limitations: ['insufficient_sample'] })
    expect(result.current.estimates.brandMentionRate).toBeNull()
    expect(result.delta.brandMentionRate).toBeNull()
    expect(result.deltaLimitations).toContain('insufficient_sample')
  })

  it('separates manual/API modes and computes period delta, exact citation, locale and competitor share', () => {
    const observations: MetricObservation[] = [
      { ...base, observedAt: '2026-08-15T00:00:00Z' },
      { ...base, queryId: 2, provider: 'gemini', observationMode: 'provider_api_observation', observedAt: '2026-08-16T00:00:00Z', brandMentioned: false, exactMentionCount: 0, firstMentionPosition: null, citationUrls: ['https://notexample.com/'], competitorMentions: { Rival: 2 } },
      { ...base, observedAt: '2026-07-15T00:00:00Z', brandMentioned: false, exactMentionCount: 0, firstMentionPosition: null, citationUrls: [], competitorMentions: {} },
    ]
    const result = calculateVisibilityMetrics({ queries, observations, canonicalDomain: 'example.com', currentStart: new Date('2026-08-01T00:00:00Z'), currentEnd: new Date('2026-09-01T00:00:00Z') })
    expect(result.current).toMatchObject({ status: 'ready', observedQueries: 1, brandMentionRate: 1, citationRate: 1, exactCitationRate: 1, competitorShareOfVoice: .5 })
    expect(result.previous).toMatchObject({ status: 'ready', observedQueries: 1, brandMentionRate: 0, citationRate: 0, exactCitationRate: 0 })
    expect(result.byMode.manual_verified.observedQueries).toBe(1)
    expect(result.byMode.provider_api_observation.observedQueries).toBe(1)
    expect(result.byMode.manual_verified.brandMentionRate).toBe(1)
    expect(result.byMode.provider_api_observation.brandMentionRate).toBe(0)
    expect(result.byProvider.gemini.status).toBe('not_ready')
    expect(result.byProvider.chatgpt.brandMentionRate).toBe(1)
    expect(result.byProvider.perplexity.status).toBe('not_ready')
    expect(result.byLocale['zh-hant'].status).toBe('not_ready')
    expect(result.byLocale.en.brandMentionRate).toBe(1)
    expect(result.current.estimates.brandMentionRate?.confidenceInterval).toMatchObject({ level: 0.95 })
    expect(result.current.limitations).toEqual(['single_sample_not_trend'])
    expect(result.delta.brandMentionRate).toBeNull()
    expect(result.deltaLimitations).toContain('single_sample_not_trend')
  })

  it('maps competitor aliases into registry share of voice and preserves unlisted attribution', () => {
    const observations: MetricObservation[] = [
      { ...base, observedAt: '2026-08-15T00:00:00Z', competitorMentions: { RivalAlias: 2, Mystery: 1 } },
    ]
    const result = calculateVisibilityMetrics({ queries, observations, canonicalDomain: 'example.com', currentStart: new Date('2026-08-01T00:00:00Z'), currentEnd: new Date('2026-09-01T00:00:00Z'), competitorRegistry: [{ id: 9, name: 'Rival Incorporated', canonicalKey: 'rival incorporated', aliases: ['RivalAlias'] }] })
    expect(result.current.shareOfVoice).toMatchObject({ status: 'ready', n: 5, brandMentions: 2, brandShare: 0.4, listed: [{ competitorId: 9, name: 'Rival Incorporated', mentions: 2, share: 0.4 }], unlistedMentions: 1, unlistedShare: 0.2, unlistedNames: ['Mystery'] })
  })
})
