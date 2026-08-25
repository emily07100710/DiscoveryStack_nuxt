import type { ContentCalendarEntry, ContentCalendarRequest, ContentCalendarResult, DueContentWork } from '../content-calendar'
import type { PublishedContentOutcomeAssessment, OutcomeLearningCandidateResult } from '../outcome-learning'
import type { contentOperationCalendarEntries, contentOperationCalendars, contentOperationClients, contentOperationEvents, contentOperationOutcomeAssessments, contentOperationPublicationAttempts, contentOperationPublicationTargets, contentOperationRuns } from '../database/schema'

export type ContentOperationClientRow = typeof contentOperationClients.$inferSelect
export type ContentOperationCalendarRow = typeof contentOperationCalendars.$inferSelect
export type ContentOperationCalendarEntryRow = typeof contentOperationCalendarEntries.$inferSelect
export type ContentOperationRunRow = typeof contentOperationRuns.$inferSelect
export type ContentOperationPublicationTargetRow = typeof contentOperationPublicationTargets.$inferSelect
export type ContentOperationPublicationAttemptRow = typeof contentOperationPublicationAttempts.$inferSelect
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

export type ReplanCalendarInput = Omit<CreateCalendarInput, 'clientId' | 'productionPlanId'> & {
  expectedPlanFingerprint: string
}

export type MaterializeInput = {
  calendarId: number
  expectedPlanFingerprint: string
  idempotencyKey: string
}

export type PublicationTargetInput = {
  idempotencyKey: string
  framework: 'astro' | 'nuxt'
  transport: 'first_party_git' | 'first_party_signed_api'
  targetOrigin: string
  contentRoot: string
  defaultBranch?: string | null
  repositoryOwner?: string | null
  repositoryName?: string | null
  endpointPath?: string | null
  credentialReference: string
  allowedContentTypes: string[]
  allowedLanguages: string[]
  maximumPayloadBytes: number
  executionEnabled?: boolean
}

export type PublicationTargetPatchInput = {
  idempotencyKey?: string
  targetOrigin?: string
  contentRoot?: string
  defaultBranch?: string
  repositoryOwner?: string | null
  repositoryName?: string | null
  endpointPath?: string | null
  credentialReference?: string
  allowedContentTypes?: string[]
  allowedLanguages?: string[]
  maximumPayloadBytes?: number
  executionEnabled?: boolean
  status?: 'active' | 'paused' | 'revoked'
}

export type ExecuteContentOperationInput = {
  idempotencyKey: string
  mode?: 'dry_run' | 'execute'
}

export type ExecuteContentOperationResult = {
  entry?: ContentOperationCalendarEntryRow
  entryId: number
  previousStatus: ContentOperationCalendarEntryRow['status']
  resultingStatus: ContentOperationCalendarEntryRow['status']
  runId: number
  stage: ContentOperationRunRow['stage']
  outcome: 'materialized' | 'awaiting_review' | 'ready_to_publish' | 'dry_run_succeeded' | 'delivered' | 'retry_wait' | 'blocked' | 'replayed'
  retryAt: Date | null
  limitations: string[]
}

export type MaterializeExecutionOptions = {
  clock?: Clock
  maxEntries?: number
  eligibleEntryIds?: number[]
  leaseToken?: string
  leaseMs?: number
}

export type OperationClaim = {
  claimed: boolean
  requestFingerprint: string
  operation: 'replan' | 'materialize'
  ownerUserId: number
  calendarId: number
  idempotencyKey: string
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
  replayed: boolean
}

export type OutcomeResult = {
  assessment: PublishedContentOutcomeAssessment
  learningCandidate: OutcomeLearningCandidateResult | null
  persisted: ContentOperationOutcomeAssessmentRow
}

export type WorkspaceEntryProjection = ContentOperationCalendarEntryRow & {
  topic: string
  framework: 'astro' | 'nuxt' | null
  target: string | null
  hasApprovedDraft: boolean
  hasPassedRiskGate: boolean
  nextAction: 'generate' | 'review' | 'publish' | 'measure' | 'learn' | 'wait' | 'none'
}

export type WorkspaceOutcomeProjection = ContentOperationOutcomeAssessmentRow & {
  validPairCount: number | null
}

export type WorkspacePayload = {
  clients: ContentOperationClientRow[]
  calendars: ContentOperationCalendarRow[]
  entries: WorkspaceEntryProjection[]
  runs: ContentOperationRunRow[]
  outcomeAssessments: WorkspaceOutcomeProjection[]
  publicationTargets: Array<Record<string, unknown> & { id: number; clientId: number; targetId: string; framework: string; transport: string; targetOrigin: string; contentRoot: string; defaultBranch: string | null; status: string; activeSlot: number | null; executionEnabled: boolean; credentialConfigured: boolean }>
  capabilities: {
    schedulerAvailable: boolean
    generationExecutorConfigured: false
    firstPartyPublisherConfigured: false
    outcomeCollectionConfigured: false
  }
  readiness: {
    schedulerAvailable: boolean
    generationExecutorAvailable: boolean
    publicationTargetConfigured: boolean
    publicationExecutionEnabled: boolean
    credentialReferenceConfigured: boolean
    runtimeCredentialResolverAvailable: boolean
    outcomeCollectionConfigured: boolean
  }
  limitations: string[]
}

export type DeliveredPublication = {
  entry: ContentOperationCalendarEntryRow
  calendar: ContentOperationCalendarRow
  deliverable: Record<string, unknown> & { id: number; ownerUserId: number; planId: number; selectionId: number; contentType: string; title: string; audience: string; language: string; evidenceSnapshotHash: string; opportunityKey: string; provenance: unknown }
  job: Record<string, unknown> & { id: number; ownerUserId: number; productionPlanId: number | null; productionDeliverableId: number | null; strategyRecommendationId: number | null; evidenceSnapshotHash: string; briefId: number }
  draft: Record<string, unknown> & { id: number; jobId: number; version: number; contentHash: string; evidenceRefs: unknown; safetyStatus: string }
  review: Record<string, unknown> & { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string }
  riskGate?: Record<string, unknown> & { id: number; draftId: number; status: string; evidenceSnapshotHash: string }
  publicationRun: ContentOperationRunRow | null
  publicationIdentity?: { publicationId: string; slug: string; path: string; identityFingerprint: string } | null
}

export type PlanBundle = {
  plan: Record<string, unknown> & { id: number; ownerUserId: number; diagnosisId: number | null; status: string; evidenceSnapshotHash: string }
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
  'owner-only execution orchestration; no public consumer workflow',
  'human approved_for_delivery review is required before publication',
  'mocked executor tests do not validate production credentials or customer-site connectivity',
  'outcomes are accepted only for delivered entries and remain bounded snapshots',
] as const
