import { describe, expect, it } from 'vitest'
import { publicArtifactInputSchema } from '../server/public-intelligence/featureContract'
import { buildSeoGeoTrainingText, seoGeoMultilabelSchema, toSeoGeoTrainingTargets } from '../server/public-intelligence/seoGeoTaxonomy'

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

  it('accepts a versioned, multi-dimensional SEO/GEO human label', () => {
    const result = publicArtifactInputSchema.safeParse({ ...base, artifactType: 'human_annotation', fieldData: { annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding', journeyStages: ['discovery', 'understanding'], searchIntents: ['informational', 'commercial'], contentTypes: ['service', 'faq'], audienceRoles: ['buyer', 'researcher'], topicClusters: ['technical SEO', 'schema markup'], entitySignals: [{ name: 'Schema.org', type: 'concept', relationship: 'Explains structured data.' }], geoSignals: ['global', 'multilingual'], citationReadiness: ['first_party_expertise', 'structured_data'], technicalSeoSignals: ['title_present', 'h1_present', 'canonical_present', 'structured_data'], frictionSignals: ['weak_cta'], actionPriority: 'high', annotationRationale: 'The reviewed page explains a service clearly but leaves the next decision step ambiguous.', reviewerConfidence: 4 } })
    expect(result.success).toBe(true)
  })

  it('rejects a multi-dimensional label without a human rationale', () => {
    const result = publicArtifactInputSchema.safeParse({ ...base, artifactType: 'human_annotation', fieldData: { annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding', journeyStages: ['understanding'], searchIntents: ['informational'], contentTypes: ['service'], audienceRoles: ['buyer'], topicClusters: ['technical SEO'], entitySignals: [{ name: 'SEO', type: 'concept', relationship: 'Topic.' }], geoSignals: ['global'], citationReadiness: ['first_party_expertise'], technicalSeoSignals: ['title_present'], frictionSignals: ['weak_cta'], actionPriority: 'high', annotationRationale: 'short', reviewerConfidence: 4 } })
    expect(result.success).toBe(false)
  })

  it('separates reviewed source content from multi-task human targets to prevent label leakage', () => {
    const annotation = seoGeoMultilabelSchema.parse({ annotationKind: 'seo_geo_multilabel', annotationVersion: 'seo-geo-journey-v1', primaryJourneyStage: 'understanding', journeyStages: ['understanding'], searchIntents: ['informational'], contentTypes: ['service'], audienceRoles: ['buyer'], topicClusters: ['technical SEO'], entitySignals: [{ name: 'SEO', type: 'concept', relationship: 'Subject of the approved source text.' }], geoSignals: ['global'], citationReadiness: ['first_party_expertise'], technicalSeoSignals: ['title_present'], frictionSignals: ['weak_cta'], actionPriority: 'high', annotationRationale: 'The reviewer found a clear service explanation but a weak decision route.', reviewerConfidence: 4 })
    const text = buildSeoGeoTrainingText({ artifactText: 'This approved page explains crawling, indexing and canonical URLs.', language: 'en' })
    expect(text).toContain('crawling')
    expect(text).not.toContain('weak_cta')
    expect(text).not.toContain(annotation.annotationRationale)
    expect(toSeoGeoTrainingTargets(annotation)).toMatchObject({ journeyStage: 'understanding', searchIntents: ['informational'], actionPriority: 'high' })
  })
})
