import { describe, expect, it } from 'vitest'
import { buildContentLearningDataset, scanOutcomeLearningPii } from '../server/outcome-learning'
import { assessPublishedContentOutcome } from '../server/outcome-learning'
import { buildOwnerContentLearningDataset } from '../server/content-operations/service'
import { makeGrantedConsent, makeOutcomeRequest } from './fixtures/outcome-learning/measurements'

const outcomeRequest = makeOutcomeRequest()
const assessment = assessPublishedContentOutcome(outcomeRequest)

function record(overrides: Record<string, unknown> = {}) {
  return { outcomeRequest, assessment, consent: makeGrantedConsent(), ...overrides }
}

describe('GEO content learning dataset runtime', () => {
  it('runs deterministic PII admission and keeps clean outcome payloads deidentified', () => {
    expect(scanOutcomeLearningPii({ consent: makeGrantedConsent(), assessment })).toEqual({ status: 'none_detected' })
    expect(scanOutcomeLearningPii({ reviewerNote: 'contact alice@example.com' })).toMatchObject({ status: 'detected', reasonCode: 'PII_PATTERN_DETECTED' })
    expect(scanOutcomeLearningPii({ capturedAt: '2026-08-25T04:00:00.000Z', windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-08T00:00:00.000Z' })).toEqual({ status: 'none_detected' })
    expect(scanOutcomeLearningPii({ phone: '+886 912 345 678' })).toMatchObject({ status: 'detected', reasonCode: 'PII_PATTERN_DETECTED' })
    const result = buildContentLearningDataset({ records: [record()] })
    expect(result.candidateResults[0]?.candidateStatus).toBe('eligible')
    expect(result.eligibleCandidates).toHaveLength(1)
    expect(result.manifest.status).toBe('gate_blocked')
    expect(result.manifest.reasonCodes).toContain('DATASET_ADMISSION_GATE_BLOCKED')
    expect(result.status).toBe('gate_blocked')
    expect(JSON.stringify(result.eligibleCandidates[0])).not.toContain('alice@example.com')
    expect(JSON.stringify(result)).not.toContain('rawResponse')
  })

  it('blocks candidates with detected PII, revoked consent, or a missing assessment without attempting training', () => {
    const pii = buildContentLearningDataset({ records: [record({ piiScanStatus: 'detected' })] })
    expect(pii.candidateResults[0]).toMatchObject({ candidateStatus: 'blocked', reasonCodes: expect.arrayContaining(['PII_DETECTED']) })
    const revoked = buildContentLearningDataset({ records: [record({ consent: makeGrantedConsent({ consentRevokedAt: '2025-02-01T00:00:00Z' }) })] })
    expect(revoked.candidateResults[0]).toMatchObject({ candidateStatus: 'blocked', reasonCodes: expect.arrayContaining(['CONSENT_REVOKED']) })
    const missing = buildContentLearningDataset({ records: [record({ assessment: null })] })
    expect(missing.candidateResults[0]).toMatchObject({ candidateStatus: 'blocked', reasonCodes: expect.arrayContaining(['ASSESSMENT_REQUIRED']) })
    expect(pii.limitations.join(' ')).toContain('does not submit, train, promote, or upload')
  })

  it('rebuilds persisted owner outcome rows into a bounded learning dataset artifact', async () => {
    const repository = { listOutcomes: async () => [{ assessmentSnapshot: assessment, baselineSnapshot: outcomeRequest.baselineMeasurements, followUpSnapshot: outcomeRequest.followUpMeasurements, consentLineageSnapshot: makeGrantedConsent() }] } as never
    const result = await buildOwnerContentLearningDataset(7, repository)
    expect(result.candidateResults[0]?.candidateStatus).toBe('eligible')
    expect(result.manifest.status).toBe('gate_blocked')
    expect(result.datasetDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('bounds dataset input and keeps deterministic dataset digest', () => {
    const records = [record(), record(), record()]
    const first = buildContentLearningDataset({ records })
    const second = buildContentLearningDataset({ records })
    expect(first.datasetDigest).toBe(second.datasetDigest)
    expect(buildContentLearningDataset({ records, candidateLimit: 1 }).manifest.reasonCodes).toContain('TOO_MANY_DATASET_CANDIDATES')
  })
})
