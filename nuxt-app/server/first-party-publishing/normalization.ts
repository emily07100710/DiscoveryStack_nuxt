import type { ApprovedFirstPartyPublication } from './types'

const SHA256 = /^[a-f0-9]{64}$/i
const OPAQUE = /^[A-Za-z0-9_.:-]+$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONTENT_ROOT_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const FORBIDDEN_REFERENCE_WORD = /(bearer|token|secret|password|credential|authorization)/i
const PUBLICATION_KEYS = new Set(['ownerScopeKey', 'scheduleEntryId', 'productionPlanId', 'productionDeliverableId', 'jobId', 'draftId', 'draftVersion', 'draftStage', 'reviewId', 'reviewDecision', 'riskGateStatus', 'evidenceSnapshotHash', 'contentHash', 'title', 'body', 'slug', 'contentType', 'language', 'scheduledAt', 'scheduleKey', 'authoritySourceIds', 'ruleIds'])

export type StrictTimestampResult =
  | { readonly ok: true; readonly iso: string; readonly milliseconds: number }
  | { readonly ok: false; readonly reason: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

export function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

export function isOpaqueReference(value: unknown, maximum = 128): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) return false
  if (CONTROL.test(value) || !OPAQUE.test(value) || FORBIDDEN_REFERENCE_WORD.test(value)) return false
  if (value.includes('://') || value.includes('..') || value !== value.normalize('NFKC')) return false
  return true
}

export function isValidBranch(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || CONTROL.test(value)) return false
  if (!BRANCH.test(value) || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')) return false
  if (value.includes('@{') || value.startsWith('/') || value.includes('\\')) return false
  return true
}

export function isValidRepositoryPart(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 100 && REPOSITORY_PART.test(value) && !value.includes('..') && value === value.normalize('NFKC')
}

export function isValidSlug(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) return false
  if (value.includes('%') || value.includes('/') || value.includes('\\') || value.includes('..')) return false
  return SLUG.test(value) && value === value.normalize('NFKC')
}

export function isValidContentRoot(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return false
  if (CONTROL.test(value) || value.includes('%') || value.includes('\\') || value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false
  const segments = value.split('/')
  return segments.length > 0 && segments.every(segment => CONTENT_ROOT_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

export function isValidContentType(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && !CONTROL.test(value) && value === value.normalize('NFKC')
}

export function isValidLanguage(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(value) && value === value.toLowerCase()
}

function normalizeAllowlist(value: unknown, field: string, validator: (item: unknown) => item is string): { readonly ok: true; readonly values: string[] } | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return { ok: false, reason: `${field} must contain 1-32 values` }
  const values: string[] = []
  for (const item of value) {
    if (!validator(item)) return { ok: false, reason: `${field} contains an invalid value` }
    const normalized = item.toLowerCase()
    if (values.includes(normalized)) return { ok: false, reason: `${field} contains a duplicate value` }
    values.push(normalized)
  }
  return { ok: true, values }
}

export function normalizeContentTypeAllowlist(value: unknown): ReturnType<typeof normalizeAllowlist> {
  return normalizeAllowlist(value, 'allowedContentTypes', isValidContentType)
}

export function normalizeLanguageAllowlist(value: unknown): ReturnType<typeof normalizeAllowlist> {
  return normalizeAllowlist(value, 'allowedLanguages', isValidLanguage)
}

export function normalizeOpaqueList(value: unknown, field: string, maximum = 64): { readonly ok: true; readonly values: string[] } | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(value) || value.length > maximum) return { ok: false, reason: `${field} must be a bounded array` }
  const values: string[] = []
  for (const item of value) {
    if (!isOpaqueReference(item)) return { ok: false, reason: `${field} contains a non-opaque identifier` }
    if (values.includes(item)) return { ok: false, reason: `${field} contains a duplicate identifier` }
    values.push(item)
  }
  return { ok: true, values }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function strictTimestamp(value: unknown): StrictTimestampResult {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return { ok: false, reason: 'timestamp must be a bounded string' }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return { ok: false, reason: 'timestamp must include strict timezone-bearing ISO syntax' }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const zone = match[8]
  if (zone === undefined) return { ok: false, reason: 'timestamp timezone is missing' }
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3))
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6))
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const maximumDay = daysInMonth[month - 1]
  if (month < 1 || month > 12 || maximumDay === undefined || day < 1 || day > maximumDay) return { ok: false, reason: 'timestamp calendar date is invalid' }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'timestamp clock component is invalid' }
  if (zone !== 'Z' && (zoneHour > 23 || zoneMinute > 59)) return { ok: false, reason: 'timestamp offset is invalid' }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return { ok: false, reason: 'timestamp cannot be canonicalized' }
  return { ok: true, iso: new Date(milliseconds).toISOString(), milliseconds }
}

