import { describe, expect, it } from 'vitest'
import { suggestLabelsFromStructuralAnalysis } from '../server/model-improvement/pipeline'
import { robotsAllowsPath, type PublicSiteAnalysisResult } from '../server/utils/publicSiteAnalysis'

const analysis: PublicSiteAnalysisResult = {
  requestedUrl: 'https://example.com/',
  finalUrl: 'https://example.com/',
  hostname: 'example.com',
  analysedAt: '2026-08-22T00:00:00.000Z',
  analysisVersion: 'public-homepage-structural-v2',
  snapshotFingerprint: 'a'.repeat(64),
  scope: 'public_homepage_only',
  scores: { overall: 42, seo: 58, geo: 20, brandContent: 45, ux: 45 },
  checks: { titlePresent: true, h1Present: true, canonicalPresent: false, indexability: 'unknown', schemaPresent: false, schemaTypeCount: 0, internalLinkCount: 3, primaryCta: false, serviceRouting: true, expertContact: false, insights: false, trustSignals: false, priceOrEstimator: false, faqOrGuidedTopics: false },
  recommendationKeys: ['add_primary_action'],
}

describe('consented model-improvement pipeline', () => {
  it('uses longest-match robots rules and remains fail-closed for a blocked homepage', () => {
    expect(robotsAllowsPath('User-agent: *\nDisallow: /\nAllow: /public', '/')).toBe(false)
    expect(robotsAllowsPath('User-agent: *\nDisallow: /\nAllow: /public', '/public')).toBe(true)
    expect(robotsAllowsPath('User-agent: OtherBot\nDisallow: /', '/')).toBe(true)
  })

  it('creates only low-confidence label suggestions that still satisfy the nine-head contract', () => {
    const labels = suggestLabelsFromStructuralAnalysis(analysis)
    expect(labels.primaryJourneyStage).toBe('response')
    expect(labels.frictionSignals).toContain('weak_cta')
    expect(labels.reviewerConfidence).toBe(1)
    expect(labels.annotationRationale).toMatch(/owner must inspect/i)
  })
})
