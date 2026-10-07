import { describe, expect, it, vi } from 'vitest'
import { approveContentEffectTraining, cleanInvalidContentEffectModels, executeContentEffectTraining, getContentEffectModelWorkspace } from '../server/learning-loop/effect-service'
import type { EffectModelDependencies } from '../server/learning-loop/effect-service'
import type { OutcomeModelInsert, OutcomeModelLease, OutcomeModelRepository } from '../server/learning-loop/effect-repository'
import type { LearningOutcomeModel } from '../server/database/schema'
import type { buildGovernedContentOutcomeRelease } from '../server/learning-loop/outcome-release'
import { buildEffectLiveActionMetadata } from '../server/learning-loop/effect-live-action-metadata'
import { buildContentLearningDataset } from '../server/outcome-learning/content-learning-runtime'
import { assessPublishedContentOutcome } from '../server/outcome-learning/engine'
import { outcomeSha256 } from '../server/outcome-learning/normalization'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning/policy-catalog'
import { fingerprint } from '../server/geo-outcome-model/canonical'
import { projectEffectPublicationTiming } from '../server/learning-loop/effect-publication-metadata'
import { verifyContentEffectArtifact } from '../server/learning-loop/effect-trainer'
import { buildGovernedContentOutcomeRelease as buildRealRelease } from '../server/learning-loop/outcome-release'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { learningFixture } from './support/learning-loop-memory-repository'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { ContentOperationOutcomeAssessmentRow, DeliveredPublication } from '../server/content-operations/types'

const OWNER = 1
const NOW = new Date('2026-10-20T12:00:00.000Z')
const copy = <T>(value: T): T => structuredClone(value)
const sha = (value: unknown) => outcomeSha256(value)

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

type Release = Awaited<ReturnType<typeof buildGovernedContentOutcomeRelease>>

