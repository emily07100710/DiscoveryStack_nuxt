import type { ContentCalendarEntry, ContentCalendarRequest, ContentCalendarResult, DueContentWork } from '../content-calendar'
import type { PublishedContentOutcomeAssessment, OutcomeLearningCandidateResult } from '../outcome-learning'
import type { contentOperationAutopilotPolicies, contentOperationBudgetReservations, contentOperationCalendarEntries, contentOperationCalendarEntryTargets, contentOperationCalendars, contentOperationClients, contentOperationEntityStrategyProfiles, contentOperationEvents, contentOperationMachineAuthorizations, contentOperationOutcomeAssessments, contentOperationPublicationAttempts, contentOperationPublicationTargets, contentOperationQueryOwnership, contentOperationRepairAttempts, contentOperationRuns, contentOperationTopicSubstitutions } from '../database/schema'

export type ContentOperationClientRow = typeof contentOperationClients.$inferSelect
export type ContentOperationCalendarRow = typeof contentOperationCalendars.$inferSelect
type CalendarEntryRow = typeof contentOperationCalendarEntries.$inferSelect
export type ContentOperationCalendarEntryRow = Omit<CalendarEntryRow, 'publicationContentHash' | 'publicationRoutingPlanId' | 'publicationAuthorityReference' | 'publicationTargetCount'> & Partial<Pick<CalendarEntryRow, 'publicationContentHash' | 'publicationRoutingPlanId' | 'publicationAuthorityReference' | 'publicationTargetCount'>>
export type ContentOperationRunRow = typeof contentOperationRuns.$inferSelect
type TargetRow = typeof contentOperationPublicationTargets.$inferSelect
type AutopilotPolicyRow = typeof contentOperationAutopilotPolicies.$inferSelect
type PublicationAttemptRow = typeof contentOperationPublicationAttempts.$inferSelect
type EventRow = typeof contentOperationEvents.$inferSelect
type OutcomeAssessmentRow = typeof contentOperationOutcomeAssessments.$inferSelect
export type ContentOperationPublicationTargetRow = Omit<TargetRow, 'websiteId' | 'serviceReference' | 'destinationPublicationIdentity' | 'provenance'> & Partial<Pick<TargetRow, 'websiteId' | 'serviceReference' | 'destinationPublicationIdentity' | 'provenance'>>
export type ContentOperationCalendarEntryTargetRow = typeof contentOperationCalendarEntryTargets.$inferSelect
export type ContentOperationAutopilotPolicyRow = Omit<AutopilotPolicyRow, 'cadenceDays' | 'evidenceFreshnessHours' | 'maximumRiskLevel' | 'requiredQualityGateVersion' | 'allowedTargetIds' | 'allowedProviderModels' | 'allowedDestinations' | 'allowedCadences' | 'allowedRiskClasses' | 'activatedAt'> & Partial<Pick<AutopilotPolicyRow, 'cadenceDays' | 'evidenceFreshnessHours' | 'maximumRiskLevel' | 'requiredQualityGateVersion' | 'allowedTargetIds' | 'allowedProviderModels' | 'allowedDestinations' | 'allowedCadences' | 'allowedRiskClasses' | 'activatedAt'>>
export type ContentOperationEntityStrategyProfileRow = typeof contentOperationEntityStrategyProfiles.$inferSelect
export type ContentOperationQueryOwnershipRow = typeof contentOperationQueryOwnership.$inferSelect
export type ContentOperationRepairAttemptRow = typeof contentOperationRepairAttempts.$inferSelect
export type ContentOperationTopicSubstitutionRow = typeof contentOperationTopicSubstitutions.$inferSelect
export type ContentOperationMachineAuthorizationRow = typeof contentOperationMachineAuthorizations.$inferSelect
export type ContentOperationBudgetReservationRow = typeof contentOperationBudgetReservations.$inferSelect
export type ContentOperationPublicationAttemptRow = Omit<PublicationAttemptRow, 'websiteId' | 'routingPlanId' | 'routeId' | 'executorRunId' | 'authorityReference' | 'receiptFingerprint' | 'publicationUrl' | 'publicationContentHash' | 'receiptLedger'> & Partial<Pick<PublicationAttemptRow, 'websiteId' | 'routingPlanId' | 'routeId' | 'executorRunId' | 'authorityReference' | 'receiptFingerprint' | 'publicationUrl' | 'publicationContentHash' | 'receiptLedger'>>
export type ContentOperationEventRow = Omit<EventRow, 'websiteId' | 'deliverableId' | 'draftId' | 'routingPlanId' | 'routeId' | 'executorRunId' | 'contentHash' | 'evidenceSnapshotHash' | 'authorityReference'> & Partial<Pick<EventRow, 'websiteId' | 'deliverableId' | 'draftId' | 'routingPlanId' | 'routeId' | 'executorRunId' | 'contentHash' | 'evidenceSnapshotHash' | 'authorityReference'>>
export type ContentOperationOutcomeAssessmentRow = Omit<OutcomeAssessmentRow, 'targetId' | 'draftId' | 'publicationReceiptFingerprint' | 'publishedUrl' | 'contentHash' | 'evidenceSnapshotHash'> & Partial<Pick<OutcomeAssessmentRow, 'targetId' | 'draftId' | 'publicationReceiptFingerprint' | 'publishedUrl' | 'contentHash' | 'evidenceSnapshotHash'>>

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
  framework: 'astro' | 'nuxt' | 'wordpress' | 'php_agent' | 'generic_http' | 'geoflow_local' | 'static_site'
  transport: 'first_party_git' | 'first_party_signed_api' | 'wordpress_rest' | 'geoflow_agent' | 'generic_http' | 'geoflow_local'
  targetOrigin: string
  serviceReference?: string | null
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
  serviceReference?: string | null
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
  targetId?: number
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

