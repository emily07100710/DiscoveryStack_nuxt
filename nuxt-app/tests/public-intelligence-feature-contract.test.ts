import { describe, expect, it } from 'vitest'
import { publicArtifactInputSchema } from '../server/public-intelligence/featureContract'

const base = {
  sourceId: 1,
  sourceUrl: 'https://example.com/service',
  sourceLocator: 'main > section:nth-of-type(2) h2',
  sourceSpanHash: 'a'.repeat(64),
  extractionMethod: 'human_annotation' as const,
  requestedUse: 'research_only' as const,
}

describe('Public Intelligence feature contract', () => {
  it('accepts a traceable typed structural artifact', () => {
    const result = publicArtifactInputSchema.safeParse({ ...base, artifactType: 'structural_features', fieldData: { signals: { primaryCta: true, serviceRouting: true, expertContact: false, insights: true, trustSignals: true, priceOrEstimator: false, faqOrGuidedTopics: true }, primaryJourneyStage: 'understanding', navigationDepth: 2, serviceRoutes: 5 } })
    expect(result.success).toBe(true)
  })

  it('rejects an artifact with no review locator or source-span hash', () => {
    const result = publicArtifactInputSchema.safeParse({ ...base, sourceLocator: '', sourceSpanHash: 'not-a-hash', artifactType: 'topic_map', fieldData: { topics: ['SEO'], searchIntents: ['informational'], primaryTopic: 'SEO' } })
    expect(result.success).toBe(false)
  })

  it('rejects feature fields outside the selected family contract', () => {
    const result = publicArtifactInputSchema.safeParse({ ...base, artifactType: 'technical_seo', fieldData: { arbitrary: 'free JSON' } })
    expect(result.success).toBe(false)
  })
})
