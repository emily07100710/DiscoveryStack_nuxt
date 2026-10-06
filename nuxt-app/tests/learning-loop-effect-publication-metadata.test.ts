import { describe, expect, it } from 'vitest'
import { buildEffectPublicationMetadata, projectEffectPublicationTiming } from '../server/learning-loop/effect-publication-metadata'
import { assessPublishedContentOutcome } from '../server/outcome-learning/engine'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning/policy-catalog'
import { outcomeSha256 } from '../server/outcome-learning/normalization'

const hash = (key: string) => outcomeSha256(key)
function fixture() {
  const subject = hash('synthetic-subject'), publication = { deidentifiedSubjectKey: subject, scheduleEntryId: '1', scheduleKey: 'synthetic', productionPlanId: '2', jobId: '3', draftId: '4', draftVersion: '1', contentHash: hash('body'), evidenceSnapshotHash: hash('evidence'), publishedAt: '2026-08-01T00:00:00.000Z', contentType: 'article', language: 'en', appliedRuleIds: ['direct-answer'], topicClusterCode: 'topic' }
  const measurement = (phase: 'baseline' | 'follow_up') => {
    const row = { source: 'google_search_console', deidentifiedSubjectKey: subject, scopeFingerprint: hash('scope'), phase, windowStart: phase === 'baseline' ? '2026-07-01T00:00:00.000Z' : '2026-08-02T00:00:00.000Z', windowEnd: phase === 'baseline' ? '2026-07-29T00:00:00.000Z' : '2026-08-30T00:00:00.000Z', capturedAt: phase === 'baseline' ? '2026-07-30T00:00:00.000Z' : '2026-08-31T00:00:00.000Z', metrics: { impressions: phase === 'baseline' ? 280 : 560, clicks: phase === 'baseline' ? 28 : 112, averagePosition: phase === 'baseline' ? 12 : 6 } }
    return { ...row, sourceHash: outcomeSha256(row) }
  }
  const followUpMeasurements = [measurement('follow_up')]
  const baselineMeasurements = [measurement('baseline')]
  const assessment = assessPublishedContentOutcome({ publication, baselineMeasurements, followUpMeasurements, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION })
  return { ownerUserId: 1, receiptFingerprint: hash('formal-receipt'), assessment, baselineMeasurements, followUpMeasurements, measuredAt: new Date('2026-09-01T00:00:00.000Z'), checkedAt: new Date('2026-09-02T00:00:00.000Z') }
}
describe('server-revalidated publication timing sidecar', () => {
  it('binds one exact GSC comparison, canonical receipt and owner scope without raw content', () => {
    const input = fixture(), timing = projectEffectPublicationTiming(input)
    expect(timing).toMatchObject({ publishedAt: input.assessment.publication.publishedAt, capturedAt: input.followUpMeasurements[0]!.capturedAt })
    expect(timing?.publicationGroupFingerprint).not.toBe(projectEffectPublicationTiming({ ...input, ownerUserId: 2 })?.publicationGroupFingerprint)
    expect(timing?.publicationGroupFingerprint).not.toBe(projectEffectPublicationTiming({ ...input, receiptFingerprint: hash('other-receipt') })?.publicationGroupFingerprint)
    expect(Object.keys(timing!)).toHaveLength(7)
    expect(JSON.stringify(timing)).not.toContain('synthetic-subject')
  })
  it('requires pre-publication captures for every baseline feature and binds baseline scope/window provenance', () => {
    const input = fixture(), baseline = input.baselineMeasurements[0]!
    const capturedLate = { ...baseline, capturedAt: '2026-09-01T00:00:00.000Z' }
    const { sourceHash: _old, ...latePayload } = capturedLate
    expect(projectEffectPublicationTiming({ ...input, baselineMeasurements: [{ ...latePayload, sourceHash: outcomeSha256(latePayload) }] })).toBeNull()
    expect(projectEffectPublicationTiming({ ...input, baselineMeasurements: [] })).toBeNull()
    expect(projectEffectPublicationTiming({ ...input, baselineMeasurements: [{ ...baseline, sourceHash: hash('forged-baseline') }] })).toBeNull()
    const alternateBaseline = { ...baseline, scopeFingerprint: hash('another-scope') }
    const alternateFollowUp = { ...input.followUpMeasurements[0]!, scopeFingerprint: hash('another-scope') }
    const { sourceHash: _baselineHash, ...baselinePayload } = alternateBaseline, { sourceHash: _followUpHash, ...followUpPayload } = alternateFollowUp
    const baselineMeasurements = [{ ...baselinePayload, sourceHash: outcomeSha256(baselinePayload) }], followUpMeasurements = [{ ...followUpPayload, sourceHash: outcomeSha256(followUpPayload) }]
    const assessment = assessPublishedContentOutcome({ publication: input.assessment.publication, baselineMeasurements, followUpMeasurements, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION })
    const other = projectEffectPublicationTiming({ ...input, baselineMeasurements, followUpMeasurements, assessment })
    expect(other).not.toBeNull()
    expect(other?.publicationGroupFingerprint).toBe(projectEffectPublicationTiming(input)?.publicationGroupFingerprint)
    expect(other?.baselineMetadataFingerprint).not.toBe(projectEffectPublicationTiming(input)?.baselineMetadataFingerprint)
  })
  it('rejects ambiguous scope, unknown timestamps, tampered source hashes and future/unavailable labels', () => {
    const input = fixture()
    expect(projectEffectPublicationTiming({ ...input, followUpMeasurements: [...input.followUpMeasurements, ...input.followUpMeasurements] })).toBeNull()
    expect(projectEffectPublicationTiming({ ...input, followUpMeasurements: [{ ...input.followUpMeasurements[0], sourceHash: hash('forged') }] })).toBeNull()
    expect(projectEffectPublicationTiming({ ...input, measuredAt: new Date('2026-08-30T00:00:00.000Z') })).toBeNull()
    expect(projectEffectPublicationTiming({ ...input, checkedAt: new Date('2026-08-31T00:00:00.000Z') })).toBeNull()
    expect(projectEffectPublicationTiming({ ...input, assessment: { ...input.assessment, comparisons: [] } })).toBeNull()
  })
  it('hashes a stable immutable subset and derives its as-of from available labels, never wall clock', () => {
    const timing = projectEffectPublicationTiming(fixture())!
    const first = { ...timing, candidateFingerprint: hash('candidate-one') }, second = { ...timing, candidateFingerprint: hash('candidate-two'), capturedAt: '2026-09-01T00:00:00.000Z' }
    const sidecar = buildEffectPublicationMetadata([first, second])!
    expect(sidecar).toEqual(buildEffectPublicationMetadata([second, first]))
    expect(sidecar.trainingAsOf).toBe(second.capturedAt)
    expect(sidecar.sidecarFingerprint).not.toBe(buildEffectPublicationMetadata([first])!.sidecarFingerprint)
    expect(buildEffectPublicationMetadata([first, first])).toBeNull()
    expect(buildEffectPublicationMetadata([])).toBeNull()
  })
})
