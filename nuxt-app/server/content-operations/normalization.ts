import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { createError } from 'h3'
import { z } from 'zod'
import { CONTENT_CALENDAR_LIMITS } from '../content-calendar'
import type { ContentOperationClientInput, CreateCalendarInput, ExecuteContentOperationInput, OutcomeAssessmentInput, PublicationTargetInput, PublicationTargetPatchInput } from './types'

const strictClient = z.object({
  displayName: z.string().trim().min(1).max(160),
  canonicalSiteOrigin: z.string().trim().min(1).max(2048),
  framework: z.enum(['astro', 'nuxt']),
  publicationTransport: z.enum(['first_party_git', 'first_party_signed_api']),
  timeZone: z.string().trim().min(1).max(80),
  defaultCadenceDays: z.union([z.literal(3), z.literal(7), z.literal(15), z.literal(30)]),
  defaultPublishLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  monthlyBudgetUnits: z.number().int().min(1).max(CONTENT_CALENDAR_LIMITS.maxBudgetUnits),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const strictCalendar = z.object({
  clientId: z.number().int().positive(),
  productionPlanId: z.number().int().positive(),
  planStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  planEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  publishLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  cadenceDays: z.union([z.literal(3), z.literal(7), z.literal(15), z.literal(30)]),
  monthlyBudgetUnits: z.number().int().min(1).max(CONTENT_CALENDAR_LIMITS.maxBudgetUnits),
  defaultCostUnits: z.number().int().min(1).max(CONTENT_CALENDAR_LIMITS.maxBudgetUnits),
  maxItemsPerCalendarMonth: z.number().int().min(1).max(CONTENT_CALENDAR_LIMITS.maxMonthlyItems),
  maximumTotalItems: z.number().int().min(1).max(CONTENT_CALENDAR_LIMITS.maxTotalItems),
  catchUpPolicy: z.enum(['skip_missed', 'one_catch_up']),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict()

const strictReplan = strictCalendar.omit({ clientId: true, productionPlanId: true }).extend({
  expectedPlanFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

const strictMaterialize = z.object({
  expectedPlanFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: z.string().trim().min(1).max(128),
}).strict()

const strictOutcome = z.object({
  entryId: z.number().int().positive(),
  targetId: z.number().int().positive().optional(),
  runId: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(1).max(128),
  baselineMeasurements: z.array(z.unknown()).max(100),
  followUpMeasurements: z.array(z.unknown()).max(100),
  consent: z.unknown(),
  dataContractVersion: z.string().trim().min(1).max(120),
  measuredAt: z.string().datetime({ offset: true }).optional(),
  learningCandidate: z.boolean().optional(),
}).strict()

export function parseClientInput(value: unknown): ContentOperationClientInput {
  const parsed = strictClient.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation client input.' })
  return { ...parsed.data, canonicalSiteOrigin: normalizePublicHttpsOrigin(parsed.data.canonicalSiteOrigin), timeZone: normalizeTimeZone(parsed.data.timeZone) }
}

export function parseCalendarInput(value: unknown): CreateCalendarInput {
  const parsed = strictCalendar.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation calendar input.' })
  assertDateOnly(parsed.data.planStartDate)
  assertDateOnly(parsed.data.planEndDate)
  if (parsed.data.planEndDate < parsed.data.planStartDate) throw createError({ statusCode: 422, statusMessage: 'Calendar plan end date must not precede its start date.' })
  if (parsed.data.defaultCostUnits > parsed.data.monthlyBudgetUnits) throw createError({ statusCode: 422, statusMessage: 'Default cost units exceed the monthly budget.' })
  return { ...parsed.data }
}

export function parseReplanInput(value: unknown): { expectedPlanFingerprint: string; idempotencyKey: string; request: Omit<CreateCalendarInput, 'clientId' | 'productionPlanId' | 'idempotencyKey'> } {
  const parsed = strictReplan.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation replan input.' })
  assertDateOnly(parsed.data.planStartDate)
  assertDateOnly(parsed.data.planEndDate)
  if (parsed.data.planEndDate < parsed.data.planStartDate) throw createError({ statusCode: 422, statusMessage: 'Calendar plan end date must not precede its start date.' })
  if (parsed.data.defaultCostUnits > parsed.data.monthlyBudgetUnits) throw createError({ statusCode: 422, statusMessage: 'Default cost units exceed the monthly budget.' })
  const { expectedPlanFingerprint, idempotencyKey, ...request } = parsed.data
  return { expectedPlanFingerprint, idempotencyKey, request }
}

export function parseMaterializeInput(value: unknown): { expectedPlanFingerprint: string; idempotencyKey: string } {
  const parsed = strictMaterialize.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation materialize input.' })
  return parsed.data
}

export function parseOutcomeInput(value: unknown): OutcomeAssessmentInput {
  const parsed = strictOutcome.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation outcome input.' })
  for (const measurement of [...parsed.data.baselineMeasurements, ...parsed.data.followUpMeasurements]) {
    if (isRecord(measurement) && isRecord(measurement.metrics) && Object.values(measurement.metrics).some(metric => typeof metric === 'number' && !Number.isFinite(metric))) throw createError({ statusCode: 422, statusMessage: 'Outcome metrics must be finite numbers.' })
  }
  return parsed.data
}

const SENSITIVE_QUERY_KEY = /^(?:token|access[_-]?token|auth|authorization|password|passwd|secret|api[_-]?key|key|code|signature|sig|credential)$/iu
const SENSITIVE_QUERY_VALUE = /(?:bearer\s+|-----begin|(?:token|secret|password|passwd|api[_-]?key|authorization|credential)(?:\s*[:=]|[-_])|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|(?:sk|pk)_[a-z0-9_-]{16,})/iu

export function assertPublicHttpsUrl(value: string, label = 'Public URL'): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw createError({ statusCode: 422, statusMessage: `${label} must be a public HTTPS URL.` }) }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) throw createError({ statusCode: 422, statusMessage: `${label} must be HTTPS on the standard port without credentials.` })
  if (!isPublicDnsHostname(url.hostname)) throw createError({ statusCode: 422, statusMessage: `${label} must use a public, non-special-use hostname.` })
  for (const [key, queryValue] of url.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEY.test(key) || SENSITIVE_QUERY_VALUE.test(queryValue)) throw createError({ statusCode: 422, statusMessage: `${label} must not contain sensitive query parameters.` })
  }
  url.hostname = url.hostname.toLowerCase()
  url.hash = ''
  return url.toString()
}

export function normalizePublicHttpsOrigin(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw createError({ statusCode: 422, statusMessage: 'Site origin must be a public HTTPS origin.' }) }
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw createError({ statusCode: 422, statusMessage: 'Site origin must be a public HTTPS origin without path, query, or fragment.' })
  return assertPublicHttpsUrl(value, 'Site origin').replace(/\/$/u, '')
}

function isPublicDnsHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  const ipVersion = isIP(normalized)
  if (ipVersion === 4) return !isSpecialUseIpv4(normalized)
  if (ipVersion === 6) return !isSpecialUseIpv6(normalized)
  if (!normalized || normalized.length > 253 || normalized.endsWith('.') || !normalized.includes('.')) return false
  const labels = normalized.split('.')
  if (labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false
  if (labels.every(label => /^\d+$/.test(label))) return false
  const suffix = normalized.toLowerCase().replace(/\.$/u, '')
  const reservedSuffixes = ['localhost', 'local', 'internal', 'onion', 'test', 'invalid', 'example']
  const documentationDomains = ['example.com', 'example.net', 'example.org']
  if (reservedSuffixes.some(value => suffix === value || suffix.endsWith(`.${value}`))) return false
  if (documentationDomains.some(value => suffix === value || suffix.endsWith(`.${value}`))) return false
  return true
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null
  const octets = parts.map(Number)
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : null
}

function isSpecialUseIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname)
  if (!octets) return true
  const [first, second, third] = octets as [number, number, number, number]
  if (first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 192 && second === 0 && (third === 0 || third === 2) || first === 192 && second === 88 && third === 99 || first === 198 && (second === 18 || second === 19) || first === 198 && second === 51 && third === 100 || first === 203 && second === 0 && third === 113 || first >= 224) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  return false
}

