import { buildContentCalendar, materializeDueContentWork } from '../../../server/content-calendar'
import { stableFingerprint } from '../../../server/content-operations/normalization'
import type { ContentOperationsRepository, WorkspaceEntryLineage } from '../../../server/content-operations/repository'
import type { ProductionPersistence } from '../../../server/seo-geo-core/service'
import { contentFingerprint } from '../../../server/seo-geo-core/riskGate'
import { geoRules } from '../../../server/geo/rules'
import type { ContentOperationAutopilotPolicyRow, ContentOperationCalendarEntryRow, ContentOperationCalendarEntryTargetRow, ContentOperationCalendarRow, ContentOperationClientRow, ContentOperationEntityStrategyProfileRow, ContentOperationEventRow, ContentOperationMachineAuthorizationRow, ContentOperationOutcomeAssessmentRow, ContentOperationPublicationAttemptRow, ContentOperationPublicationTargetRow, ContentOperationQueryOwnershipRow, ContentOperationRepairAttemptRow, ContentOperationRunRow, ContentOperationTopicSubstitutionRow, DeliveredPublication, PlanBundle } from '../../../server/content-operations/types'

export const HASH = 'a'.repeat(64)

function now(): Date { return new Date('2026-01-01T00:00:00.000Z') }
const canonicalFixtureRules = geoRules.filter(rule => ['direct-answer-first', 'semantic-sections'].includes(rule.id))

export function fixtureClient(ownerUserId = 1, id = 1): ContentOperationClientRow {
  return { id, ownerUserId, displayName: `Owner ${ownerUserId}`, canonicalSiteOrigin: `https://owner${ownerUserId}.example`, framework: 'nuxt', publicationTransport: 'first_party_git', timeZone: 'UTC', defaultCadenceDays: 3, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, status: 'active', idempotencyKey: `client-${ownerUserId}`, createdAt: now(), updatedAt: now() }
}

export function fixturePlan(ownerUserId = 1, deliverableCount = 2): PlanBundle {
  const opportunities = Array.from({ length: deliverableCount }, (_, index) => ({ key: `opportunity-${index + 1}`, deliverableType: 'article' as const, title: `Article ${index + 1}`, audience: 'owner audience', goals: ['explain'], constraints: ['verify'] }))
  const approvedAt = now().toISOString()
  const deliverables = opportunities.map((opportunity, index) => ({ id: index + 1, ownerUserId, planId: 11, selectionId: index + 1, opportunityKey: `${index + 1}:${opportunity.key}`, contentType: opportunity.deliverableType, title: opportunity.title, audience: opportunity.audience, goals: opportunity.goals, constraints: opportunity.constraints, language: 'en', status: 'planned', evidenceSnapshotHash: HASH, provenance: { strategyRecommendationId: index + 1, issueCode: 'synthetic_issue', recommendationKey: 'synthetic_recommendation', ruleIds: ['rule-topic'], rules: [{ id: 'rule-topic' }] } }))
  return {
    plan: { id: 11, ownerUserId, diagnosisId: 9, status: 'ready', language: 'en', evidenceSnapshotHash: HASH },
    selections: deliverables.map((deliverable, index) => ({ id: deliverable.selectionId, ownerUserId, planId: 11, strategyRecommendationId: index + 1, status: 'selected', evidenceSnapshotHash: HASH })),
    strategies: deliverables.map((deliverable, index) => ({ id: index + 1, ownerUserId, diagnosisId: 9, status: 'selected', evidenceSnapshotHash: HASH, priority: 'high', ruleIds: canonicalFixtureRules.map(rule => rule.id), ruleSetVersion: 'autogeo-compatible-rules-v1', rules: canonicalFixtureRules, evidenceRefs: [{ sourceId: index + 1, artifactId: index + 1, artifactHash: HASH, locator: `https://evidence.fixture.example/source-${index + 1}`, approvedAt }], contentOpportunities: [opportunities[index]!], provenance: { engine: 'autogeo-strategy-v1', ruleSource: 'discoverystack-autogeo-compatible' } })),
    deliverables,
  } as unknown as PlanBundle
}

export class ContentOperationsFixture {
  clients: ContentOperationClientRow[] = []
  calendars: ContentOperationCalendarRow[] = []
  entries: ContentOperationCalendarEntryRow[] = []
  runs: ContentOperationRunRow[] = []
  events: ContentOperationEventRow[] = []
  outcomes: ContentOperationOutcomeAssessmentRow[] = []
  targets: ContentOperationPublicationTargetRow[] = []
  entryTargetBindings: ContentOperationCalendarEntryTargetRow[] = []
  autopilotPolicies: ContentOperationAutopilotPolicyRow[] = []
  entityStrategyProfiles: ContentOperationEntityStrategyProfileRow[] = []
  queryOwnership: ContentOperationQueryOwnershipRow[] = []
  repairAttempts: ContentOperationRepairAttemptRow[] = []
  topicSubstitutions: ContentOperationTopicSubstitutionRow[] = []
  machineAuthorizations: ContentOperationMachineAuthorizationRow[] = []
  attempts: ContentOperationPublicationAttemptRow[] = []
  bundles = new Map<string, PlanBundle>()
  delivered = new Map<number, DeliveredPublication>()
  generated = new Map<number, { deliverable: Record<string, unknown>; job: Record<string, unknown>; draft?: Record<string, unknown>; riskGate?: Record<string, unknown> }>()
  briefs = new Map<number, Record<string, unknown>>()
  reviews = new Map<number, Record<string, unknown>>()
  nextId = 100
  evidenceApprovalAt = now().toISOString()
  riskCandidate = false
  readonly repository: ContentOperationsRepository

