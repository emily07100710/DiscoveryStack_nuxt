import { describe, expect, it } from 'vitest'
import {
  OUTCOME_DATA_CONTRACT_VERSION,
  OUTCOME_EVALUATION_CONTRACT_VERSION,
  OUTCOME_LEARNING_ENGINE_VERSION,
  OUTCOME_MAX_DATASET_CANDIDATES,
  assessPublishedContentOutcome,
  buildOutcomeDatasetManifest,
  buildOutcomeLearningCandidate,
  evaluateModelReleaseGate,
  normalizeOutcomeLearningCandidate,
  normalizeOutcomeMeasurement,
  normalizeOutcomeTimestamp,
  normalizePublicationIdentity,
  type OutcomeLearningCandidateResult,
  outcomeMeasurementSources,
  outcomeSha256,
} from '../server/outcome-learning'
import {
  DATA_CONTRACT_VERSION,
  SCOPE_KEY,
  SUBJECT_KEY,
  makeCandidateInput,
  makeEligibleCandidate,
  makeGrantedConsent,
  makeMeasurement,
  makeOutcomeRequest,
  makePassingReleaseGate,
  makePublication,
} from './fixtures/outcome-learning/measurements'

function expectBlocked(result: OutcomeLearningCandidateResult, ...reasons: string[]): void {
  expect(result.candidateStatus).toBe('blocked')
  if (result.candidateStatus === 'blocked') for (const reason of reasons) expect(result.reasonCodes).toContain(reason)
}

