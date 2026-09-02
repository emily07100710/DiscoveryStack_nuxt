import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { assertSafeAuditTarget } from '../audit/targetGuard'
import { normalizeUrl, urlHash } from '../site-evidence/normalization'
import { interventionTypes, measurementSources } from './types'
import type { AttachExperimentInput, ExperimentInput, ManualDeploymentInput, ManualMeasurementInput, ManualRecrawlInput, ManualRefreshInput, QueueStatusInput, RefreshPolicyInput, RegisterInterventionInput } from './types'

function invalid(code: string, statusMessage: string): never {
  throw createError({ statusCode: 422, statusMessage, data: { code } })
}

function record(value: unknown, code = 'INVALID_INPUT'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code, '輸入必須是物件。')
  return value as Record<string, unknown>
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key))
  if (unexpected) invalid('UNEXPECTED_KEY', `不接受欄位 ${unexpected}。`)
}

function text(value: unknown, name: string, min: number, max: number, required = true): string | null {
  if (value === undefined || value === null) {
    if (required) invalid('INVALID_INPUT', `${name} 為必填。`)
    return null
  }
  if (typeof value !== 'string') invalid('INVALID_INPUT', `${name} 必須是文字。`)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max) invalid(name === 'expectedSnippet' && normalized.length > max ? 'EXPECTED_SNIPPET_TOO_LONG' : 'INVALID_INPUT', `${name} 長度必須介於 ${min} 到 ${max} 個字元。`)
  return normalized
}

function positiveInt(value: unknown, name: string, required = false): number | null {
  if (value === undefined || value === null) {
    if (required) invalid('INVALID_INPUT', `${name} 為必填。`)
    return null
  }
  if (!Number.isInteger(value) || Number(value) <= 0) invalid('INVALID_INPUT', `${name} 必須是正整數。`)
  return Number(value)
}

function isoDate(value: unknown, name: string, required: boolean): Date | null {
  if (value === undefined || value === null) {
    if (required) invalid('INVALID_INPUT', `${name} 為必填。`)
    return null
  }
  if (typeof value !== 'string') invalid('INVALID_INPUT', `${name} 必須是 ISO 日期時間。`)
  const result = new Date(value)
  if (Number.isNaN(result.getTime())) invalid('INVALID_INPUT', `${name} 必須是有效的 ISO 日期時間。`)
  return result
}

function boundedNumber(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) invalid('INVALID_INPUT', `${name} 必須是大於或等於 ${min} 的有限數字。`)
  return value
}

export function parseRegisterInterventionInput(value: unknown): RegisterInterventionInput {
  const input = record(value)
  strictKeys(input, ['targetUrl', 'changeSummary', 'interventionType', 'hypothesis', 'expectedImpact', 'expectedSnippet', 'briefId', 'draftId', 'entryId', 'targetId', 'idempotencyKey'])
  const targetUrl = text(input.targetUrl, 'targetUrl', 1, 2048)!
  let safe: ReturnType<typeof assertSafeAuditTarget>
  try { safe = assertSafeAuditTarget(targetUrl) } catch { invalid('TARGET_URL_NOT_ALLOWED', 'targetUrl 必須是公開且安全的 HTTP 或 HTTPS 網址。') }
  const interventionType = input.interventionType
  if (!interventionTypes.includes(interventionType as never)) invalid('INVALID_INTERVENTION_TYPE', 'interventionType 不在允許清單中。')
  const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 1, 128)!
  if (!/^[A-Za-z0-9:_\-.]+$/u.test(idempotencyKey)) invalid('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 格式不正確。')
  let expectedImpact: RegisterInterventionInput['expectedImpact'] = null
  if (input.expectedImpact !== undefined && input.expectedImpact !== null) {
    const impact = record(input.expectedImpact)
    strictKeys(impact, ['metric', 'direction', 'note'])
    if (!['clicks', 'impressions', 'ctr', 'averagePosition'].includes(String(impact.metric))) invalid('INVALID_EXPECTED_IMPACT', 'expectedImpact.metric 不正確。')
    if (!['increase', 'decrease'].includes(String(impact.direction))) invalid('INVALID_EXPECTED_IMPACT', 'expectedImpact.direction 不正確。')
    const note = text(impact.note, 'expectedImpact.note', 1, 500, false)
    expectedImpact = { metric: impact.metric as NonNullable<RegisterInterventionInput['expectedImpact']>['metric'], direction: impact.direction as 'increase' | 'decrease', ...(note ? { note } : {}) }
  }
  const normalizedUrl = normalizeUrl(safe.normalizedUrl)
  return {
    targetUrl,
    normalizedUrl,
    urlHash: urlHash(normalizedUrl),
    siteHost: new URL(normalizedUrl).hostname.toLowerCase(),
    changeSummary: text(input.changeSummary, 'changeSummary', 3, 1000)!,
    interventionType: interventionType as RegisterInterventionInput['interventionType'],
    hypothesis: text(input.hypothesis, 'hypothesis', 1, 4000, false),
    expectedImpact,
    expectedSnippet: input.expectedSnippet === undefined || input.expectedSnippet === null ? null : text(String(input.expectedSnippet).replace(/\s+/gu, ' '), 'expectedSnippet', 5, 500),
    briefId: positiveInt(input.briefId, 'briefId'),
    draftId: positiveInt(input.draftId, 'draftId'),
    entryId: positiveInt(input.entryId, 'entryId'),
    targetId: positiveInt(input.targetId, 'targetId'),
    idempotencyKey,
  }
}