function ipv6Words(hostname: string): number[] | null {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const pieces = value.split('::')
  if (pieces.length > 2) return null
  const left = pieces[0] ? pieces[0].split(':') : []
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : []
  const expand = (part: string): number[] | null => {
    if (part.includes('.')) {
      const ipv4 = parseIpv4(part)
      return ipv4 ? [(ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!] : null
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    return [Number.parseInt(part, 16)]
  }
  const expandAll = (parts: string[]): number[] | null => {
    const words: number[] = []
    for (const part of parts) {
      const expanded = expand(part)
      if (!expanded) return null
      words.push(...expanded)
    }
    return words
  }
  const leftWords = expandAll(left)
  const rightWords = expandAll(right)
  if (!leftWords || !rightWords || (leftWords.length + rightWords.length > 8) || (pieces.length === 1 && leftWords.length !== 8)) return null
  const zeroes = 8 - leftWords.length - rightWords.length
  return [...leftWords, ...Array.from({ length: zeroes }, () => 0), ...rightWords]
}

function isSpecialUseIpv6(hostname: string): boolean {
  const words = ipv6Words(hostname)
  if (!words || words.length !== 8) return true
  const first = words[0]!
  const second = words[1]!
  const third = words[2]!
  const allZero = words.every(word => word === 0)
  const loopback = words.slice(0, 7).every(word => word === 0) && words[7] === 1
  const compatible = words.slice(0, 6).every(word => word === 0)
  const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
  const mappedTranslated = words.slice(0, 4).every(word => word === 0) && words[4] === 0xffff && words[5] === 0
  const nat64Translated = first === 0x0064 && second === 0xff9b
  const sixToFour = first === 0x2002
  const reservedDocumentation = first === 0x2001 && (second === 0x0000 || second === 0x0001 || second === 0x0002 || second === 0x0003 || second === 0x0004 || second === 0x0010 || second === 0x0020 || second === 0x0db8) || (first & 0xfff0) === 0x3ff0
  const sixBone = first === 0x3ffe
  const uniqueLocal = (first & 0xfe00) === 0xfc00
  const linkLocal = (first & 0xffc0) === 0xfe80
  const multicast = (first & 0xff00) === 0xff00
  const benchmarking = first === 0x0100 && second === 0 && third === 0 && words[3] === 0
  return allZero || loopback || compatible || mapped || mappedTranslated || nat64Translated || sixToFour || sixBone || uniqueLocal || linkLocal || multicast || benchmarking || reservedDocumentation
}

export function normalizeTimeZone(value: string): string {
  const candidate = value.trim()
  try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date()) } catch { throw createError({ statusCode: 422, statusMessage: 'Invalid IANA time zone.' }) }
  return candidate
}