describe('DiscoveryStack Outcome Learning Loop Engine V1', () => {
  it('exports the fixed engine version', () => {
    expect(OUTCOME_LEARNING_ENGINE_VERSION).toBe('outcome-learning-loop-engine-v1')
  })

  it('accepts exactly the four governed measurement sources', () => {
    expect(outcomeMeasurementSources).toEqual(['google_search_console', 'llm_visibility', 'first_party_analytics', 'crm_aggregate'])
  })

  it.each(['google_search_console', 'llm_visibility', 'first_party_analytics', 'crm_aggregate'] as const)('normalizes a valid %s aggregate measurement', (source) => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ source }))).not.toBeNull()
  })

  it('canonicalizes an offset timestamp to UTC ISO', () => {
    expect(normalizeOutcomeTimestamp('2025-01-01T08:00:00+08:00')).toBe('2025-01-01T00:00:00.000Z')
  })

  it('rejects timestamps without an explicit timezone', () => {
    expect(normalizeOutcomeTimestamp('2025-01-01T00:00:00')).toBeNull()
  })

  it.each([
    '2025-99-99T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2025-04-31T23:59:59+00:00',
    '2025-01-01T24:00:00Z',
    '2025-01-01T00:60:00Z',
    '2025-01-01T00:00:60Z',
    '2025-01-01T00:00:00+24:00',
    '2025-01-01T00:00:00+08:60',
  ])('rejects invalid calendar timestamp %s', (timestamp) => {
    expect(normalizeOutcomeTimestamp(timestamp)).toBeNull()
  })

  it('accepts a valid leap-day timestamp', () => {
    expect(normalizeOutcomeTimestamp('2024-02-29T23:59:59Z')).toBe('2024-02-29T23:59:59.000Z')
  })

  it('rejects an unknown measurement source', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ source: 'unknown' as never }))).toBeNull()
  })

  it('rejects a non-SHA subject key', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ deidentifiedSubjectKey: 'company.example' }))).toBeNull()
  })

  it('accepts a valid upstream deidentified subject key', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ deidentifiedSubjectKey: SUBJECT_KEY }))?.deidentifiedSubjectKey).toBe(SUBJECT_KEY)
  })

  it('rejects a non-SHA scope fingerprint', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ scopeFingerprint: 'scope' }))).toBeNull()
  })

  it('accepts a valid scope fingerprint', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ scopeFingerprint: SCOPE_KEY }))?.scopeFingerprint).toBe(SCOPE_KEY)
  })

  it('rejects a non-SHA source hash', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ sourceHash: 'bad-hash' }))).toBeNull()
  })

  it('rejects a tampered source hash', () => {
    const measurement = makeMeasurement({ metrics: { impressions: 701, clicks: 70, averagePosition: 10 } })
    expect(normalizeOutcomeMeasurement({ ...measurement, metrics: { impressions: 702, clicks: 70, averagePosition: 10 } })).toBeNull()
  })

  it('rejects a window where start is after end', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ windowStart: '2025-01-09T00:00:00Z', windowEnd: '2025-01-08T00:00:00Z' }))).toBeNull()
  })

  it('rejects a zero-length window', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ windowStart: '2025-01-08T00:00:00Z', windowEnd: '2025-01-08T00:00:00Z' }))).toBeNull()
  })

  it('rejects capturedAt before windowEnd', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ capturedAt: '2025-01-07T00:00:00Z' }))).toBeNull()
  })

  it('rejects a negative count', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: -1, clicks: 0, averagePosition: 10 } }))).toBeNull()
  })

  it('rejects NaN metrics', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: Number.NaN, clicks: 0, averagePosition: 10 }, sourceHash: 'f'.repeat(64) }))).toBeNull()
  })

  it('rejects Infinity metrics', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: Number.POSITIVE_INFINITY, clicks: 0, averagePosition: 10 }, sourceHash: 'f'.repeat(64) }))).toBeNull()
  })

  it('rejects fractional count metrics', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: 1.5, clicks: 0, averagePosition: 10 } }))).toBeNull()
  })

  it('rejects GSC clicks greater than impressions', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: 5, clicks: 6, averagePosition: 10 } }))).toBeNull()
  })

  it('rejects non-positive averagePosition', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: 5, clicks: 2, averagePosition: 0 } }))).toBeNull()
  })

  it('rejects LLM mentionCount greater than queryCount', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ source: 'llm_visibility', metrics: { queryCount: 3, mentionCount: 4, citationCount: 1 } }))).toBeNull()
  })

  it('rejects LLM citationCount greater than queryCount', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ source: 'llm_visibility', metrics: { queryCount: 3, mentionCount: 1, citationCount: 4 } }))).toBeNull()
  })

  it('rejects engagedSessions greater than sessions', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ source: 'first_party_analytics', metrics: { sessions: 3, engagedSessions: 4 } }))).toBeNull()
  })

  it('rejects conversions greater than qualifiedLeads', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ source: 'crm_aggregate', metrics: { qualifiedLeads: 3, conversions: 4 } }))).toBeNull()
  })

  it('derives GSC CTR and preserves average position', () => {
    const measurement = normalizeOutcomeMeasurement(makeMeasurement())
    expect(measurement?.derivedMetrics.ctr).toBeCloseTo(0.1)
    expect(measurement?.metrics.averagePosition).toBe(10)
  })

  it('derives LLM mention and citation rates', () => {
    const measurement = normalizeOutcomeMeasurement(makeMeasurement({ source: 'llm_visibility' }))
    expect(measurement?.derivedMetrics.mentionRate).toBe(0.2)
    expect(measurement?.derivedMetrics.citationRate).toBe(0.1)
  })

  it('derives first-party engagement rate', () => {
    const measurement = normalizeOutcomeMeasurement(makeMeasurement({ source: 'first_party_analytics' }))
    expect(measurement?.derivedMetrics.engagementRate).toBe(0.6)
  })

  it('derives CRM conversion rate', () => {
    const measurement = normalizeOutcomeMeasurement(makeMeasurement({ source: 'crm_aggregate' }))
    expect(measurement?.derivedMetrics.conversionRate).toBe(0.2)
  })

  it('normalizes publication identity hashes and applied rules', () => {
    const publication = normalizePublicationIdentity(makePublication())
    expect(publication?.appliedRuleIds).toEqual(['rule-a', 'rule-b'])
    expect(publication?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects publication identity with a missing content hash', () => {
    expect(normalizePublicationIdentity({ ...makePublication(), contentHash: null })).toBeNull()
  })

  it('rejects publication identity with a missing evidence snapshot hash', () => {
    expect(normalizePublicationIdentity({ ...makePublication(), evidenceSnapshotHash: '' })).toBeNull()
  })

  it('rejects publication identity with a company name', () => {
    expect(normalizePublicationIdentity({ ...makePublication(), companyName: 'Synthetic Company' })).toBeNull()
  })

  it('rejects publication identity with a URL', () => {
    expect(normalizePublicationIdentity({ ...makePublication(), url: 'https://synthetic.example' })).toBeNull()
  })

  it('produces a positive GSC observational signal after daily normalization', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest())
    expect(assessment.status).toBe('partial')
    expect(assessment.signal).toBe('positive_signal')
    expect(assessment.comparisons[0]?.followUpDailyMetrics.impressionsPerDay).toBe(200)
  })

  it('does not compare raw totals when baseline and follow-up windows differ', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({
      baselineMeasurements: [makeMeasurement({ windowEnd: '2025-01-06T00:00:00Z', capturedAt: '2025-01-06T01:00:00Z', metrics: { impressions: 500, clicks: 50, averagePosition: 10 } })],
      followUpMeasurements: [makeMeasurement({ phase: 'follow_up', windowStart: '2025-01-10T00:00:00Z', windowEnd: '2025-01-24T00:00:00Z', capturedAt: '2025-01-25T00:00:00Z', metrics: { impressions: 1000, clicks: 100, averagePosition: 10 } })],
    }))
    expect(assessment.status).toBe('partial')
    expect(assessment.comparisons[0]?.baselineDailyMetrics.impressionsPerDay).toBeCloseTo(100)
    expect(assessment.comparisons[0]?.followUpDailyMetrics.impressionsPerDay).toBeCloseTo(71.428571)
    expect(assessment.signal).toBe('negative_signal')
  })

  it('rejects a baseline window after publication', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ baselineMeasurements: [makeMeasurement({ windowStart: '2025-01-11T00:00:00Z', windowEnd: '2025-01-12T00:00:00Z', capturedAt: '2025-01-12T01:00:00Z' })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('WINDOW_MISMATCH')
  })

  it('rejects a follow-up window beginning before publication', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', windowStart: '2025-01-09T00:00:00Z', windowEnd: '2025-01-16T00:00:00Z', capturedAt: '2025-01-17T00:00:00Z' })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('WINDOW_MISMATCH')
  })

  it('rejects a follow-up shorter than seven days', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', windowEnd: '2025-01-16T00:00:00Z', capturedAt: '2025-01-17T00:00:00Z' })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('WINDOW_MISMATCH')
  })

  it('rejects a follow-up longer than ninety days', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', windowEnd: '2025-05-01T00:00:00Z', capturedAt: '2025-05-02T00:00:00Z' })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('WINDOW_MISMATCH')
  })

  it('rejects overlapping baseline and follow-up windows', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', windowStart: '2025-01-07T00:00:00Z', windowEnd: '2025-01-14T00:00:00Z', capturedAt: '2025-01-15T00:00:00Z' })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('OVERLAPPING_WINDOWS')
  })

  it('rejects source mismatch', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ source: 'llm_visibility', phase: 'follow_up' })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('SOURCE_MISMATCH')
  })

  it('rejects subject mismatch', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', deidentifiedSubjectKey: 'c'.repeat(64) })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('SUBJECT_MISMATCH')
  })

  it('rejects scope mismatch', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', scopeFingerprint: 'd'.repeat(64) })] }))
    expect(assessment.status).toBe('blocked')
    expect(assessment.reasonCodes).toContain('SCOPE_MISMATCH')
  })

  it('returns insufficient_data when no pair exists', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({ baselineMeasurements: [], followUpMeasurements: [] }))
    expect(assessment.status).toBe('insufficient_data')
    expect(assessment.reasonCodes).toContain('NO_VALID_PAIR')
  })

  it('returns partial for one valid source', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest())
    expect(assessment.status).toBe('partial')
    expect(assessment.validSourceCount).toBe(1)
  })

  it('returns ready only when two sources are valid and comparable', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({
      baselineMeasurements: [makeMeasurement(), makeMeasurement({ source: 'llm_visibility' })],
      followUpMeasurements: [makeMeasurement({ phase: 'follow_up', metrics: { impressions: 1400, clicks: 210, averagePosition: 8 } }), makeMeasurement({ source: 'llm_visibility', phase: 'follow_up', metrics: { queryCount: 100, mentionCount: 40, citationCount: 20 } })],
    }))
    expect(assessment.status).toBe('ready')
    expect(assessment.validSourceCount).toBe(2)
  })

  it('returns mixed_signal when source metric directions conflict', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest({
      baselineMeasurements: [makeMeasurement()],
      followUpMeasurements: [makeMeasurement({ phase: 'follow_up', metrics: { impressions: 1400, clicks: 10, averagePosition: 12 } })],
    }))
    expect(assessment.signal).toBe('mixed_signal')
  })

  it('includes all required non-causal limitations', () => {
    const assessment = assessPublishedContentOutcome(makeOutcomeRequest())
    expect(assessment.limitations).toEqual(expect.arrayContaining(['observational_not_causal', 'platform_measurement_may_change', 'attribution_not_established', 'external_factors_not_controlled']))
  })

  it('does not expose causal lift or truth score fields', () => {
    const serialized = JSON.stringify(assessPublishedContentOutcome(makeOutcomeRequest()))
    expect(serialized).not.toContain('causalLift')
    expect(serialized).not.toContain('truthScore')
    expect(serialized).not.toContain('ROI')
  })

  it('is deterministic for repeated assessment', () => {
    const request = makeOutcomeRequest()
    expect(assessPublishedContentOutcome(request).assessmentFingerprint).toBe(assessPublishedContentOutcome(request).assessmentFingerprint)
  })

  it('changes assessment fingerprint when source hash lineage changes', () => {
    const first = assessPublishedContentOutcome(makeOutcomeRequest())
    const second = assessPublishedContentOutcome(makeOutcomeRequest({ followUpMeasurements: [makeMeasurement({ phase: 'follow_up', metrics: { impressions: 1400, clicks: 210, averagePosition: 8 }, capturedAt: '2025-01-19T00:00:00Z' })] }))
    expect(first.assessmentFingerprint).not.toBe(second.assessmentFingerprint)
  })

  it('requires explicit granted consent for a learning candidate', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentStatus: 'not_granted' }) }))
    expectBlocked(result, 'CONSENT_REQUIRED')
  })

  it('requires a non-empty consent version', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentVersion: '' }) }))
    expectBlocked(result, 'CONSENT_REQUIRED')
  })

  it('requires a valid consentedAt timestamp', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentedAt: '2025-01-01T00:00:00' }) }))
    expectBlocked(result, 'CONSENT_REQUIRED')
  })

  it('requires model_improvement in allowed uses', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentAllowedUses: ['research'] }) }))
    expectBlocked(result, 'CONSENT_USE_NOT_ALLOWED')
  })

  it('blocks revoked consent', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentRevokedAt: '2025-02-01T00:00:00Z' }) }))
    expectBlocked(result, 'CONSENT_REVOKED')
  })

  it('requires rights confirmation', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ rightsConfirmed: false }) }))
    expectBlocked(result, 'RIGHTS_NOT_CONFIRMED')
  })

  it('requires a clean PII scan', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ piiScanStatus: 'detected' }))
    expectBlocked(result, 'PII_DETECTED')
  })

  it('requires a data contract version', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ dataContractVersion: '' }))
    expectBlocked(result, 'DATA_CONTRACT_MISSING')
  })

  it('requires ready or partial outcome status and a valid pair', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ outcomeRequest: makeOutcomeRequest({ baselineMeasurements: [], followUpMeasurements: [] }) }))
    expectBlocked(result, 'CANDIDATE_NOT_ELIGIBLE', 'NO_VALID_PAIR')
  })

  it('builds an eligible candidate with aggregate-only features', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    expect(result.candidateStatus).toBe('eligible')
    expect(result.candidateFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result).toHaveProperty('aggregateNumericFeatures')
  })

  it('stores publication identity hashes rather than raw publication identity', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    expect(result.candidateStatus).toBe('eligible')
    expect(JSON.stringify(result)).not.toContain('schedule-entry-001')
    expect(JSON.stringify(result)).not.toContain('synthetic content')
  })

  it('stores consent lineage and limitations', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    expect(result.candidateStatus).toBe('eligible')
    if (result.candidateStatus === 'eligible') {
      expect(result.consentLineage.consentStatus).toBe('granted')
      expect(result.limitations).toContain('observational_not_causal')
    }
  })

  it('rejects raw content keys recursively', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), nested: { articleBody: 'synthetic body' } })
    expectBlocked(result, 'FORBIDDEN_PAYLOAD_KEY')
  })

  it('rejects mixed-case forbidden keys', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), nested: { EmaIl: 'synthetic@example.invalid' } })
    expectBlocked(result, 'FORBIDDEN_PAYLOAD_KEY')
  })

  it('rejects snake-case forbidden keys', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), nested: { raw_content: 'synthetic body' } })
    expectBlocked(result, 'FORBIDDEN_PAYLOAD_KEY')
  })

  it.each([null, undefined, 'primitive', 42, []])('fails closed for malformed assessment input %#', (input) => {
    expect(() => assessPublishedContentOutcome(input)).not.toThrow()
    expect(assessPublishedContentOutcome(input).status).toBe('blocked')
  })

  it.each([null, undefined, 'primitive', 42, []])('fails closed for malformed candidate input %#', (input) => {
    expect(() => buildOutcomeLearningCandidate(input)).not.toThrow()
    expect(buildOutcomeLearningCandidate(input).candidateStatus).toBe('blocked')
  })

  it('rejects candidate assessment fingerprint tampering', () => {
    const input = makeCandidateInput()
    const result = buildOutcomeLearningCandidate({ ...input, assessment: { ...input.assessment, assessmentFingerprint: 'f'.repeat(64) } })
    expectBlocked(result, 'CANDIDATE_NOT_ELIGIBLE')
  })

  it('rejects a duplicate source hash pair', () => {
    const baseline = makeMeasurement()
    const followUp = makeMeasurement({ phase: 'follow_up', sourceHash: baseline.sourceHash })
    const result = assessPublishedContentOutcome(makeOutcomeRequest({ baselineMeasurements: [baseline], followUpMeasurements: [followUp] }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('DUPLICATE_SOURCE_HASH')
  })

  it('rejects more than 100 measurements before deep normalization', () => {
    const measurements = Array.from({ length: 101 }, () => makeMeasurement())
    const result = assessPublishedContentOutcome(makeOutcomeRequest({ baselineMeasurements: measurements, followUpMeasurements: [] }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('TOO_MANY_MEASUREMENTS')
  })

  it('rejects more than 500 metric fields before deep normalization', () => {
    const measurements = Array.from({ length: 101 }, () => ({ metrics: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`field-${index}`, 1])) }))
    const result = assessPublishedContentOutcome(makeOutcomeRequest({ baselineMeasurements: measurements, followUpMeasurements: [] }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain('TOO_MANY_METRIC_FIELDS')
  })

  it('does not read candidate fields when learning input is a forbidden proxy', () => {
    let reads = 0
    const guarded = new Proxy(makeCandidateInput(), { get(_target, key) { reads += 1; throw new Error(`read ${String(key)}`) } })
    const result = buildOutcomeLearningCandidate(guarded)
    expect(result.candidateStatus).toBe('blocked')
    expect(reads).toBeGreaterThan(0)
  })

  it('blocks a dataset manifest with fewer than 150 candidates', () => {
    const candidates = Array.from({ length: 10 }, (_, index) => makeEligibleCandidate(index, 'article', 'en', ['google_search_console', 'llm_visibility']))
    const result = buildOutcomeDatasetManifest({ candidates })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('DATASET_ADMISSION_GATE_BLOCKED')
  })

  it('blocks a dataset manifest with duplicate candidates', () => {
    const candidate = makeEligibleCandidate(1, 'article', 'en', ['google_search_console', 'llm_visibility'])
    const result = buildOutcomeDatasetManifest({ candidates: [candidate, candidate] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('DUPLICATE_CANDIDATE')
  })

  it('blocks a dataset manifest with duplicate publication lineage', () => {
    const first = makeEligibleCandidate(2, 'article', 'en', ['google_search_console', 'llm_visibility'])
    const second = { ...first, candidateFingerprint: outcomeSha256({ duplicate: 'different fingerprint' }) }
    const result = buildOutcomeDatasetManifest({ candidates: [first, second] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('DUPLICATE_PUBLICATION_LINEAGE')
  })

  it('blocks a revoked candidate from dataset admission', () => {
    const candidate = { ...makeEligibleCandidate(3, 'article', 'en', ['google_search_console', 'llm_visibility']), consentLineage: { ...makeGrantedConsent(), consentRevokedAt: '2025-02-01T00:00:00.000Z' } }
    const result = buildOutcomeDatasetManifest({ candidates: [candidate] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CONSENT_REVOKED')
  })

  it('returns deterministic manifest results for the same candidate set', () => {
    const candidates = Array.from({ length: 3 }, (_, index) => makeEligibleCandidate(index + 10, 'article', 'en', ['google_search_console', 'llm_visibility']))
    const first = buildOutcomeDatasetManifest({ candidates })
    const second = buildOutcomeDatasetManifest({ candidates: [...candidates].reverse() })
    expect(first).toEqual(second)
  })

  it('uses candidate fingerprints in stable manifest ordering', () => {
    const candidates = [makeEligibleCandidate(20, 'article', 'en', ['google_search_console', 'llm_visibility']), makeEligibleCandidate(21, 'article', 'en', ['google_search_console', 'llm_visibility'])]
    const result = buildOutcomeDatasetManifest({ candidates })
    expect(result.candidateFingerprints).toEqual([...result.candidateFingerprints].sort())
  })

  it('blocks a dataset candidate with an invalid source hash lineage', () => {
    const candidate = { ...makeEligibleCandidate(30, 'article', 'en', ['google_search_console', 'llm_visibility']), sourceHashes: ['bad'] }
    const result = buildOutcomeDatasetManifest({ candidates: [candidate] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_HASH')
  })

  it('blocks a dataset manifest containing a blocked candidate', () => {
    const blocked = buildOutcomeLearningCandidate(makeCandidateInput({ piiScanStatus: 'detected' }))
    const result = buildOutcomeDatasetManifest({ candidates: [blocked] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_NOT_ELIGIBLE')
  })

  it('admits a complete synthetic 150-candidate dataset gate', () => {
    const candidates = [
      ...Array.from({ length: 40 }, (_, index) => makeEligibleCandidate(index, 'article', 'en', ['google_search_console', 'llm_visibility'])),
      ...Array.from({ length: 20 }, (_, index) => makeEligibleCandidate(index + 40, 'article', 'zh-hant', ['google_search_console', 'llm_visibility'])),
      ...Array.from({ length: 25 }, (_, index) => makeEligibleCandidate(index + 60, 'faq', 'en', ['google_search_console', 'llm_visibility'])),
      ...Array.from({ length: 20 }, (_, index) => makeEligibleCandidate(index + 85, 'faq', 'zh-hant', ['google_search_console'])),
      ...Array.from({ length: 25 }, (_, index) => makeEligibleCandidate(index + 105, 'service_page', 'en', ['google_search_console'])),
      ...Array.from({ length: 20 }, (_, index) => makeEligibleCandidate(index + 130, 'service_page', 'zh-hant', ['google_search_console'])),
    ]
    const result = buildOutcomeDatasetManifest({ candidates })
    expect(result.status).toBe('ready_for_dataset_review')
    expect(result.eligibleCandidateCount).toBe(150)
    expect(result.contentTypeCounts.article).toBe(60)
    expect(result.contentTypeCounts.faq).toBe(45)
    expect(result.contentTypeCounts.service_page).toBe(45)
    expect(result.languageCounts.en).toBe(90)
    expect(result.languageCounts['zh-hant']).toBe(60)
    expect(result.trainCandidateFingerprints.length + result.validationCandidateFingerprints.length + result.testCandidateFingerprints.length).toBe(150)
  })

  it('keeps dataset split deterministic across repeated builds', () => {
    const candidates = Array.from({ length: 4 }, (_, index) => makeEligibleCandidate(index + 200, 'article', 'en', ['google_search_console', 'llm_visibility']))
    expect(buildOutcomeDatasetManifest({ candidates }).manifestFingerprint).toBe(buildOutcomeDatasetManifest({ candidates }).manifestFingerprint)
  })

  it('does not include raw fields in a dataset manifest', () => {
    const result = buildOutcomeDatasetManifest({ candidates: [makeEligibleCandidate(300, 'article', 'en', ['google_search_console', 'llm_visibility'])] })
    expect(JSON.stringify(result)).not.toContain('schedule-entry-001')
    expect(JSON.stringify(result)).not.toContain('article body')
  })

  it('blocks release evidence with invalid hashes', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ baselineModelArtifactHash: 'bad' }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MODEL_EVIDENCE')
  })

  it('blocks release evidence with too few evaluation cases', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ evaluationCaseCount: 99 }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('EVALUATION_CASES_INSUFFICIENT')
  })

  it('blocks factual error regression', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ candidateMetrics: { ...makePassingReleaseGate().candidateMetrics, factualErrorRate: 0.3 } }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('FACTUAL_ERROR_REGRESSION')
  })

  it('blocks blocked-content escape regression', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ candidateMetrics: { ...makePassingReleaseGate().candidateMetrics, blockedContentEscapeRate: 0.3 } }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('BLOCKED_CONTENT_ESCAPE_REGRESSION')
  })

  it('blocks citation readiness regression', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ candidateMetrics: { ...makePassingReleaseGate().candidateMetrics, citationReadiness: 0.6 } }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CITATION_READINESS_REGRESSION')
  })

  it('blocks missing task quality improvement', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ candidateMetrics: { ...makePassingReleaseGate().candidateMetrics, taskQuality: 0.705 } }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('TASK_QUALITY_NOT_IMPROVED')
  })

  it('blocks nonzero safety incidents', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ safetyIncidents: 1 }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('SAFETY_REGRESSION')
  })

  it('blocks missing rollback artifact', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ rollbackArtifactAvailable: false }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('ROLLBACK_ARTIFACT_REQUIRED')
  })

  it('returns shadow_ready before a passed shadow run', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ shadowRunStatus: 'pending', canaryRunStatus: 'pending' }))
    expect(result.decision).toBe('shadow_ready')
    expect(result.reasonCodes).toContain('SHADOW_RUN_REQUIRED')
  })

  it('returns canary_ready after shadow but before canary', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ canaryRunStatus: 'pending' }))
    expect(result.decision).toBe('canary_ready')
    expect(result.reasonCodes).toContain('CANARY_RUN_REQUIRED')
  })

  it('returns promotion_ready only for complete passing evidence', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate())
    expect(result.decision).toBe('promotion_ready')
    expect(result.reasonCodes).toEqual([])
    expect(result).not.toHaveProperty('deployed')
    expect(result.limitations).toContain('promotion_ready is an evidence gate only; it is not deployed and does not change production configuration.')
  })

  it('does not call providers or mutate production configuration', () => {
    const request = makePassingReleaseGate()
    const before = JSON.stringify(request)
    evaluateModelReleaseGate(request)
    expect(JSON.stringify(request)).toBe(before)
  })

  it('keeps release fingerprints deterministic', () => {
    const request = makePassingReleaseGate()
    expect(evaluateModelReleaseGate(request).releaseFingerprint).toBe(evaluateModelReleaseGate(request).releaseFingerprint)
  })

  it('changes release fingerprint when candidate artifact hash changes', () => {
    const first = evaluateModelReleaseGate(makePassingReleaseGate())
    const second = evaluateModelReleaseGate(makePassingReleaseGate({ candidateModelArtifactHash: outcomeSha256({ model: 'candidate-v2' }) }))
    expect(first.releaseFingerprint).not.toBe(second.releaseFingerprint)
  })

  it('returns blocked for a primitive release request', () => {
    expect(evaluateModelReleaseGate(null).decision).toBe('gate_blocked')
    expect(evaluateModelReleaseGate('bad').decision).toBe('gate_blocked')
  })

  it('rejects a forbidden key in release evidence', () => {
    const result = evaluateModelReleaseGate({ ...makePassingReleaseGate(), token: 'synthetic-token' })
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MODEL_EVIDENCE')
  })

  it('keeps candidate output free of customer, URL, email, prompt, and response data', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('companyName')
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('@')
    expect(serialized).not.toContain('prompt')
    expect(serialized).not.toContain('response')
  })

  it('rejects a customer name nested in consent lineage', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), consent: { ...makeGrantedConsent(), nested: { name: 'Synthetic Customer' } } })
    expectBlocked(result, 'FORBIDDEN_PAYLOAD_KEY')
  })

  it('rejects a visitor id nested in an outcome request', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), outcomeRequest: { ...makeOutcomeRequest(), nested: { visitorId: 'visitor-001' } } })
    expectBlocked(result, 'FORBIDDEN_PAYLOAD_KEY')
  })

  it('does not generate a causal claim in candidate output', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    expect(JSON.stringify(result)).not.toContain('causalLift')
    expect(JSON.stringify(result)).toContain('observational_not_causal')
  })

  it('uses no current time in assessment output', () => {
    const request = makeOutcomeRequest()
    const first = assessPublishedContentOutcome(request)
    const second = assessPublishedContentOutcome(request)
    expect(first).toEqual(second)
  })

  it('uses no random split in manifest output', () => {
    const candidates = Array.from({ length: 3 }, (_, index) => makeEligibleCandidate(index + 400, 'article', 'en', ['google_search_console', 'llm_visibility']))
    const first = buildOutcomeDatasetManifest({ candidates })
    const second = buildOutcomeDatasetManifest({ candidates })
    expect(first.trainCandidateFingerprints).toEqual(second.trainCandidateFingerprints)
    expect(first.validationCandidateFingerprints).toEqual(second.validationCandidateFingerprints)
    expect(first.testCandidateFingerprints).toEqual(second.testCandidateFingerprints)
  })

  it('keeps aggregate metrics bounded to declared fields', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement({ metrics: { impressions: 700, clicks: 70, averagePosition: 10, extra: 1 } }))).toBeNull()
  })

  it('does not accept raw search query fields', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), outcomeRequest: { ...makeOutcomeRequest(), rawSearchQuery: 'synthetic query' } })
    expect(result.candidateStatus).toBe('blocked')
  })

  it('does not accept raw CRM record fields', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), outcomeRequest: { ...makeOutcomeRequest(), rawCrmRecord: { conversions: 1 } } })
    expect(result.candidateStatus).toBe('blocked')
  })

  it('does not accept raw page content fields', () => {
    const result = buildOutcomeLearningCandidate({ ...makeCandidateInput(), outcomeRequest: { ...makeOutcomeRequest(), rawPageContent: 'synthetic page' } })
    expect(result.candidateStatus).toBe('blocked')
  })

  it('produces a stable hash for equivalent object key order', () => {
    expect(outcomeSha256({ a: 1, b: 2 })).toBe(outcomeSha256({ b: 2, a: 1 }))
  })

  it('rejects undefined in canonical fingerprint inputs', () => {
    expect(() => outcomeSha256({ a: undefined })).toThrow()
  })

  it('rejects non-finite numbers in canonical fingerprint inputs', () => {
    expect(() => outcomeSha256({ a: Number.NaN })).toThrow()
  })

  it('keeps the fixed data contract version in eligible candidates', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    expect(result.candidateStatus === 'eligible' && result.dataContractVersion).toBe(DATA_CONTRACT_VERSION)
  })
})

