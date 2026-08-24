import type { ContentCalendarEntry, ContentCalendarRequest, ContentCalendarResult, DueContentWork } from '../content-calendar'
import type { PublishedContentOutcomeAssessment, OutcomeLearningCandidateResult } from '../outcome-learning'
import type { contentOperationCalendarEntries, contentOperationCalendars, contentOperationClients, contentOperationEvents, contentOperationOutcomeAssessments, contentOperationRuns } from '../database/schema'

export type ContentOperationClientRow = typeof contentOperationClients.$inferSelect
export type ContentOperationCalendarRow = typeof contentOperationCalendars.$inferSelect
export type ContentOperationCalendarEntryRow = typeof contentOperationCalendarEntries.$inferSelect
export type ContentOperationRunRow = typeof contentOperationRuns.$inferSelect
export type ContentOperationEventRow = typeof contentOperationEvents.$inferSelect
export type ContentOperationOutcomeAssessmentRow = typeof contentOperationOutcomeAssessments.$inferSelect

export type ContentOperationClientInput = {
  displayName: string
  canonicalSiteOrigin: string
  framework: 'astro' | 'nuxt'
  publicationTransport: 'first_party_git' | 'first_party_signed_api'
  timeZone: string
  defaultCadenceDays: 3 | 7 | 15 | 30
  defaultPublishLocalTime: string
  monthlyBudgetUnits: number
  idempotencyKey: string
}

export type CreateCalendarInput = {
  clientId: number
  productionPlanId: number
  planStartDate: string
  planEndDate: string
  publishLocalTime: string
  cadenceDays: 3 | 7 | 15 | 30
  monthlyBudgetUnits: number
  defaultCostUnits: number
  maxItemsPerCalendarMonth: number
  maximumTotalItems: number
  catchUpPolicy: 'skip_missed' | 'one_catch_up'
  idempotencyKey: string
}

export type ReplanCalendarInput = {
  calendarId: number
  expectedPlanFingerprint: string
  request: CreateCalendarInput
}

export type MaterializeInput = {
  calendarId: number
  clock?: Clock
  maxEntries?: number
  onlyEntryIds?: number[]
  leaseOwner?: string
  leaseMs?: number
}

export type OutcomeAssessmentInput = {
  entryId: number
  runId?: number
  idempotencyKey: string
  baselineMeasurements: unknown[]
  followUpMeasurements: unknown[]
  consent: unknown
  dataContractVersion: string
  measuredAt?: string
  learningCandidate?: boolean
}

export type Clock = {
  now: () => Date
  localDate: (date: Date, timeZone: string) => string
}

export type MaterializeResult = {
  calendar: ContentOperationCalendarRow
  dueWork: DueContentWork[]
  entries: ContentOperationCalendarEntryRow[]
  runs: ContentOperationRunRow[]
  events: ContentOperationEventRow[]
}

export type OutcomeResult = {
  assessment: PublishedContentOutcomeAssessment
  learningCandidate: OutcomeLearningCandidateResult | null
  persisted: ContentOperationOutcomeAssessmentRow
}

export type WorkspacePayload = {
  clients: ContentOperationClientRow[]
  calendars: ContentOperationCalendarRow[]
  entries: ContentOperationCalendarEntryRow[]
  runs: ContentOperationRunRow[]
  outcomeAssessments: ContentOperationOutcomeAssessmentRow[]
  capabilities: {
    schedulerAvailable: boolean
    generationExecutorConfigured: false
    firstPartyPublisherConfigured: false
    outcomeCollectionConfigured: false
  }
  limitations: string[]
}

export type DeliveredPublication = {
  entry: ContentOperationCalendarEntryRow
  calendar: ContentOperationCalendarRow
  deliverable: Record<string, unknown> & { id: number; ownerUserId: number; planId: number; provenance: unknown }
  job: Record<string, unknown> & { id: number }
  draft: Record<string, unknown> & { id: number; version: number; contentHash: string }
  review: Record<string, unknown> & { id: number; decision: string }
  publicationRun: ContentOperationRunRow | null
}

export type PlanBundle = {
  plan: Record<string, unknown> & { id: number; ownerUserId: number; status: string; evidenceSnapshotHash: string }
  selections: Array<Record<string, unknown> & { id: number; ownerUserId: number; planId: number; strategyRecommendationId: number; status: string; evidenceSnapshotHash: string }>
  strategies: Array<Record<string, unknown> & { id: number; ownerUserId: number; diagnosisId: number; status: string; evidenceSnapshotHash: string; ruleIds: unknown; evidenceRefs: unknown; contentOpportunities: unknown; provenance: unknown }>
  deliverables: Array<Record<string, unknown> & { id: number; ownerUserId: number; planId: number; selectionId: number; opportunityKey: string; contentType: string; title: string; audience: string; language: string; evidenceSnapshotHash: string; provenance: unknown }>
}

export type CalendarPersistence = {
  result: ContentCalendarResult
  request: ContentCalendarRequest
}

export type PersistedCalendarEntry = ContentCalendarEntry & {
  productionDeliverableId: number
}

export const CONTENT_OPERATIONS_LIMITATIONS = [
  'persistence and scheduling metadata only',
  'no provider, LLM, CMS, website, or publication execution',
  'generation, review, and publication require separate owner-controlled workflows',
  'outcomes are accepted only for delivered entries and remain bounded snapshots',
] as const
