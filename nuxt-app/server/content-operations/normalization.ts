import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { z } from 'zod'
import { CONTENT_CALENDAR_LIMITS } from '../content-calendar'
import type { ContentOperationClientInput, CreateCalendarInput, OutcomeAssessmentInput } from './types'

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

const strictReplan = z.object({
  expectedPlanFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  request: strictCalendar.omit({ clientId: true, productionPlanId: true, idempotencyKey: true }).strict(),
}).strict()

const strictMaterialize = z.object({}).strict()

const strictOutcome = z.object({
  entryId: z.number().int().positive(),
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

export function parseReplanInput(value: unknown): { expectedPlanFingerprint: string; request: Omit<CreateCalendarInput, 'clientId' | 'productionPlanId' | 'idempotencyKey'> } {
  const parsed = strictReplan.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation replan input.' })
  assertDateOnly(parsed.data.request.planStartDate)
  assertDateOnly(parsed.data.request.planEndDate)
  if (parsed.data.request.planEndDate < parsed.data.request.planStartDate) throw createError({ statusCode: 422, statusMessage: 'Calendar plan end date must not precede its start date.' })
  if (parsed.data.request.defaultCostUnits > parsed.data.request.monthlyBudgetUnits) throw createError({ statusCode: 422, statusMessage: 'Default cost units exceed the monthly budget.' })
  return parsed.data
}

export function parseMaterializeInput(value: unknown): Record<string, never> {
  const parsed = strictMaterialize.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Materialize input must be an empty object.' })
  return parsed.data
}

export function parseOutcomeInput(value: unknown): OutcomeAssessmentInput {
  const parsed = strictOutcome.safeParse(value)
  if (!parsed.success) throw createError({ statusCode: 422, statusMessage: 'Invalid content operation outcome input.' })
  return parsed.data
}

export function normalizePublicHttpsOrigin(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw createError({ statusCode: 422, statusMessage: 'Site origin must be a public HTTPS origin.' }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') throw createError({ statusCode: 422, statusMessage: 'Site origin must be a public HTTPS origin without credentials, path, query, or fragment.' })
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]' || isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) throw createError({ statusCode: 422, statusMessage: 'Private, local, and link-local site origins are not allowed.' })
  url.hostname = hostname
  url.username = ''
  url.password = ''
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) return false
  const octets = parts.map(Number)
  if (octets.some(octet => octet < 0 || octet > 255)) return true
  const first = octets[0]!
  const second = octets[1]!
  return first === 10 || first === 127 || first === 0 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return value.includes(':') && (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb'))
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