export function parseManualMeasurementInput(value: unknown): ManualMeasurementInput {
  const input = record(value)
  strictKeys(input, ['source', 'windowStart', 'windowEnd', 'metrics', 'sampleSize', 'note'])
  const source = input.source === undefined ? 'google_search_console' : input.source
  if (!measurementSources.includes(source as never)) invalid('INVALID_MEASUREMENT_SOURCE', 'source 不在允許清單中。')
  const windowStart = isoDate(input.windowStart, 'windowStart', true)!
  const windowEnd = isoDate(input.windowEnd, 'windowEnd', true)!
  if (windowStart >= windowEnd) invalid('INVALID_MEASUREMENT_WINDOW', 'windowStart 必須早於 windowEnd。')
  if (windowEnd.getTime() - windowStart.getTime() > 400 * 86_400_000) invalid('MEASUREMENT_WINDOW_TOO_LONG', '量測期間不得超過 400 天。')
  const rawMetrics = record(input.metrics)
  strictKeys(rawMetrics, ['clicks', 'impressions', 'ctr', 'averagePosition'])
  if (rawMetrics.clicks === undefined || rawMetrics.impressions === undefined) invalid('INVALID_METRICS', 'metrics.clicks 與 metrics.impressions 為必填。')
  const clicks = boundedNumber(rawMetrics.clicks, 'metrics.clicks')
  const impressions = boundedNumber(rawMetrics.impressions, 'metrics.impressions')
  const metrics: ManualMeasurementInput['metrics'] = { clicks, impressions, ctr: rawMetrics.ctr === undefined ? (impressions > 0 ? clicks / impressions : 0) : boundedNumber(rawMetrics.ctr, 'metrics.ctr') }
  if (rawMetrics.averagePosition !== undefined) metrics.averagePosition = boundedNumber(rawMetrics.averagePosition, 'metrics.averagePosition')
  const sampleSize = input.sampleSize === undefined ? Math.trunc(impressions) : positiveInt(input.sampleSize, 'sampleSize', true)!
  return { source: source as ManualMeasurementInput['source'], windowStart, windowEnd, metrics, sampleSize, note: text(input.note, 'note', 1, 500, false) }
}

export function parseManualDeploymentInput(value: unknown, now = new Date()): ManualDeploymentInput {
  const input = record(value); strictKeys(input, ['note', 'deployedAt'])
  const deployedAt = isoDate(input.deployedAt, 'deployedAt', false)
  if (deployedAt && deployedAt > now) invalid('FUTURE_DEPLOYMENT', 'deployedAt 不可在未來。')
  return { note: text(input.note, 'note', 3, 1000)!, deployedAt }
}

export function parseManualRecrawlInput(value: unknown, now = new Date()): ManualRecrawlInput {
  const input = record(value); strictKeys(input, ['note', 'confirmedAt'])
  const confirmedAt = isoDate(input.confirmedAt, 'confirmedAt', false)
  if (confirmedAt && confirmedAt > now) invalid('FUTURE_RECRAWL', 'confirmedAt 不可在未來。')
  return { note: text(input.note, 'note', 5, 1000)!, confirmedAt }
}

export function parseExperimentInput(value: unknown): ExperimentInput {
  const input = record(value); strictKeys(input, ['name', 'design', 'hypothesis', 'primaryMetric', 'idempotencyKey'])
  if (input.design !== 'pre_post' && input.design !== 'grouped') invalid('INVALID_EXPERIMENT_DESIGN', 'design 必須是 pre_post 或 grouped。')
  const primaryMetric = input.primaryMetric === undefined ? 'clicks' : input.primaryMetric
  if (!['clicks', 'impressions', 'ctr', 'averagePosition'].includes(String(primaryMetric))) invalid('INVALID_PRIMARY_METRIC', 'primaryMetric 不正確。')
  const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 1, 128)!
  if (!/^[A-Za-z0-9:_\-.]+$/u.test(idempotencyKey)) invalid('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey 格式不正確。')
  return { name: text(input.name, 'name', 1, 200)!, design: input.design, hypothesis: text(input.hypothesis, 'hypothesis', 1, 4000, false), primaryMetric: primaryMetric as ExperimentInput['primaryMetric'], idempotencyKey }
}

