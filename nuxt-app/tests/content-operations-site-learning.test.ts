import { describe, expect, it } from 'vitest'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { learningFixture } from './support/learning-loop-memory-repository'
import { assessPublishedContentOutcome, OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning'
import { stableFingerprint } from '../server/content-operations/normalization'
import { recordSiteLearningOptIn, revokeSiteLearningOptIn, resolveSiteLearningCollectionProof, reviewSiteLearningOutcome, buildSiteLearningRelease, getSiteLearningWorkspace, type SiteLearningCollectionProof, type SiteLearningOptions } from '../server/content-operations/site-learning'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'
import { makeMeasurement, makePublication } from './fixtures/outcome-learning/measurements'
import type { ConfirmedSiteMeasurementLineage } from '../server/content-operations/site-measurement'
import type { ContentOperationEventRow, ContentOperationOutcomeAssessmentRow } from '../server/content-operations/types'

const NOW = new Date('2025-01-18T06:00:00.000Z')
const CONFIRMATION = 'a'.repeat(64)
const TARGET = 41
const ENTRY = 52

function makeLineage(): ConfirmedSiteMeasurementLineage {
  const publication = makePublication({ productionPlanId: '11', jobId: '9', draftId: '8', draftVersion: '1', appliedRuleIds: ['rule-a', 'rule-b'] })
  return { evidenceKind: 'site_publication_confirmation', ownerUserId: 1, entryId: ENTRY, targetId: TARGET, clientId: 2,
    canonicalPage: 'https://client.acme.taipei/journal/synthetic/', publicationReceiptFingerprint: CONFIRMATION, confirmationFingerprint: CONFIRMATION,
    contentHash: publication.contentHash, evidenceSnapshotHash: publication.evidenceSnapshotHash, timeZone: 'Asia/Taipei', publicationLocalDate: '2025-01-10',
    publishedAt: new Date(publication.publishedAt), calendarId: 3, draftId: 8, draftVersion: 1, jobId: 9, productionPlanId: 11,
    scheduleKey: publication.scheduleKey, contentType: 'article', language: 'en', appliedRuleIds: ['rule-a', 'rule-b'], topicClusterCode: 'topic-cluster-001' }
}

async function harness() {
  const ops = new ContentOperationsFixture(), auth = learningFixture()
  auth.now.setTime(new Date('2025-01-10T00:00:00.000Z').getTime())
  const siteClock = { value: new Date('2025-01-10T00:00:00.000Z') }
  const learningClient = auth.repository.clients[0]!
  learningClient.canonicalSiteOrigin = 'https://client.acme.taipei'
  const source = auth.repository.sources[0]!
  source.sourceUrl = 'https://client.acme.taipei/'
  source.canonicalUrl = 'https://client.acme.taipei/'
  const created = await createLearningAuthorization(1, { ...auth.input, expiresAt: '2025-04-09T00:00:00.000Z' }, { repository: auth.repository, now: () => auth.now })
  const lineage = makeLineage()
  Object.assign(ops.repository, {
    listSiteLearningEvents: async (owner: number, entry: number) => ops.events.filter(row => row.ownerUserId === owner && row.entryId === entry && ['site_learning_opt_in','site_learning_revoked','site_learning_outcome_reviewed'].includes(row.eventType)).sort((a,b) => b.id-a.id).slice(0,501),
    findSiteLearningEvent: async (owner: number, fp: string) => ops.events.find(row => row.ownerUserId === owner && row.eventFingerprint === fp) || null,
    listOutcomes: async (owner: number) => ops.outcomes.filter(row => row.ownerUserId === owner),
  })
  const options: SiteLearningOptions = { operations: ops.repository, learning: auth.repository, now: () => siteClock.value,
    resolveSiteLineages: async (owner, entry, ctx) => owner === 1 && entry === ENTRY && ops.repository === ctx.repository ? [lineage] : owner === 1 && entry === ENTRY ? [lineage] : [] }
  const optInValue = { targetRowId: TARGET, expectedConfirmationFingerprint: CONFIRMATION, authorizationId: created.authorization.id,
    expectedAuthorizationFingerprint: created.authorization.authorizationFingerprint, customerEvidenceConfirmed: true as const, scopeConfirmed: true as const, idempotencyKey: 'site-learning-optin-001' }
  const grant = await recordSiteLearningOptIn(1, ENTRY, optInValue, options)
  const proof = await resolveSiteLearningCollectionProof(1, lineage, options)
  if (!proof) throw new Error('Synthetic grant did not resolve to a collection proof.')
  return { ops, auth, created, lineage, options, optInValue, grant, proof, setNow: (value: Date) => { siteClock.value = value } }
}

function siteOutcome(proof: SiteLearningCollectionProof): ContentOperationOutcomeAssessmentRow {
  const lineage = makeLineage()
  const publication = makePublication({ productionPlanId: String(lineage.productionPlanId), jobId: String(lineage.jobId), draftId: String(lineage.draftId), draftVersion: String(lineage.draftVersion),
    contentHash: lineage.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, publishedAt: lineage.publishedAt.toISOString(), contentType: 'article', language: 'en',
    appliedRuleIds: lineage.appliedRuleIds, topicClusterCode: lineage.topicClusterCode })
  const baseline = makeMeasurement({ phase: 'baseline', capturedAt: '2025-01-18T04:10:00.000Z' })
  const follow = makeMeasurement({ phase: 'follow_up', capturedAt: '2025-01-18T04:30:00.000Z', metrics: { impressions: 1400, clicks: 210, averagePosition: 8 } })
  const collectionProof = structuredClone(proof)
  const withProof = (measurement: ReturnType<typeof makeMeasurement>) => ({ ...measurement, providerProvenance: { siteLearningCollectionProof: collectionProof } })
  const baselineSnapshot = [withProof(baseline)], followUpSnapshot = [withProof(follow)]
  const request = { publication, baselineMeasurements: [baseline], followUpMeasurements: [follow], dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
  const assessment = assessPublishedContentOutcome(request)
  const assessmentSnapshot = { ...assessment, evidenceKind: 'site_publication_confirmation', targetId: TARGET, confirmationFingerprint: CONFIRMATION, learningCandidate: false, siteLearningCollectionProof: collectionProof }
  return { id: 801, ownerUserId: 1, entryId: ENTRY, runId: null, targetId: TARGET, draftId: lineage.draftId, publicationReceiptFingerprint: CONFIRMATION,
    publishedUrl: lineage.canonicalPage, contentHash: lineage.contentHash, evidenceSnapshotHash: lineage.evidenceSnapshotHash, assessmentStatus: assessment.status,
    assessmentFingerprint: stableFingerprint(assessmentSnapshot), baselineSnapshot, followUpSnapshot,
    assessmentSnapshot,
    consentLineageSnapshot: { consentStatus: 'unknown' }, idempotencyKey: 'site-measurement-outcome-001', measuredAt: new Date('2025-01-18T04:45:00.000Z'), createdAt: new Date('2025-01-18T04:46:00.000Z') }
}

function replaceStoredProof(outcome: ContentOperationOutcomeAssessmentRow, mutate: (proof: Record<string, unknown>) => void) {
  const snapshot = outcome.assessmentSnapshot as Record<string, unknown>
  const proof = structuredClone(snapshot.siteLearningCollectionProof) as Record<string, unknown>
  mutate(proof)
  snapshot.siteLearningCollectionProof = structuredClone(proof)
  for (const group of [outcome.baselineSnapshot, outcome.followUpSnapshot]) {
    for (const item of group as Array<Record<string, unknown>>) {
      const provenance = item.providerProvenance as Record<string, unknown>
      provenance.siteLearningCollectionProof = structuredClone(proof)
    }
  }
  outcome.assessmentFingerprint = stableFingerprint(snapshot)
}

function reviewValue(proof: SiteLearningCollectionProof, assessmentFingerprint: string, decision: 'approve' | 'reject' = 'approve', key = `site-review-${decision}-001`) {
  return { expectedAssessmentFingerprint: assessmentFingerprint, expectedGrantFingerprint: proof.grantFingerprint, decision,
    piiReviewed: true, limitationsUnderstood: true, idempotencyKey: key }
}

describe('independent site-confirmation learning authority', () => {
  it('requires a live source authorization and exact confirmation; hashes proof and cannot revive revoked grants', async () => {
    const f = await harness()
    expect(f.proof).toMatchObject({ contractVersion: 'site-learning-collection-proof-v1', grantFingerprint: f.grant.grantFingerprint, confirmationFingerprint: CONFIRMATION })
    expect(Object.keys(f.proof).sort()).toEqual(['approvedAt','authorizationFingerprint','authorizationId','confirmationFingerprint','consentVersion','contractVersion','expiresAt','grantFingerprint','grantedAt','retentionDays','sourceFingerprint'].sort())
    expect(JSON.stringify(f.proof)).not.toContain('client.acme')
    expect((await recordSiteLearningOptIn(1, ENTRY, f.optInValue, f.options)).replayed).toBe(true)
    const revoked = await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: f.grant.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-revoke-001' }, f.options)
    expect(revoked.state).toBe('revoked')
    expect(await resolveSiteLearningCollectionProof(1, f.lineage, f.options)).toBeNull()
    await expect(recordSiteLearningOptIn(1, ENTRY, f.optInValue, f.options)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('fails closed for wrong owner, changed public confirmation, unavailable authorization, and corrupt grant events', async () => {
    const f = await harness()
    expect(await resolveSiteLearningCollectionProof(99, f.lineage, f.options)).toBeNull()
    const changed = { ...f.lineage, confirmationFingerprint: 'f'.repeat(64) }
    expect(await resolveSiteLearningCollectionProof(1, changed, f.options)).toBeNull()
    await f.auth.repository.revokeAuthorization(1, f.created.authorization.id, NOW)
    expect(await resolveSiteLearningCollectionProof(1, f.lineage, f.options)).toBeNull()
    const corrupt = await harness()
    const grantEvent = corrupt.ops.events.find(row => row.eventType === 'site_learning_opt_in')!
    ;(grantEvent.metadata as Record<string, unknown>).sourceFingerprint = '9'.repeat(64)
    expect(await resolveSiteLearningCollectionProof(1, corrupt.lineage, corrupt.options)).toBeNull()
  })

  it('requires post-opt-in baseline and follow-up proofs plus exact owner review; release remains review-only', async () => {
    const f = await harness()
    f.setNow(NOW)
    const outcome = siteOutcome(f.proof)
    f.ops.outcomes.push(outcome)
    expect(await resolveSiteLearningCollectionProof(1, f.lineage, f.options)).not.toBeNull()
    const saved = outcome.assessmentSnapshot as Record<string, unknown>
    const strip = (value: unknown) => { const { providerProvenance: _provenance, ...measurement } = value as Record<string, unknown>; return measurement }
    expect(assessPublishedContentOutcome({ publication: saved.publication, baselineMeasurements: (outcome.baselineSnapshot as unknown[]).map(strip), followUpMeasurements: (outcome.followUpSnapshot as unknown[]).map(strip), dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }).assessmentFingerprint).toBe(saved.assessmentFingerprint)
    const value = { expectedAssessmentFingerprint: outcome.assessmentFingerprint, expectedGrantFingerprint: f.proof.grantFingerprint, decision: 'approve' as const,
      piiReviewed: true, limitationsUnderstood: true, idempotencyKey: 'site-learning-review-001' }
    expect(await reviewSiteLearningOutcome(1, outcome.id, value, f.options)).toMatchObject({ state: 'approved', replayed: false })
    const replay = await reviewSiteLearningOutcome(1, outcome.id, value, f.options)
    expect(replay).toMatchObject({ state: 'approved', replayed: true })
    const release = await buildSiteLearningRelease(1, f.options)
    expect(release).toMatchObject({ status: 'gate_blocked', modelTrainingAllowed: false, citationTrainingEligible: false, eligibleCandidateCount: 1 })
    expect(release.manifest.status).toBe('gate_blocked')
  })

  it('does not approve unmarked legacy outcomes or measurements captured before authorization', async () => {
    const f = await harness()
    f.setNow(NOW)
    const outcome = siteOutcome(f.proof)
    ;(outcome.assessmentSnapshot as Record<string, unknown>).siteLearningCollectionProof = undefined
    f.ops.outcomes.push(outcome)
    await expect(reviewSiteLearningOutcome(1, outcome.id, { expectedAssessmentFingerprint: outcome.assessmentFingerprint, expectedGrantFingerprint: f.proof.grantFingerprint,
      decision: 'approve', piiReviewed: true, limitationsUnderstood: true, idempotencyKey: 'site-learning-review-legacy' }, f.options)).rejects.toMatchObject({ statusCode: 409 })
    const legacy = siteOutcome(f.proof)
    ;(legacy.baselineSnapshot as Array<Record<string, unknown>>)[0]!.capturedAt = '2025-01-09T00:00:00.000Z'
    f.ops.outcomes.push(legacy)
    await expect(reviewSiteLearningOutcome(1, legacy.id, { expectedAssessmentFingerprint: legacy.assessmentFingerprint, expectedGrantFingerprint: f.proof.grantFingerprint,
      decision: 'approve', piiReviewed: true, limitationsUnderstood: true, idempotencyKey: 'site-learning-review-stale' }, f.options)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('fails closed on grant, revocation, and review record hash or envelope tampering', async () => {
    for (const mutate of [
      (event: ContentOperationEventRow) => { (event.metadata as Record<string, unknown>).sourceFingerprint = '9'.repeat(64) },
      (event: ContentOperationEventRow) => { event.eventType = 'wrong_event_type' as ContentOperationEventRow['eventType'] },
      (event: ContentOperationEventRow) => { event.entryId = ENTRY + 1 },
      (event: ContentOperationEventRow) => { event.ownerUserId = 99 },
      (event: ContentOperationEventRow) => { event.clientId = 99 },
    ]) {
      const f = await harness(), grant = f.ops.events.find(event => event.eventType === 'site_learning_opt_in')!
      mutate(grant)
      expect(await resolveSiteLearningCollectionProof(1, f.lineage, f.options)).toBeNull()
    }

    const revoked = await harness()
    await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: revoked.grant.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-revoke-hash' }, revoked.options)
    const revokeEvent = revoked.ops.events.find(event => event.eventType === 'site_learning_revoked')!
    ;(revokeEvent.metadata as Record<string, unknown>).revokedAt = '2025-01-11T00:00:00.000Z'
    expect(await resolveSiteLearningCollectionProof(1, revoked.lineage, revoked.options)).toBeNull()

    const movedRevocation = await harness()
    await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: movedRevocation.grant.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-revoke-envelope' }, movedRevocation.options)
    const movedEvent = movedRevocation.ops.events.find(event => event.eventType === 'site_learning_revoked')!
    movedEvent.entryId = ENTRY + 1
    movedRevocation.ops.repository.listSiteLearningEvents = async () => movedRevocation.ops.events
    // A revocation moved outside the scoped query must not silently revive the grant.
    await expect(resolveSiteLearningCollectionProof(1, movedRevocation.lineage, movedRevocation.options)).rejects.toMatchObject({ statusCode: 409 })

    const reviewed = await harness()
    reviewed.setNow(NOW)
    const outcome = siteOutcome(reviewed.proof)
    reviewed.ops.outcomes.push(outcome)
    await reviewSiteLearningOutcome(1, outcome.id, reviewValue(reviewed.proof, outcome.assessmentFingerprint), reviewed.options)
    const reviewEvent = reviewed.ops.events.find(event => event.eventType === 'site_learning_outcome_reviewed')!
    ;(reviewEvent.metadata as Record<string, unknown>).decision = 'reject'
    expect((await buildSiteLearningRelease(1, reviewed.options)).eligibleCandidateCount).toBe(0)
    const envelopeTamper = await harness()
    envelopeTamper.setNow(NOW)
    const envelopeOutcome = siteOutcome(envelopeTamper.proof)
    envelopeTamper.ops.outcomes.push(envelopeOutcome)
    await reviewSiteLearningOutcome(1, envelopeOutcome.id, reviewValue(envelopeTamper.proof, envelopeOutcome.assessmentFingerprint), envelopeTamper.options)
    envelopeTamper.ops.events.find(event => event.eventType === 'site_learning_outcome_reviewed')!.ownerUserId = 99
    expect((await buildSiteLearningRelease(1, envelopeTamper.options)).eligibleCandidateCount).toBe(0)
  })

  it('never falls back from a revoked latest grant to an earlier grant', async () => {
    const f = await harness()
    await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: f.grant.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-revoke-first' }, f.options)
    const second = await recordSiteLearningOptIn(1, ENTRY, { ...f.optInValue, idempotencyKey: 'site-learning-optin-second' }, f.options)
    expect(second.grantFingerprint).not.toBe(f.grant.grantFingerprint)
    await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: second.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-revoke-second' }, f.options)
    expect(await resolveSiteLearningCollectionProof(1, f.lineage, f.options)).toBeNull()
  })

  it('keeps authorization revoked, expired, or source-changed authority unusable', async () => {
    for (const change of [
      (f: Awaited<ReturnType<typeof harness>>) => f.auth.repository.revokeAuthorization(1, f.created.authorization.id, NOW),
      (f: Awaited<ReturnType<typeof harness>>) => { f.auth.repository.authorizations[0]!.expiresAt = new Date('2025-01-17T00:00:00.000Z') },
      (f: Awaited<ReturnType<typeof harness>>) => { f.auth.repository.sources[0]!.canonicalUrl = 'https://elsewhere.example/' },
    ]) {
      const f = await harness()
      await change(f)
      expect(await resolveSiteLearningCollectionProof(1, f.lineage, f.options)).toBeNull()
    }
  })

  it('binds assessment proof to all eleven proof fields and rejects missing or extra keys', async () => {
    const proofFields: Array<[string, (proof: Record<string, unknown>) => void]> = [
      ['grantFingerprint', proof => { proof.grantFingerprint = 'e'.repeat(64) }],
      ['confirmationFingerprint', proof => { proof.confirmationFingerprint = 'e'.repeat(64) }],
      ['authorizationId', proof => { proof.authorizationId = 77 }],
      ['authorizationFingerprint', proof => { proof.authorizationFingerprint = 'e'.repeat(64) }],
      ['sourceFingerprint', proof => { proof.sourceFingerprint = 'e'.repeat(64) }],
      ['grantedAt', proof => { proof.grantedAt = '2025-01-11T00:00:00.000Z' }],
      ['approvedAt', proof => { proof.approvedAt = '2025-01-11T00:00:00.000Z' }],
      ['expiresAt', proof => { proof.expiresAt = '2025-12-01T00:00:00.000Z' }],
      ['retentionDays', proof => { proof.retentionDays = 29 }],
      ['consentVersion', proof => { proof.consentVersion = 'different-consent-v2' }],
      ['contractVersion', proof => { proof.contractVersion = 'other-contract-v1' }],
      ['missing key', proof => { delete proof.consentVersion }],
      ['extra key', proof => { proof.unrecognized = true }],
    ]
    for (const [field, mutate] of proofFields) {
      const f = await harness()
      f.setNow(NOW)
      const outcome = siteOutcome(f.proof)
      replaceStoredProof(outcome, mutate)
      f.ops.outcomes.push(outcome)
      await expect(reviewSiteLearningOutcome(1, outcome.id, reviewValue(f.proof, outcome.assessmentFingerprint, 'approve', `site-proof-${field.replaceAll(' ', '-')}`), f.options))
        .rejects.toMatchObject({ statusCode: 409 })
    }
  })

  it('rejects captures before grant, after outcome time, outside retention, or before their window end', async () => {
    const mutations: Array<[string, (outcome: ContentOperationOutcomeAssessmentRow, f: Awaited<ReturnType<typeof harness>>) => void]> = [
      ['before grant', outcome => { ((outcome.baselineSnapshot as unknown[])[0] as Record<string, unknown>).capturedAt = '2025-01-09T12:00:00.000Z' }],
      ['future capture', outcome => { ((outcome.baselineSnapshot as unknown[])[0] as Record<string, unknown>).capturedAt = '2025-01-18T07:00:00.000Z' }],
      ['outside retention', (outcome, f) => { f.setNow(new Date('2025-03-01T00:00:00.000Z')) }],
      ['before window end', outcome => { ((outcome.followUpSnapshot as unknown[])[0] as Record<string, unknown>).capturedAt = '2025-01-16T00:00:00.000Z' }],
    ]
    for (const [caseName, mutate] of mutations) {
      const f = await harness()
      f.setNow(NOW)
      const outcome = siteOutcome(f.proof)
      mutate(outcome, f)
      f.ops.outcomes.push(outcome)
      await expect(reviewSiteLearningOutcome(1, outcome.id, reviewValue(f.proof, outcome.assessmentFingerprint, 'approve', `site-time-${caseName.replaceAll(' ', '-')}`), f.options))
        .rejects.toMatchObject({ statusCode: 409 })
    }
  })

  it('isolates owner, client, entry, and calendar identity and detects publication changes during review', async () => {
    for (const alter of [
      (lineage: ConfirmedSiteMeasurementLineage) => { lineage.ownerUserId = 99 },
      (lineage: ConfirmedSiteMeasurementLineage) => { lineage.entryId = ENTRY + 1 },
      (lineage: ConfirmedSiteMeasurementLineage) => { lineage.clientId = 99 },
    ]) {
      const f = await harness(), altered = { ...f.lineage }
      alter(altered)
      const options = { ...f.options, resolveSiteLineages: async () => [altered] }
      expect(await resolveSiteLearningCollectionProof(1, f.lineage, options)).toBeNull()
    }
    const movedCalendar = await harness()
    let calls = 0
    const calendarOptions = { ...movedCalendar.options, resolveSiteLineages: async () => ++calls === 1 ? [movedCalendar.lineage] : [{ ...movedCalendar.lineage, calendarId: movedCalendar.lineage.calendarId + 1 }] }
    await expect(recordSiteLearningOptIn(1, ENTRY, { ...movedCalendar.optInValue, idempotencyKey: 'site-learning-calendar-race' }, calendarOptions)).rejects.toMatchObject({ statusCode: 409 })

    const changed = await harness()
    changed.setNow(NOW)
    const outcome = siteOutcome(changed.proof)
    changed.ops.outcomes.push(outcome)
    let resolves = 0
    const raceOptions = { ...changed.options, resolveSiteLineages: async () => ++resolves < 2 ? [changed.lineage] : [{ ...changed.lineage, contentHash: 'f'.repeat(64) }] }
    await expect(reviewSiteLearningOutcome(1, outcome.id, reviewValue(changed.proof, outcome.assessmentFingerprint), raceOptions)).rejects.toMatchObject({ statusCode: 409 })
    expect(changed.ops.events.some(event => event.eventType === 'site_learning_outcome_reviewed')).toBe(false)

    const changedOutcome = await harness()
    changedOutcome.setNow(NOW)
    const stableOutcome = siteOutcome(changedOutcome.proof)
    changedOutcome.ops.outcomes.push(stableOutcome)
    let reads = 0
    changedOutcome.ops.repository.listOutcomes = async () => {
      reads++
      return reads === 1 ? [stableOutcome] : [{ ...stableOutcome, contentHash: 'f'.repeat(64) }]
    }
    await expect(reviewSiteLearningOutcome(1, stableOutcome.id, reviewValue(changedOutcome.proof, stableOutcome.assessmentFingerprint), changedOutcome.options)).rejects.toMatchObject({ statusCode: 409 })
    expect(changedOutcome.ops.events.some(event => event.eventType === 'site_learning_outcome_reviewed')).toBe(false)
  })

  it('bounds reads, never falls back without injected repositories, and uses cached workspace versus fresh release', async () => {
    const tooMany = await harness()
    tooMany.ops.repository.listSiteLearningEvents = async () => Array.from({ length: 501 }, (_, index) => ({ ...tooMany.ops.events[0]!, id: index + 1 }))
    await expect(resolveSiteLearningCollectionProof(1, tooMany.lineage, tooMany.options)).rejects.toMatchObject({ statusCode: 409 })

    const noRepository = await harness()
    const noDI = { ...noRepository.options, operations: undefined as unknown as SiteLearningOptions['operations'] }
    await expect(resolveSiteLearningCollectionProof(1, noRepository.lineage, noDI)).rejects.toBeTruthy()

    const f = await harness(), freshness: boolean[] = []
    f.ops.repository.listEntries = async () => [{ id: ENTRY, ownerUserId: 1, status: 'awaiting_site_review' } as never]
    f.ops.outcomes.push(siteOutcome(f.proof))
    const options = { ...f.options, resolveSiteLineages: async (_owner: number, _entry: number, context: { fresh: boolean }) => { freshness.push(context.fresh); return [f.lineage] } }
    await getSiteLearningWorkspace(1, options)
    expect(freshness).toEqual([false])
    freshness.length = 0
    await buildSiteLearningRelease(1, options)
    expect(freshness).toEqual([true])
  })

  it('excludes pending, rejected, and subsequently revoked outcomes from a site dataset', async () => {
    const pending = await harness()
    pending.setNow(NOW)
    const pendingOutcome = siteOutcome(pending.proof)
    pending.ops.outcomes.push(pendingOutcome)
    expect((await buildSiteLearningRelease(1, pending.options)).eligibleCandidateCount).toBe(0)

    const rejected = await harness()
    rejected.setNow(NOW)
    const rejectedOutcome = siteOutcome(rejected.proof)
    rejected.ops.outcomes.push(rejectedOutcome)
    await reviewSiteLearningOutcome(1, rejectedOutcome.id, reviewValue(rejected.proof, rejectedOutcome.assessmentFingerprint, 'reject', 'site-learning-reject-final'), rejected.options)
    await expect(reviewSiteLearningOutcome(1, rejectedOutcome.id, reviewValue(rejected.proof, rejectedOutcome.assessmentFingerprint, 'approve', 'site-learning-attempt-revive'), rejected.options)).rejects.toMatchObject({ statusCode: 409 })
    expect((await buildSiteLearningRelease(1, rejected.options)).eligibleCandidateCount).toBe(0)

    const revoked = await harness()
    revoked.setNow(NOW)
    const revokedOutcome = siteOutcome(revoked.proof)
    revoked.ops.outcomes.push(revokedOutcome)
    await reviewSiteLearningOutcome(1, revokedOutcome.id, reviewValue(revoked.proof, revokedOutcome.assessmentFingerprint), revoked.options)
    await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: revoked.proof.grantFingerprint, confirmed: true, idempotencyKey: 'site-learning-revoke-after-review' }, revoked.options)
    expect((await buildSiteLearningRelease(1, revoked.options)).eligibleCandidateCount).toBe(0)
  })

  it('keeps workspace local-only and returns only safe summaries', async () => {
    const f = await harness(), before = 0
    const workspace = await getSiteLearningWorkspace(1, f.options)
    expect(workspace.release).toMatchObject({ state: 'not_generated', modelTrainingAllowed: false, citationTrainingEligible: false })
    expect(JSON.stringify(workspace)).not.toContain('client.acme')
    expect(JSON.stringify(workspace)).not.toContain('model-improvement consent receipt')
    expect(before).toBe(0)
  })

  it('retains a revocation-only workspace entry when the source authorization and site resolver become unavailable', async () => {
    const f = await harness()
    f.ops.repository.listEntries = async () => [{ id: ENTRY, ownerUserId: 1, calendarId: f.lineage.calendarId, status: 'completed' } as never]
    await f.auth.repository.revokeAuthorization(1, f.created.authorization.id, NOW)
    const unavailable = { ...f.options, resolveSiteLineages: async () => { throw new Error('synthetic unavailable site') } }
    const workspace = await getSiteLearningWorkspace(1, unavailable)
    expect(workspace.entries).toHaveLength(1)
    expect(workspace.entries[0]).toMatchObject({ entryId: ENTRY, targetRowId: TARGET, authorizations: [], grant: { fingerprint: f.proof.grantFingerprint } })
    await revokeSiteLearningOptIn(1, ENTRY, { targetRowId: TARGET, expectedGrantFingerprint: f.proof.grantFingerprint, confirmed: true, idempotencyKey: 'revoke-unavailable-site' }, unavailable)
    expect((await getSiteLearningWorkspace(1, unavailable)).entries).toEqual([])
  })

  it('rechecks retention and full publication identity on release and rereads changed outcomes after fresh status awaits', async () => {
    for (const scenario of ['retention', 'identity', 'raced-outcome'] as const) {
      const f = await harness()
      f.setNow(NOW)
      const outcome = siteOutcome(f.proof)
      f.ops.outcomes.push(outcome)
      await reviewSiteLearningOutcome(1, outcome.id, reviewValue(f.proof, outcome.assessmentFingerprint), f.options)
      if (scenario === 'retention') f.setNow(new Date('2025-03-01T06:00:00.000Z'))
      if (scenario === 'identity') f.lineage.draftVersion++
      if (scenario === 'raced-outcome') {
        let passes = 0
        f.options.resolveSiteLineages = async () => {
          if (++passes === 2) outcome.draftId = Number(outcome.draftId) + 1
          return [f.lineage]
        }
      }
      expect((await buildSiteLearningRelease(1, f.options)).eligibleCandidateCount).toBe(0)
    }
  })
})