export function assertDateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw createError({ statusCode: 422, statusMessage: 'Date must use YYYY-MM-DD.' })
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw createError({ statusCode: 422, statusMessage: 'Date must be a real calendar date.' })
  return value
}

export function assertSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw createError({ statusCode: 422, statusMessage: `${label} must be a SHA-256 fingerprint.` })
  return value
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export function sanitizeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Content operation failed.'
  return message.replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [redacted]').replace(/(?:token|secret|password|authorization|credential)[^\s:=]*\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').replace(/\s+at\s+[^\n]+/g, '').replace(/[\r\n\t]+/g, ' ').slice(0, 480)
}

export function toPublicContentOperationsError(error: unknown, fallback = 'Content operation request was rejected.') {
  const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && Number.isInteger((error as { statusCode?: unknown }).statusCode) ? Number((error as { statusCode: number }).statusCode) : 503
  const status = [400, 401, 403, 404, 409, 422, 429].includes(statusCode) ? statusCode : 503
  const statusMessage = status === 401 || status === 403 ? 'Owner authorization is required.' : status === 404 ? 'Content operation resource was not found.' : status === 409 ? 'Content operation request conflicts with current state.' : status === 422 ? 'Content operation request is invalid.' : fallback
  return createError({ statusCode: status, statusMessage })
}

const strictPublicationTarget = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  framework: z.enum(['astro', 'nuxt', 'wordpress', 'php_agent', 'generic_http', 'geoflow_local', 'static_site']),
  transport: z.enum(['first_party_git', 'first_party_signed_api', 'wordpress_rest', 'geoflow_agent', 'generic_http', 'geoflow_local']),
  targetOrigin: z.string().trim().min(1).max(2048),
  serviceReference: z.string().trim().min(1).max(128).nullable().optional(),
  contentRoot: z.string().trim().min(1).max(256),
  defaultBranch: z.string().trim().min(1).max(128).nullable().optional(),
  repositoryOwner: z.string().trim().min(1).max(100).nullable().optional(),
  repositoryName: z.string().trim().min(1).max(100).nullable().optional(),
  endpointPath: z.string().trim().min(1).max(256).nullable().optional(),
  credentialReference: z.string().trim().min(1).max(128),
  allowedContentTypes: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
  allowedLanguages: z.array(z.string().trim().min(1).max(24)).min(1).max(32),
  maximumPayloadBytes: z.number().int().min(1).max(10_000_000),
  executionEnabled: z.boolean().optional().default(false),
}).strict()

const strictPublicationTargetPatch = z.object({
  targetOrigin: z.string().trim().min(1).max(2048).optional(),
  serviceReference: z.string().trim().min(1).max(128).nullable().optional(),
  contentRoot: z.string().trim().min(1).max(256).optional(),
  defaultBranch: z.string().trim().min(1).max(128).optional(),
  repositoryOwner: z.string().trim().min(1).max(100).nullable().optional(),
  repositoryName: z.string().trim().min(1).max(100).nullable().optional(),
  endpointPath: z.string().trim().min(1).max(256).nullable().optional(),
  credentialReference: z.string().trim().min(1).max(128).optional(),
  allowedContentTypes: z.array(z.string().trim().min(1).max(64)).min(1).max(32).optional(),
  allowedLanguages: z.array(z.string().trim().min(1).max(24)).min(1).max(32).optional(),
  maximumPayloadBytes: z.number().int().min(1).max(10_000_000).optional(),
  executionEnabled: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'revoked']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'At least one target patch field is required.' })