export function parseAttachExperimentInput(value: unknown): AttachExperimentInput {
  const input = record(value); strictKeys(input, ['interventionId', 'group'])
  if (input.group !== 'treatment' && input.group !== 'control') invalid('INVALID_EXPERIMENT_GROUP', 'group 必須是 treatment 或 control。')
  return { interventionId: positiveInt(input.interventionId, 'interventionId', true)!, group: input.group }
}

export function parseRefreshPolicyInput(value: unknown): RefreshPolicyInput {
  const input = record(value); strictKeys(input, ['regressionDropPercent', 'minimumSampleSize', 'staleAfterDays'])
  if (!Object.keys(input).length) invalid('INVALID_INPUT', '至少提供一個政策欄位。')
  const result: RefreshPolicyInput = {}
  const ranges = { regressionDropPercent: [1, 90], minimumSampleSize: [1, 100_000], staleAfterDays: [7, 730] } as const
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    if (input[key] === undefined) continue
    const value = input[key]
    const [min, max] = ranges[key]
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) invalid('INVALID_REFRESH_POLICY', `${key} 必須介於 ${min} 與 ${max}。`)
    result[key] = Number(value)
  }
  return result
}

export function parseManualRefreshInput(value: unknown): ManualRefreshInput {
  const input = record(value); strictKeys(input, ['interventionId', 'targetUrl', 'note', 'severity', 'dueAt'])
  const interventionId = positiveInt(input.interventionId, 'interventionId')
  const targetUrlText = text(input.targetUrl, 'targetUrl', 1, 2048, false)
  if ((interventionId === null) === (targetUrlText === null)) invalid('INVALID_REFRESH_TARGET', 'interventionId 與 targetUrl 必須擇一提供。')
  let targetUrl: string | null = null
  if (targetUrlText) {
    try { targetUrl = normalizeUrl(assertSafeAuditTarget(targetUrlText).normalizedUrl) } catch { invalid('TARGET_URL_NOT_ALLOWED', 'targetUrl 必須是公開且安全的 HTTP 或 HTTPS 網址。') }
  }
  const severity = input.severity === undefined ? 'warning' : input.severity
  if (!['info', 'warning', 'critical'].includes(String(severity))) invalid('INVALID_SEVERITY', 'severity 不正確。')
  return { interventionId, targetUrl, note: text(input.note, 'note', 3, 500)!, severity: severity as ManualRefreshInput['severity'], dueAt: isoDate(input.dueAt, 'dueAt', false) }
}

export function parseQueueStatusInput(value: unknown): QueueStatusInput {
  const input = record(value); strictKeys(input, ['status'])
  if (!['open', 'in_progress', 'done', 'dismissed'].includes(String(input.status))) invalid('INVALID_QUEUE_STATUS', 'status 不正確。')
  return { status: input.status as QueueStatusInput['status'] }
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return ''
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

export function fingerprint(value: unknown): string { return createHash('sha256').update(stableStringify(value)).digest('hex') }

function decodedText(value: string) {
  return value.replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;/giu, "'").replace(/&nbsp;/giu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase()
}

export function snippetMatches(html: string, expectedSnippet: string): boolean {
  const expected = decodedText(expectedSnippet)
  const visible = decodedText(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ').replace(/<[^>]+>/gu, ' '))
  const raw = decodedText(html)
  return visible.includes(expected) || raw.includes(expected)
}

export function dateOnly(date: Date): string { return date.toISOString().slice(0, 10) }
export function dayWindow(date: string): { windowStart: Date, windowEnd: Date } {
  const windowStart = new Date(`${date}T00:00:00.000Z`)
  return { windowStart, windowEnd: new Date(windowStart.getTime() + 86_400_000) }
}

// Same convention as content-operations/normalization.ts and measurement-collection/api.ts: owner-guard, same-origin,
// body-size and validation errors keep their status so the page can tell "sign in again" from "server failed";
// everything else collapses to 503 with a generic message so internal failures never leak.
export const INTERVENTION_PUBLIC_STATUS_CODES = [400, 401, 403, 404, 409, 413, 422, 503] as const
export function toPublicInterventionLoopError(error: unknown) {
  const candidate = error as { statusCode?: unknown, statusMessage?: unknown, data?: { code?: unknown } }
  const raw = Number(candidate?.statusCode)
  const passthrough = (INTERVENTION_PUBLIC_STATUS_CODES as readonly number[]).includes(raw)
  const statusCode = passthrough ? raw : 503
  const code = passthrough ? typeof candidate?.data?.code === 'string' ? candidate.data.code : 'INTERVENTION_LOOP_ERROR' : 'INTERVENTION_LOOP_UNAVAILABLE'
  const statusMessage = passthrough && typeof candidate?.statusMessage === 'string' && candidate.statusMessage ? candidate.statusMessage : passthrough ? 'Intervention loop request was rejected.' : 'Intervention loop request could not be completed.'
  return createError({ statusCode, statusMessage, data: { code } })
}
