import type { CalendarReasonCode, CatchUpPolicy, ContentCadenceDays, ContentLanguage, ContentPriority, ContentType, OpportunityStatus } from './policy-catalog'
import { CONTENT_CALENDAR_LIMITS, CONTENT_CADENCE_DAYS, CONTENT_LANGUAGES, CONTENT_TYPES, CONTENT_PRIORITIES, CATCH_UP_POLICIES, compareAscii, isEnumValue, isPositiveInteger, OPPORTUNITY_STATUSES } from './policy-catalog'
import type { ContentCalendarOpportunity, ContentCalendarRequest, NormalizedContentCalendarRequest } from './types'

export class ContentCalendarValidationError extends Error {
  readonly reasonCode: CalendarReasonCode

  constructor(reasonCode: CalendarReasonCode, message: string) {
    super(message)
    this.name = 'ContentCalendarValidationError'
    this.reasonCode = reasonCode
  }
}

function invalid(message: string, reasonCode: CalendarReasonCode = 'INVALID_INPUT'): never {
  throw new ContentCalendarValidationError(reasonCode, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  return value
}

const REQUEST_KEYS = [
  'clientScopeKey', 'planStartDate', 'planEndDate', 'timeZone', 'publishLocalTime', 'cadenceDays',
  'monthlyBudgetUnits', 'defaultCostUnits', 'maxItemsPerCalendarMonth', 'maximumTotalItems',
  'catchUpPolicy', 'evidenceSnapshotHash', 'opportunities',
] as const

const OPPORTUNITY_KEYS = [
  'id', 'strategyRecommendationId', 'title', 'contentType', 'language', 'priority', 'status',
  'topicCluster', 'evidenceSnapshotHash', 'estimatedCostUnits', 'ruleIds', 'authoritySourceIds',
] as const

function assertExactShape(value: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
  let actualKeys: string[]
  try {
    actualKeys = Object.keys(value).sort(compareAscii)
  } catch {
    invalid(`${label} keys could not be inspected`)
  }
  const expected = [...expectedKeys].sort(compareAscii)
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) invalid(`${label} must contain exactly its required keys`)
}

function read(value: Record<string, unknown>, key: string, label: string): unknown {
  try {
    return value[key]
  } catch {
    invalid(`${label}.${key} could not be read`)
  }
}

function normalizeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`)
  const normalized = value.normalize('NFKC').trim()
  if (normalized.length < 1 || normalized.length > maximum) invalid(`${label} length is outside its bounded range`)
  return normalized
}

function normalizeIdentifier(value: unknown, label: string, maximum = CONTENT_CALENDAR_LIMITS.maxIdentifierLength): string {
  const normalized = normalizeText(value, label, maximum)
  if (!/^[A-Za-z0-9_:-]+$/.test(normalized)) invalid(`${label} contains unsupported characters`)
  return normalized
}

function normalizeClientScopeKey(value: unknown): string {
  const normalized = normalizeIdentifier(value, 'clientScopeKey', CONTENT_CALENDAR_LIMITS.maxClientScopeKeyLength)
  if (/(?:^|[-_:])(corp(?:oration)?|company|inc|ltd)(?:$|[-_:])/i.test(normalized) || /公司|有限公司/i.test(normalized)) invalid('clientScopeKey must be an opaque scope key and must not contain a company name')
  return normalized
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) invalid(`${label} must be a 64-character SHA-256 hex string`, 'INVALID_HASH')
  return value.toLowerCase()
}

function normalizeDateOnly(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(`${label} must use YYYY-MM-DD`, 'INVALID_DATE')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(`${label} is not a real calendar date`, 'INVALID_DATE')
  return value
}

function normalizeLocalTime(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid('publishLocalTime must use strict HH:mm', 'INVALID_TIME')
  return value
}

function normalizeTimeZone(value: unknown): string {
  const normalized = normalizeText(value, 'timeZone', CONTENT_CALENDAR_LIMITS.maxIdentifierLength)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date('2026-01-01T00:00:00.000Z'))
  } catch {
    invalid('timeZone must be a valid IANA timezone', 'INVALID_TIMEZONE')
  }
  return normalized
}

function normalizeEnum<T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (!isEnumValue(values, value)) invalid(`${label} has an unsupported value`)
  return value
}

function normalizeBoundedInteger(value: unknown, label: string, maximum: number): number {
  if (!isPositiveInteger(value, maximum)) invalid(`${label} must be an integer from 1 to ${maximum}`)
  return value
}

function normalizeStringSet(value: unknown, label: string, maximumItems: number): string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`)
  if (value.length > maximumItems) invalid(`${label} exceeds its bounded item count`)
  const normalized = value.map((item, index) => normalizeIdentifier(item, `${label}[${index}]`))
  if (new Set(normalized).size !== normalized.length) invalid(`${label} must not contain duplicates`, 'DUPLICATE_OPPORTUNITY')
  return [...normalized].sort(compareAscii)
}

