import { buildContentCalendar } from '../../../server/content-calendar'
import type { ContentOperationsRepository } from '../../../server/content-operations/repository'
import type { ContentOperationCalendarEntryRow, ContentOperationCalendarRow, ContentOperationClientRow, ContentOperationEventRow, ContentOperationOutcomeAssessmentRow, ContentOperationRunRow, DeliveredPublication, PlanBundle } from '../../../server/content-operations/types'

export const HASH = 'a'.repeat(64)

function now(): Date { return new Date('2026-01-01T00:00:00.000Z') }

export function fixtureClient(ownerUserId = 1, id = 1): ContentOperationClientRow {
  return { id, ownerUserId, displayName: `Owner ${ownerUserId}`, canonicalSiteOrigin: `https://owner${ownerUserId}.example`, framework: 'nuxt', publicationTransport: 'first_party_git', timeZone: 'UTC', defaultCadenceDays: 3, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, status: 'active', idempotencyKey: `client-${ownerUserId}`, createdAt: now(), updatedAt: now() }
}

export function fixturePlan(ownerUserId = 1, deliverableCount = 2): PlanBundle {
  const opportunities = Array.from({ length: deliverableCount }, (_, index) => ({ key: `opportunity-${index + 1}`, deliverableType: 'article' as const, title: `Article ${index + 1}`, audience: 'owner audience', goals: ['explain'], constraints: ['verify'] }))
  const deliverables = opportunities.map((opportunity, index) => ({ id: index + 1, ownerUserId, planId: 11, selectionId: index + 1, opportunityKey: `strategy-${index + 1}:${opportunity.key}`, contentType: opportunity.deliverableType, title: opportunity.title, audience: opportunity.audience, goals: opportunity.goals, constraints: opportunity.constraints, language: 'en', status: 'planned', evidenceSnapshotHash: HASH, provenance: { ruleIds: ['rule-topic'], authoritySourceIds: [`source-${index + 1}`], topicCluster: `topic-${index + 1}` } }))
  return {
    plan: { id: 11, ownerUserId, status: 'ready', evidenceSnapshotHash: HASH },
    selections: deliverables.map((deliverable, index) => ({ id: deliverable.selectionId, ownerUserId, planId: 11, strategyRecommendationId: index + 1, status: 'selected', evidenceSnapshotHash: HASH })),
    strategies: deliverables.map((deliverable, index) => ({ id: index + 1, ownerUserId, diagnosisId: 9, status: 'selected', evidenceSnapshotHash: HASH, priority: 'high', ruleIds: ['rule-topic'], evidenceRefs: [{ sourceId: index + 1, artifactId: index + 1 }], contentOpportunities: [opportunities[index]!], provenance: { ruleIds: ['rule-topic'], authoritySourceIds: [`source-${index + 1}`], topicCluster: `topic-${index + 1}` } })),
    deliverables,
  } as PlanBundle
}

export class ContentOperationsFixture {
  clients: ContentOperationClientRow[] = []
  calendars: ContentOperationCalendarRow[] = []
  entries: ContentOperationCalendarEntryRow[] = []
  runs: ContentOperationRunRow[] = []
  events: ContentOperationEventRow[] = []
  outcomes: ContentOperationOutcomeAssessmentRow[] = []
  bundles = new Map<string, PlanBundle>()
  delivered = new Map<number, DeliveredPublication>()
  nextId = 100
  readonly repository: ContentOperationsRepository

