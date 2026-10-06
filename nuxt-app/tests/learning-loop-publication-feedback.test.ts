import { describe, expect, it, vi } from 'vitest'
import type { ContentOperationsRepository } from '../server/content-operations/repository'
import type { DeliveredPublication, ContentOperationOutcomeAssessmentRow } from '../server/content-operations/types'
import { createInMemoryInterventionLoopRepository } from '../server/intervention-loop/repository'
import { notifyLearningLoopPublicationDelivered, publicationLearningSnapshot } from '../server/learning-loop/publication-bridge'
import { buildGovernedContentOutcomeRelease } from '../server/learning-loop/outcome-release'
import { createLearningAuthorization } from '../server/learning-loop/service'
import { assessPublishedContentOutcome } from '../server/outcome-learning/engine'
import { outcomeSha256 } from '../server/outcome-learning/normalization'
import { scanOutcomeLearningPii } from '../server/outcome-learning/content-learning-runtime'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning/policy-catalog'
import { contentFingerprint } from '../server/seo-geo-core/riskGate'
import { learningFixture } from './support/learning-loop-memory-repository'

const HASH = 'a'.repeat(64)
const OWNER = 1
const CLIENT = 2
const ENTRY = 42
const TARGET = 22
const DRAFT = 51
const DRAFT_VERSION = 3
const CONTENT_HASH = 'b'.repeat(64)
const EVIDENCE_HASH = 'c'.repeat(64)
const RECEIPT_HASH = 'd'.repeat(64)
const PUBLISHED_AT = new Date('2026-10-02T12:00:00.000Z')
const RELEASE_NOW = new Date('2026-10-20T12:00:00.000Z')

type OpsOverrides = Partial<{ publication: DeliveredPublication | null; outcomes: ContentOperationOutcomeAssessmentRow[] }>

function publication(): DeliveredPublication
function publication(override: DeliveredPublication): DeliveredPublication
function publication(override: null): null
function publication(override?: DeliveredPublication | null): DeliveredPublication | null {
  const draft = { id: DRAFT, jobId: 71, version: DRAFT_VERSION, contentHash: CONTENT_HASH, evidenceRefs: [], safetyStatus: 'approved' }
  const entry = { id: ENTRY, ownerUserId: OWNER, calendarId: 9, status: 'delivered', contentHash: CONTENT_HASH, evidenceSnapshotHash: EVIDENCE_HASH, contentType: 'article', language: 'en' }
  const calendar = { id: 9, ownerUserId: OWNER, clientId: CLIENT }
  const client = { id: CLIENT, ownerUserId: OWNER, canonicalSiteOrigin: 'https://client.acme.taipei' }
  const job = { id: 71, ownerUserId: OWNER, productionPlanId: 70, productionDeliverableId: ENTRY, strategyRecommendationId: 1, evidenceSnapshotHash: EVIDENCE_HASH, briefId: 80 }
  const deliverable = { id: ENTRY, ownerUserId: OWNER, planId: 70, selectionId: 1, contentType: 'article', title: 'Synthetic published content', audience: 'synthetic audience', language: 'en', evidenceSnapshotHash: EVIDENCE_HASH, opportunityKey: 'synthetic-topic', provenance: {} }
  const run = { id: 91, ownerUserId: OWNER, entryId: ENTRY, stage: 'publication', state: 'succeeded' }
  const target = { id: TARGET, ownerUserId: OWNER, clientId: CLIENT, transport: 'generic_http', framework: 'generic_http', targetId: 'first-party-boundary', targetOrigin: 'https://publisher.invalid', contentRoot: '/', status: 'active' }
  const attempt = { id: 92, ownerUserId: OWNER, clientId: CLIENT, entryId: ENTRY, runId: 91, targetId: TARGET, status: 'delivered', mode: 'execute', receiptFingerprint: RECEIPT_HASH, contentHash: CONTENT_HASH, publicationUrl: 'https://client.acme.taipei/en/articles/synthetic-content', completedAt: PUBLISHED_AT }
  const exact: DeliveredPublication = { entry, calendar, deliverable, job, draft, publicationRun: run, publicationTarget: target, publicationAttempt: attempt } as never
  return override === undefined ? exact : override
}

