import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OUTCOME_DATA_CONTRACT_VERSION } from '../server/outcome-learning'
import { createContentOperationsRepository, createOwnerContentClient, createCalendarFromProductionPlan, getOwnerContentOperationsWorkspace, materializeOwnerDueContent, recordOwnerOutcomeAssessment, replanOwnerContentCalendar, runContentOperationsTick } from '../server/content-operations'
import { createContentOperationsRepositoryFromDatabase } from '../server/content-operations/repository'
import { normalizePublicHttpsOrigin, stableFingerprint } from '../server/content-operations/normalization'
import { ContentOperationsFixture, HASH, fixtureClient } from './fixtures/content-operations/repository'

const clock = { now: () => new Date('2026-01-01T12:00:00.000Z'), localDate: () => '2026-01-01' }

function validClientInput(idempotencyKey = 'client-key', origin = 'https://example.com') {
  return { displayName: 'Example', canonicalSiteOrigin: origin, framework: 'nuxt' as const, publicationTransport: 'first_party_git' as const, timeZone: 'UTC', defaultCadenceDays: 3 as const, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey }
}

function validCalendarInput(clientId: number, productionPlanId = 11, idempotencyKey = 'calendar-key') {
  return { clientId, productionPlanId, planStartDate: '2026-01-01', planEndDate: '2026-03-31', publishLocalTime: '09:00', cadenceDays: 3 as const, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: 10, catchUpPolicy: 'skip_missed' as const, idempotencyKey }
}

function validReplanInput(expectedPlanFingerprint: string, idempotencyKey = 'replan-key') {
  return { expectedPlanFingerprint, idempotencyKey, planStartDate: '2026-02-01', planEndDate: '2026-04-30', publishLocalTime: '09:00', cadenceDays: 7 as const, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: 10, catchUpPolicy: 'one_catch_up' as const }
}

function validMaterializeInput(calendar: { id: number; planFingerprint: string }, idempotencyKey: string) {
  return { calendarId: calendar.id, expectedPlanFingerprint: calendar.planFingerprint, idempotencyKey }
}

