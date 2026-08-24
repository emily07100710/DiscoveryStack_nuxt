import type {
  CalendarEntryStatus,
  CalendarReasonCode,
  CalendarStatus,
  CatchUpPolicy,
  ContentCadenceDays,
  ContentLanguage,
  ContentPriority,
  ContentType,
  OpportunityStatus,
} from './policy-catalog'

export type ContentCalendarOpportunity = {
  id: string
  strategyRecommendationId: number
  title: string
  contentType: ContentType
  language: ContentLanguage
  priority: ContentPriority
  status: OpportunityStatus
  topicCluster: string
  evidenceSnapshotHash: string
  estimatedCostUnits: number
  ruleIds: string[]
  authoritySourceIds: string[]
}

export type ContentCalendarRequest = {
  clientScopeKey: string
  planStartDate: string
  planEndDate: string
  timeZone: string
  publishLocalTime: string
  cadenceDays: ContentCadenceDays
  monthlyBudgetUnits: number
  defaultCostUnits: number
  maxItemsPerCalendarMonth: number
  maximumTotalItems: number
  catchUpPolicy: CatchUpPolicy
  evidenceSnapshotHash: string
  opportunities: ContentCalendarOpportunity[]
}

export type NormalizedContentCalendarRequest = ContentCalendarRequest

export type ContentCalendarEntry = {
  entryId: string
  scheduleKey: string
  plannedLocalDate: string
  publishLocalTime: string
  timeZone: string
  opportunityId: string
  strategyRecommendationId: number
  contentType: ContentType
  language: ContentLanguage
  topicCluster: string
  evidenceSnapshotHash: string
  estimatedCostUnits: number
  status: CalendarEntryStatus
  idempotencyKey: string
}

export type UnscheduledOpportunity = {
  opportunityId: string
  reasonCode: CalendarReasonCode
}

export type ContentCalendarResult = {
  engineVersion: 'content-calendar-cadence-engine-v1'
  status: CalendarStatus
  revision: number
  previousPlanFingerprint: string | null
  normalizedRequest: NormalizedContentCalendarRequest | null
  entries: ContentCalendarEntry[]
  unscheduledOpportunities: UnscheduledOpportunity[]
  reasonCodes: CalendarReasonCode[]
  limitations: string[]
  planFingerprint: string
}

export type DueContentWork = {
  workId: string
  entryId: string
  scheduleKey: string
  plannedLocalDate: string
  publishLocalTime: string
  timeZone: string
  opportunityId: string
  strategyRecommendationId: number
  contentType: ContentType
  language: ContentLanguage
  topicCluster: string
  evidenceSnapshotHash: string
  estimatedCostUnits: number
  idempotencyKey: string
  status: 'materialized'
}

export type MaterializeDueContentWorkInput = {
  calendar: ContentCalendarResult
  expectedPlanFingerprint: string
  nowLocalDate: string
  completedEntryIds?: string[]
  cancelledEntryIds?: string[]
  eligibleEntryIds?: string[]
}

export type MaterializeDueContentWorkResult = {
  calendar: ContentCalendarResult | null
  dueWork: DueContentWork[]
  skippedEntryIds: string[]
  reasonCodes: CalendarReasonCode[]
  limitations: string[]
}

export type ReplanContentCalendarInput = {
  calendar: ContentCalendarResult
  expectedPlanFingerprint: string
  request: ContentCalendarRequest
}
