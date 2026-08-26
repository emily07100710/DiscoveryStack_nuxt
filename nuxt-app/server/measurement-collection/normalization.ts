import { createHash } from 'node:crypto'
import { outcomeSha256, stableOutcomeStringify } from '../outcome-learning'
import { normalizePublicHttpsOrigin, normalizeTimeZone, stableFingerprint } from '../content-operations'
import { MEASUREMENT_CHECKPOINTS, MEASUREMENT_MAX_ERROR_SUMMARY, MEASUREMENT_MAX_PAGE_SCOPE, MEASUREMENT_SOURCES, type MeasurementCheckpointDays, type MeasurementConnectionInput, type MeasurementPhase, type MeasurementSource, type MeasurementSourceSnapshot, type MeasurementWindow } from './types'

const DAY_MS = 86_400_000

export const GOOGLE_SEARCH_CONSOLE_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'
export const GOOGLE_ANALYTICS_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isMeasurementCheckpoint(value: unknown): value is MeasurementCheckpointDays {
  return typeof value === 'number' && MEASUREMENT_CHECKPOINTS.includes(value as MeasurementCheckpointDays)
}

export function normalizeCredentialReference(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:/-]+$/u.test(normalized)) return null
  if (/^(?:bearer|basic|ya29|token|sk-|AIza)/iu.test(normalized)) return null
  return normalized
}

export function normalizeCanonicalPage(value: unknown, canonicalOrigin: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    const origin = normalizePublicHttpsOrigin(canonicalOrigin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash) return null
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname || '/'
    return url.toString()
  } catch {
    return null
  }
}

export function normalizePageScope(value: unknown, canonicalOrigin: string): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MEASUREMENT_MAX_PAGE_SCOPE) return null
  const pages = value.map(item => normalizeCanonicalPage(item, canonicalOrigin))
  if (pages.some(page => !page)) return null
  const unique = [...new Set(pages as string[])]
  return unique.length === pages.length ? unique.sort() : null
}

export function normalizeGa4PropertyId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,12}$/u.test(value.trim())) return null
  const normalized = value.trim()
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? normalized : null
}

export function normalizeSearchConsoleProperty(value: unknown, canonicalOrigin: string): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  const normalized = value.normalize('NFKC').trim()
  if (normalized === canonicalOrigin) return normalized
  if (/^sc-domain:[a-z0-9.-]+$/iu.test(normalized)) return normalized.toLocaleLowerCase('en-US')
  return null
}

function localDateParts(date: Date, timeZone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return [get('year'), get('month'), get('day')]
}

function localMidnight(dateOnly: string, timeZone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateOnly)) throw new Error('INVALID_LOCAL_DATE')
  const dateParts = dateOnly.split('-').map(Number)
  const year = dateParts[0] ?? 0
  const month = dateParts[1] ?? 0
  const day = dateParts[2] ?? 0
  let guess = Date.UTC(year, month - 1, day)
  for (let i = 0; i < 5; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess))
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    const targetUtc = Date.UTC(year, month - 1, day)
    guess += targetUtc - asUtc
  }
  return new Date(guess)
}

export function buildMeasurementWindow(publicationLocalDate: string, timeZone: string, checkpointDays: MeasurementCheckpointDays, availabilityLagDays: number, now = new Date(), publicationInstant?: Date): MeasurementWindow {
  const normalizedTimeZone = normalizeTimeZone(timeZone)
  const localPublicationBoundary = localMidnight(publicationLocalDate, normalizedTimeZone)
  const baselineEnd = publicationInstant && Number.isFinite(publicationInstant.getTime()) ? new Date(publicationInstant) : localPublicationBoundary
  const baselineStart = new Date(baselineEnd.getTime() - checkpointDays * DAY_MS)
  const followUpStart = baselineEnd
  const followUpEnd = new Date(followUpStart.getTime() + checkpointDays * DAY_MS)
  const lagDays = Math.max(0, Math.min(90, Math.trunc(availabilityLagDays)))
  const dueAt = new Date(followUpEnd.getTime() + lagDays * DAY_MS)
  if (followUpEnd.getTime() <= followUpStart.getTime() || baselineEnd.getTime() > followUpStart.getTime() || dueAt.getTime() < now.getTime() - 100 * 365 * DAY_MS) throw new Error('INVALID_MEASUREMENT_WINDOW')
  return { publicationLocalDate, timeZone: normalizedTimeZone, baselineStart, baselineEnd, followUpStart, followUpEnd, dueAt }
}