function operationsFixture(overrides: OpsOverrides = {}) {
  const client = { id: CLIENT, ownerUserId: OWNER, canonicalSiteOrigin: 'https://client.acme.taipei' }
  let currentPublication = overrides.publication === undefined ? publication() : overrides.publication
  let outcomes = overrides.outcomes || []
  const ops = {
    findClient: vi.fn(async (ownerUserId: number, id: number) => ownerUserId === OWNER && id === CLIENT ? client : null),
    resolveDeliveredPublication: vi.fn(async (ownerUserId: number, entryId: number) => ownerUserId === OWNER && entryId === ENTRY ? currentPublication : null),
    listOutcomes: vi.fn(async (ownerUserId: number, limit = 100) => ownerUserId === OWNER ? structuredClone(outcomes.slice(0, limit)) : []),
    findOutcomeByIdempotency: vi.fn(async (ownerUserId: number, key: string) => structuredClone(outcomes.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === key) || null)),
    listEntries: vi.fn(async () => currentPublication ? [currentPublication.entry] : []),
    findCalendar: vi.fn(async (_ownerUserId: number, calendarId: number) => calendarId === 9 ? currentPublication?.calendar || null : null),
  } as unknown as ContentOperationsRepository
  return {
    ops,
    setPublication(value: DeliveredPublication | null) { currentPublication = value },
    setOutcomes(value: ContentOperationOutcomeAssessmentRow[]) { outcomes = value },
    client,
  }
}

function interventionDependencies() {
  const repository = createInMemoryInterventionLoopRepository()
  return {
    repository,
    clock: { now: () => RELEASE_NOW },
    linkResolver: {
      resolveBrief: async (_owner: number, id: number) => ({ id }),
      resolveDraft: async (_owner: number, id: number) => ({ id, jobId: 71, contentHash: CONTENT_HASH }),
      resolveEntry: async (_owner: number, id: number) => ({ id }),
    },
    baselineProvider: { readInventoryHash: async () => null },
    pageFetcher: vi.fn(async () => { throw new Error('not expected in metadata-only publication registration') }),
    urlInspector: vi.fn(async () => ({ status: 'unknown' as const, reasonCode: 'not_configured' as const })),
    pageMetricsPuller: vi.fn(async () => ({ status: 'unknown' as const, reasonCode: 'not_configured' as const })),
  }
}

const datasetOutcome = (source: string, phase: 'baseline' | 'follow_up', windowStart: string, windowEnd: string, capturedAt: string, metrics: Record<string, number>) => {
  const base = { source, deidentifiedSubjectKey: 'e'.repeat(64), scopeFingerprint: 'f'.repeat(64), phase, windowStart, windowEnd, capturedAt, metrics }
  return { ...base, sourceHash: outcomeSha256(base) }
}

function validOutcome(): ContentOperationOutcomeAssessmentRow {
  const publicationIdentity = {
    deidentifiedSubjectKey: 'e'.repeat(64), scheduleEntryId: String(ENTRY), scheduleKey: 'calendar-entry-42', productionPlanId: '70', jobId: '71', draftId: String(DRAFT), draftVersion: String(DRAFT_VERSION),
    contentHash: CONTENT_HASH, evidenceSnapshotHash: EVIDENCE_HASH, publishedAt: PUBLISHED_AT.toISOString(), contentType: 'article', language: 'en', appliedRuleIds: ['direct-answer-first'], topicClusterCode: 'content-discovery',
  }
  const baselineSnapshot = [datasetOutcome('google_search_console', 'baseline', '2026-09-01T00:00:00.000Z', '2026-09-29T00:00:00.000Z', '2026-09-30T00:00:00.000Z', { impressions: 280, clicks: 28, averagePosition: 12 })]
  const followUpSnapshot = [datasetOutcome('google_search_console', 'follow_up', '2026-10-03T00:00:00.000Z', '2026-10-17T00:00:00.000Z', '2026-10-18T00:00:00.000Z', { impressions: 210, clicks: 42, averagePosition: 9 })]
  const request = { publication: publicationIdentity, baselineMeasurements: baselineSnapshot, followUpMeasurements: followUpSnapshot, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }
  const assessment = assessPublishedContentOutcome(request)
  return {
    id: 101, ownerUserId: OWNER, entryId: ENTRY, runId: 91, targetId: TARGET, draftId: DRAFT, publicationReceiptFingerprint: RECEIPT_HASH,
    publishedUrl: 'https://client.acme.taipei/en/articles/synthetic-content', contentHash: CONTENT_HASH, evidenceSnapshotHash: EVIDENCE_HASH,
    assessmentStatus: assessment.status, assessmentFingerprint: assessment.assessmentFingerprint, baselineSnapshot, followUpSnapshot, assessmentSnapshot: assessment,
    consentLineageSnapshot: {}, idempotencyKey: 'outcome-101', measuredAt: new Date('2026-10-19T12:00:00.000Z'), createdAt: RELEASE_NOW,
  } as ContentOperationOutcomeAssessmentRow
}