  constructor() {
    this.repository = {
      transaction: async work => work(this.repository),
      findClientByIdempotency: async (owner, key) => this.clients.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      findClientByOrigin: async (owner, origin) => this.clients.find(row => row.ownerUserId === owner && row.canonicalSiteOrigin === origin) || null,
      findClient: async (owner, id) => this.clients.find(row => row.ownerUserId === owner && row.id === id) || null,
      insertClient: async input => { const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationClientRow; this.clients.push(row); return row },
      listClients: async owner => this.clients.filter(row => row.ownerUserId === owner),
      findCalendarByIdempotency: async (owner, key) => this.calendars.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      findCalendar: async (owner, id) => this.calendars.find(row => row.ownerUserId === owner && row.id === id) || null,
      insertCalendar: async input => { const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationCalendarRow; this.calendars.push(row); return row },
      updateCalendar: async (owner, id, patch) => { const row = this.calendars.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing calendar'); Object.assign(row, patch, { updatedAt: now() }); return row },
      listCalendars: async owner => this.calendars.filter(row => row.ownerUserId === owner),
      findEntry: async (owner, id) => this.entries.find(row => row.ownerUserId === owner && row.id === id) || null,
      listEntries: async (owner, calendarId) => this.entries.filter(row => row.ownerUserId === owner && (calendarId === undefined || row.calendarId === calendarId)).sort((a, b) => a.plannedLocalDate.localeCompare(b.plannedLocalDate) || a.scheduleKey.localeCompare(b.scheduleKey)),
      insertEntry: async input => { const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationCalendarEntryRow; this.entries.push(row); return row },
      updateEntry: async (owner, id, patch) => { const row = this.entries.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing entry'); Object.assign(row, patch, { updatedAt: now() }); return row },
      listRuns: async (owner, entryId) => this.runs.filter(row => row.ownerUserId === owner && (entryId === undefined || row.entryId === entryId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findRunByIdempotency: async (owner, key) => this.runs.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null,
      insertRun: async input => { const row = { ...input, id: ++this.nextId, createdAt: now(), updatedAt: now() } as ContentOperationRunRow; this.runs.push(row); return row },
      acquireRunLease: async (owner, id, leaseOwner, at, leaseMs) => { const row = this.runs.find(item => item.ownerUserId === owner && item.id === id); if (!row) return null; if (row.state === 'processing' && row.leaseExpiresAt && row.leaseExpiresAt > at) return null; Object.assign(row, { state: 'processing', leaseOwner, leaseExpiresAt: new Date(at.getTime() + leaseMs), startedAt: at, updatedAt: at }); return row },
      releaseRunLease: async (owner, id, state, at, error) => { const row = this.runs.find(item => item.ownerUserId === owner && item.id === id); if (!row) throw new Error('missing run'); Object.assign(row, { state, leaseOwner: null, leaseExpiresAt: null, errorCode: error?.code || null, errorSummary: error?.summary || null, updatedAt: at }); return row },
      appendEvent: async input => { const existing = this.events.find(row => row.ownerUserId === input.ownerUserId && row.eventFingerprint === input.eventFingerprint); if (existing) return existing; const row = { ...input, id: ++this.nextId, occurredAt: now() } as ContentOperationEventRow; this.events.push(row); return row },
      listEvents: async (owner, entryId) => this.events.filter(row => row.ownerUserId === owner && (entryId === undefined || row.entryId === entryId)),
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
        return { plan: bundle.plan, deliverable, selection, strategy, diagnosis: {}, diagnosisResult: {}, opportunity: { key: deliverable.opportunityKey.split(':').slice(1).join(':'), deliverableType: deliverable.contentType, title: deliverable.title, audience: deliverable.audience, goals: [], constraints: [] }, rules: [], evidenceSnapshot: { refs: [], context: '', hash: HASH, materials: [] } } as any
      },
      resolveDeliveredPublication: async (owner, entryId) => { const value = this.delivered.get(entryId); return value && value.entry.ownerUserId === owner ? value : null },
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

  async addCalendar(ownerUserId = 1, start = '2026-01-01', count = 2) {
    const client = this.clients.find(row => row.ownerUserId === ownerUserId) || this.addClient(ownerUserId)
    this.addPlan(ownerUserId, count)
    const bundle = this.bundles.get(`${ownerUserId}:11`)!
    const opportunities = bundle.deliverables.map((deliverable, index) => ({ id: `deliverable-${deliverable.id}`, strategyRecommendationId: index + 1, title: deliverable.title, contentType: 'article' as const, language: 'en' as const, priority: 'high' as const, status: 'selected' as const, topicCluster: `topic-${index + 1}`, evidenceSnapshotHash: HASH, estimatedCostUnits: 1, ruleIds: ['rule-topic'], authoritySourceIds: [`source-${index + 1}`] }))
    const request = { clientScopeKey: `client-${client.id}`, planStartDate: start, planEndDate: '2026-12-31', timeZone: 'UTC', publishLocalTime: '09:00', cadenceDays: 3 as const, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: count, catchUpPolicy: 'skip_missed' as const, evidenceSnapshotHash: HASH, opportunities }
    const result = buildContentCalendar(request)
    const calendar = { id: ++this.nextId, ownerUserId, clientId: client.id, productionPlanId: 11, engineVersion: result.engineVersion, status: result.status, planStartDate: start, planEndDate: '2026-12-31', timeZone: 'UTC', publishLocalTime: '09:00', cadenceDays: 3, monthlyBudgetUnits: 100, defaultCostUnits: 1, maxItemsPerCalendarMonth: 31, maximumTotalItems: count, catchUpPolicy: 'skip_missed' as const, evidenceSnapshotHash: HASH, revision: result.revision, previousPlanFingerprint: result.previousPlanFingerprint, planFingerprint: result.planFingerprint, normalizedRequestSnapshot: result.normalizedRequest, resultSnapshot: result, idempotencyKey: `calendar-${ownerUserId}-${this.nextId}`, createdAt: now(), updatedAt: now() } as ContentOperationCalendarRow
    this.calendars.push(calendar)
    for (const entry of result.entries) this.entries.push({ id: ++this.nextId, ownerUserId, calendarId: calendar.id, productionDeliverableId: Number(entry.opportunityId.replace('deliverable-', '')), strategyRecommendationId: entry.strategyRecommendationId, jobId: null, draftId: null, reviewId: null, scheduleKey: entry.scheduleKey, plannedLocalDate: entry.plannedLocalDate, publishLocalTime: entry.publishLocalTime, timeZone: entry.timeZone, contentType: entry.contentType, language: entry.language, topicCluster: entry.topicCluster, evidenceSnapshotHash: entry.evidenceSnapshotHash, contentHash: null, status: 'planned', engineEntryId: entry.entryId, idempotencyKey: entry.idempotencyKey, createdAt: now(), updatedAt: now() })
    return calendar
  }
}