describe('Content Operations Persistence & Scheduler Core V1', () => {
  it('keeps client persistence owner-scoped, idempotent, origin-safe, and credential-free', async () => {
    const fixture = new ContentOperationsFixture()
    const first = await createOwnerContentClient(1, validClientInput(), fixture.repository)
    const replay = await createOwnerContentClient(1, validClientInput(), fixture.repository)
    expect(replay.id).toBe(first.id)
    await expect(createOwnerContentClient(1, validClientInput('client-key', 'https://other.example'), fixture.repository)).rejects.toMatchObject({ statusCode: 409 })
    const otherOwner = await createOwnerContentClient(2, validClientInput('client-key', 'https://example.com'), fixture.repository)
    expect(otherOwner.ownerUserId).toBe(2)
    expect(JSON.stringify(first)).not.toMatch(/token|secret|authorization|credential/i)
    for (const origin of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.1.1', 'https://example.com/path', 'https://user:pass@example.com']) await expect(createOwnerContentClient(1, validClientInput(`bad-${origin}`, origin), fixture.repository)).rejects.toMatchObject({ statusCode: 422 })
    expect(normalizePublicHttpsOrigin('https://EXAMPLE.com/')).toBe('https://example.com')
  })

  it('builds calendar opportunities only from persisted plan provenance and replays deterministically', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    fixture.addPlan(1, 2)
    const created = await createCalendarFromProductionPlan(1, validCalendarInput(client.id), fixture.repository)
    expect(created.replayed).toBe(false)
    expect(created.entries.length).toBeGreaterThan(0)
    expect(created.calendar.evidenceSnapshotHash).toBe(HASH)
    expect(created.entries[0]?.productionDeliverableId).toBe(1)
    const replay = await createCalendarFromProductionPlan(1, validCalendarInput(client.id), fixture.repository)
    expect(replay.replayed).toBe(true)
    expect(replay.calendar.id).toBe(created.calendar.id)
    await expect(createCalendarFromProductionPlan(1, { ...validCalendarInput(client.id), maximumTotalItems: 5 }, fixture.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(createCalendarFromProductionPlan(2, validCalendarInput(client.id), fixture.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('fails closed for missing, mixed, stale, or client-supplied opportunity provenance', async () => {
    const missing = new ContentOperationsFixture()
    const client = missing.addClient(1)
    const plan = missing.addPlan(1, 1)
    plan.strategies[0]!.ruleIds = []
    await expect(createCalendarFromProductionPlan(1, validCalendarInput(client.id), missing.repository)).rejects.toMatchObject({ statusCode: 422 })
    const mixed = new ContentOperationsFixture()
    const mixedClient = mixed.addClient(1)
    const mixedPlan = mixed.addPlan(1, 2)
    mixedPlan.deliverables[1]!.evidenceSnapshotHash = 'b'.repeat(64)
    await expect(createCalendarFromProductionPlan(1, validCalendarInput(mixedClient.id), mixed.repository)).rejects.toMatchObject({ statusCode: 409 })
    const clientPayload = { ...validCalendarInput(mixedClient.id), opportunities: [{ id: 'client-fake' }] }
    await expect(createCalendarFromProductionPlan(1, clientPayload, mixed.repository)).rejects.toMatchObject({ statusCode: 422 })
    expect(mixedPlan.plan.status).toBe('ready')
  })

  it('increments revision on replan, preserves completed history, and rejects stale fingerprints', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    fixture.addPlan(1, 2)
    const created = await createCalendarFromProductionPlan(1, validCalendarInput(client.id), fixture.repository)
    const completed = fixture.entries.find(entry => entry.calendarId === created.calendar.id)!
    fixture.markCompleted(created.calendar.id, completed.id)
    const initialRevision = created.calendar.revision
    const initialFingerprint = created.calendar.planFingerprint
    const replanned = await replanOwnerContentCalendar(1, created.calendar.id, validReplanInput(initialFingerprint), fixture.repository)
    expect(replanned.calendar.revision).toBeGreaterThan(initialRevision)
    expect(replanned.calendar.previousPlanFingerprint).toBe(initialFingerprint)
    expect(fixture.entries.find(entry => entry.id === completed.id)?.status).toBe('completed')
    const replay = await replanOwnerContentCalendar(1, created.calendar.id, validReplanInput(initialFingerprint), fixture.repository)
    expect(replay.replayed).toBe(true)
    await expect(replanOwnerContentCalendar(1, created.calendar.id, validReplanInput(initialFingerprint, 'replan-stale'), fixture.repository)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('cancels planned rows removed by a smaller replan while keeping the active snapshot valid', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    fixture.addPlan(1, 3)
    const created = await createCalendarFromProductionPlan(1, validCalendarInput(client.id), fixture.repository)
    const replanned = await replanOwnerContentCalendar(1, created.calendar.id, { ...validReplanInput(created.calendar.planFingerprint, 'replan-smaller'), maximumTotalItems: 1 }, fixture.repository)
    expect((replanned.calendar.resultSnapshot as { entries: unknown[] }).entries).toHaveLength(1)
    expect(replanned.entries.filter(entry => entry.status === 'planned')).toHaveLength(1)
    expect(replanned.entries.filter(entry => entry.status === 'cancelled')).toHaveLength(2)
    expect(fixture.events.filter(event => event.eventType === 'entry_cancelled_by_replan')).toHaveLength(2)
    const materialized = await materializeOwnerDueContent(1, { calendarId: created.calendar.id, expectedPlanFingerprint: replanned.calendar.planFingerprint, idempotencyKey: 'materialize-after-smaller-replan' }, fixture.repository, { clock: { now: () => new Date('2026-02-01T12:00:00Z'), localDate: () => '2026-02-01' } })
    expect(materialized.entries.filter(entry => entry.status === 'cancelled')).toHaveLength(2)
  })

  it('can expand after a smaller replan without losing cancelled audit history', async () => {
    const fixture = new ContentOperationsFixture()
    const client = fixture.addClient(1)
    fixture.addPlan(1, 3)
    const created = await createCalendarFromProductionPlan(1, validCalendarInput(client.id), fixture.repository)
    const smaller = await replanOwnerContentCalendar(1, created.calendar.id, { ...validReplanInput(created.calendar.planFingerprint, 'replan-down'), maximumTotalItems: 1 }, fixture.repository)
    const cancelledIds = smaller.entries.filter(entry => entry.status === 'cancelled').map(entry => entry.id).sort((left, right) => left - right)
    const expanded = await replanOwnerContentCalendar(1, created.calendar.id, { ...validReplanInput(smaller.calendar.planFingerprint, 'replan-up'), maximumTotalItems: 3 }, fixture.repository)
    expect(expanded.entries.filter(entry => entry.status === 'planned')).toHaveLength(3)
    expect(expanded.entries.filter(entry => entry.status === 'cancelled').map(entry => entry.id).sort((left, right) => left - right)).toEqual(cancelledIds)
    expect(new Set(expanded.entries.map(entry => entry.id)).size).toBe(expanded.entries.length)
  })

  it('materializes due work once, creates a staged run/event, and never calls a provider', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar(1, '2026-01-01', 2)
    const first = await materializeOwnerDueContent(1, validMaterializeInput(calendar, 'materialize-1'), fixture.repository, { clock, maxEntries: 1 })
    expect(first.dueWork).toHaveLength(1)
    expect(first.runs[0]?.stage).toBe('generation')
    expect(first.events[0]?.eventType).toBe('entry_materialized')
    const second = await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: first.calendar.planFingerprint, idempotencyKey: 'materialize-2' }, fixture.repository, { clock: { now: () => new Date('2026-01-04T12:00:00.000Z'), localDate: () => '2026-01-04' }, maxEntries: 1 })
    expect(second.dueWork).toHaveLength(1)
    expect(fixture.entries.filter(entry => entry.status === 'materialized')).toHaveLength(2)
    expect(fixture.events.map(event => event.eventType)).toEqual(['operation_claim', 'entry_materialized', 'operation_claim', 'entry_materialized'])
  })

  it('enforces non-overlapping leases and supports expired lease recovery', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar()
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    const run = await fixture.repository.insertRun({ ownerUserId: 1, entryId: entry.id, stage: 'generation', state: 'queued', attemptNumber: 0, idempotencyKey: 'lease-key', inputFingerprint: HASH, outputFingerprint: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: null, completedAt: null })
    expect(await fixture.repository.acquireRunLease(1, run.id, 'worker-a', clock.now(), 300000)).not.toBeNull()
    expect(await fixture.repository.acquireRunLease(1, run.id, 'worker-b', clock.now(), 300000)).toBeNull()
    fixture.runs[0]!.leaseExpiresAt = new Date('2025-12-31T00:00:00.000Z')
    expect(await fixture.repository.acquireRunLease(1, run.id, 'worker-b', clock.now(), 300000)).not.toBeNull()
  })

  it('bounds a scheduler tick at 50 entries and lists only truthful capabilities', async () => {
    const fixture = new ContentOperationsFixture()
    let calendar = await fixture.addCalendar(1, '2026-01-01', 1)
    for (let index = 1; index < 60; index += 1) calendar = await fixture.addCalendar(1, '2026-01-01', 1)
    expect(new Set(fixture.entries.map(entry => entry.idempotencyKey)).size).toBe(60)
    const result = await runContentOperationsTick({ ownerUserId: 1, repository: fixture.repository, clock, maxEntries: 500 })
    expect(result.selected).toBe(50)
    expect(result.materialized).toBe(50)
    expect(fixture.entries.filter(entry => entry.status === 'materialized')).toHaveLength(50)
    const workspace = await getOwnerContentOperationsWorkspace(1, fixture.repository)
    expect(workspace.capabilities).toEqual({ schedulerAvailable: true, generationExecutorConfigured: false, firstPartyPublisherConfigured: false, outcomeCollectionConfigured: false })
    expect(workspace.calendars.some(item => item.id === calendar.id)).toBe(true)
  })

  it('uses append-only events and blocks outcome assessment before delivery or across owners', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar()
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    const baseline = [{ source: 'google_search_console', deidentifiedSubjectKey: 'ignored', scopeFingerprint: HASH, phase: 'baseline', windowStart: '2025-10-01T00:00:00.000Z', windowEnd: '2025-10-31T00:00:00.000Z', capturedAt: '2025-11-01T00:00:00.000Z', sourceHash: 'b'.repeat(64), metrics: { clicks: 1 } }]
    const followUp = [{ ...baseline[0], phase: 'follow_up', windowStart: '2026-01-02T00:00:00.000Z', windowEnd: '2026-02-01T00:00:00.000Z', capturedAt: '2026-02-02T00:00:00.000Z', sourceHash: 'c'.repeat(64), metrics: { clicks: 2 } }]
    await expect(recordOwnerOutcomeAssessment(1, { entryId: entry.id, idempotencyKey: 'outcome-before', baselineMeasurements: baseline, followUpMeasurements: followUp, consent: {}, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }, fixture.repository)).rejects.toMatchObject({ statusCode: 422 })
    entry.status = 'delivered'
    entry.contentHash = 'd'.repeat(64)
    fixture.delivered.set(entry.id, { entry, calendar, deliverable: { id: entry.productionDeliverableId, ownerUserId: 1, planId: calendar.productionPlanId, selectionId: entry.strategyRecommendationId, contentType: entry.contentType, title: 'Article 1', audience: 'owner audience', language: entry.language, evidenceSnapshotHash: HASH, opportunityKey: `strategy-${entry.strategyRecommendationId}:${entry.topicCluster}`, provenance: {} }, job: { id: 201, ownerUserId: 1, productionPlanId: calendar.productionPlanId, productionDeliverableId: entry.productionDeliverableId, strategyRecommendationId: entry.strategyRecommendationId, evidenceSnapshotHash: HASH, briefId: 301 }, draft: { id: 301, jobId: 201, version: 1, contentHash: entry.contentHash, evidenceRefs: [], safetyStatus: 'passed' }, review: { id: 401, jobId: 201, draftId: 301, reviewerUserId: 1, decision: 'approved_for_delivery', evidenceSnapshotHash: HASH }, riskGate: { id: 451, draftId: 301, status: 'passed', evidenceSnapshotHash: HASH }, publicationRun: { id: 501, ownerUserId: 1, entryId: entry.id, stage: 'publication', state: 'succeeded', attemptNumber: 1, idempotencyKey: 'publication', inputFingerprint: HASH, outputFingerprint: HASH, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: new Date('2026-01-01T12:00:00Z'), completedAt: new Date('2026-01-01T12:00:00Z'), createdAt: new Date('2026-01-01T12:00:00Z'), updatedAt: new Date('2026-01-01T12:00:00Z') } })
    const assessed = await recordOwnerOutcomeAssessment(1, { entryId: entry.id, idempotencyKey: 'outcome-key', baselineMeasurements: baseline.map(item => ({ ...item, deidentifiedSubjectKey: 'owner-subject' })), followUpMeasurements: followUp.map(item => ({ ...item, deidentifiedSubjectKey: 'owner-subject' })), consent: {}, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION, learningCandidate: true }, fixture.repository)
    expect(assessed.assessment.publication.contentHash).toBe(entry.contentHash)
    expect(assessed.learningCandidate?.candidateStatus).toBe('blocked')
    const replay = await recordOwnerOutcomeAssessment(1, { entryId: entry.id, idempotencyKey: 'outcome-key', baselineMeasurements: baseline.map(item => ({ ...item, deidentifiedSubjectKey: 'owner-subject' })), followUpMeasurements: followUp.map(item => ({ ...item, deidentifiedSubjectKey: 'owner-subject' })), consent: {}, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION, learningCandidate: true }, fixture.repository)
    expect(replay.persisted.id).toBe(assessed.persisted.id)
    await expect(recordOwnerOutcomeAssessment(1, { entryId: entry.id, idempotencyKey: 'outcome-key', baselineMeasurements: [], followUpMeasurements: [], consent: {}, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }, fixture.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(recordOwnerOutcomeAssessment(2, { entryId: entry.id, idempotencyKey: 'owner-b', baselineMeasurements: [], followUpMeasurements: [], consent: {}, dataContractVersion: OUTCOME_DATA_CONTRACT_VERSION }, fixture.repository)).rejects.toMatchObject({ statusCode: 422 })
    expect(fixture.repository).not.toHaveProperty('updateEvent')
    expect(fixture.repository).not.toHaveProperty('deleteEvent')
  })

  it('fails closed when the database is unavailable and rejects malformed JSON/unknown keys', async () => {
    expect(() => createContentOperationsRepository()).toThrowError(/Content Operations is temporarily unavailable/)
    const fixture = new ContentOperationsFixture()
    await expect(createOwnerContentClient(1, { ...validClientInput(), unexpected: true }, fixture.repository)).rejects.toMatchObject({ statusCode: 422 })
    await expect(createCalendarFromProductionPlan(1, { ...validCalendarInput(1), opportunity: [] }, fixture.repository)).rejects.toMatchObject({ statusCode: 422 })
    expect(() => JSON.parse('{malformed')).toThrow()
    expect(createContentOperationsRepositoryFromDatabase).toBeTypeOf('function')
  })
})

describe('Content Operations repair concurrency and integrity regressions', () => {
  it('processes stable first 50 eligible entries, leaves the 51st planned, and keeps snapshot fingerprint valid', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar(1, '2026-01-01', 51)
    const oldFingerprint = calendar.planFingerprint
    const result = await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: oldFingerprint, idempotencyKey: 'materialize-50' }, fixture.repository, { clock: { now: () => new Date('2026-06-30T12:00:00.000Z'), localDate: () => '2026-06-30' } })
    expect(result.entries.filter(entry => entry.status === 'skipped')).toHaveLength(50)
    expect(result.entries.filter(entry => entry.status === 'planned')).toHaveLength(1)
    expect(result.calendar.planFingerprint).toBe((result.calendar.resultSnapshot as { planFingerprint: string }).planFingerprint)
    expect(result.calendar.revision).toBeGreaterThan(1)
    await expect(materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: oldFingerprint, idempotencyKey: 'materialize-stale' }, fixture.repository, { clock })).rejects.toMatchObject({ statusCode: 409 })
    const noDue = await materializeOwnerDueContent(1, { calendarId: calendar.id, expectedPlanFingerprint: result.calendar.planFingerprint, idempotencyKey: 'materialize-no-due' }, fixture.repository, { clock: { now: () => new Date('2025-01-01T12:00:00.000Z'), localDate: () => '2025-01-01' } })
    expect(noDue.calendar.revision).toBe(result.calendar.revision)
    expect(noDue.calendar.planFingerprint).toBe((result.calendar.resultSnapshot as { planFingerprint: string }).planFingerprint)
  })

  it('replays duplicate materialize without new run/event and concurrent identical requests claim once', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar()
    const input = validMaterializeInput(calendar, 'materialize-replay')
    const [first, second] = await Promise.all([materializeOwnerDueContent(1, input, fixture.repository, { clock }), materializeOwnerDueContent(1, input, fixture.repository, { clock })])
    expect([first.replayed, second.replayed].sort()).toEqual([false, true])
    expect(fixture.entries.filter(entry => entry.status === 'materialized')).toHaveLength(1)
    expect(fixture.events.filter(event => event.eventType === 'entry_materialized')).toHaveLength(1)
    expect(fixture.events.filter(event => event.eventType === 'operation_claim')).toHaveLength(1)
  })

  it('enforces retry eligibility, terminal-state exclusion, and token-bound release', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar()
    const entry = fixture.entries.find(item => item.calendarId === calendar.id)!
    const futureRetry = await fixture.repository.insertRun({ ownerUserId: 1, entryId: entry.id, stage: 'generation', state: 'retry_wait', attemptNumber: 1, idempotencyKey: 'retry-future', inputFingerprint: HASH, outputFingerprint: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: new Date('2026-01-02T00:00:00Z'), errorCode: 'TEMP', errorSummary: 'retry later', startedAt: null, completedAt: null })
    expect(await fixture.repository.acquireRunLease(1, futureRetry.id, 'worker-a', clock.now(), 300000)).toBeNull()
    futureRetry.retryEligibleAt = new Date('2025-12-31T00:00:00Z')
    expect(await fixture.repository.acquireRunLease(1, futureRetry.id, 'worker-a', clock.now(), 300000)).not.toBeNull()
    expect(await fixture.repository.releaseRunLease(1, futureRetry.id, 'queued', 'worker-b', clock.now())).toBeNull()
    expect(futureRetry.state).toBe('processing')
    expect(await fixture.repository.releaseRunLease(1, futureRetry.id, 'queued', 'worker-a', clock.now())).not.toBeNull()
    for (const state of ['succeeded', 'failed', 'blocked', 'cancelled'] as const) {
      const terminal = await fixture.repository.insertRun({ ownerUserId: 1, entryId: entry.id, stage: 'generation', state, attemptNumber: 1, idempotencyKey: `terminal-${state}`, inputFingerprint: HASH, outputFingerprint: HASH, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: clock.now(), completedAt: clock.now() })
      expect(await fixture.repository.acquireRunLease(1, terminal.id, 'worker-terminal', clock.now(), 300000)).toBeNull()
    }
  })

  it('rejects a stale run identity and rolls back a fully conflicted materialization claim', async () => {
    const stale = new ContentOperationsFixture()
    const staleCalendar = await stale.addCalendar(1, '2026-01-01', 1)
    const staleEntry = stale.entries.find(entry => entry.calendarId === staleCalendar.id)!
    await stale.repository.insertRun({ ownerUserId: 1, entryId: staleEntry.id, stage: 'generation', state: 'queued', attemptNumber: 0, idempotencyKey: `content-operation-run:${staleEntry.idempotencyKey}:generation`.slice(0, 128), inputFingerprint: 'b'.repeat(64), outputFingerprint: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: null, completedAt: null })
    await expect(materializeOwnerDueContent(1, validMaterializeInput(staleCalendar, 'stale-run'), stale.repository, { clock })).rejects.toMatchObject({ statusCode: 409 })
    expect(stale.entries.find(entry => entry.id === staleEntry.id)?.status).toBe('planned')
    expect(stale.events).toHaveLength(0)

    const conflicted = new ContentOperationsFixture()
    const conflictedCalendar = await conflicted.addCalendar(1, '2026-01-01', 1)
    const conflictedEntry = conflicted.entries.find(entry => entry.calendarId === conflictedCalendar.id)!
    const inputFingerprint = stableFingerprint({ entryId: conflictedEntry.engineEntryId, stage: 'generation', evidenceSnapshotHash: conflictedEntry.evidenceSnapshotHash, planFingerprint: conflictedCalendar.planFingerprint })
    const run = await conflicted.repository.insertRun({ ownerUserId: 1, entryId: conflictedEntry.id, stage: 'generation', state: 'queued', attemptNumber: 0, idempotencyKey: `content-operation-run:${conflictedEntry.idempotencyKey}:generation`.slice(0, 128), inputFingerprint, outputFingerprint: null, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: null, completedAt: null })
    await conflicted.repository.acquireRunLease(1, run.id, 'other-worker', clock.now(), 300000)
    await expect(materializeOwnerDueContent(1, validMaterializeInput(conflictedCalendar, 'lease-conflict'), conflicted.repository, { clock, leaseToken: 'this-worker' })).rejects.toMatchObject({ statusCode: 409 })
    expect(conflicted.entries.find(entry => entry.id === conflictedEntry.id)?.status).toBe('planned')
    expect(conflicted.events).toHaveLength(0)
  })

  it('projects the canonical topic cluster for the owner workbench', async () => {
    const fixture = new ContentOperationsFixture()
    const calendar = await fixture.addCalendar(1, '2026-01-01', 1)
    const workspace = await getOwnerContentOperationsWorkspace(1, fixture.repository)
    const entry = workspace.entries.find(candidate => candidate.calendarId === calendar.id)
    expect(entry?.topic).toBe(entry?.topicCluster)
    expect(entry?.topic).toBe('opportunity-1')
  })
})