const strictEntryPublicationTargets = z.object({
  targetRowIds: z.array(z.number().int().positive()).min(1).max(20),
}).strict()

const strictExecute = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  mode: z.enum(['dry_run', 'execute']).optional().default('dry_run'),
}).strict()

const strictAutopilotPolicy = z.object({
  expiresAt: z.string().trim().min(1).max(64),
  targetRowId: z.number().int().positive().optional(),
  allowedTargetIds: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional(),
  cadenceDays: z.union([z.literal(3), z.literal(7), z.literal(15), z.literal(30)]).optional(),
  evidenceFreshnessHours: z.number().int().min(1).max(24 * 365).optional(),
  maximumRiskLevel: z.enum(['low', 'general', 'high']).optional(),
  requiredQualityGateVersion: z.string().trim().min(1).max(96).optional(),
  allowedProviderModels: z.array(z.string().trim().min(1).max(128)).min(1).max(20).optional(),
  requireApprovedForDelivery: z.boolean().optional().default(false),
  allowedContentTypes: z.array(z.enum(['article', 'faq', 'service_page'])).min(1).max(3),
  allowedLanguages: z.array(z.enum(['en', 'zh-hant'])).min(1).max(2),
}).strict()

export function parsePublicationTargetInput(value: unknown): PublicationTargetInput {
  const parsed = strictPublicationTarget.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid publication target input.' })
  const data = parsed.data
  const firstParty = data.transport === 'first_party_git' || data.transport === 'first_party_signed_api'
  if (data.transport === 'first_party_git' && !data.defaultBranch) throw createError({ statusCode: 422, statusMessage: 'Git publication target requires defaultBranch.' })
  if (data.transport === 'first_party_signed_api' && data.defaultBranch !== undefined && data.defaultBranch !== null) throw createError({ statusCode: 422, statusMessage: 'Signed API publication target must not use defaultBranch.' })
  if (firstParty && data.serviceReference !== undefined && data.serviceReference !== null) throw createError({ statusCode: 422, statusMessage: 'First-party publication target must not use serviceReference.' })
  if (data.transport === 'geoflow_local' && !data.serviceReference) throw createError({ statusCode: 422, statusMessage: 'GEOFlow local target requires an opaque serviceReference.' })
  if (data.transport !== 'geoflow_local' && data.serviceReference !== undefined && data.serviceReference !== null) throw createError({ statusCode: 422, statusMessage: 'Only GEOFlow local target may use serviceReference.' })
  return { ...data, serviceReference: data.serviceReference ?? null, defaultBranch: data.defaultBranch ?? null, repositoryOwner: data.repositoryOwner ?? null, repositoryName: data.repositoryName ?? null, endpointPath: data.endpointPath ?? null }
}

export function parsePublicationTargetPatchInput(value: unknown): PublicationTargetPatchInput {
  const parsed = strictPublicationTargetPatch.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid publication target patch.' })
  if (parsed.data.serviceReference !== undefined && parsed.data.serviceReference !== null && parsed.data.serviceReference.trim() === '') throw createError({ statusCode: 422, statusMessage: 'serviceReference must be an opaque reference or null.' })
  return { ...parsed.data, repositoryOwner: parsed.data.repositoryOwner ?? undefined, repositoryName: parsed.data.repositoryName ?? undefined, endpointPath: parsed.data.endpointPath ?? undefined }
}

export function parseEntryPublicationTargetsInput(value: unknown): { targetRowIds: number[] } {
  const parsed = strictEntryPublicationTargets.safeParse(value)
  if (!parsed.success || new Set(parsed.data.targetRowIds).size !== parsed.data.targetRowIds.length) throw createError({ statusCode: 422, statusMessage: 'Entry publication targets must be 1-20 unique target row IDs.' })
  return parsed.data
}

export function parseExecuteInput(value: unknown): ExecuteContentOperationInput {
  const parsed = strictExecute.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation execute input.' })
  return parsed.data
}

export type AutopilotPolicyRequestInput = {
  expiresAt: string
  targetRowId?: number
  allowedTargetIds?: string[]
  cadenceDays?: 3 | 7 | 15 | 30
  evidenceFreshnessHours?: number
  maximumRiskLevel?: 'low' | 'general' | 'high'
  requiredQualityGateVersion?: string
  allowedProviderModels?: string[]
  requireApprovedForDelivery: boolean
  allowedContentTypes: Array<'article' | 'faq' | 'service_page'>
  allowedLanguages: Array<'en' | 'zh-hant'>
}

export function parseAutopilotPolicyInput(value: unknown): AutopilotPolicyRequestInput {
  const parsed = strictAutopilotPolicy.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid governed autopilot policy input.' })
  return parsed.data
}
