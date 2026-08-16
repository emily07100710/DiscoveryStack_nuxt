import { describe, expect, it } from 'vitest'
import { classifyJourneyFriction } from '../server/audit/classifier'
import { serialiseDeidentifiedFeature } from '../server/audit/huggingface'
import { assertSafeAuditTarget } from '../server/audit/targetGuard'
import { buildApprovedTrainingExample } from '../server/audit/training'
import { publicResearchCases } from '../server/audit/researchCases'
import { buildBaselineReadiness } from '../server/audit/baselines'

const observations = [
  { id: 1, observationKey: 'seo.title_present', valueText: 'false', evidenceQuote: 'No title tag recorded', sourceUrl: 'https://example.com/' },
  { id: 2, observationKey: 'content.service_language', valueText: 'false', evidenceQuote: 'No service-language signal recorded', sourceUrl: 'https://example.com/' },
]

describe('Journey Intelligence governance', () => {
  it('rejects local, credentialed and non-http audit targets', () => {
    expect(() => assertSafeAuditTarget('http://127.0.0.1/')).toThrow(/Private, local/)
    expect(() => assertSafeAuditTarget('https://person:pass@example.com/')).toThrow(/credentials/)
    expect(() => assertSafeAuditTarget('file:///etc/passwd')).toThrow(/http/)
    expect(assertSafeAuditTarget('https://Example.com/path#fragment').normalizedUrl).toBe('https://example.com/path')
  })

  it('never labels conversion from public-page signals and requires human review for every baseline assessment', () => {
    const assessments = classifyJourneyFriction(observations, 'en')
    const conversion = assessments.find(item => item.journeyStage === 'conversion')
    expect(conversion).toMatchObject({ assessmentStatus: 'insufficient_evidence', score: 0, requiresHumanReview: true })
    expect(assessments.every(item => item.requiresHumanReview)).toBe(true)
  })

  it('allows a training candidate only after consent, a passed quality check and a human rationale', () => {
    const assessments = classifyJourneyFriction(observations, 'en')
    const withheld = buildApprovedTrainingExample({ language: 'en', observations, assessments, workspaceTrainingConsent: false, review: { decision: 'confirmed', correctedPrimaryStage: 'discovery', reviewNote: 'Human reviewer confirms the label.', approvedForTraining: true, qualityCheckStatus: 'passed' } })
    expect(withheld).toBeNull()
    const candidate = buildApprovedTrainingExample({ language: 'en', observations, assessments, workspaceTrainingConsent: true, review: { decision: 'confirmed', correctedPrimaryStage: 'discovery', reviewNote: 'Human reviewer confirms the label.', approvedForTraining: true, qualityCheckStatus: 'passed' } })
    expect(candidate).toMatchObject({ labelStage: 'discovery', labelDecision: 'confirmed', featureContractVersion: 'journey-features-v1' })
  })

  it('serialises only de-identified feature aggregates for BGE-M3', () => {
    const candidate = buildApprovedTrainingExample({ language: 'en', observations, assessments: classifyJourneyFriction(observations, 'en'), workspaceTrainingConsent: true, review: { decision: 'amended', correctedPrimaryStage: 'understanding', reviewNote: 'Strategist correction.', approvedForTraining: true, qualityCheckStatus: 'passed' } })
    expect(candidate).not.toBeNull()
    const payload = serialiseDeidentifiedFeature({ id: 9, auditRunId: 3, labelStage: candidate!.labelStage, labelDecision: candidate!.labelDecision, featureVector: candidate!.featureVector })
    expect(payload).toContain('contract=journey-features-v1')
    expect(payload).not.toContain('https://example.com')
    expect(payload).not.toContain('No title tag recorded')
  })

  it('keeps the four public research cases as private Source Card candidates, never auto-admitted model inputs', () => {
    expect(publicResearchCases).toHaveLength(4)
    for (const item of publicResearchCases) {
      expect(item.status).toBe('pending_source_card_review')
      expect(item.restrictions).toEqual(['private_registry', 'policy_gate_required', 'no_client_outcome_claim', 'not_auto_admitted'])
      expect(Object.values(item.signals).every(value => typeof value === 'boolean')).toBe(true)
    }
  })

  it('keeps BGE-M3 and supervised learning gated until consented coverage is sufficient', () => {
    const readiness = buildBaselineReadiness({ consentedCandidates: 1, stageCounts: { discovery: 1 }, huggingFaceConfigured: true })
    expect(readiness.bgeM3.status).toBe('needs_two_consented_candidates')
    expect(readiness.bgeM3.similarityOnly).toBe(true)
    expect(readiness.supervisedLearning.status).toBe('not_ready')
    expect(readiness.supervisedLearning.requiresHumanReview).toBe(true)
  })
})