async function authorizedFixture() {
  const fixture = learningFixture()
  const result = await createLearningAuthorization(OWNER, fixture.input, { repository: fixture.repository, now: () => fixture.now })
  expect(result.authorization.usable).toBe(true)
  return fixture
}

describe('learning publication feedback integration', () => {
  it('keeps publication snapshots hash-only and exact to the accepted draft/receipt', () => {
    const title = 'Synthetic title', body = 'Paragraph one.\n\nParagraph two.', draftContentHash = contentFingerprint(title, body)
    const snapshot = publicationLearningSnapshot({ draftId: DRAFT, draftVersion: DRAFT_VERSION, draftContentHash, title, body, targetId: TARGET, publicationContentHash: CONTENT_HASH, receiptFingerprint: RECEIPT_HASH })
    expect(snapshot).toMatchObject({ draftId: DRAFT, draftVersion: DRAFT_VERSION, draftContentHash, targetId: TARGET, receiptFingerprint: RECEIPT_HASH, comparisonKind: 'exact_published_draft_snapshot', causalChangeSetEligible: false })
    expect(JSON.stringify(snapshot)).not.toContain('Synthetic title')
    expect(JSON.stringify(snapshot)).not.toContain('Paragraph one')
    expect(() => publicationLearningSnapshot({ draftId: DRAFT, draftVersion: DRAFT_VERSION, draftContentHash: CONTENT_HASH, title: 'x', body: 'x', targetId: TARGET, publicationContentHash: CONTENT_HASH, receiptFingerprint: 'invalid' })).toThrow()
  })

  it('is default-off before any receipt reads, intervention registration, or scheduling', async () => {
    const fixture = operationsFixture()
    const register = vi.fn()
    const schedule = vi.fn()
    const result = await notifyLearningLoopPublicationDelivered(OWNER, ENTRY, fixture.ops, { enabled: false, register, schedule })
    expect(result).toMatchObject({ status: 'disabled', interventionId: null, scheduled: 0 })
    expect(fixture.ops.resolveDeliveredPublication).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('blocks dry-run, missing receipt timestamp, and absent formal receipt', async () => {
    for (const invalid of [
      publication({ ...publication(), publicationAttempt: { ...publication().publicationAttempt!, status: 'fake' } } as never),
      publication({ ...publication(), publicationAttempt: { ...publication().publicationAttempt!, mode: 'dry_run' } } as never),
      publication({ ...publication(), publicationAttempt: { ...publication().publicationAttempt!, completedAt: null } } as never),
      null,
    ]) {
      const fixture = operationsFixture({ publication: invalid })
      const register = vi.fn()
      const result = await notifyLearningLoopPublicationDelivered(OWNER, ENTRY, fixture.ops, { enabled: true, register, schedule: async () => ({ entryId: ENTRY, targetIds: [TARGET], scheduled: 0, runs: [] }) })
      expect(result.status).toBe('blocked')
      expect(result.reasonCodes).toContain('EXACT_DELIVERED_RECEIPT_REQUIRED')
      expect(register).not.toHaveBeenCalled()
    }
  })

  it('registers from exact receipt metadata idempotently and only schedules metadata work', async () => {
    const fixture = operationsFixture()
    const intervention = interventionDependencies()
    const schedule = vi.fn(async () => ({ entryId: ENTRY, targetIds: [TARGET], scheduled: 1, runs: [] }))
    const deps = { enabled: true, intervention, schedule }
    const first = await notifyLearningLoopPublicationDelivered(OWNER, ENTRY, fixture.ops, deps)
    const replay = await notifyLearningLoopPublicationDelivered(OWNER, ENTRY, fixture.ops, deps)
    expect(first).toMatchObject({ status: 'completed', scheduled: 1, interventionId: expect.any(Number) })
    expect(replay.interventionId).toBe(first.interventionId)
    await expect(intervention.repository.listInterventions(OWNER)).resolves.toHaveLength(1)
    expect(intervention.pageFetcher).not.toHaveBeenCalled()
    expect(intervention.urlInspector).not.toHaveBeenCalled()
    expect(intervention.pageMetricsPuller).not.toHaveBeenCalled()
    expect(schedule).toHaveBeenCalledTimes(2)
  })

  it('defers a post-commit learning outage without any publication retry path', async () => {
    const fixture = operationsFixture()
    const register = vi.fn(async () => { throw new Error('synthetic intervention repository outage') })
    const schedule = vi.fn(async () => ({ entryId: ENTRY, targetIds: [TARGET], scheduled: 1, runs: [] }))
    const result = await notifyLearningLoopPublicationDelivered(OWNER, ENTRY, fixture.ops, { enabled: true, register, schedule })
    expect(result).toMatchObject({ status: 'deferred', interventionId: null, scheduled: 1, reasonCodes: ['INTERVENTION_REGISTRATION_DEFERRED'] })
    expect(register).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(fixture.ops.resolveDeliveredPublication).toHaveBeenCalled()
    // The bridge has no publisher dependency; recovery is registration/scheduling only.
  })

  it('recomputes exact delivered outcomes into directional candidates while keeping citation eligibility off', async () => {
    const learning = await authorizedFixture()
    const outcome = validOutcome()
    const ops = operationsFixture({ outcomes: [outcome] })
    const historical = outcome.assessmentSnapshot as { publication: unknown }
    const payload = { outcomeRequest: { publication: historical.publication, baselineMeasurements: outcome.baselineSnapshot, followUpMeasurements: outcome.followUpSnapshot, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }, assessment: historical }
    expect(scanOutcomeLearningPii(payload).status).toBe('none_detected')
    const release = await buildGovernedContentOutcomeRelease(OWNER, { operations: ops.ops, repository: learning.repository, now: RELEASE_NOW })
    expect(release.dataset.eligibleCandidates, JSON.stringify(release.blocked)).toHaveLength(1)
    expect(release.dataset.eligibleCandidates[0]?.directionalLabels).toEqual([{ source: 'google_search_console', signal: 'positive_signal' }])
    expect(release.dataset.manifest.status).toBe('gate_blocked')
    expect(release.citationTrainingEligible).toBe(false)
    expect(release.taskType).toBe('content_effect_direction')
    expect(ops.ops.listOutcomes).toHaveBeenCalledWith(OWNER, 500)
    expect(ops.ops.findOutcomeByIdempotency).toHaveBeenCalledWith(OWNER, outcome.idempotencyKey)
  })

  it('excludes revoked consent, current source-policy drift, receipt drift, and a tampered assessment', async () => {
    for (const mutation of ['revoked', 'source-drift', 'receipt-drift', 'tampered-assessment'] as const) {
      const learning = await authorizedFixture()
      const outcome = validOutcome()
      const ops = operationsFixture({ outcomes: [outcome] })
      if (mutation === 'revoked') {
        learning.repository.authorizations[0]!.status = 'revoked'
        learning.repository.authorizations[0]!.revokedAt = RELEASE_NOW
      }
      if (mutation === 'source-drift') learning.repository.sources[0]!.termsStatus = 'prohibits_training'
      if (mutation === 'receipt-drift') {
        const old = publication()
        ops.setPublication({ ...old, publicationAttempt: { ...old.publicationAttempt!, receiptFingerprint: 'e'.repeat(64) } } as never)
      }
      if (mutation === 'tampered-assessment') {
        const historical = outcome.assessmentSnapshot as Record<string, unknown>
        outcome.assessmentSnapshot = { ...historical, signal: 'negative_signal' } as never
      }
      const release = await buildGovernedContentOutcomeRelease(OWNER, { operations: ops.ops, repository: learning.repository, now: RELEASE_NOW })
      expect(release.dataset.eligibleCandidates, mutation).toHaveLength(0)
      expect(release.citationTrainingEligible).toBe(false)
    }
  })

  it('drops a staged outcome when consent is revoked before the final release recheck', async () => {
    const learning = await authorizedFixture()
    const outcome = validOutcome()
    const ops = operationsFixture({ outcomes: [outcome] })
    const readScope = learning.repository.getScope.bind(learning.repository)
    let scopeReads = 0
    learning.repository.getScope = async (owner, id) => {
      scopeReads += 1
      if (scopeReads === 2) {
        learning.repository.authorizations[0]!.status = 'revoked'
        learning.repository.authorizations[0]!.revokedAt = RELEASE_NOW
      }
      return readScope(owner, id)
    }
    const release = await buildGovernedContentOutcomeRelease(OWNER, { operations: ops.ops, repository: learning.repository, now: RELEASE_NOW })
    expect(scopeReads).toBe(2)
    expect(release.dataset.eligibleCandidates).toHaveLength(0)
    expect(release.blocked.map(item => item.reasonCode)).toContain('LINEAGE_CHANGED_BEFORE_RELEASE')
  })

  it('re-reads the exact persisted outcome and rejects changed snapshots, timestamps or identity before release', async () => {
    for (const mutation of ['missing', 'baseline', 'follow-up', 'assessment', 'measured-at', 'owner', 'identity'] as const) {
      const learning = await authorizedFixture(), outcome = validOutcome(), ops = operationsFixture({ outcomes: [outcome] })
      vi.mocked(ops.ops.findOutcomeByIdempotency).mockImplementation(async () => {
        if (mutation === 'missing') return null
        const changed = structuredClone(outcome)
        if (mutation === 'baseline') changed.baselineSnapshot = []
        if (mutation === 'follow-up') changed.followUpSnapshot = []
        if (mutation === 'assessment') changed.assessmentSnapshot = { ...changed.assessmentSnapshot as object, signal: 'negative_signal' }
        if (mutation === 'measured-at') changed.measuredAt = new Date(outcome.measuredAt.getTime() + 1000)
        if (mutation === 'owner') changed.ownerUserId = OWNER + 1
        if (mutation === 'identity') changed.id += 1
        return changed
      })
      const release = await buildGovernedContentOutcomeRelease(OWNER, { operations: ops.ops, repository: learning.repository, now: RELEASE_NOW })
      expect(release.dataset.eligibleCandidates, mutation).toHaveLength(0)
      expect(release.blocked.map(item => item.reasonCode), mutation).toContain('LINEAGE_CHANGED_BEFORE_RELEASE')
    }
  })

  it('rechecks current evidence lineage and current time after delayed receipt reads', async () => {
    for (const mutation of ['evidence', 'expired'] as const) {
      const learning = await authorizedFixture(), outcome = validOutcome(), ops = operationsFixture({ outcomes: [outcome] })
      let reads = 0, now = RELEASE_NOW
      vi.mocked(ops.ops.resolveDeliveredPublication).mockImplementation(async () => {
        reads += 1
        const current = publication()
        if (reads === 2 && mutation === 'evidence') current.entry.evidenceSnapshotHash = '9'.repeat(64)
        if (reads === 2 && mutation === 'expired') now = new Date('2027-01-01T00:00:00.000Z')
        return current
      })
      const release = await buildGovernedContentOutcomeRelease(OWNER, { operations: ops.ops, repository: learning.repository, now: () => now })
      expect(reads).toBe(2)
      expect(release.dataset.eligibleCandidates, mutation).toHaveLength(0)
      expect(release.blocked.map(item => item.reasonCode), mutation).toContain('LINEAGE_CHANGED_BEFORE_RELEASE')
    }
  })
})