function makeCompleteDatasetCandidates() {
  return [
    ...Array.from({ length: 40 }, (_, index) => makeEligibleCandidate(index + 500, 'article', 'en', ['google_search_console', 'llm_visibility'])),
    ...Array.from({ length: 20 }, (_, index) => makeEligibleCandidate(index + 540, 'article', 'zh-hant', ['google_search_console', 'llm_visibility'])),
    ...Array.from({ length: 25 }, (_, index) => makeEligibleCandidate(index + 560, 'faq', 'en', ['google_search_console', 'llm_visibility'])),
    ...Array.from({ length: 20 }, (_, index) => makeEligibleCandidate(index + 585, 'faq', 'zh-hant', ['google_search_console'])),
    ...Array.from({ length: 25 }, (_, index) => makeEligibleCandidate(index + 605, 'service_page', 'en', ['google_search_console'])),
    ...Array.from({ length: 20 }, (_, index) => makeEligibleCandidate(index + 630, 'service_page', 'zh-hant', ['google_search_console'])),
  ]
}

describe('Outcome Learning Loop Engine V1 blocker repairs', () => {
  it('changes assessment fingerprint when data contract changes and blocks the mismatch', () => {
    const valid = assessPublishedContentOutcome(makeOutcomeRequest({ dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }))
    const attacker = assessPublishedContentOutcome(makeOutcomeRequest({ dataContractVersion: 'attacker-contract' }))
    expect(valid.dataContractVersion).toBe(OUTCOME_DATA_CONTRACT_VERSION)
    expect(attacker.status).toBe('blocked')
    expect(attacker.reasonCodes).toContain('DATA_CONTRACT_MISMATCH')
    expect(attacker.assessmentFingerprint).not.toBe(valid.assessmentFingerprint)
  })

  it.each(['latest', 'v2', '', '  ', 'arbitrary-contract'])('blocks non-fixed assessment data contract %s', (dataContractVersion) => {
    const result = assessPublishedContentOutcome(makeOutcomeRequest({ dataContractVersion }))
    expect(result.status).toBe('blocked')
    expect(result.reasonCodes).toContain(dataContractVersion.trim() ? 'DATA_CONTRACT_MISMATCH' : 'DATA_CONTRACT_MISSING')
  })

  it('requires a supplied assessment object', () => {
    const input = makeCandidateInput()
    const { assessment: _assessment, ...withoutAssessment } = input
    expectBlocked(buildOutcomeLearningCandidate(withoutAssessment), 'ASSESSMENT_REQUIRED')
  })

  it('blocks a null supplied assessment', () => {
    expectBlocked(buildOutcomeLearningCandidate({ ...makeCandidateInput(), assessment: null }), 'ASSESSMENT_REQUIRED')
  })

  it('blocks a primitive supplied assessment', () => {
    expectBlocked(buildOutcomeLearningCandidate({ ...makeCandidateInput(), assessment: 'assessment' }), 'ASSESSMENT_INVALID')
  })

  it('blocks a malformed supplied assessment object', () => {
    expect(buildOutcomeLearningCandidate({ ...makeCandidateInput(), assessment: { status: 'partial' } }).candidateStatus).toBe('blocked')
  })

  it('blocks a supplied assessment without fingerprint', () => {
    const input = makeCandidateInput()
    const malformed = { ...input.assessment } as Record<string, unknown>
    delete malformed.assessmentFingerprint
    expectBlocked(buildOutcomeLearningCandidate({ ...input, assessment: malformed }), 'ASSESSMENT_FINGERPRINT_MISMATCH')
  })

  it('blocks outcome, assessment, and candidate contract disagreement', () => {
    const outcomeMismatch = makeOutcomeRequest({ dataContractVersion: 'attacker-contract' })
    expectBlocked(buildOutcomeLearningCandidate(makeCandidateInput({ outcomeRequest: outcomeMismatch })), 'DATA_CONTRACT_MISMATCH')
    expectBlocked(buildOutcomeLearningCandidate(makeCandidateInput({ dataContractVersion: 'attacker-contract' })), 'DATA_CONTRACT_MISMATCH')
    const input = makeCandidateInput()
    expectBlocked(buildOutcomeLearningCandidate({ ...input, assessment: { ...input.assessment, dataContractVersion: 'attacker-contract' } }), 'DATA_CONTRACT_MISMATCH')
  })

  it('includes fixed data contract in eligible assessment and candidate fingerprints', () => {
    const input = makeCandidateInput()
    const candidate = buildOutcomeLearningCandidate(input)
    expect(input.assessment.dataContractVersion).toBe(OUTCOME_DATA_CONTRACT_VERSION)
    expect(candidate.candidateStatus).toBe('eligible')
    if (candidate.candidateStatus === 'eligible') expect(candidate.dataContractVersion).toBe(OUTCOME_DATA_CONTRACT_VERSION)
  })

  it('blocks an email hidden in topicClusterCode', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: 'customer@example.com' }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('blocks a URL hidden in topicClusterCode', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: 'https://customer.example' }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('blocks a phone-like topicClusterCode', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: '+1 (555) 123-4567' }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('blocks an email hidden in appliedRuleIds', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ appliedRuleIds: ['customer@example.com'] }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('does not preserve raw topic or rule values in candidate output', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput())
    expect(result.candidateStatus).toBe('eligible')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('topic-cluster-001')
    expect(serialized).not.toContain('rule-a')
    expect(serialized).not.toContain('rule-b')
    if (result.candidateStatus === 'eligible') {
      expect(result.topicClusterHash).toMatch(/^[a-f0-9]{64}$/)
      expect(result.appliedRuleHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true)
    }
  })

  it('blocks an oversized learning reference', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: 'x'.repeat(257) }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('blocks control characters in a learning reference', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: 'topic\u0000cluster' }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('blocks malformed Unicode in a learning reference', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: '\ud800' }) }))
    expectBlocked(result, 'VALUE_POLICY_VIOLATION')
  })

  it('blocks a candidate when rightsConfirmed changes but the old fingerprint remains', () => {
    const candidate = makeEligibleCandidate(700)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, consentLineage: { ...candidate.consentLineage, rightsConfirmed: false } }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('blocks a candidate when consentStatus changes but the old fingerprint remains', () => {
    const candidate = makeEligibleCandidate(701)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, consentLineage: { ...candidate.consentLineage, consentStatus: 'not_granted' } }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('blocks a candidate when model_improvement use is removed', () => {
    const candidate = makeEligibleCandidate(702)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, consentLineage: { ...candidate.consentLineage, consentAllowedUses: ['evaluation'] } }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('blocks a candidate when data contract is modified', () => {
    const candidate = makeEligibleCandidate(703)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, dataContractVersion: 'v2' as never }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('blocks a candidate when aggregate feature is modified', () => {
    const candidate = makeEligibleCandidate(704)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'google_search_console.impressionsPerDay.baseline': 999 } }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('blocks NaN and Infinity aggregate features during candidate normalization', () => {
    const candidate = makeEligibleCandidate(705)
    for (const numeric of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'google_search_console.impressionsPerDay.baseline': numeric } }] })
      expect(result.status).toBe('gate_blocked')
      expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
    }
  })

  it('blocks invalid candidate enums', () => {
    const candidate = makeEligibleCandidate(706)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, language: 'fr' as never }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('blocks an invalid candidate source hash', () => {
    const candidate = makeEligibleCandidate(707)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, sourceHashes: ['not-a-sha'] }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_HASH')
  })

  it('blocks an unknown extra candidate key', () => {
    const candidate = makeEligibleCandidate(708)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, attackerField: 'ignored' }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('recomputes and accepts an untampered candidate fingerprint', () => {
    const candidate = makeEligibleCandidate(709)
    const normalized = normalizeOutcomeLearningCandidate(candidate)
    expect(normalized).toEqual(candidate)
  })

  it('rejects dataset candidates over the upper bound before reading nested fields', () => {
    let nestedReads = 0
    const candidates = new Proxy([], {
      get(target, property, receiver) {
        if (property !== 'length' && property !== Symbol.iterator) nestedReads += 1
        if (property === 'length') return OUTCOME_MAX_DATASET_CANDIDATES + 1
        return Reflect.get(target, property, receiver)
      },
    })
    const result = buildOutcomeDatasetManifest({ candidates })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('TOO_MANY_DATASET_CANDIDATES')
    expect(nestedReads).toBe(0)
  })

  it('allocates exactly 120/15/15 for 150 admitted candidates', () => {
    const result = buildOutcomeDatasetManifest({ candidates: makeCompleteDatasetCandidates() })
    expect(result.status).toBe('ready_for_dataset_review')
    expect(result.trainCandidateFingerprints).toHaveLength(120)
    expect(result.validationCandidateFingerprints).toHaveLength(15)
    expect(result.testCandidateFingerprints).toHaveLength(15)
  })

  it('keeps the exact split stable when input rows are reversed', () => {
    const candidates = makeCompleteDatasetCandidates()
    const first = buildOutcomeDatasetManifest({ candidates })
    const reversed = buildOutcomeDatasetManifest({ candidates: [...candidates].reverse() })
    expect(reversed).toEqual(first)
  })

  it('keeps repeated manifest fingerprints identical', () => {
    const candidates = makeCompleteDatasetCandidates()
    expect(buildOutcomeDatasetManifest({ candidates }).manifestFingerprint).toBe(buildOutcomeDatasetManifest({ candidates }).manifestFingerprint)
  })

  it('keeps train validation and test arrays disjoint', () => {
    const result = buildOutcomeDatasetManifest({ candidates: makeCompleteDatasetCandidates() })
    const train = new Set(result.trainCandidateFingerprints)
    const validation = new Set(result.validationCandidateFingerprints)
    const test = new Set(result.testCandidateFingerprints)
    expect([...train].some((fingerprint) => validation.has(fingerprint) || test.has(fingerprint))).toBe(false)
    expect([...validation].some((fingerprint) => test.has(fingerprint))).toBe(false)
  })

  it('makes split union exactly equal to the admitted fingerprint set', () => {
    const result = buildOutcomeDatasetManifest({ candidates: makeCompleteDatasetCandidates() })
    expect(new Set([...result.trainCandidateFingerprints, ...result.validationCandidateFingerprints, ...result.testCandidateFingerprints])).toEqual(new Set(result.candidateFingerprints))
  })

  it('blocks identical baseline and candidate model artifact hashes', () => {
    const request = makePassingReleaseGate()
    const result = evaluateModelReleaseGate({ ...request, candidateModelArtifactHash: request.baselineModelArtifactHash })
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('MODEL_ARTIFACTS_NOT_DISTINCT')
  })

  it.each(['latest', 'v2', '', '  ', 'arbitrary-evaluation-contract'])('blocks non-fixed evaluation contract %s', (evaluationContractVersion) => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ evaluationContractVersion: evaluationContractVersion as never }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('EVALUATION_CONTRACT_MISMATCH')
  })

  it('blocks a release request with missing evaluation contract', () => {
    const request = makePassingReleaseGate()
    const { evaluationContractVersion: _evaluationContractVersion, ...withoutContract } = request
    const result = evaluateModelReleaseGate(withoutContract)
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('EVALUATION_CONTRACT_MISMATCH')
  })

  it('blocks unknown release request keys', () => {
    const result = evaluateModelReleaseGate({ ...makePassingReleaseGate(), attackerField: 'ignored' })
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_RELEASE_SHAPE')
  })

  it('blocks extra and missing evaluation metric keys', () => {
    const request = makePassingReleaseGate()
    const extra = evaluateModelReleaseGate({ ...request, candidateMetrics: { ...request.candidateMetrics, extraMetric: 0 } })
    const { taskQuality: _taskQuality, ...withoutTaskQuality } = request.candidateMetrics
    const missing = evaluateModelReleaseGate({ ...request, candidateMetrics: withoutTaskQuality })
    expect(extra.decision).toBe('gate_blocked')
    expect(extra.reasonCodes).toContain('INVALID_MODEL_EVIDENCE')
    expect(missing.decision).toBe('gate_blocked')
    expect(missing.reasonCodes).toContain('INVALID_MODEL_EVIDENCE')
  })

  it('blocks unsafe evaluation case counts', () => {
    for (const evaluationCaseCount of [Number.MAX_SAFE_INTEGER + 1, 1.5, Number.POSITIVE_INFINITY]) {
      const result = evaluateModelReleaseGate(makePassingReleaseGate({ evaluationCaseCount }))
      expect(result.decision).toBe('gate_blocked')
      expect(result.reasonCodes).toContain('EVALUATION_CASES_INVALID')
    }
  })

  it('blocks pending shadow with passed canary', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ shadowRunStatus: 'pending', canaryRunStatus: 'passed' }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('SHADOW_CANARY_ORDER_INVALID')
  })

  it('blocks a failed shadow run', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ shadowRunStatus: 'failed', canaryRunStatus: 'pending' }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('SAFETY_REGRESSION')
  })

  it('blocks a failed canary run', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate({ canaryRunStatus: 'failed' }))
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('SAFETY_REGRESSION')
  })

  it('returns promotion_ready only for complete valid evidence', () => {
    const result = evaluateModelReleaseGate(makePassingReleaseGate())
    expect(result.decision).toBe('promotion_ready')
    expect(result.reasonCodes).toEqual([])
  })

  it('produces the same release fingerprint for canonical equivalent timestamps', () => {
    const canonical = evaluateModelReleaseGate(makePassingReleaseGate())
    const equivalent = evaluateModelReleaseGate(makePassingReleaseGate({ evaluatedAt: '2025-02-01T08:00:00+08:00' }))
    expect(equivalent.releaseFingerprint).toBe(canonical.releaseFingerprint)
  })
})

