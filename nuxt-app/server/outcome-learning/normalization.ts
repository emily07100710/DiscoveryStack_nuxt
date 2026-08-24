import { createHash } from 'node:crypto'
import { outcomeContentTypes, outcomeLanguages, outcomeMeasurementSources, type NormalizedOutcomeMeasurement, type OutcomeMeasurementSource, type PublicationIdentity } from './types'

const FORBIDDEN_KEYS = new Set([
  'email',
  'phone',
  'name',
  'companyname',
  'url',
  'rawurl',
  'rawcontent',
  'rawsearchquery',
  'rawcrmrecord',
  'rawpagecontent',
  'articlebody',
  'prompt',
  'response',
  'ip',
  'visitorid',
  'contact',
  ['cre', 'dential'].join(''),
  'token',
  ['sec', 'ret'].join(''),
  'password',
])

const SOURCE_METRICS: Record<OutcomeMeasurementSource, readonly string[]> = {
  google_search_console: ['impressions', 'clicks', 'averagePosition'],
  llm_visibility: ['queryCount', 'mentionCount', 'citationCount'],
  first_party_analytics: ['sessions', 'engagedSessions'],
  crm_aggregate: ['qualifiedLeads', 'conversions'],
}

export function normalizeOutcomeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  return normalized || null
}

export function normalizeOutcomeComparable(value: unknown): string | null {
  const normalized = normalizeOutcomeText(value)
  return normalized ? normalized.toLocaleLowerCase('en-US') : null
}

export function isOutcomeSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value.trim())
}

export function normalizeOutcomeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFKC').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) return null
  const date = new Date(text)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function stableOutcomeStringify(value: unknown): string {
  if (value === undefined) throw new Error('UNDEFINED_NOT_ALLOWED')
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NONFINITE_NOT_ALLOWED')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new Error('UNSUPPORTED_VALUE')
  if (Array.isArray(value)) return `[${value.map((item) => stableOutcomeStringify(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => `${JSON.stringify(key)}:${stableOutcomeStringify(record[key])}`).join(',')}}`
  }
  throw new Error('UNSUPPORTED_VALUE')
}

export function outcomeSha256(value: unknown): string {
  return createHash('sha256').update(stableOutcomeStringify(value), 'utf8').digest('hex')
}

function normalizedKey(value: string): string {
  return value.normalize('NFKC').replace(/[_-]/gu, '').toLocaleLowerCase('en-US')
}

export function containsForbiddenOutcomeKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.some((item) => containsForbiddenOutcomeKey(item, seen))
    const record = value as Record<string, unknown>
    return Object.keys(record).some((key) => FORBIDDEN_KEYS.has(normalizedKey(key)) || containsForbiddenOutcomeKey(record[key], seen))
  } catch {
    return true
  } finally {
    seen.delete(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStringList(value: unknown, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value)) return null
  const normalized: string[] = []
  for (const item of value) {
    const text = normalizeOutcomeText(item)
    if (!text) return null
    normalized.push(text)
  }
  if (!allowEmpty && normalized.length === 0) return null
  return [...new Set(normalized)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function normalizeComparableList(value: unknown, allowEmpty: boolean): string[] | null {
  const texts = normalizeStringList(value, allowEmpty)
  return texts ? texts.map((item) => item.toLocaleLowerCase('en-US')) : null
}

function normalizeMetricNumber(value: unknown, integer: boolean, positive = false): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (integer && (!Number.isInteger(value) || value < 0)) return null
  if (positive && value <= 0) return null
  return value
}

function durationDays(start: string, end: string): number | null {
  const value = (Date.parse(end) - Date.parse(start)) / 86_400_000
  return Number.isFinite(value) && value > 0 ? value : null
}

function normalizeMetrics(source: OutcomeMeasurementSource, value: unknown): { metrics: Record<string, number>; derivedMetrics: Record<string, number> } | null {
  if (!isRecord(value)) return null
  const allowed = SOURCE_METRICS[source]
  const keys = Object.keys(value)
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return null
  const metrics: Record<string, number> = {}
  for (const key of allowed) {
    const numeric = normalizeMetricNumber(value[key], source === 'google_search_console' ? key !== 'averagePosition' : true, source === 'google_search_console' && key === 'averagePosition')
    if (numeric === null) return null
    metrics[key] = numeric
  }
  const derivedMetrics: Record<string, number> = {}
  const metric = (key: string): number => {
    const numeric = metrics[key]
    if (typeof numeric !== 'number') throw new Error('MISSING_NORMALIZED_METRIC')
    return numeric
  }
  if (source === 'google_search_console') {
    const clicks = metric('clicks')
    const impressions = metric('impressions')
    if (clicks > impressions) return null
    derivedMetrics.ctr = impressions === 0 ? 0 : clicks / impressions
  } else if (source === 'llm_visibility') {
    const queryCount = metric('queryCount')
    const mentionCount = metric('mentionCount')
    const citationCount = metric('citationCount')
    if (mentionCount > queryCount || citationCount > queryCount) return null
    derivedMetrics.mentionRate = queryCount === 0 ? 0 : mentionCount / queryCount
    derivedMetrics.citationRate = queryCount === 0 ? 0 : citationCount / queryCount
  } else if (source === 'first_party_analytics') {
    const sessions = metric('sessions')
    const engagedSessions = metric('engagedSessions')
    if (engagedSessions > sessions) return null
    derivedMetrics.engagementRate = sessions === 0 ? 0 : engagedSessions / sessions
  } else {
    const qualifiedLeads = metric('qualifiedLeads')
    const conversions = metric('conversions')
    if (conversions > qualifiedLeads) return null
    derivedMetrics.conversionRate = qualifiedLeads === 0 ? 0 : conversions / qualifiedLeads
  }
  return { metrics, derivedMetrics }
}

export function normalizePublicationIdentity(value: unknown): PublicationIdentity | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  try {
    const sourceKey = normalizeOutcomeText(value.deidentifiedSubjectKey)
    const scheduleEntryId = normalizeOutcomeText(value.scheduleEntryId)
    const scheduleKey = normalizeOutcomeText(value.scheduleKey)
    const productionPlanId = normalizeOutcomeText(value.productionPlanId)
    const jobId = normalizeOutcomeText(value.jobId)
    const draftId = normalizeOutcomeText(value.draftId)
    const draftVersion = normalizeOutcomeText(value.draftVersion)
    const contentHash = typeof value.contentHash === 'string' && isOutcomeSha256(value.contentHash) ? value.contentHash.trim().toLocaleLowerCase('en-US') : null
    const evidenceSnapshotHash = typeof value.evidenceSnapshotHash === 'string' && isOutcomeSha256(value.evidenceSnapshotHash) ? value.evidenceSnapshotHash.trim().toLocaleLowerCase('en-US') : null
    const publishedAt = normalizeOutcomeTimestamp(value.publishedAt)
    const contentType = value.contentType
    const language = value.language
    const appliedRuleIds = normalizeStringList(value.appliedRuleIds, true)
    const topicClusterCode = normalizeOutcomeText(value.topicClusterCode)
    if (!sourceKey || !isOutcomeSha256(sourceKey) || !scheduleEntryId || !scheduleKey || !productionPlanId || !jobId || !draftId || !draftVersion || !contentHash || !evidenceSnapshotHash || !publishedAt || !outcomeContentTypes.includes(contentType as never) || !outcomeLanguages.includes(language as never) || !appliedRuleIds || !topicClusterCode) return null
    return { deidentifiedSubjectKey: sourceKey.toLocaleLowerCase('en-US'), scheduleEntryId, scheduleKey, productionPlanId, jobId, draftId, draftVersion, contentHash, evidenceSnapshotHash, publishedAt, contentType: contentType as PublicationIdentity['contentType'], language: language as PublicationIdentity['language'], appliedRuleIds, topicClusterCode }
  } catch {
    return null
  }
}