function syntheticRelease(count = 180): Release {
  const records = Array.from({ length: count }, (_, i) => {
    const positive = i % 2 === 0, subject = sha(`effect-subject-${Math.floor(i / 4)}`)
    const published = Date.parse('2023-02-01T00:00:00.000Z') + Math.floor(i / 6) * 30 * 86400000 + (i % 6) * 3600000
    const date = (days: number) => new Date(published + days * 86400000).toISOString()
    const publication = { deidentifiedSubjectKey: subject, scheduleEntryId: `entry-${i}`, scheduleKey: `schedule-${i}`, productionPlanId: `plan-${i}`, jobId: `job-${i}`, draftId: `draft-${i}`, draftVersion: '1', contentHash: sha(`content-${i}`), evidenceSnapshotHash: sha(`evidence-${i}`), publishedAt: date(0), contentType: ['article', 'faq', 'service_page'][i % 3]!, language: i % 2 ? 'en' : 'zh-hant', appliedRuleIds: ['direct-answer'], topicClusterCode: 'synthetic-topic' }
    const measurement = (source: string, phase: string, metrics: Record<string, number>) => { const body = { source, phase, deidentifiedSubjectKey: subject, scopeFingerprint: sha(`${source}-${i}`), windowStart: phase === 'baseline' ? date(-29) : date(1), windowEnd: phase === 'baseline' ? date(-1) : date(15), capturedAt: phase === 'baseline' ? date(-1) : date(16), metrics }; return { ...body, sourceHash: sha(body) } }
    const baseline = [measurement('google_search_console', 'baseline', { impressions: 280, clicks: 28, averagePosition: 12 })]
    const followUp = [measurement('google_search_console', 'follow_up', positive ? { impressions: 560, clicks: 112, averagePosition: 6 } : { impressions: 140, clicks: 7, averagePosition: 24 })]
    if (i % 3) {
      baseline.push(measurement('first_party_analytics', 'baseline', { sessions: 280, engagedSessions: 140 }))
      followUp.push(measurement('first_party_analytics', 'follow_up', positive ? { sessions: 560, engagedSessions: 400 } : { sessions: 140, engagedSessions: 50 }))
    }
    const request = { publication, baselineMeasurements: baseline, followUpMeasurements: followUp, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
    return { outcomeRequest: request, assessment: assessPublishedContentOutcome(request), consent: { consentStatus: 'granted' as const, consentVersion: 'synthetic-v1', consentedAt: '2026-08-01T00:00:00.000Z', consentAllowedUses: ['model_improvement', 'evaluation'], consentRevokedAt: null, rightsConfirmed: true }, piiScanStatus: 'none_detected' as const }
  })
  const dataset = buildContentLearningDataset({ records })
  expect(dataset.status, JSON.stringify({ manifest: dataset.manifest, results: dataset.candidateResults.slice(0, 4) })).toBe('ready_for_dataset_review')
  const publicationMetadataEntries = dataset.candidateResults.flatMap((row, i) => {
    if (row.candidateStatus !== 'eligible') return []
    const request = records[i]!.outcomeRequest, measurement = request.followUpMeasurements[0]!
    const metadata = projectEffectPublicationTiming({ ownerUserId: OWNER, receiptFingerprint: sha(`publication-${i}`), assessment: records[i]!.assessment, baselineMeasurements: request.baselineMeasurements, followUpMeasurements: request.followUpMeasurements, measuredAt: new Date(measurement.capturedAt), checkedAt: NOW })
    expect(metadata, `synthetic publication timing ${i}: ${JSON.stringify(records[i]?.assessment)}`).not.toBeNull()
    return metadata ? [{ candidateFingerprint: row.candidateFingerprint, ...metadata }] : []
  })
  const admittedLineage = dataset.eligibleCandidates.map(candidate => ({ candidateFingerprint: candidate.candidateFingerprint, lineageFingerprint: fingerprint({ candidate: candidate.candidateFingerprint, authority: 'synthetic-current' }) }))
  return { contractVersion: 'governed-content-outcome-release-v1', generatedAt: NOW.toISOString(), taskType: 'content_effect_direction', citationTrainingEligible: false, dataset, lineage: [], admittedLineage, publicationMetadataEntries, metadataBlocked: [], blocked: [], limitations: [], releaseFingerprint: fingerprint({ dataset, admittedLineage, publicationMetadataEntries }) } as Release
}

function withActions(release: Release): Release {
  const byCandidate = new Map(release.publicationMetadataEntries.map(row => [row.candidateFingerprint, row]))
  const actionRows = release.dataset.eligibleCandidates.map((candidate, index) => {
    const publication = byCandidate.get(candidate.candidateFingerprint)!
    const publishedAt = Date.parse(publication.publishedAt)
    const added = index % 3 + 1, replaced = index % 2, retained = index % 4
    return { candidateFingerprint: candidate.candidateFingerprint, actionEvidenceFingerprint: sha(`evidence-${index}`), actionReviewFingerprint: sha(`review-${index}`), actionReleaseFingerprint: sha(`action-release-${index}`), plannedActionFingerprint: sha(`planned-${index}`), receiptFingerprint: sha(`receipt-${index}`), authorizationFingerprint: sha(`authorization-${index}`), sourceFingerprint: sha(`source-${index}`), beforeCapturedAt: new Date(publishedAt - 20_000).toISOString(), dispatchStartedAt: new Date(publishedAt - 1_000).toISOString(), publishedAt: publication.publishedAt, verifiedAt: new Date(publishedAt + 60_000).toISOString(), expiresAt: new Date(publishedAt + 3 * 86400000).toISOString(), features: { newPage: 0, titleChanged: index % 2, paragraphsAdded: added, paragraphsRemoved: replaced, paragraphsReplaced: replaced, paragraphsUnmodified: retained, beforeTextLength: 120 + retained * 20, plannedTextLength: 160 + (added + retained) * 20, beforeParagraphCount: replaced * 2 + retained, plannedParagraphCount: added + replaced + retained } }
  })
  const sidecar = buildEffectLiveActionMetadata(actionRows)
  expect(sidecar).not.toBeNull()
  return { ...release, liveActionMetadataEntries: sidecar!.entries, liveActionBlocked: [] } as Release
}

function candidateLineageRows(model: LearningOutcomeModel | undefined): Record<string, unknown>[] {
  const value: unknown = model?.candidateLineage
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
}

function effectFixture() {
  let current = withActions(syntheticRelease())
  const models = new MemoryModels()
  const release = vi.fn(async (_owner: number, options?: { includeLiveActions?: boolean }) => {
    const snapshot = copy(current)
    if (options?.includeLiveActions !== true) { delete (snapshot as Partial<Release>).liveActionMetadataEntries; delete (snapshot as Partial<Release>).liveActionBlocked }
    return snapshot
  })
  const deps: EffectModelDependencies = { models, release, enabled: true, now: () => NOW }
  const review = async (includeLiveActions?: boolean) => {
    const workspace = await getContentEffectModelWorkspace(OWNER, deps)
    const projection = includeLiveActions ? workspace.actionRelease : workspace.release
    if (!projection) throw new Error('expected synthetic ready release')
    return approveContentEffectTraining(OWNER, { datasetDigest: projection.datasetDigest, lineageFingerprint: projection.lineageFingerprint, ...(includeLiveActions === undefined ? {} : { includeLiveActions }), piiReviewConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Synthetic source, live action, rights and PII review.' }, deps)
  }
  return { models, deps, release, review, current: () => current, setCurrent(value: Release) { current = value } }
}

describe('effect model live-action release integration', () => {
  it('requires explicit dataset-review opt-in and stores V3 action lineage only for the selected mode', async () => {
    const f = effectFixture(), legacy = await f.review(), action = await f.review(true)
    expect(f.release).toHaveBeenCalledWith(OWNER, expect.objectContaining({ includeLiveActions: true }))
    expect(legacy.model.inputMode).toBe('outcome_only')
    expect(legacy.model.lineageFingerprint).not.toBe(action.model.lineageFingerprint)
    expect(candidateLineageRows(f.models.rows[0])[0]).not.toHaveProperty('liveActionReleaseFingerprint')
    expect(candidateLineageRows(f.models.rows[1])[0]).toHaveProperty('liveActionReleaseFingerprint', expect.stringMatching(/^[a-f0-9]{64}$/))
    expect(action.model.inputMode).toBe('reviewed_live_actions')
    expect((await getContentEffectModelWorkspace(OWNER, f.deps)).actionRelease?.liveActionMetadataFingerprint).toMatch(/^[a-f0-9]{64}$/)
    await expect(approveContentEffectTraining(OWNER, { datasetDigest: action.model.datasetDigest, lineageFingerprint: action.model.lineageFingerprint, includeLiveActions: true, liveActionMetadata: f.current().liveActionMetadataEntries, piiReviewConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Forged sidecar is not a permitted review input.' }, f.deps)).rejects.toMatchObject({ data: { code: 'INVALID_EFFECT_DATA_REVIEW' } })
  })

  it('preserves V2 review/hash lineage when action inclusion is not requested', async () => {
    const f = effectFixture(), approved = await f.review()
    expect(approved.model.inputMode).toBe('outcome_only')
    expect(candidateLineageRows(f.models.rows[0]).every(item => !('liveActionReleaseFingerprint' in item))).toBe(true)
    const replay = await f.review()
    expect(replay.model.id).toBe(approved.model.id)
    expect(replay.replayed).toBe(true)
  })

  it.each(['missing', 'changed', 'revoked'] as const)('invalidates approval and fitted weights when a current live action is %s', async mutation => {
    const f = effectFixture(), approved = await f.review(true)
    if (mutation === 'missing') {
      const changed = copy(f.current()); changed.liveActionMetadataEntries = changed.liveActionMetadataEntries!.slice(1); f.setCurrent(changed)
    } else {
      const changed = copy(f.current()), first = changed.liveActionMetadataEntries![0]!
      changed.liveActionMetadataEntries![0] = { ...first, ...(mutation === 'changed' ? { actionReleaseFingerprint: sha('different-current-release') } : { actionReviewFingerprint: sha('revoked-review') }) }
      const rebuilt = buildEffectLiveActionMetadata(changed.liveActionMetadataEntries!)
      expect(rebuilt).not.toBeNull()
      changed.liveActionMetadataEntries = rebuilt!.entries; f.setCurrent(changed)
    }
    const trainer = vi.fn()
    await expect(executeContentEffectTraining(OWNER, { modelId: approved.model.id }, { ...f.deps, trainer })).rejects.toMatchObject({ data: { code: 'CURRENT_EFFECT_LINEAGE_REQUIRED' } })
    expect(trainer).not.toHaveBeenCalled()
    expect(await cleanInvalidContentEffectModels(OWNER, f.deps)).toEqual({ checked: 1, revoked: 1 })
    expect(f.models.rows[0]).toMatchObject({ status: 'revoked', artifact: null, artifactHash: null, metrics: null })
    expect((await getContentEffectModelWorkspace(OWNER, f.deps)).models[0]).toMatchObject({ currentLineageValid: false, artifact: null })
  })

  it('erases V3 weights if action lineage drifts during fit, and never serves the old artifact', async () => {
    const f = effectFixture(), approved = await f.review(true)
    const trainer = vi.fn(async (input: Parameters<NonNullable<typeof f.deps['trainer']>>[0]) => {
      const changed = copy(f.current()), first = changed.liveActionMetadataEntries![0]!
      changed.liveActionMetadataEntries![0] = { ...first, actionReleaseFingerprint: sha('revoked-after-fit-start') }
      changed.liveActionMetadataEntries = buildEffectLiveActionMetadata(changed.liveActionMetadataEntries!)!.entries
      f.setCurrent(changed)
      const { trainContentEffectModel } = await import('../server/learning-loop/effect-trainer')
      return trainContentEffectModel(input)
    })
    await expect(executeContentEffectTraining(OWNER, { modelId: approved.model.id }, { ...f.deps, trainer })).rejects.toMatchObject({ data: { code: 'CURRENT_EFFECT_LINEAGE_REQUIRED' } })
    expect(f.models.rows[0]).toMatchObject({ status: 'revoked', artifact: null, artifactHash: null })
    expect((await getContentEffectModelWorkspace(OWNER, f.deps)).models[0]?.artifact).toBeNull()
  })

  it('does not expose a validly rehashed V3 artifact whose action sidecar fingerprint was changed', async () => {
    const f = effectFixture(), approved = await f.review(true)
    const trained = await executeContentEffectTraining(OWNER, { modelId: approved.model.id }, f.deps)
    expect(trained.model.status, trained.model.reasonCode || '').toBe('completed')
    const row = f.models.rows[0]!
    if (!row.artifact || typeof row.artifact !== 'object' || Array.isArray(row.artifact)) throw new Error('Expected durable synthetic V3 artifact.')
    const { artifactHash: _oldHash, ...body } = row.artifact as Record<string, unknown> & { artifactHash: string }
    const forged = { ...body, liveActionMetadataFingerprint: sha('different-but-well-formed-action-sidecar') }
    row.artifact = { ...forged, artifactHash: sha(forged) }
    row.artifactHash = sha(forged)
    const workspace = await getContentEffectModelWorkspace(OWNER, f.deps)
    expect(workspace.models[0]?.currentLineageValid).toBe(true)
    expect(workspace.models[0]?.artifact).toBeNull()
  })

  it('does not expose a valid V2 artifact transplanted onto reviewed live-action lineage', async () => {
    const f = effectFixture(), live = await f.review(true)
    const liveFit = await executeContentEffectTraining(OWNER, { modelId: live.model.id }, f.deps)
    expect(liveFit.model.status, liveFit.model.reasonCode || '').toBe('completed')
    const outcomeOnly = await f.review(false)
    const legacyFit = await executeContentEffectTraining(OWNER, { modelId: outcomeOnly.model.id }, f.deps)
    expect(legacyFit.model.status, legacyFit.model.reasonCode || '').toBe('completed')
    const liveRow = f.models.rows.find(row => row.id === live.model.id)!
    const legacyRow = f.models.rows.find(row => row.id === outcomeOnly.model.id)!
    if (!legacyRow.artifact || typeof legacyRow.artifact !== 'object' || Array.isArray(legacyRow.artifact)) throw new Error('Expected valid synthetic V2 artifact.')
    const { artifactHash: _oldHash, ...legacyBody } = legacyRow.artifact as Record<string, unknown> & { artifactHash: string }
    const transplanted = { ...legacyBody, datasetDigest: liveRow.datasetDigest, lineageFingerprint: liveRow.lineageFingerprint }
    expect(verifyContentEffectArtifact({ ...transplanted, artifactHash: sha(transplanted) })).toBe(true)
    liveRow.artifact = { ...transplanted, artifactHash: sha(transplanted) }
    liveRow.artifactHash = sha(transplanted)
    const workspace = await getContentEffectModelWorkspace(OWNER, f.deps)
    expect(workspace.models.find(row => row.id === liveRow.id)?.currentLineageValid).toBe(true)
    expect(workspace.models.find(row => row.id === liveRow.id)?.artifact).toBeNull()
  })

  it('keeps an approved subset current when unrelated new candidates are added', async () => {
    const f = effectFixture(), approved = await f.review(true)
    const expanded = withActions(syntheticRelease(184))
    f.setCurrent(expanded)
    const trainer = vi.fn(async (input: Parameters<NonNullable<typeof f.deps['trainer']>>[0]) => ({ status: 'blocked' as const, artifact: null, reasonCodes: ['SYNTHETIC_SUBSET_AUTHORITY_ONLY'], counts: { admittedCandidates: input.candidates.length, binaryRows: 0, subjects: 0, excludedSignals: { mixed_signal: 0, no_material_change: 0, insufficient_data: 0, missing_gsc_label: 0, ambiguous_gsc_label: 0 } } }))
    const result = await executeContentEffectTraining(OWNER, { modelId: approved.model.id }, { ...f.deps, trainer })
    expect(result.model.status).toBe('blocked')
    expect(trainer).toHaveBeenCalledOnce()
    expect(trainer.mock.calls[0]?.[0].candidates).toHaveLength(approved.model.candidateCount)
  })

  it('does not treat a client-authored action flag or an unreviewed release as action authority', async () => {
    const f = effectFixture(), workspace = await getContentEffectModelWorkspace(OWNER, f.deps)
    await expect(approveContentEffectTraining(OWNER, { datasetDigest: workspace.actionRelease!.datasetDigest, lineageFingerprint: workspace.actionRelease!.lineageFingerprint, includeLiveActions: true, piiReviewConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Request cannot provide its own sidecar authority.' }, { ...f.deps, release: async (_owner, options) => { const value = copy(f.current()); if (options?.includeLiveActions === true) delete value.liveActionMetadataEntries; return value } })).rejects.toMatchObject({ data: { code: 'EFFECT_DATASET_NOT_READY' } })
    await expect(approveContentEffectTraining(OWNER, { datasetDigest: workspace.actionRelease!.datasetDigest, lineageFingerprint: workspace.actionRelease!.lineageFingerprint, includeLiveActions: 'true', piiReviewConfirmed: true, observationalOnlyAcknowledged: true, reviewReason: 'Client flag is not a boolean authority.' }, f.deps)).rejects.toMatchObject({ data: { code: 'INVALID_EFFECT_DATA_REVIEW' } })
  })
})

// The real builder is exercised with a real synthetic current authorization and exact delivered
// outcome join. This guards the production release seam without creating a fake reviewed action.
describe('governed release action authority join', () => {
  it('keeps action metadata absent/blocked unless the exact current reviewed action repository proves it', async () => {
    const learning = learningFixture()
    await createLearningAuthorization(OWNER, learning.input, { repository: learning.repository, now: () => learning.now })
    const publishedAt = new Date('2026-10-02T12:00:00.000Z')
    const draft = { id: 51, jobId: 71, version: 3, contentHash: 'b'.repeat(64), evidenceRefs: [], safetyStatus: 'approved' }
    const entry = { id: 42, ownerUserId: OWNER, calendarId: 9, status: 'delivered', contentHash: 'b'.repeat(64), evidenceSnapshotHash: 'c'.repeat(64), contentType: 'article', language: 'en' }
    const client = { id: 2, ownerUserId: OWNER, canonicalSiteOrigin: 'https://client.acme.taipei' }
    const delivered = { entry, calendar: { id: 9, ownerUserId: OWNER, clientId: 2 }, deliverable: { id: 42, ownerUserId: OWNER, planId: 70, selectionId: 1, contentType: 'article', title: 'Synthetic', audience: 'Synthetic', language: 'en', evidenceSnapshotHash: 'c'.repeat(64), opportunityKey: 'x', provenance: {} }, job: { id: 71, ownerUserId: OWNER, productionPlanId: 70, productionDeliverableId: 42, strategyRecommendationId: 1, evidenceSnapshotHash: 'c'.repeat(64), briefId: 80 }, draft, publicationRun: { id: 91, ownerUserId: OWNER, entryId: 42, stage: 'publication', state: 'succeeded' }, publicationTarget: { id: 22, ownerUserId: OWNER, clientId: 2, transport: 'generic_http', framework: 'generic_http', targetId: 'fixture', targetOrigin: 'https://publisher.invalid', contentRoot: '/', status: 'active' }, publicationAttempt: { id: 92, ownerUserId: OWNER, clientId: 2, entryId: 42, runId: 91, targetId: 22, status: 'delivered', mode: 'execute', receiptFingerprint: 'd'.repeat(64), contentHash: 'b'.repeat(64), publicationUrl: 'https://client.acme.taipei/en/articles/synthetic', completedAt: publishedAt }, publicationIdentity: null } as unknown as DeliveredPublication
    const baselineBase = { source: 'google_search_console', deidentifiedSubjectKey: 'e'.repeat(64), scopeFingerprint: 'f'.repeat(64), phase: 'baseline', windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-29T00:00:00.000Z', capturedAt: '2026-09-30T00:00:00.000Z', metrics: { impressions: 280, clicks: 28, averagePosition: 12 } }
    const followBase = { ...baselineBase, phase: 'follow_up', windowStart: '2026-10-03T00:00:00.000Z', windowEnd: '2026-10-17T00:00:00.000Z', capturedAt: '2026-10-18T00:00:00.000Z', metrics: { impressions: 560, clicks: 112, averagePosition: 6 } }
    const baseline = { ...baselineBase, sourceHash: sha(baselineBase) }, follow = { ...followBase, sourceHash: sha(followBase) }
    const publication = { deidentifiedSubjectKey: 'e'.repeat(64), scheduleEntryId: '42', scheduleKey: 'calendar-entry-42', productionPlanId: '70', jobId: '71', draftId: '51', draftVersion: '3', contentHash: 'b'.repeat(64), evidenceSnapshotHash: 'c'.repeat(64), publishedAt: publishedAt.toISOString(), contentType: 'article', language: 'en', appliedRuleIds: ['direct-answer-first'], topicClusterCode: 'content-discovery' }
    const request = { publication, baselineMeasurements: [baseline], followUpMeasurements: [follow], dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
    const assessment = assessPublishedContentOutcome(request)
    const outcome = { id: 101, ownerUserId: OWNER, entryId: 42, runId: 91, targetId: 22, draftId: 51, publicationReceiptFingerprint: 'd'.repeat(64), publishedUrl: 'https://client.acme.taipei/en/articles/synthetic', contentHash: 'b'.repeat(64), evidenceSnapshotHash: 'c'.repeat(64), assessmentStatus: assessment.status, assessmentFingerprint: assessment.assessmentFingerprint, baselineSnapshot: [baseline], followUpSnapshot: [follow], assessmentSnapshot: assessment, consentLineageSnapshot: {}, idempotencyKey: 'outcome-101', measuredAt: new Date('2026-10-19T12:00:00.000Z'), createdAt: NOW } as ContentOperationOutcomeAssessmentRow
    const operations = { findClient: async (owner: number, id: number) => owner === OWNER && id === 2 ? client : null, resolveDeliveredPublication: async (owner: number, id: number) => owner === OWNER && id === 42 ? delivered : null, listOutcomes: async (owner: number) => owner === OWNER ? [outcome] : [], findOutcomeByIdempotency: async (owner: number, key: string) => owner === OWNER && key === outcome.idempotencyKey ? outcome : null } as unknown as ContentOperationsRepository
    const actionRepository = { findByAttempt: vi.fn(async () => null) }
    const result = await buildRealRelease(OWNER, { operations, repository: learning.repository, liveActions: actionRepository as never, includeLiveActions: true, now: NOW })
    expect(result.dataset.eligibleCandidates, JSON.stringify({ blocked: result.blocked, metadataBlocked: result.metadataBlocked, manifest: result.dataset.manifest, results: result.dataset.candidateResults })).toHaveLength(1)
    expect(result.liveActionMetadataEntries).toEqual([])
    expect(result.liveActionBlocked).toMatchObject([{ reasonCode: 'CURRENT_REVIEWED_LIVE_ACTION_REQUIRED' }])
    expect(actionRepository.findByAttempt).toHaveBeenCalledWith(OWNER, 92)
  })
})
