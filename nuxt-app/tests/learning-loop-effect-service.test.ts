import { describe, expect, it, vi } from 'vitest'
import { approveContentEffectTraining, cleanInvalidContentEffectModels, executeContentEffectTraining, getContentEffectModelWorkspace, revokeContentEffectModel, runContentEffectTrainingTick } from '../server/learning-loop/effect-service'
import type { OutcomeModelInsert, OutcomeModelLease, OutcomeModelRepository } from '../server/learning-loop/effect-repository'
import type { LearningOutcomeModel } from '../server/database/schema'
import type { buildGovernedContentOutcomeRelease } from '../server/learning-loop/outcome-release'
import { buildContentLearningDataset } from '../server/outcome-learning/content-learning-runtime'
import { assessPublishedContentOutcome } from '../server/outcome-learning/engine'
import { outcomeSha256 } from '../server/outcome-learning/normalization'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning/policy-catalog'
import { fingerprint } from '../server/geo-outcome-model/canonical'

type Release = Awaited<ReturnType<typeof buildGovernedContentOutcomeRelease>>
const NOW = new Date('2026-10-07T00:00:00.000Z'), copy = <T>(value: T): T => structuredClone(value)
class MemoryModels implements OutcomeModelRepository {
  rows: LearningOutcomeModel[] = []
  async list(owner: number) { return copy(this.rows.filter(row => row.ownerUserId === owner)) }
  async countLive(owner: number) { return this.rows.filter(row => row.ownerUserId === owner && !row.revokedAt).length }
  async listLive(owner: number, offset: number) { return copy(this.rows.filter(row => row.ownerUserId === owner && !row.revokedAt).slice(offset, offset + 100)) }
  async nextPending(owner: number, now: Date) { return copy(this.rows.find(row => row.ownerUserId === owner && !row.revokedAt && (row.status === 'queued' || row.status === 'training' && (!row.leaseExpiresAt || row.leaseExpiresAt <= now))) || null) }
  async get(owner: number, id: number) { return copy(this.rows.find(row => row.ownerUserId === owner && row.id === id) || null) }
  async findRelease(owner: number, digest: string, lineage: string) { return copy(this.rows.find(row => row.ownerUserId === owner && row.datasetDigest === digest && row.lineageFingerprint === lineage) || null) }
  async reserve(input: OutcomeModelInsert) { const existing = await this.findRelease(input.ownerUserId, input.datasetDigest, input.lineageFingerprint); if (existing) return existing; const row = { ...copy(input), id: this.rows.length + 1, createdAt: NOW }; this.rows.push(row); return copy(row) }
  async claim(owner: number, id: number, version: number, token: string, now: Date, expires: Date) { const row = this.rows.find(row => row.ownerUserId === owner && row.id === id && row.leaseVersion === version && !row.revokedAt && (row.status === 'queued' || row.status === 'training' && (!row.leaseExpiresAt || row.leaseExpiresAt <= now))); if (!row) return null; Object.assign(row, { status: 'training', leaseVersion: version + 1, leaseToken: token, leaseExpiresAt: expires }); return copy(row) }
  async finalize(lease: OutcomeModelLease, now: Date, result: Pick<LearningOutcomeModel, 'status' | 'artifact' | 'artifactHash' | 'metrics' | 'reasonCode'>) { const row = this.rows.find(row => row.ownerUserId === lease.ownerUserId && row.id === lease.id && row.status === 'training' && row.leaseVersion === lease.leaseVersion && row.leaseToken === lease.leaseToken && !row.revokedAt && row.leaseExpiresAt && row.leaseExpiresAt > now); if (!row) return null; Object.assign(row, copy(result), { completedAt: now, leaseToken: null, leaseExpiresAt: null }); return copy(row) }
  async revoke(owner: number, id: number, version: number, now: Date, reasonCode: string) { const row = this.rows.find(row => row.ownerUserId === owner && row.id === id && row.leaseVersion === version && !row.revokedAt); if (!row) return false; Object.assign(row, { status: 'revoked', revokedAt: now, leaseVersion: version + 1, leaseToken: null, leaseExpiresAt: null, artifact: null, artifactHash: null, metrics: null, reasonCode }); return true }
}