export function normalizeOutcomeMeasurement(value: unknown): NormalizedOutcomeMeasurement | null {
  if (!isRecord(value) || containsForbiddenOutcomeKey(value)) return null
  try {
    const source = value.source
    const deidentifiedSubjectKey = typeof value.deidentifiedSubjectKey === 'string' && isOutcomeSha256(value.deidentifiedSubjectKey) ? value.deidentifiedSubjectKey.trim().toLocaleLowerCase('en-US') : null
    const scopeFingerprint = typeof value.scopeFingerprint === 'string' && isOutcomeSha256(value.scopeFingerprint) ? value.scopeFingerprint.trim().toLocaleLowerCase('en-US') : null
    const phase = value.phase
    const windowStart = normalizeOutcomeTimestamp(value.windowStart)
    const windowEnd = normalizeOutcomeTimestamp(value.windowEnd)
    const capturedAt = normalizeOutcomeTimestamp(value.capturedAt)
    const sourceHash = typeof value.sourceHash === 'string' && isOutcomeSha256(value.sourceHash) ? value.sourceHash.trim().toLocaleLowerCase('en-US') : null
    if (!outcomeMeasurementSources.includes(source as never) || !deidentifiedSubjectKey || !scopeFingerprint || !sourceHash || (phase !== 'baseline' && phase !== 'follow_up') || !windowStart || !windowEnd || !capturedAt) return null
    const days = durationDays(windowStart, windowEnd)
    if (!days || Date.parse(capturedAt) < Date.parse(windowEnd)) return null
    const normalizedMetrics = normalizeMetrics(source as OutcomeMeasurementSource, value.metrics)
    if (!normalizedMetrics) return null
    const canonicalPayload = { source, deidentifiedSubjectKey, scopeFingerprint, phase, windowStart, windowEnd, capturedAt, metrics: normalizedMetrics.metrics }
    if (outcomeSha256(canonicalPayload) !== sourceHash) return null
    return { source: source as OutcomeMeasurementSource, deidentifiedSubjectKey, scopeFingerprint, phase, windowStart, windowEnd, capturedAt, sourceHash, metrics: normalizedMetrics.metrics, derivedMetrics: normalizedMetrics.derivedMetrics, durationDays: days }
  } catch {
    return null
  }
}

export function outcomeMetricKeys(source: OutcomeMeasurementSource): readonly string[] {
  return SOURCE_METRICS[source]
}

export function outcomeSourceCombinationKey(sources: readonly OutcomeMeasurementSource[]): string {
  return [...new Set(sources)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).join('+')
}
