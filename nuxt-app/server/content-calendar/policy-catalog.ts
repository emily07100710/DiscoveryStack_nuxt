export const CONTENT_CALENDAR_ENGINE_VERSION = 'content-calendar-cadence-engine-v1' as const

export const CONTENT_CADENCE_DAYS = [3, 7, 15, 30] as const
export type ContentCadenceDays = typeof CONTENT_CADENCE_DAYS[number]

export const CONTENT_TYPES = ['article', 'faq', 'service_page'] as const
export type ContentType = typeof CONTENT_TYPES[number]

export const CONTENT_LANGUAGES = ['en', 'zh-hant'] as const
export type ContentLanguage = typeof CONTENT_LANGUAGES[number]

export const CONTENT_PRIORITIES = ['high', 'medium', 'low'] as const
export type ContentPriority = typeof CONTENT_PRIORITIES[number]

export const OPPORTUNITY_STATUSES = ['selected', 'rejected', 'superseded', 'proposed'] as const
export type OpportunityStatus = typeof OPPORTUNITY_STATUSES[number]

export const CATCH_UP_POLICIES = ['skip_missed', 'one_catch_up'] as const
export type CatchUpPolicy = typeof CATCH_UP_POLICIES[number]

export const CALENDAR_STATUSES = ['ready', 'partial', 'blocked'] as const
export type CalendarStatus = typeof CALENDAR_STATUSES[number]

export const CALENDAR_ENTRY_STATUSES = ['planned', 'materialized', 'completed', 'cancelled', 'skipped', 'blocked'] as const
export type CalendarEntryStatus = typeof CALENDAR_ENTRY_STATUSES[number]

export const CALENDAR_ENTRY_LIFECYCLE_TRANSITIONS: Readonly<Record<CalendarEntryStatus, readonly CalendarEntryStatus[]>> = {
  planned: ['planned', 'materialized', 'skipped', 'cancelled'],
  materialized: ['materialized', 'completed', 'cancelled'],
  completed: ['completed'],
  cancelled: ['cancelled'],
  skipped: ['skipped'],
  blocked: ['blocked'],
}

export const CALENDAR_REASON_CODES = [
  'MONTHLY_BUDGET_EXHAUSTED',
  'MONTHLY_ITEM_CAP_REACHED',
  'PLAN_ITEM_CAP_REACHED',
  'NO_AVAILABLE_SLOT',
  'EVIDENCE_SNAPSHOT_MISMATCH',
  'OPPORTUNITY_NOT_SELECTED',
  'DUPLICATE_OPPORTUNITY',
  'INVALID_INPUT',
  'INVALID_DATE',
  'INVALID_TIMEZONE',
  'INVALID_TIME',
  'INVALID_HASH',
  'UNSUPPORTED_CADENCE',
  'OPPORTUNITY_COST_EXCEEDS_BUDGET',
  'NO_DUE_WORK',
  'ALREADY_MATERIALIZED',
  'REPLAN_PRESERVED_EXECUTED',
  'PRESERVED_OPPORTUNITY_MISSING',
  'HISTORICAL_FIXED_OVER_BUDGET',
  'HISTORICAL_MONTHLY_ITEM_CAP_EXCEEDED',
] as const
export type CalendarReasonCode = typeof CALENDAR_REASON_CODES[number]

export const CONTENT_CALENDAR_LIMITS = {
  maxClientScopeKeyLength: 128,
  maxOpportunityIdLength: 128,
  maxStrategyRecommendationId: 1_000_000_000,
  maxTitleLength: 512,
  maxTopicClusterLength: 128,
  maxEvidenceHashLength: 64,
  maxOpportunities: 200,
  maxTotalItems: 100,
  maxRevision: 1_000_000,
  maxMonthlyItems: 31,
  maxBudgetUnits: 100_000,
  maxRuleIds: 64,
  maxAuthoritySourceIds: 64,
  maxIdentifierLength: 128,
  maxUnscheduledItems: 200,
} as const

export const CONTENT_CALENDAR_LIMITATIONS = [
  'server-side pure planning only',
  'no database persistence',
  'no API or queue dispatch',
  'no provider execution',
  'local date/time/timezone tuple only',
  'DST dispatch resolution belongs to the integration layer',
  'evidence snapshot equality is required',
  'no performance guarantee',
  'no ranking, traffic, LLM citation, or conversion guarantee',
] as const

export function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isEnumValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
}

export function isPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum
}

export function isRevision(value: unknown): value is number {
  return isPositiveInteger(value, CONTENT_CALENDAR_LIMITS.maxRevision)
}