function normalizeOpportunity(value: unknown, index: number, evidenceSnapshotHash: string): ContentCalendarOpportunity {
  const input = requireRecord(value, `opportunities[${index}]`)
  assertExactShape(input, OPPORTUNITY_KEYS, `opportunities[${index}]`)
  const id = normalizeIdentifier(read(input, 'id', `opportunities[${index}]`), `opportunities[${index}].id`, CONTENT_CALENDAR_LIMITS.maxOpportunityIdLength)
  const strategyRecommendationIdValue = read(input, 'strategyRecommendationId', `opportunities[${index}]`)
  const strategyRecommendationId = normalizeBoundedInteger(strategyRecommendationIdValue, `opportunities[${index}].strategyRecommendationId`, CONTENT_CALENDAR_LIMITS.maxStrategyRecommendationId)
  const title = normalizeText(read(input, 'title', `opportunities[${index}]`), `opportunities[${index}].title`, CONTENT_CALENDAR_LIMITS.maxTitleLength)
  const contentType = normalizeEnum(read(input, 'contentType', `opportunities[${index}]`), CONTENT_TYPES, `opportunities[${index}].contentType`) as ContentType
  const language = normalizeEnum(read(input, 'language', `opportunities[${index}]`), CONTENT_LANGUAGES, `opportunities[${index}].language`) as ContentLanguage
  const priority = normalizeEnum(read(input, 'priority', `opportunities[${index}]`), CONTENT_PRIORITIES, `opportunities[${index}].priority`) as ContentPriority
  const status = normalizeEnum(read(input, 'status', `opportunities[${index}]`), OPPORTUNITY_STATUSES, `opportunities[${index}].status`) as OpportunityStatus
  const topicCluster = normalizeIdentifier(read(input, 'topicCluster', `opportunities[${index}]`), `opportunities[${index}].topicCluster`, CONTENT_CALENDAR_LIMITS.maxTopicClusterLength)
  const opportunityEvidenceHash = normalizeHash(read(input, 'evidenceSnapshotHash', `opportunities[${index}]`), `opportunities[${index}].evidenceSnapshotHash`)
  if (opportunityEvidenceHash !== evidenceSnapshotHash) invalid(`opportunities[${index}] has a mixed evidence snapshot`, 'EVIDENCE_SNAPSHOT_MISMATCH')
  const estimatedCostUnits = normalizeBoundedInteger(read(input, 'estimatedCostUnits', `opportunities[${index}]`), `opportunities[${index}].estimatedCostUnits`, CONTENT_CALENDAR_LIMITS.maxBudgetUnits)
  const ruleIds = normalizeStringSet(read(input, 'ruleIds', `opportunities[${index}]`), `opportunities[${index}].ruleIds`, CONTENT_CALENDAR_LIMITS.maxRuleIds)
  const authoritySourceIds = normalizeStringSet(read(input, 'authoritySourceIds', `opportunities[${index}]`), `opportunities[${index}].authoritySourceIds`, CONTENT_CALENDAR_LIMITS.maxAuthoritySourceIds)
  return { id, strategyRecommendationId, title, contentType, language, priority, status, topicCluster, evidenceSnapshotHash: opportunityEvidenceHash, estimatedCostUnits, ruleIds, authoritySourceIds }
}

function wrapUnknownError(error: unknown): never {
  if (error instanceof ContentCalendarValidationError) throw error
  invalid('input could not be safely normalized')
}