export function publicationLocalDate(publishedAt: Date, timeZone: string): string {
  const [year, month, day] = localDateParts(publishedAt, normalizeTimeZone(timeZone))
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function deidentifiedSubjectKey(ownerUserId: number): string {
  return createHash('sha256').update(`content-operations:${ownerUserId}`).digest('hex')
}

export function measurementScopeFingerprint(input: { ownerUserId: number; clientId: number; websiteOrigin: string; entryId: number; targetId: number; canonicalPage: string; source: MeasurementSource; checkpointDays: number }): string {
  return stableFingerprint({ ownerUserId: input.ownerUserId, clientId: input.clientId, websiteOrigin: input.websiteOrigin, entryId: input.entryId, targetId: input.targetId, canonicalPage: input.canonicalPage, source: input.source, checkpointDays: input.checkpointDays })
}

export function measurementIdempotencyKey(input: { ownerUserId: number; entryId: number; targetId: number; source: MeasurementSource; checkpointDays: number; baselineStart: Date; followUpStart: Date }): string {
  return `measurement-run:${stableFingerprint({ ownerUserId: input.ownerUserId, entryId: input.entryId, targetId: input.targetId, source: input.source, checkpointDays: input.checkpointDays, baselineStart: input.baselineStart.toISOString(), followUpStart: input.followUpStart.toISOString() })}`.slice(0, 128)
}

export function measurementInputFingerprint(input: unknown): string {
  return stableFingerprint(input)
}

export function snapshotSourceHash(input: { source: MeasurementSource; deidentifiedSubjectKey: string; scopeFingerprint: string; phase: MeasurementPhase; windowStart: Date; windowEnd: Date; capturedAt: Date; metrics: Record<string, number> }): string {
  return outcomeSha256({ source: input.source, deidentifiedSubjectKey: input.deidentifiedSubjectKey, scopeFingerprint: input.scopeFingerprint, phase: input.phase, windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(), capturedAt: input.capturedAt.toISOString(), metrics: input.metrics })
}

export function normalizeMetrics(source: MeasurementSource, value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  const required: Record<MeasurementSource, string[]> = {
    google_search_console: ['impressions', 'clicks', 'averagePosition'],
    first_party_analytics: ['sessions', 'engagedSessions'],
    llm_visibility: ['queryCount', 'mentionCount', 'citationCount'],
  }
  const keys = Object.keys(value)
  if (keys.length !== required[source].length || keys.some(key => !required[source].includes(key))) return null
  const result: Record<string, number> = {}
  for (const key of required[source]) {
    const metric = value[key]
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 || metric > Number.MAX_SAFE_INTEGER) return null
    if (source !== 'google_search_console' || key !== 'averagePosition') {
      if (!Number.isSafeInteger(metric)) return null
    }
    result[key] = metric
  }
  const metric = (key: string): number => result[key] ?? -1
  if (source === 'google_search_console' && metric('clicks') > metric('impressions')) return null
  if (source === 'first_party_analytics' && metric('engagedSessions') > metric('sessions')) return null
  if (source === 'llm_visibility' && (metric('mentionCount') > metric('queryCount') || metric('citationCount') > metric('queryCount'))) return null
  return result
}

export function buildSnapshot(input: { source: MeasurementSource; phase: MeasurementPhase; deidentifiedSubjectKey: string; scopeFingerprint: string; windowStart: Date; windowEnd: Date; capturedAt: Date; metrics: unknown; providerProvenance: Record<string, unknown>; limitations: string[] }): MeasurementSourceSnapshot | null {
  const metrics = normalizeMetrics(input.source, input.metrics)
  if (!metrics || input.windowEnd.getTime() <= input.windowStart.getTime() || input.capturedAt.getTime() < input.windowEnd.getTime()) return null
  const sourceHash = snapshotSourceHash({ ...input, metrics })
  return { source: input.source, phase: input.phase, deidentifiedSubjectKey: input.deidentifiedSubjectKey, scopeFingerprint: input.scopeFingerprint, windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(), capturedAt: input.capturedAt.toISOString(), sourceHash, normalizedMetrics: metrics, providerProvenance: input.providerProvenance, limitations: [...new Set(input.limitations)].slice(0, 20).sort() }
}

export function sanitizeError(error: unknown, fallback = 'MEASUREMENT_PROVIDER_ERROR'): { code: string; summary: string } {
  const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,100}$/u.test(error.code) ? error.code : fallback
  const summary = code.replace(/_/gu, ' ').toLocaleLowerCase('en-US').slice(0, MEASUREMENT_MAX_ERROR_SUMMARY)
  return { code, summary }
}

export function canonicalConnectionFingerprint(input: MeasurementConnectionInput & { canonicalOrigin: string; timeZone: string; allowedPageScope: string[]; sourceAvailabilityLagDays: number; credentialReference: string | null; googleSearchConsoleProperty: string | null; ga4PropertyId: string | null; llmVisibilityProjectId: number | null; providerTargets: unknown[] | null }): string {
  return stableFingerprint({ clientId: input.clientId, publicationTargetId: input.publicationTargetId || null, source: input.source, credentialReference: input.credentialReference, googleSearchConsoleProperty: input.googleSearchConsoleProperty, ga4PropertyId: input.ga4PropertyId, llmVisibilityProjectId: input.llmVisibilityProjectId, canonicalOrigin: input.canonicalOrigin, timeZone: input.timeZone, allowedPageScope: input.allowedPageScope, sourceAvailabilityLagDays: input.sourceAvailabilityLagDays, providerTargets: input.providerTargets })
}

export function hasOnlyMeasurementSource(value: unknown): value is MeasurementSource {
  return typeof value === 'string' && MEASUREMENT_SOURCES.includes(value as MeasurementSource)
}

export function stableJson(value: unknown): string {
  return stableOutcomeStringify(value)
}
