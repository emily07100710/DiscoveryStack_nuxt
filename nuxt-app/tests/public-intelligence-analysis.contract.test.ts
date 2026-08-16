import { describe, expect, it } from 'vitest'
import { classifyJourneyFriction } from '../server/audit/classifier'
import { serialisePublicStructuralFeature } from '../server/public-intelligence/analysis'

describe('Public Intelligence analysis contract', () => {
  it('serialises only structural fields for BGE-M3, never source text, URLs, owners or outcomes', () => {
    const document = serialisePublicStructuralFeature({
      primaryJourneyStage: 'understanding',
      navigationDepth: 2,
      serviceRoutes: 4,
      signals: { primaryCta: true, serviceRouting: true, expertContact: false, insights: true, trustSignals: false, priceOrEstimator: false, faqOrGuidedTopics: true },
    })
    expect(document).toContain('contract=public-intelligence-structural-v1')
    expect(document).toContain('primaryCta=true')
    expect(document).not.toMatch(/https?:\/\//i)
    expect(document).not.toMatch(/@/)
    expect(document).not.toMatch(/revenue|conversion rate|customer name/i)
  })

  it('keeps the public structural baseline explainable and never infers conversion', () => {
    const assessments = classifyJourneyFriction([
      { id: 1, observationKey: 'journey.cta_present', valueText: 'false', evidenceQuote: null, sourceUrl: 'https://approved.example/page' },
      { id: 2, observationKey: 'journey.contact_route', valueText: 'false', evidenceQuote: null, sourceUrl: 'https://approved.example/page' },
      { id: 3, observationKey: 'content.service_language', valueText: 'false', evidenceQuote: null, sourceUrl: 'https://approved.example/page' },
    ], 'en')
    const conversion = assessments.find(item => item.journeyStage === 'conversion')
    expect(conversion?.assessmentStatus).toBe('insufficient_evidence')
    expect(conversion?.requiresHumanReview).toBe(true)
    expect(assessments.every(item => item.requiresHumanReview)).toBe(true)
  })
})