export function canonicalJson(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : undefined
  } catch {
    return undefined
  }
}

export function normalizeApprovedPublication(input: unknown): { readonly ok: true; readonly publication: ApprovedFirstPartyPublication } | { readonly ok: false; readonly reason: string } {
  if (!isRecord(input)) return { ok: false, reason: 'publication must be a plain object' }
  if (Object.keys(input).some(key => !PUBLICATION_KEYS.has(key))) return { ok: false, reason: 'publication contains an unknown key' }
  const get = (key: string) => readValue(input, key)
  const ownerScopeKey = get('ownerScopeKey')
  const scheduleEntryId = get('scheduleEntryId')
  const productionPlanId = get('productionPlanId')
  const productionDeliverableId = get('productionDeliverableId')
  const jobId = get('jobId')
  const draftId = get('draftId')
  const draftVersion = get('draftVersion')
  const draftStage = get('draftStage')
  const reviewId = get('reviewId')
  const reviewDecision = get('reviewDecision')
  const riskGateStatus = get('riskGateStatus')
  const evidenceSnapshotHash = get('evidenceSnapshotHash')
  const contentHash = get('contentHash')
  const title = get('title')
  const body = get('body')
  const slug = get('slug')
  const contentType = get('contentType')
  const language = get('language')
  const scheduledAt = get('scheduledAt')
  const scheduleKey = get('scheduleKey')
  const authoritySourceIds = normalizeOpaqueList(get('authoritySourceIds'), 'authoritySourceIds')
  const ruleIds = normalizeOpaqueList(get('ruleIds'), 'ruleIds')
  const timestamp = strictTimestamp(scheduledAt)
  if (!isOpaqueReference(ownerScopeKey) || !isOpaqueReference(scheduleEntryId) || !isOpaqueReference(productionPlanId) || !isOpaqueReference(productionDeliverableId) || !isOpaqueReference(jobId) || !isOpaqueReference(draftId) || !isOpaqueReference(reviewId) || !isOpaqueReference(scheduleKey, 256)) return { ok: false, reason: 'publication identity is invalid' }
  if (!Number.isSafeInteger(draftVersion) || (draftVersion as number) < 1) return { ok: false, reason: 'draftVersion must be a positive safe integer' }
  if (draftStage !== 'optimized' || (reviewDecision !== 'approved_for_delivery' && reviewDecision !== 'governed_autopilot') || riskGateStatus !== 'passed') return { ok: false, reason: 'publication approvals do not satisfy optimized delivery gates' }
  if (reviewDecision === 'governed_autopilot' && (typeof reviewId !== 'string' || !/^ref-autopilot-[A-Za-z0-9._:-]+$/u.test(reviewId))) return { ok: false, reason: 'governed_autopilot requires an opaque ref-autopilot authority reference' }
  if (!isValidSha256(evidenceSnapshotHash) || !isValidSha256(contentHash)) return { ok: false, reason: 'publication hashes must be SHA-256' }
  if (typeof title !== 'string' || title.length < 1 || title.length > 512 || CONTROL.test(title)) return { ok: false, reason: 'title is invalid' }
  if (typeof body !== 'string' || body.length < 1 || body.length > 5_000_000 || CONTROL.test(body.replace(/\n/g, '').replace(/\r/g, ''))) return { ok: false, reason: 'body is invalid' }
  if (!isValidSlug(slug) || !isValidContentType(contentType) || !isValidLanguage(language)) return { ok: false, reason: 'slug, contentType, or language is invalid' }
  if (!timestamp.ok) return { ok: false, reason: timestamp.reason }
  if (!authoritySourceIds.ok) return { ok: false, reason: authoritySourceIds.reason }
  if (!ruleIds.ok) return { ok: false, reason: ruleIds.reason }
  return {
    ok: true,
    publication: {
      ownerScopeKey,
      scheduleEntryId,
      productionPlanId,
      productionDeliverableId,
      jobId,
      draftId,
      draftVersion: draftVersion as number,
      draftStage: 'optimized',
      reviewId,
      reviewDecision: reviewDecision as 'approved_for_delivery' | 'governed_autopilot',
      riskGateStatus: 'passed',
      evidenceSnapshotHash: evidenceSnapshotHash.toLowerCase(),
      contentHash: contentHash.toLowerCase(),
      title,
      body,
      slug,
      contentType: contentType.toLowerCase(),
      language,
      scheduledAt: timestamp.iso,
      scheduleKey,
      authoritySourceIds: authoritySourceIds.values,
      ruleIds: ruleIds.values,
    },
  }
}