function withCandidatePatch(candidate: ReturnType<typeof makeEligibleCandidate>, patch: Record<string, unknown>): ReturnType<typeof makeEligibleCandidate> {
  const { candidateFingerprint: _candidateFingerprint, ...body } = candidate
  const patched = { ...body, ...patch }
  return { ...patched, candidateFingerprint: outcomeSha256(patched) } as ReturnType<typeof makeEligibleCandidate>
}

describe('Outcome Learning Loop Engine V1 second repair', () => {
  it('blocks whitespace-padded deidentifiedSubjectKey', () => {
    const measurement = makeMeasurement({ deidentifiedSubjectKey: ` ${SUBJECT_KEY} ` })
    expect(normalizeOutcomeMeasurement(measurement)).toBeNull()
  })

  it('blocks whitespace-padded publicationIdentityHash with a specific reason', () => {
    const candidate = makeEligibleCandidate(800)
    const patched = withCandidatePatch(candidate, { publicationIdentityHashes: [` ${candidate.publicationIdentityHashes[0]} `] })
    const result = buildOutcomeDatasetManifest({ candidates: [patched] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('NON_CANONICAL_HASH')
  })

  it('blocks whitespace-padded sourceHash with a specific reason', () => {
    const candidate = makeEligibleCandidate(801)
    const patched = withCandidatePatch(candidate, { sourceHashes: [` ${candidate.sourceHashes[0]} `, candidate.sourceHashes[1]] })
    const result = buildOutcomeDatasetManifest({ candidates: [patched] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('NON_CANONICAL_HASH')
  })

  it('blocks whitespace-padded candidateFingerprint with a specific reason', () => {
    const candidate = makeEligibleCandidate(802)
    const result = buildOutcomeDatasetManifest({ candidates: [{ ...candidate, candidateFingerprint: ` ${candidate.candidateFingerprint} ` }] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('NON_CANONICAL_HASH')
  })

  it('blocks whitespace-padded baseline artifact hash', () => {
    const request = makePassingReleaseGate()
    const result = evaluateModelReleaseGate({ ...request, baselineModelArtifactHash: ` ${request.baselineModelArtifactHash} ` })
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('NON_CANONICAL_HASH')
  })

  it('blocks whitespace-padded candidate artifact hash', () => {
    const request = makePassingReleaseGate()
    const result = evaluateModelReleaseGate({ ...request, candidateModelArtifactHash: ` ${request.candidateModelArtifactHash} ` })
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('NON_CANONICAL_HASH')
  })

  it('blocks whitespace-padded dataset manifest hash', () => {
    const request = makePassingReleaseGate()
    const result = evaluateModelReleaseGate({ ...request, datasetManifestHash: ` ${request.datasetManifestHash} ` })
    expect(result.decision).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('NON_CANONICAL_HASH')
  })

  it('blocks uppercase SHA input', () => {
    const measurement = makeMeasurement({ deidentifiedSubjectKey: SUBJECT_KEY.toUpperCase() })
    expect(normalizeOutcomeMeasurement(measurement)).toBeNull()
  })

  it('blocks newline and tab in SHA input', () => {
    const measurement = makeMeasurement({ deidentifiedSubjectKey: `\n${SUBJECT_KEY}\t` })
    expect(normalizeOutcomeMeasurement(measurement)).toBeNull()
  })

  it('accepts a canonical lowercase 64-character SHA', () => {
    expect(normalizeOutcomeMeasurement(makeMeasurement())).not.toBeNull()
  })

  it('blocks embedded Email in topicClusterCode', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: 'topic customer@example.com reference' }) }))
    expect(result.candidateStatus).toBe('blocked')
  })

  it('blocks embedded Email in appliedRuleIds', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ appliedRuleIds: ['rule customer@example.com'] }) }))
    expect(result.candidateStatus).toBe('blocked')
  })

  it('blocks embedded Email in consentVersion', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentVersion: 'consent customer@example.com' }) }))
    expect(result.candidateStatus).toBe('blocked')
  })

  it('blocks an embedded URL in a structured identifier', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ draftId: 'https://example.com/draft' }) }))
    expect(result.candidateStatus).toBe('blocked')
  })

  it('blocks a phone-like structured identifier', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication: makePublication({ topicClusterCode: '123-456-7890' }) }))
    expect(result.candidateStatus).toBe('blocked')
  })

  it('blocks control characters in consentVersion', () => {
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ consent: makeGrantedConsent({ consentVersion: 'consent\u0000v1' }) }))
    expect(result.candidateStatus).toBe('blocked')
  })

  it('accepts a valid opaque structured identifier', () => {
    const publication = makePublication({ topicClusterCode: 'topic.cluster|v1', appliedRuleIds: ['rule.alpha', 'rule_beta'] })
    expect(normalizePublicationIdentity(publication)).not.toBeNull()
    expect(buildOutcomeLearningCandidate(makeCandidateInput({ publication })).candidateStatus).toBe('eligible')
  })

  it('does not expose raw embedded topic or rule values in candidate output', () => {
    const publication = makePublication({ topicClusterCode: 'topic.cluster|v1', appliedRuleIds: ['rule.alpha'] })
    const result = buildOutcomeLearningCandidate(makeCandidateInput({ publication }))
    expect(result.candidateStatus).toBe('eligible')
    expect(JSON.stringify(result)).not.toContain('topic.cluster|v1')
    expect(JSON.stringify(result)).not.toContain('rule.alpha')
  })

  it('blocks an envelope with an unrelated extra field', () => {
    const result = buildOutcomeDatasetManifest({ candidates: [], unrelated: 'x' })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MANIFEST_SHAPE')
  })

  it('blocks an envelope with an extra version field', () => {
    const result = buildOutcomeDatasetManifest({ candidates: [], version: 'v1' })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MANIFEST_SHAPE')
  })

  it('blocks a manifest with missing candidates', () => {
    const result = buildOutcomeDatasetManifest({})
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MANIFEST_SHAPE')
  })

  it('blocks a singular candidate key', () => {
    const result = buildOutcomeDatasetManifest({ candidate: [] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MANIFEST_SHAPE')
  })

  it('blocks a manifest when Object.keys throws', () => {
    const input = new Proxy({ candidates: [] }, { ownKeys: () => { throw new Error('keys unavailable') } })
    const result = buildOutcomeDatasetManifest(input)
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('INVALID_MANIFEST_SHAPE')
  })

  it('keeps oversized candidates early-rejected before nested access', () => {
    let nestedReads = 0
    const candidates = new Proxy([], {
      get(target, property, receiver) {
        if (property !== 'length' && property !== Symbol.iterator) nestedReads += 1
        if (property === 'length') return OUTCOME_MAX_DATASET_CANDIDATES + 1
        return Reflect.get(target, property, receiver)
      },
    })
    const result = buildOutcomeDatasetManifest({ candidates })
    expect(result.reasonCodes).toContain('TOO_MANY_DATASET_CANDIDATES')
    expect(nestedReads).toBe(0)
  })

  it('blocks llm_visibility.impressionsPerDay', () => {
    const candidate = makeEligibleCandidate(810)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'llm_visibility.impressionsPerDay.baseline': 1 } })
    const result = buildOutcomeDatasetManifest({ candidates: [patched] })
    expect(result.reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks crm_aggregate.mentionRate', () => {
    const candidate = makeEligibleCandidate(811)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'crm_aggregate.mentionRate.delta': 1 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks google_search_console.conversionRate', () => {
    const candidate = makeEligibleCandidate(812)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'google_search_console.conversionRate.follow_up': 1 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks an unknown feature source', () => {
    const candidate = makeEligibleCandidate(813)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'unknown_source.impressions.baseline': 1 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks an unknown feature field', () => {
    const candidate = makeEligibleCandidate(814)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'google_search_console.unknownField.baseline': 1 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks an unknown feature phase', () => {
    const candidate = makeEligibleCandidate(815)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'google_search_console.impressions.latest': 1 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks a GSC-only candidate with a CRM feature', () => {
    const candidate = makeEligibleCandidate(816, 'article', 'en', ['google_search_console'])
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'crm_aggregate.qualifiedLeadsPerDay.baseline': 1, 'crm_aggregate.qualifiedLeadsPerDay.follow_up': 1, 'crm_aggregate.qualifiedLeadsPerDay.delta': 0 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks an LLM-declared candidate with no LLM features', () => {
    const candidate = makeEligibleCandidate(817, 'article', 'en', ['google_search_console'])
    const patched = withCandidatePatch(candidate, { measurementSources: ['llm_visibility'], directionalLabels: [{ source: 'llm_visibility', signal: 'positive_signal' }] })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks a candidate missing a baseline feature', () => {
    const candidate = makeEligibleCandidate(818)
    const features = { ...candidate.aggregateNumericFeatures }
    delete features['google_search_console.impressions.baseline']
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: features })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks a candidate missing a follow_up feature', () => {
    const candidate = makeEligibleCandidate(819)
    const features = { ...candidate.aggregateNumericFeatures }
    delete features['google_search_console.impressions.follow_up']
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: features })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks a candidate missing a delta feature', () => {
    const candidate = makeEligibleCandidate(820)
    const features = { ...candidate.aggregateNumericFeatures }
    delete features['google_search_console.impressions.delta']
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: features })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks an arbitrary feature key', () => {
    const candidate = makeEligibleCandidate(821)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'google_search_console.impressions.baseline.extra': 1 } })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('blocks a sourceHashes count mismatch', () => {
    const candidate = makeEligibleCandidate(822)
    const patched = withCandidatePatch(candidate, { sourceHashes: [candidate.sourceHashes[0]] })
    expect(buildOutcomeDatasetManifest({ candidates: [patched] }).reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
  })

  it('accepts a correct untampered candidate after runtime revalidation', () => {
    const candidate = makeEligibleCandidate(823)
    expect(normalizeOutcomeLearningCandidate(candidate)).toEqual(candidate)
  })

  it('blocks a re-fingerprinted but semantically invalid candidate', () => {
    const candidate = makeEligibleCandidate(824)
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: { ...candidate.aggregateNumericFeatures, 'llm_visibility.impressionsPerDay.baseline': 1 } })
    const result = buildOutcomeDatasetManifest({ candidates: [patched] })
    expect(result.status).toBe('gate_blocked')
    expect(result.reasonCodes).toContain('CANDIDATE_FEATURE_LINEAGE_INVALID')
    expect(result.reasonCodes).not.toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })

  it('reports feature lineage rather than fingerprint mismatch for correct re-fingerprints', () => {
    const candidate = makeEligibleCandidate(825)
    const features = { ...candidate.aggregateNumericFeatures }
    delete features['google_search_console.clicks.delta']
    const patched = withCandidatePatch(candidate, { aggregateNumericFeatures: features })
    const result = buildOutcomeDatasetManifest({ candidates: [patched] })
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['CANDIDATE_FEATURE_LINEAGE_INVALID']))
    expect(result.reasonCodes).not.toContain('CANDIDATE_FINGERPRINT_MISMATCH')
  })
})