// Synthetic server-owned release only. No approval, receipt, customer or consent is created in a real DB.
function fixture(count = 180) {
  const records = Array.from({ length: count }, (_, i) => {
    const positive = i % 2 === 0, subject = outcomeSha256(`synthetic-subject-${Math.floor(i / 6)}`)
    const publication = { deidentifiedSubjectKey: subject, scheduleEntryId: `entry-${i}`, scheduleKey: `schedule-${i}`, productionPlanId: `plan-${i}`, jobId: `job-${i}`, draftId: `draft-${i}`, draftVersion: '1', contentHash: outcomeSha256(`content-${i}`), evidenceSnapshotHash: outcomeSha256(`evidence-${i}`), publishedAt: '2026-09-01T00:00:00.000Z', contentType: ['article', 'faq', 'service_page'][i % 3]!, language: i % 2 ? 'en' : 'zh-hant', appliedRuleIds: ['direct-answer'], topicClusterCode: 'synthetic-topic' }
    const measurement = (source: string, phase: string, metrics: Record<string, number>) => { const body = { source, phase, deidentifiedSubjectKey: subject, scopeFingerprint: outcomeSha256(`${source}-${i}`), windowStart: phase === 'baseline' ? '2026-08-01T00:00:00.000Z' : '2026-09-02T00:00:00.000Z', windowEnd: phase === 'baseline' ? '2026-08-29T00:00:00.000Z' : '2026-09-30T00:00:00.000Z', capturedAt: phase === 'baseline' ? '2026-08-30T00:00:00.000Z' : '2026-10-01T00:00:00.000Z', metrics }; return { ...body, sourceHash: outcomeSha256(body) } }
    const baseline = [measurement('google_search_console', 'baseline', { impressions: 280, clicks: 28, averagePosition: 12 })]
    const followup = [measurement('google_search_console', 'follow_up', positive ? { impressions: 560, clicks: 112, averagePosition: 6 } : { impressions: 140, clicks: 7, averagePosition: 24 })]
    if (i % 3) { baseline.push(measurement('first_party_analytics', 'baseline', { sessions: 280, engagedSessions: 140 })); followup.push(measurement('first_party_analytics', 'follow_up', positive ? { sessions: 560, engagedSessions: 400 } : { sessions: 140, engagedSessions: 50 })) }
    const outcomeRequest = { publication, baselineMeasurements: baseline, followUpMeasurements: followup, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
    return { outcomeRequest, assessment: assessPublishedContentOutcome(outcomeRequest), consent: { consentStatus: 'granted', consentVersion: 'synthetic-v1', consentedAt: '2026-08-01T00:00:00.000Z', consentAllowedUses: ['model_improvement', 'evaluation'], consentRevokedAt: null, rightsConfirmed: true }, piiScanStatus: 'none_detected' as const }
  })
  const dataset = buildContentLearningDataset({ records })
  expect(dataset.status, JSON.stringify(dataset.manifest.reasonCodes)).toBe('ready_for_dataset_review')
  let current: Release = { contractVersion: 'governed-content-outcome-release-v1', generatedAt: NOW.toISOString(), taskType: 'content_effect_direction', citationTrainingEligible: false, dataset, lineage: [], admittedLineage: dataset.eligibleCandidates.map(candidate => ({ candidateFingerprint: candidate.candidateFingerprint, lineageFingerprint: fingerprint({ receipt: candidate.publicationIdentityHashes, source: 'synthetic-reviewed-source', consent: 'current-synthetic-grant' }) })), blocked: [], limitations: [], releaseFingerprint: fingerprint('synthetic release') }
  const models = new MemoryModels(), release = vi.fn(async () => copy(current)), deps = { models, release, enabled: true, now: () => NOW }
  const review = async () => { const workspace = await getContentEffectModelWorkspace(1, deps); expect(workspace.release).not.toBeNull(); return approveContentEffectTraining(1, { datasetDigest: workspace.release!.datasetDigest, lineageFingerprint: workspace.release!.lineageFingerprint, piiReviewConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Synthetic source, consent, PII and receipt review.' }, deps) }
  return { models, deps, review, get current() { return current }, setCurrent(value: Release) { current = value } }
}

describe('durable reviewed observational retraining', () => {
  it('is default-off before storage/release access and rejects client-authored training flags', async () => {
    const models = { get: vi.fn() } as unknown as OutcomeModelRepository, release = vi.fn()
    await expect(executeContentEffectTraining(1, { modelId: 1 }, { models, release, enabled: false })).rejects.toMatchObject({ data: { code: 'EFFECT_TRAINING_DISABLED' } })
    expect(models.get).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
    await expect(executeContentEffectTraining(1, { modelId: 1, enabled: true }, { models, release, enabled: true })).rejects.toMatchObject({ data: { code: 'INVALID_EFFECT_TRAINING_INPUT' } })
  })
  it('reserves the exact approved release idempotently and does not train at approval', async () => {
    const f = fixture(), first = await f.review(), replay = await f.review()
    expect(first.model.status).toBe('queued'); expect(first.trainingPerformed).toBe(false)
    expect(replay.model.id).toBe(first.model.id); expect(replay.replayed).toBe(true); expect(f.models.rows).toHaveLength(1)
    const workspace = await getContentEffectModelWorkspace(1, f.deps)
    await expect(approveContentEffectTraining(1, { datasetDigest: 'a'.repeat(64), lineageFingerprint: workspace.release!.lineageFingerprint, piiReviewConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Synthetic sufficient review.' }, f.deps)).rejects.toMatchObject({ data: { code: 'EFFECT_RELEASE_CHANGED' } })
  })
  it('fits actual CPU weights but returns no weights and never activates a production model', async () => {
    const f = fixture(), approved = await f.review(), result = await executeContentEffectTraining(1, { modelId: approved.model.id }, f.deps)
    expect(result.model.status, result.model.reasonCode || '').toBe('completed')
    expect(result.model.artifact).not.toBeNull(); expect(result.productionActivation).toBe(false)
    expect(result.model.automaticDraftModification).toBe(false)
    const raw = f.models.rows[0]!.artifact as { coefficients: number[]; splits: { temporalHoldout: string } }
    expect(raw.coefficients.length).toBeGreaterThan(0); expect(raw.splits.temporalHoldout).toBe('UNAVAILABLE')
    const summary = JSON.stringify(result); expect(summary).not.toContain('"coefficients":'); expect(summary).not.toContain('"intercept":'); expect(summary).not.toContain('"normalization":')
    const replay = await executeContentEffectTraining(1, { modelId: approved.model.id }, f.deps)
    expect(replay.replayed).toBe(true)
  })
  it('rejects missing owner review, foreign owners, stale fingerprints and removed current members before fitting', async () => {
    const f = fixture(), approved = await f.review(), trainer = vi.fn()
    await expect(executeContentEffectTraining(2, { modelId: approved.model.id }, { ...f.deps, trainer })).rejects.toMatchObject({ data: { code: 'EFFECT_MODEL_NOT_FOUND' } })
    const originalReview = f.models.rows[0]!.dataReviewFingerprint
    f.models.rows[0]!.dataReviewFingerprint = 'a'.repeat(64)
    await expect(executeContentEffectTraining(1, { modelId: approved.model.id }, { ...f.deps, trainer })).rejects.toMatchObject({ data: { code: 'CURRENT_EFFECT_LINEAGE_REQUIRED' } })
    expect(trainer).not.toHaveBeenCalled()
    f.models.rows[0]!.dataReviewFingerprint = originalReview
    f.setCurrent({ ...f.current, dataset: { ...f.current.dataset, eligibleCandidates: f.current.dataset.eligibleCandidates.slice(1) } })
    await expect(executeContentEffectTraining(1, { modelId: approved.model.id }, { ...f.deps, trainer })).rejects.toMatchObject({ data: { code: 'CURRENT_EFFECT_LINEAGE_REQUIRED' } })
    expect(trainer).not.toHaveBeenCalled()
  })
  it('uses one claim under concurrent executions and keeps new candidates outside the approved set', async () => {
    const f = fixture(), approved = await f.review()
    f.setCurrent(fixture(186).current)
    const trainer = vi.fn(async (_input: { candidates: unknown[] }) => ({ status: 'blocked' as const, artifact: null, reasonCodes: ['SYNTHETIC_INSUFFICIENT_BINARY_ROWS'], counts: { admittedCandidates: 180, binaryRows: 0, subjects: 30, excludedSignals: { mixed_signal: 0, no_material_change: 0, insufficient_data: 0, missing_gsc_label: 0, ambiguous_gsc_label: 0 } } }))
    const results = await Promise.all(Array.from({ length: 8 }, () => executeContentEffectTraining(1, { modelId: approved.model.id }, { ...f.deps, trainer })))
    expect(trainer).toHaveBeenCalledTimes(1); expect(results.filter(result => !result.replayed)).toHaveLength(1)
    expect(trainer.mock.calls[0]?.[0].candidates).toHaveLength(180)
  })
  it('drops model weights when receipt/consent lineage changes during fitting or before release', async () => {
    const f = fixture(), approved = await f.review()
    const trainer = async () => { f.setCurrent({ ...f.current, admittedLineage: [] }); return { status: 'blocked' as const, artifact: null, reasonCodes: ['SYNTHETIC_TEST_ONLY'], counts: {} as never } }
    await expect(executeContentEffectTraining(1, { modelId: approved.model.id }, { ...f.deps, trainer })).rejects.toMatchObject({ data: { code: 'CURRENT_EFFECT_LINEAGE_REQUIRED' } })
    expect(f.models.rows[0]).toMatchObject({ status: 'revoked', artifact: null, artifactHash: null, metrics: null })
  })
  it('keeps a revoked artifact unavailable and fences expired workers on takeover', async () => {
    const f = fixture(), approved = await f.review(), row = f.models.rows[0]!
    Object.assign(row, { status: 'training', leaseToken: 'old-worker', leaseVersion: 2, leaseExpiresAt: new Date(NOW.getTime() - 1) })
    const result = await runContentEffectTrainingTick(1, f.deps)
    expect(result.trained).toBe(1); expect(row.leaseVersion).toBe(3)
    expect(await f.models.finalize({ ownerUserId: 1, id: row.id, leaseToken: 'old-worker', leaseVersion: 2 }, NOW, { status: 'completed', artifact: {}, artifactHash: 'a'.repeat(64), metrics: {}, reasonCode: null })).toBeNull()
    await revokeContentEffectModel(1, approved.model.id, f.deps)
    const workspace = await getContentEffectModelWorkspace(1, f.deps)
    expect(workspace.models[0]).toMatchObject({ status: 'revoked', currentLineageValid: false, artifact: null })
    expect(row.artifact).toBeNull()
  })
  it('erases a completed fit if consent changes during the final response check', async () => {
    const f = fixture(), approved = await f.review()
    let reads = 0
    const release = async () => { reads += 1; if (reads === 4) f.setCurrent({ ...f.current, admittedLineage: [] }); return copy(f.current) }
    await expect(executeContentEffectTraining(1, { modelId: approved.model.id }, { ...f.deps, release })).rejects.toMatchObject({ data: { code: 'CURRENT_EFFECT_LINEAGE_REQUIRED' } })
    expect(reads).toBe(4); expect(f.models.rows[0]).toMatchObject({ status: 'revoked', artifact: null, artifactHash: null })
  })
  it('rechecks consent and the exact lease after a delayed claim, before any fitting', async () => {
    for (const mutation of ['consent', 'revoke', 'expiry', 'takeover'] as const) {
      const f = fixture(), approved = await f.review(), claim = f.models.claim.bind(f.models), trainer = vi.fn()
      f.models.claim = async (...args) => {
        const claimed = await claim(...args), row = f.models.rows[0]!
        if (mutation === 'consent') f.setCurrent({ ...f.current, admittedLineage: [] })
        if (mutation === 'revoke') await f.models.revoke(1, row.id, row.leaseVersion, NOW, 'SYNTHETIC_OWNER_REVOKED')
        if (mutation === 'expiry') row.leaseExpiresAt = NOW
        if (mutation === 'takeover') { row.leaseToken = 'other-worker'; row.leaseVersion += 1 }
        return claimed
      }
      await expect(executeContentEffectTraining(1, { modelId: approved.model.id }, { ...f.deps, trainer }), mutation).rejects.toMatchObject({ data: { code: mutation === 'consent' || mutation === 'revoke' ? 'CURRENT_EFFECT_LINEAGE_REQUIRED' : 'EFFECT_TRAINING_LEASE_LOST' } })
      expect(trainer, mutation).not.toHaveBeenCalled()
    }
  })
  it('rechecks membership for retention cleanup even with new training paused', async () => {
    const f = fixture(), approved = await f.review()
    await executeContentEffectTraining(1, { modelId: approved.model.id }, f.deps)
    f.setCurrent({ ...f.current, dataset: { ...f.current.dataset, eligibleCandidates: [] }, admittedLineage: [] })
    expect(await cleanInvalidContentEffectModels(1, { ...f.deps, enabled: false })).toEqual({ checked: 1, revoked: 1 })
    expect(f.models.rows[0]).toMatchObject({ artifact: null, artifactHash: null, status: 'revoked' })
  })
})