  constructor() {
    this.repository = {
      transaction: async work => {
        const snapshot = { clients: this.clients.map(row => ({ ...row })), calendars: this.calendars.map(row => ({ ...row })), entries: this.entries.map(row => ({ ...row })), runs: this.runs.map(row => ({ ...row })), events: this.events.map(row => ({ ...row })), outcomes: this.outcomes.map(row => ({ ...row })), targets: this.targets.map(row => ({ ...row })), entryTargetBindings: this.entryTargetBindings.map(row => ({ ...row })), autopilotPolicies: this.autopilotPolicies.map(row => ({ ...row })), entityStrategyProfiles: this.entityStrategyProfiles.map(row => structuredClone(row)), queryOwnership: this.queryOwnership.map(row => structuredClone(row)), repairAttempts: this.repairAttempts.map(row => structuredClone(row)), topicSubstitutions: this.topicSubstitutions.map(row => structuredClone(row)), machineAuthorizations: this.machineAuthorizations.map(row => structuredClone(row)), attempts: this.attempts.map(row => ({ ...row })), generated: new Map([...this.generated].map(([key, value]) => [key, structuredClone(value)])), briefs: new Map([...this.briefs].map(([key, value]) => [key, structuredClone(value)])), reviews: new Map([...this.reviews].map(([key, value]) => [key, structuredClone(value)])), nextId: this.nextId }
        try { return await work(this.repository) } catch (error) { this.clients = snapshot.clients; this.calendars = snapshot.calendars; this.entries = snapshot.entries; this.runs = snapshot.runs; this.events = snapshot.events; this.outcomes = snapshot.outcomes; this.targets = snapshot.targets; this.entryTargetBindings = snapshot.entryTargetBindings; this.autopilotPolicies = snapshot.autopilotPolicies; this.entityStrategyProfiles = snapshot.entityStrategyProfiles; this.queryOwnership = snapshot.queryOwnership; this.repairAttempts = snapshot.repairAttempts; this.topicSubstitutions = snapshot.topicSubstitutions; this.machineAuthorizations = snapshot.machineAuthorizations; this.attempts = snapshot.attempts; this.generated = snapshot.generated; this.briefs = snapshot.briefs; this.reviews = snapshot.reviews; this.nextId = snapshot.nextId; throw error }
      },
      findClientByIdempotency: async (owner, key) => this.clients.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      findClientByOrigin: async (owner, origin) => this.clients.find(row => row.ownerUserId === owner && row.canonicalSiteOrigin === origin) || null,
      findClient: async (owner, id) => this.clients.find(row => row.ownerUserId === owner && row.id === id) || null,
      insertClient: async input => { if (this.clients.some(row => row.ownerUserId === input.ownerUserId && (row.idempotencyKey === input.idempotencyKey || row.canonicalSiteOrigin === input.canonicalSiteOrigin))) throw Object.assign(new Error('duplicate entry'), { code: 'ER_DUP_ENTRY' }); const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationClientRow; this.clients.push(row); return row },
      listClients: async owner => this.clients.filter(row => row.ownerUserId === owner),
      findPublicationTargetByIdempotency: async (owner, key) => this.targets.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      findPublicationTarget: async (owner, id) => this.targets.find(row => row.ownerUserId === owner && row.id === id) || null,
      findActivePublicationTarget: async (owner, clientId) => this.targets.find(row => row.ownerUserId === owner && row.clientId === clientId && row.status === 'active' && row.activeSlot === 1) || null,
      insertPublicationTarget: async input => { if (input.activeSlot !== null && this.targets.some(row => row.ownerUserId === input.ownerUserId && row.clientId === input.clientId && row.activeSlot === input.activeSlot)) throw Object.assign(new Error('active slot duplicate'), { code: 'ER_DUP_ENTRY' }); const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationPublicationTargetRow; this.targets.push(row); return row },
      updatePublicationTarget: async (owner, id, patch) => { const row = this.targets.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing target'); if (patch.activeSlot !== undefined && patch.activeSlot !== null && this.targets.some(item => item.ownerUserId === owner && item.clientId === row.clientId && item.activeSlot === patch.activeSlot && item.id !== id)) throw Object.assign(new Error('active slot duplicate'), { code: 'ER_DUP_ENTRY' }); Object.assign(row, patch, { updatedAt: now() }); return row },
      listPublicationTargets: async owner => this.targets.filter(row => row.ownerUserId === owner),
      findAutopilotPolicy: async (owner, clientId, publicationTargetId) => this.autopilotPolicies.find(row => row.ownerUserId === owner && row.clientId === clientId && row.publicationTargetId === publicationTargetId) || null,
      listAutopilotPolicies: async (owner, clientId) => this.autopilotPolicies.filter(row => row.ownerUserId === owner && row.clientId === clientId).sort((left, right) => left.publicationTargetId - right.publicationTargetId),
      insertAutopilotPolicy: async input => { if (this.autopilotPolicies.some(row => row.ownerUserId === input.ownerUserId && row.publicationTargetId === input.publicationTargetId)) throw Object.assign(new Error('autopilot policy duplicate'), { code: 'ER_DUP_ENTRY' }); const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationAutopilotPolicyRow; this.autopilotPolicies.push(row); return row },
      revokeAutopilotPolicy: async (owner, policyId, revokedAt) => { const row = this.autopilotPolicies.find(item => item.ownerUserId === owner && item.policyId === policyId); if (!row) return null; Object.assign(row, { status: 'revoked', revokedAt, updatedAt: now() }); return row },
      findEntityStrategyProfile: async (owner, clientId, websiteId, profileId) => this.entityStrategyProfiles.filter(row => row.ownerUserId === owner && row.clientId === clientId && row.websiteId === websiteId && (!profileId || row.profileId === profileId) && row.status === 'active').sort((a, b) => b.version - a.version)[0] || null,
      insertEntityStrategyProfile: async input => { const existing = this.entityStrategyProfiles.find(row => row.ownerUserId === input.ownerUserId && row.profileFingerprint === input.profileFingerprint); if (existing) return existing; const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationEntityStrategyProfileRow; this.entityStrategyProfiles.push(row); return row },
      findQueryOwnership: async (owner, clientId, websiteId, normalizedQuery) => this.queryOwnership.filter(row => row.ownerUserId === owner && row.clientId === clientId && row.websiteId === websiteId && row.normalizedQuery === normalizedQuery && row.status === 'active').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] || null,
      insertQueryOwnership: async input => { const existing = this.queryOwnership.find(row => row.ownerUserId === input.ownerUserId && row.fingerprint === input.fingerprint); if (existing) return existing; const collision = this.queryOwnership.find(row => row.ownerUserId === input.ownerUserId && row.clientId === input.clientId && row.websiteId === input.websiteId && row.normalizedQuery === input.normalizedQuery && row.status === 'active' && row.ownerPageId !== input.ownerPageId); if (collision) throw Object.assign(new Error('active canonical query owner collision'), { statusCode: 409 }); const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationQueryOwnershipRow; this.queryOwnership.push(row); return row },
      listRepairAttempts: async (owner, entryId) => this.repairAttempts.filter(row => row.ownerUserId === owner && row.entryId === entryId).sort((a, b) => a.repairAttempt - b.repairAttempt),
      insertRepairAttempt: async input => { const existing = this.repairAttempts.find(row => row.ownerUserId === input.ownerUserId && row.repairFingerprint === input.repairFingerprint); if (existing) return existing; const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationRepairAttemptRow; this.repairAttempts.push(row); return row },
      updateRepairAttempt: async (owner, repairFingerprint, patch) => { const row = this.repairAttempts.find(item => item.ownerUserId === owner && item.repairFingerprint === repairFingerprint); if (!row) throw new Error('repair attempt not found'); if (patch.repairedDraftId !== undefined) row.repairedDraftId = patch.repairedDraftId; if (patch.repairedContentHash !== undefined) row.repairedContentHash = patch.repairedContentHash; if (patch.status !== undefined) row.status = patch.status; return row },
      listTopicSubstitutions: async (owner, entryId) => this.topicSubstitutions.filter(row => row.ownerUserId === owner && row.entryId === entryId).sort((a, b) => a.substitutionAttempt - b.substitutionAttempt),
      insertTopicSubstitution: async input => { const existing = this.topicSubstitutions.find(row => row.ownerUserId === input.ownerUserId && row.substitutionFingerprint === input.substitutionFingerprint); if (existing) return existing; const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationTopicSubstitutionRow; this.topicSubstitutions.push(row); return row },
      findMachineAuthorization: async (owner, entryId, authorizationFingerprint) => this.machineAuthorizations.find(row => row.ownerUserId === owner && row.entryId === entryId && row.authorizationFingerprint === authorizationFingerprint) || null,
      insertMachineAuthorization: async input => { const existing = this.machineAuthorizations.find(row => row.ownerUserId === input.ownerUserId && row.authorizationFingerprint === input.authorizationFingerprint); if (existing) return existing; const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationMachineAuthorizationRow; this.machineAuthorizations.push(row); return row },
      findCalendarByIdempotency: async (owner, key) => this.calendars.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      findCalendar: async (owner, id) => this.calendars.find(row => row.ownerUserId === owner && row.id === id) || null,
      insertCalendar: async input => { if (this.calendars.some(row => row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey)) throw Object.assign(new Error('duplicate entry'), { code: 'ER_DUP_ENTRY' }); const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationCalendarRow; this.calendars.push(row); return row },
      updateCalendar: async (owner, id, patch) => { const row = this.calendars.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing calendar'); Object.assign(row, patch, { updatedAt: now() }); return row },
      updateCalendarIfFingerprint: async (owner, id, fingerprint, patch) => { const row = this.calendars.find(item => item.ownerUserId === owner && item.id === id && item.planFingerprint === fingerprint); if (!row) return null; Object.assign(row, patch, { updatedAt: now() }); return row },
      claimOperation: async input => {
        const existing = this.events.find(row => row.ownerUserId === input.ownerUserId && row.eventFingerprint === input.eventFingerprint)
        if (existing) return { claimed: false, requestFingerprint: isRecord(existing.metadata) && typeof existing.metadata.requestFingerprint === 'string' ? existing.metadata.requestFingerprint : '', operation: input.operation, ownerUserId: input.ownerUserId, calendarId: input.calendarId, idempotencyKey: input.idempotencyKey }
        const row = { id: ++this.nextId, ownerUserId: input.ownerUserId, clientId: null, calendarId: input.calendarId, entryId: null, runId: null, eventType: 'operation_claim', fromStatus: null, toStatus: null, eventFingerprint: input.eventFingerprint, metadata: { claim: true, operation: input.operation, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint }, occurredAt: now() } as ContentOperationEventRow
        this.events.push(row)
        return { claimed: true, requestFingerprint: input.requestFingerprint, operation: input.operation, ownerUserId: input.ownerUserId, calendarId: input.calendarId, idempotencyKey: input.idempotencyKey }
      },
      listCalendars: async owner => this.calendars.filter(row => row.ownerUserId === owner),
      findEntry: async (owner, id) => this.entries.find(row => row.ownerUserId === owner && row.id === id) || null,
      listEntries: async (owner, calendarId) => this.entries.filter(row => row.ownerUserId === owner && (calendarId === undefined || row.calendarId === calendarId)).sort((a, b) => a.plannedLocalDate.localeCompare(b.plannedLocalDate) || a.scheduleKey.localeCompare(b.scheduleKey)),
      listEntryTargetBindings: async (owner, entryId) => this.entryTargetBindings.filter(row => row.ownerUserId === owner && row.entryId === entryId).sort((a, b) => a.slot - b.slot),
      insertEntryTargetBinding: async input => { const duplicate = this.entryTargetBindings.find(row => row.ownerUserId === input.ownerUserId && (row.entryId === input.entryId && row.targetId === input.targetId || row.entryId === input.entryId && row.slot === input.slot)); if (duplicate) { if (duplicate.targetId === input.targetId && duplicate.slot === input.slot && duplicate.bindingFingerprint === input.bindingFingerprint) return duplicate; throw Object.assign(new Error('entry target binding duplicate'), { code: 'ER_DUP_ENTRY' }); } const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationCalendarEntryTargetRow; this.entryTargetBindings.push(row); return row },
      insertEntry: async input => { const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationCalendarEntryRow; this.entries.push(row); return row },
      updateEntry: async (owner, id, patch) => { const row = this.entries.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing entry'); Object.assign(row, patch, { updatedAt: now() }); return row },
      listRuns: async (owner, entryId) => this.runs.filter(row => row.ownerUserId === owner && (entryId === undefined || row.entryId === entryId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      listEligibleRuns: async (at, limit, owner) => this.runs.filter(row => (owner === undefined || row.ownerUserId === owner) && (row.state === 'queued' || (row.state === 'retry_wait' && row.retryEligibleAt !== null && row.retryEligibleAt <= at) || (row.state === 'processing' && row.leaseExpiresAt !== null && row.leaseExpiresAt < at))).sort((a, b) => (a.retryEligibleAt || a.createdAt).getTime() - (b.retryEligibleAt || b.createdAt).getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id).slice(0, limit),
      findRunByIdempotency: async (owner, key) => this.runs.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      insertRun: async input => { const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationRunRow; this.runs.push(row); return row },
      acquireRunLease: async (owner, id, token, at, leaseMs) => { const row = this.runs.find(item => item.ownerUserId === owner && item.id === id); const eligible = row?.state === 'queued' || row?.state === 'retry_wait' && row.retryEligibleAt !== null && row.retryEligibleAt <= at || row?.state === 'processing' && row.leaseExpiresAt !== null && row.leaseExpiresAt < at; if (!row || !eligible) return null; Object.assign(row, { state: 'processing', leaseOwner: token, leaseExpiresAt: new Date(at.getTime() + leaseMs), startedAt: row.startedAt || at, updatedAt: at }); return row },
      releaseRunLease: async (owner, id, state, token, at, error) => { const row = this.runs.find(item => item.ownerUserId === owner && item.id === id && item.state === 'processing' && item.leaseOwner === token); if (!row) return null; Object.assign(row, { state, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: error?.retryEligibleAt || null, errorCode: error?.code || null, errorSummary: error?.summary || null, completedAt: ['succeeded', 'failed', 'blocked', 'cancelled'].includes(state) ? at : null, updatedAt: at }); return row },
      updateRun: async (owner, id, patch) => { const row = this.runs.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing run'); Object.assign(row, patch, { updatedAt: now() }); return row },
      appendEvent: async input => { const existing = this.events.find(row => row.ownerUserId === input.ownerUserId && row.eventFingerprint === input.eventFingerprint); if (existing) return existing; const row = { ...input, id: ++this.nextId, occurredAt: now() } as ContentOperationEventRow; this.events.push(row); return row },
      listEvents: async (owner, entryId) => this.events.filter(row => row.ownerUserId === owner && (entryId === undefined || row.entryId === entryId)),
      findLatestOptimizedDraft: async (owner, jobId) => [...this.generated.values()].map(value => value.draft).find(draft => Boolean(draft) && draft?.jobId === jobId && (draft?.ownerUserId === undefined || draft?.ownerUserId === owner)) as never || null,
      findRiskGate: async (owner, draftId, evidenceSnapshotHash) => [...this.generated.values()].map(value => value.riskGate).find(gate => Boolean(gate) && gate?.draftId === draftId && gate?.evidenceSnapshotHash === evidenceSnapshotHash && (gate?.ownerUserId === undefined || gate?.ownerUserId === owner)) as never || null,
      findLatestReview: async (owner, jobId, draftId, evidenceSnapshotHash) => [...this.reviews.values()].filter(review => review.ownerUserId === owner && review.jobId === jobId && review.draftId === draftId && review.evidenceSnapshotHash === evidenceSnapshotHash).sort((left, right) => Number(right.id) - Number(left.id))[0] as never || null,
      findPublicationAttemptByIdempotency: async (owner, key) => this.attempts.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      listPublicationAttempts: async (owner, entryId) => this.attempts.filter(row => row.ownerUserId === owner && (entryId === undefined || row.entryId === entryId)),
      insertPublicationAttempt: async input => { if (this.attempts.some(row => row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey)) throw Object.assign(new Error('duplicate attempt'), { code: 'ER_DUP_ENTRY' }); const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationPublicationAttemptRow; this.attempts.push(row); return row },
      reservePublicationAttempt: async input => {
        const existing = this.attempts.find(row => row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey)
        if (existing) {
          if (existing.entryId !== input.entryId || existing.runId !== input.runId || existing.targetId !== input.targetId || existing.mode !== input.mode || existing.inputFingerprint !== input.inputFingerprint) throw Object.assign(new Error('attempt idempotency collision'), { statusCode: 409 })
          const run = this.runs.find(row => row.ownerUserId === input.ownerUserId && row.id === input.runId && row.stage === 'publication' && row.state === 'processing' && row.leaseOwner === input.leaseToken)
          const entry = this.entries.find(row => row.ownerUserId === input.ownerUserId && row.id === input.entryId)
          if (!run || !entry || !['ready_to_publish', 'publishing'].includes(entry.status)) throw new Error('missing run or entry')
          entry.status = 'publishing'
          return { attempt: existing, run, replayed: true }
        }
        const run = this.runs.find(row => row.ownerUserId === input.ownerUserId && row.id === input.runId && row.stage === 'publication' && row.state === 'processing' && row.leaseOwner === input.leaseToken)
        const entry = this.entries.find(row => row.ownerUserId === input.ownerUserId && row.id === input.entryId)
        if (!run || !entry || !['ready_to_publish', 'publishing'].includes(entry.status)) throw Object.assign(new Error('publication lease or entry missing'), { statusCode: 409 })
        entry.status = 'publishing'
                  const requestedAttemptNumber = input.attemptNumber
          if (!Number.isSafeInteger(requestedAttemptNumber) || requestedAttemptNumber < 1 || requestedAttemptNumber > 3 || requestedAttemptNumber < run.attemptNumber) throw Object.assign(new Error('Publication retry limit has been reached or attempt number is stale.'), { statusCode: 422 })
          if (requestedAttemptNumber > run.attemptNumber) run.attemptNumber = requestedAttemptNumber
          run.updatedAt = input.startedAt
          const { jobId: _jobId, draftId: _draftId, reviewId: _reviewId, riskGateId: _riskGateId, leaseToken: _leaseToken, attemptNumber: _attemptNumber, ...attemptInput } = input
          const attempt = { ...attemptInput, attemptNumber: requestedAttemptNumber, artifactFingerprint: null, status: 'planned' as const, remoteState: null, remoteRevision: null, errorCode: null, errorSummary: null, completedAt: null, id: ++this.nextId, createdAt: now() } as ContentOperationPublicationAttemptRow

        this.attempts.push(attempt)
        return { attempt, run, replayed: false }
      },
      finalizePublicationAttempt: async (owner, id, patch) => { const row = this.attempts.find(item => item.ownerUserId === owner && item.id === id && item.status === 'planned'); if (!row) return null; Object.assign(row, patch); return row },
      findOutcomeByIdempotency: async (owner, key) => this.outcomes.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      insertOutcome: async input => { const row = { ...input, id: ++this.nextId, createdAt: now() } as ContentOperationOutcomeAssessmentRow; this.outcomes.push(row); return row },
      listOutcomes: async owner => this.outcomes.filter(row => row.ownerUserId === owner),
      getPlanBundle: async (owner, planId) => this.bundles.get(`${owner}:${planId}`) || (() => { throw new Error('missing plan') })(),
      resolveCanonicalContext: async (owner, planId, deliverableId) => {
        const bundle = this.bundles.get(`${owner}:${planId}`)
        const deliverable = bundle?.deliverables.find(item => item.id === deliverableId)
        const selection = bundle?.selections.find(item => item.id === deliverable?.selectionId)
        const strategy = bundle?.strategies.find(item => item.id === selection?.strategyRecommendationId)
        if (!bundle || !deliverable || !selection || !strategy) throw new Error('missing canonical fixture context')
        const opportunity = (strategy.contentOpportunities as Array<{ key: string; deliverableType: 'article' | 'faq' | 'service_page'; title: string; audience: string; goals: string[]; constraints: string[] }>).find(item => `${strategy.id}:${item.key}` === deliverable.opportunityKey) || (strategy.contentOpportunities as Array<{ key: string; deliverableType: 'article' | 'faq' | 'service_page'; title: string; audience: string; goals: string[]; constraints: string[] }>)[0]
        const rules = Array.isArray(strategy.ruleIds) ? strategy.ruleIds.map(id => canonicalFixtureRules.find(rule => rule.id === String(id)) || { id: String(id) }) : []
        const refs = (Array.isArray(strategy.evidenceRefs) ? strategy.evidenceRefs : []).map(ref => ({ ...ref, approvedAt: this.evidenceApprovalAt }))
        const approvalTimestamps = refs.map(ref => typeof ref.approvedAt === 'string' ? ref.approvedAt : this.evidenceApprovalAt)
        const materials = refs.filter(ref => typeof ref.artifactId === 'number').map(ref => ({ sourceId: ref.sourceId, artifactId: ref.artifactId!, sourceName: `Fixture source ${ref.sourceId}`, locator: `https://evidence.routing.discoverystack.dev/section-${ref.sourceId}`, artifactType: 'text', artifactHash: ref.artifactHash || HASH, reviewedText: `Approved fixture evidence for source ${ref.sourceId}; this text is inert reviewed material.${this.riskCandidate ? ' Approved test evidence records ranked #1 as a prohibited measurement claim.' : ''}` }))
        return { plan: bundle.plan, deliverable, selection, strategy, diagnosis: { id: bundle.plan.diagnosisId }, diagnosisResult: { status: 'ready' }, opportunity, rules, evidenceSnapshot: { refs, context: materials.map(material => material.reviewedText).join('\\n\\n'), hash: HASH, materials, approvalTimestamps, freshnessBasis: [...approvalTimestamps].sort()[0] || '' } } as any
      },
      resolveWorkspaceEntry: async (owner, entryId) => {
        const entry = this.entries.find(row => row.ownerUserId === owner && row.id === entryId)
        const calendar = entry && this.calendars.find(row => row.ownerUserId === owner && row.id === entry.calendarId)
        const client = calendar && this.clients.find(row => row.ownerUserId === owner && row.id === calendar.clientId)
        const bundle = calendar ? this.bundles.get(`${owner}:${calendar.productionPlanId}`) : undefined
        const deliverable = entry && bundle?.deliverables.find(row => row.id === entry.productionDeliverableId)
        if (!entry || !calendar || !client || !deliverable) return null
        const delivered = this.delivered.get(entryId)
        const binding = this.entryTargetBindings.filter(row => row.ownerUserId === owner && row.entryId === entryId).sort((left, right) => left.slot - right.slot)[0]
        const target = binding ? this.targets.find(row => row.ownerUserId === owner && row.id === binding.targetId) || null : this.targets.find(row => row.ownerUserId === owner && row.clientId === client.id && row.status === 'active' && row.activeSlot === 1) || null
        const generated = this.generated.get(entryId)
        const review = delivered?.review || this.reviews.get(entryId) || null
        return { entry, calendar, client, target, deliverable: delivered?.deliverable || generated?.deliverable || deliverable as any, job: delivered?.job || generated?.job || null, draft: delivered?.draft || generated?.draft || null, review: review as WorkspaceEntryLineage['review'], riskGate: delivered?.riskGate || generated?.riskGate || null } as WorkspaceEntryLineage
      },
      resolveDeliveredPublication: async (owner, entryId) => {
        const legacy = this.delivered.get(entryId)
        if (legacy && legacy.entry.ownerUserId === owner) return legacy
        const entry = this.entries.find(row => row.ownerUserId === owner && row.id === entryId)
        const lineage = entry ? await this.repository.resolveWorkspaceEntry(owner, entryId) : null
        const run = this.runs.find(row => row.ownerUserId === owner && row.entryId === entryId && row.stage === 'publication' && row.state === 'succeeded') || null
        const attempt = run ? this.attempts.find(row => row.ownerUserId === owner && row.entryId === entryId && row.runId === run.id && row.status === 'delivered') || null : null
        if (!entry || !lineage?.job || !lineage.draft || !lineage.riskGate || !run || !attempt) return null
        return { entry, calendar: lineage.calendar, deliverable: lineage.deliverable, job: lineage.job, draft: lineage.draft, review: lineage.review, riskGate: lineage.riskGate, publicationRun: run, publicationTarget: lineage.target || null, publicationAttempt: attempt, authorityReference: entry.publicationAuthorityReference || null, publicationIdentity: entry.publicationSlug && entry.publicationPath && entry.publicationIdentityFingerprint ? { publicationId: `publication-${entry.id}`, slug: entry.publicationSlug, path: entry.publicationPath, identityFingerprint: entry.publicationIdentityFingerprint } : null } as DeliveredPublication
      },
    }
  }

  addPlan(ownerUserId = 1, deliverableCount = 2) {
    const bundle = fixturePlan(ownerUserId, deliverableCount)
    this.bundles.set(`${ownerUserId}:${bundle.plan.id}`, bundle)
    return bundle
  }

  addClient(ownerUserId = 1) {
    const row = fixtureClient(ownerUserId, this.nextId + 1)
    this.clients.push(row)
    return row
  }

  productionPersistence(): ProductionPersistence {
    return {
      resolveProductionContext: async input => this.repository.resolveCanonicalContext(input.ownerUserId, input.planId, input.deliverableId) as never,
      createContentJob: async input => {
        const existingEntry = this.entries.find(entry => entry.ownerUserId === input.ownerUserId && entry.productionDeliverableId === input.productionDeliverableId)
        const existing = existingEntry ? this.generated.get(existingEntry.id)?.job : undefined
        if (existing) return existing as never
        const brief = this.briefs.get(input.briefId)
        if (!brief) throw new Error('fixture production brief not found')
        const job = { id: ++this.nextId, ownerUserId: input.ownerUserId, briefId: input.briefId, productionPlanId: input.productionPlanId ?? null, productionDeliverableId: input.productionDeliverableId ?? null, strategyRecommendationId: input.strategyRecommendationId ?? null, requestFingerprint: stableFingerprint(input), operation: input.operation, providerMode: input.providerMode, status: 'queued', idempotencyKey: input.idempotencyKey, evidenceSnapshotHash: String(brief.evidenceSnapshotHash), createdAt: now(), updatedAt: now(), startedAt: null, completedAt: null, errorCode: null, errorSummary: null, providerProvenance: null }
        if (existingEntry) this.generated.set(existingEntry.id, { deliverable: this.bundles.get(`${input.ownerUserId}:11`)!.deliverables.find(deliverable => deliverable.id === existingEntry.productionDeliverableId)! as unknown as Record<string, unknown>, job })
        return job as never
      },
      createCanonicalProductionBrief: async (ownerUserId, context) => {
        if (context.brief) return context.brief
        const existing = [...this.briefs.values()].find(brief => brief.ownerUserId === ownerUserId && brief.productionDeliverableId === context.deliverable.id)
        if (existing) return existing as never
        const brief = { id: ++this.nextId, ownerUserId, diagnosisId: context.diagnosis.id, strategyRecommendationId: context.strategy.id, productionPlanId: context.plan.id, productionDeliverableId: context.deliverable.id, ruleIds: context.rules.map(rule => rule.id), provenance: { stage: 'canonical-production-context', source: 'server-resolved', evidenceSnapshotHash: context.evidenceSnapshot.hash }, title: context.opportunity.title, audience: context.opportunity.audience, contentType: context.opportunity.deliverableType, language: context.plan.language, goals: context.opportunity.goals, constraints: context.opportunity.constraints, evidenceRefs: context.evidenceSnapshot.refs, evidenceSnapshotHash: context.evidenceSnapshot.hash, status: 'ready_for_generation', createdAt: now(), updatedAt: now() }
        this.briefs.set(brief.id, brief)
        return brief as never
      },
      transitionContentJob: async input => {
        const item = [...this.generated.entries()].find(([, value]) => value.job.id === input.jobId && value.job.ownerUserId === input.ownerUserId)
        if (!item) throw new Error('fixture production job not found')
        Object.assign(item[1].job, { status: input.to, errorCode: input.errorCode || null, errorSummary: input.errorSummary || null, providerProvenance: input.providerProvenance || item[1].job.providerProvenance, updatedAt: now() })
        return item[1].job as never
      },
      saveContentCandidate: async input => {
        const item = [...this.generated.entries()].find(([, value]) => value.job.id === input.jobId)
        if (!item) throw new Error('fixture production job not found for draft')
        const previous = item[1].draft
        const draft = { id: ++this.nextId, ownerUserId: item[1].job.ownerUserId, jobId: input.jobId, version: previous ? Number(previous.version || 0) + 1 : 1, title: input.title, body: input.body, contentHash: input.contentHash, sourceMode: input.sourceMode, provenance: input.provenance, evidenceRefs: input.evidenceRefs, safetyStatus: input.safetyStatus, safetyNotes: input.safetyNotes, createdAt: now(), updatedAt: now() }
        item[1].draft = draft
        return draft as never
      },
      saveRiskGate: async input => {
        const item = [...this.generated.entries()].find(([, value]) => value.draft?.id === input.draftId)
        if (!item || !item[1].draft) throw new Error('fixture production draft not found for risk gate')
        const riskGate = { id: ++this.nextId, ownerUserId: item[1].job.ownerUserId, draftId: input.draftId, status: input.result.status, gateVersion: input.result.gateVersion, riskLevel: input.result.riskLevel, findings: input.result.findings, evidenceSnapshotHash: input.evidenceSnapshotHash }
        item[1].riskGate = riskGate
        return riskGate as never
      },
      updateProductionDeliverable: async (ownerUserId, deliverableId, patch) => {
        const bundle = this.bundles.get(`${ownerUserId}:11`)
        const deliverable = bundle?.deliverables.find(item => item.id === deliverableId)
        if (!deliverable) throw new Error('fixture production deliverable not found')
        Object.assign(deliverable, patch)
        return deliverable as never
      },
    }
  }

  persistGeneratedLineage(entryId: number, lineage: { deliverable: Record<string, unknown>; job: Record<string, unknown>; draft: Record<string, unknown>; riskGate: Record<string, unknown> }) {
    this.generated.set(entryId, lineage)
    return lineage
  }

  recordOwnerReview(entryId: number, input: { ownerUserId: number; jobId: number; draftId: number; decision: string; evidenceSnapshotHash: string }) {
    const review = { id: ++this.nextId, reviewerUserId: input.ownerUserId, ...input }
    this.reviews.set(entryId, review)
    const generated = this.generated.get(entryId)
    if (generated) {
      const nextStatus = input.decision.startsWith('approved') ? 'approved' : input.decision === 'changes_requested' ? 'needs_human_review' : 'blocked'
      Object.assign(generated.job, { status: nextStatus, completedAt: now() })
      Object.assign(generated.deliverable, { status: input.decision.startsWith('approved') ? 'approved' : nextStatus })
    }
    return review
  }

  markCompleted(calendarId: number, entryId: number) {
    const calendar = this.calendars.find(row => row.id === calendarId)
    const entry = this.entries.find(row => row.id === entryId && row.calendarId === calendarId)
    if (!calendar || !entry) throw new Error('missing fixture entry')
    const materialized = materializeDueContentWork({ calendar: calendar.resultSnapshot, expectedPlanFingerprint: calendar.planFingerprint, nowLocalDate: entry.plannedLocalDate, eligibleEntryIds: [entry.engineEntryId] })
    if (!materialized.calendar) throw new Error('fixture materialization transition blocked')
    const result = materializeDueContentWork({ calendar: materialized.calendar, expectedPlanFingerprint: materialized.calendar.planFingerprint, nowLocalDate: entry.plannedLocalDate, completedEntryIds: [entry.engineEntryId] })
    if (!result.calendar) throw new Error('fixture completion transition blocked')
    Object.assign(calendar, { status: result.calendar.status, revision: result.calendar.revision, previousPlanFingerprint: result.calendar.previousPlanFingerprint, planFingerprint: result.calendar.planFingerprint, normalizedRequestSnapshot: result.calendar.normalizedRequest, resultSnapshot: result.calendar })
    for (const snapshotEntry of result.calendar.entries) {
      const durable = this.entries.find(row => row.calendarId === calendarId && row.engineEntryId === snapshotEntry.entryId)
      if (durable) durable.status = snapshotEntry.status === 'completed' ? 'completed' : snapshotEntry.status === 'materialized' ? 'materialized' : durable.status
    }
  }

  async addCalendar(ownerUserId = 1, start = '2026-01-01', count = 2) {
    const client = this.clients.find(row => row.ownerUserId === ownerUserId) || this.addClient(ownerUserId)
    this.addPlan(ownerUserId, count)
    const bundle = this.bundles.get(`${ownerUserId}:11`)!
    const opportunities = bundle.deliverables.map((deliverable, index) => ({ id: `deliverable-${deliverable.id}`, strategyRecommendationId: index + 1, title: deliverable.title, contentType: 'article' as const, language: 'en' as const, priority: 'high' as const, status: 'selected' as const, topicCluster: `opportunity-${index + 1}`, evidenceSnapshotHash: HASH, estimatedCostUnits: 1, ruleIds: ['rule-topic'], authoritySourceIds: [`source:${index + 1}`] }))
    const request = { clientScopeKey: `client-${client.id}`, planStartDate: start, planEndDate: '2026-12-31', timeZone: 'UTC', publishLocalTime: '09:00', cadenceDays: 3 as const, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: count, catchUpPolicy: 'skip_missed' as const, evidenceSnapshotHash: HASH, opportunities }
    const result = buildContentCalendar(request)
    const calendar = { id: ++this.nextId, ownerUserId, clientId: client.id, productionPlanId: 11, engineVersion: result.engineVersion, status: result.status, planStartDate: start, planEndDate: '2026-12-31', timeZone: 'UTC', publishLocalTime: '09:00', cadenceDays: 3, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: count, catchUpPolicy: 'skip_missed' as const, evidenceSnapshotHash: HASH, revision: result.revision, previousPlanFingerprint: result.previousPlanFingerprint, planFingerprint: result.planFingerprint, normalizedRequestSnapshot: result.normalizedRequest, resultSnapshot: result, idempotencyKey: `calendar-${ownerUserId}-${this.nextId}`, createdAt: now(), updatedAt: now() } as ContentOperationCalendarRow
    this.calendars.push(calendar)
    for (const entry of result.entries) this.entries.push({ id: ++this.nextId, ownerUserId, calendarId: calendar.id, productionDeliverableId: Number(entry.opportunityId.replace('deliverable-', '')), strategyRecommendationId: entry.strategyRecommendationId, jobId: null, draftId: null, reviewId: null, scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, contentType: entry.contentType, language: entry.language, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, contentHash: null, publicationTargetId: null, publicationSlug: null, publicationPath: null, publicationIdentityFingerprint: null, status: 'planned', engineEntryId: entry.entryId, idempotencyKey: `content-operation-entry:${stableFingerprint({ calendarId: calendar.id, engineEntryId: entry.entryId, engineIdempotencyKey: entry.idempotencyKey })}`, createdAt: now(), updatedAt: now() })
    return calendar
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