export function normalizeContentCalendarRequest(input: unknown): NormalizedContentCalendarRequest {
  try {
    const request = requireRecord(input, 'request')
    assertExactShape(request, REQUEST_KEYS, 'request')
    const clientScopeKey = normalizeClientScopeKey(read(request, 'clientScopeKey', 'request'))
    const planStartDate = normalizeDateOnly(read(request, 'planStartDate', 'request'), 'planStartDate')
    const planEndDate = normalizeDateOnly(read(request, 'planEndDate', 'request'), 'planEndDate')
    const startMillis = Date.parse(`${planStartDate}T00:00:00.000Z`)
    const endMillis = Date.parse(`${planEndDate}T00:00:00.000Z`)
    if (endMillis < startMillis) invalid('planEndDate must not precede planStartDate', 'INVALID_DATE')
    if ((endMillis - startMillis) / 86_400_000 > 366) invalid('planning horizon must not exceed 366 calendar days', 'INVALID_DATE')
    const timeZone = normalizeTimeZone(read(request, 'timeZone', 'request'))
    const publishLocalTime = normalizeLocalTime(read(request, 'publishLocalTime', 'request'))
    const cadenceDays = normalizeBoundedInteger(read(request, 'cadenceDays', 'request'), 'cadenceDays', 30) as ContentCadenceDays
    if (!(CONTENT_CADENCE_DAYS as readonly number[]).includes(cadenceDays)) invalid('cadenceDays is unsupported', 'UNSUPPORTED_CADENCE')
    const monthlyBudgetUnits = normalizeBoundedInteger(read(request, 'monthlyBudgetUnits', 'request'), 'monthlyBudgetUnits', CONTENT_CALENDAR_LIMITS.maxBudgetUnits)
    const defaultCostUnits = normalizeBoundedInteger(read(request, 'defaultCostUnits', 'request'), 'defaultCostUnits', CONTENT_CALENDAR_LIMITS.maxBudgetUnits)
    const maxItemsPerCalendarMonth = normalizeBoundedInteger(read(request, 'maxItemsPerCalendarMonth', 'request'), 'maxItemsPerCalendarMonth', CONTENT_CALENDAR_LIMITS.maxMonthlyItems)
    const maximumTotalItems = normalizeBoundedInteger(read(request, 'maximumTotalItems', 'request'), 'maximumTotalItems', CONTENT_CALENDAR_LIMITS.maxTotalItems)
    const catchUpPolicy = normalizeEnum(read(request, 'catchUpPolicy', 'request'), CATCH_UP_POLICIES, 'catchUpPolicy') as CatchUpPolicy
    const evidenceSnapshotHash = normalizeHash(read(request, 'evidenceSnapshotHash', 'request'), 'evidenceSnapshotHash')
    const rawOpportunities = read(request, 'opportunities', 'request')
    if (!Array.isArray(rawOpportunities)) invalid('opportunities must be an array')
    if (rawOpportunities.length > CONTENT_CALENDAR_LIMITS.maxOpportunities) invalid('opportunities exceed the maximum count')
    const opportunities = rawOpportunities.map((opportunity, index) => normalizeOpportunity(opportunity, index, evidenceSnapshotHash))
    const ids = opportunities.map(opportunity => opportunity.id)
    if (new Set(ids).size !== ids.length) invalid('opportunity ids must be unique', 'DUPLICATE_OPPORTUNITY')
    const strategyAndOpportunityKeys = opportunities.map(opportunity => `${opportunity.strategyRecommendationId}:${opportunity.id}`)
    if (new Set(strategyAndOpportunityKeys).size !== strategyAndOpportunityKeys.length) invalid('strategyRecommendationId and opportunity id pairs must be unique', 'DUPLICATE_OPPORTUNITY')
    return { clientScopeKey, planStartDate, planEndDate, timeZone, publishLocalTime, cadenceDays, monthlyBudgetUnits, defaultCostUnits, maxItemsPerCalendarMonth, maximumTotalItems, catchUpPolicy, evidenceSnapshotHash, opportunities }
  } catch (error) {
    return wrapUnknownError(error)
  }
}