export type WorkspaceTargetReceiptSummary = {
  attemptId: number
  status: string
  attemptNumber: number
  receiptFingerprint: string | null
  publicationUrl: string | null
  remoteRevision: string | null
  errorCode: string | null
  errorSummary: string | null
  completedAt: Date | null
  retryEligibleAt: Date | null
}

export type WorkspaceEntryTargetProjection = {
  bindingId: number
  slot: number
  targetRowId: number
  targetId: string
  websiteId: string | null
  framework: string
  transport: string
  targetOrigin: string
  status: string
  executionEnabled: boolean
  credentialConfigured: boolean
  destinationPublicationIdentityConfigured: boolean
  serviceReferenceConfigured: boolean
  bindingFingerprint: string
  latestAttempt: WorkspaceTargetReceiptSummary | null
}

export type WorkspaceEntryProjection = ContentOperationCalendarEntryRow & {
  topic: string
  framework: string | null
  target: string | null
  hasApprovedDraft: boolean
  hasPassedRiskGate: boolean
  nextAction: 'generate' | 'review' | 'publish' | 'measure' | 'learn' | 'wait' | 'none'
  publicationTargetBindings: WorkspaceEntryTargetProjection[]
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
  governance: {
    policies: ContentOperationAutopilotPolicyRow[]
    entityProfiles: ContentOperationEntityStrategyProfileRow[]
    queryOwnership: ContentOperationQueryOwnershipRow[]
    budgetReservations: ContentOperationBudgetReservationRow[]
    repairs: ContentOperationRepairAttemptRow[]
    substitutions: ContentOperationTopicSubstitutionRow[]
    machineAuthorizations: ContentOperationMachineAuthorizationRow[]
  }
  capabilities: {
    schedulerAvailable: boolean
    generationExecutorConfigured: boolean
    firstPartyPublisherConfigured: boolean
    outcomeCollectionConfigured: boolean
    externalRuntimeAvailability: {
      generationProviderConfigured: boolean
      firstPartyTransportConfigured: boolean
      nonFirstPartyTransportConfigured: boolean
      credentialResolverAvailable: boolean
    }
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
  review?: Record<string, unknown> & { id: number; jobId: number; draftId: number; reviewerUserId: number; decision: string; evidenceSnapshotHash: string } | null
  riskGate?: Record<string, unknown> & { id: number; draftId: number; status: string; evidenceSnapshotHash: string }
  publicationRun: ContentOperationRunRow | null
  publicationTarget?: ContentOperationPublicationTargetRow | null
  publicationAttempt?: ContentOperationPublicationAttemptRow
  authorityReference?: string | null
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
  'manual publication requires a current owner approved_for_delivery review; governed autopilot requires an active owner-scoped policy snapshot and never fabricates a review row',
  'mocked executor tests do not validate production credentials or customer-site connectivity',
  'outcomes are accepted only for delivered entries and remain bounded snapshots',
] as const
