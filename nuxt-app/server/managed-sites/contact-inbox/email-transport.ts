import { createError } from 'h3'
import { readBoundedManagedSiteResponse } from '../live-connectors/hmac-broker-transport'
import { assertAllowedManagedSiteProviderOrigin } from '../live-connectors/provider-verifiers'

const RESEND_SEND_ENDPOINT = 'https://api.resend.com/emails'
const DEFAULT_TIMEOUT_MS = 10_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 16 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const EMAIL_ADDRESS = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/u
const RESEND_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

type EmailEnvironment = Record<string, string | undefined>

export type ManagedSiteEmailTransport = {
  configured: boolean
  send(input: { to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }): Promise<{ delivered: true; providerMessageId: string }>
}

export type ManagedSiteEmailReadiness = {
  configured: boolean
  status: 'configured' | 'missing' | 'invalid'
  missing: string[]
  issues: string[]
}

type RecordedManagedSiteEmail = { to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }
type ResendConfiguration = { endpoint: string; apiKey: string; from: string; timeoutMs: number }

function unavailable(): never {
  throw createError({ statusCode: 503, statusMessage: '寄信服務尚未開通，暫時無法寄信。' })
}

function deliveryFailed(input: { message?: string; statusCode?: number; code?: string } = {}): never {
  throw createError({
    statusCode: input.statusCode || 502,
    statusMessage: input.message || '寄信服務暫時無法送出郵件，請稍後再試。',
    data: { code: input.code || 'email_provider_rejected' },
  })
}

function validAddress(value: string): boolean {
  if (!value || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 320 || CONTROL.test(value)) return false
  const match = EMAIL_ADDRESS.exec(value)
  return Boolean(match && match[1]!.length <= 64 && match[2]!.split('.').every(label => label.length <= 63))
}

function validFrom(value: string): boolean {
  if (validAddress(value)) return true
  if (!value || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 512 || CONTROL.test(value)) return false
  const match = /^([^<>]{1,160})\s+<([^<>]+)>$/u.exec(value)
  return Boolean(match && match[1]!.trim() === match[1] && validAddress(match[2]!))
}

function parseTimeout(value: string | undefined): number | null {
  if (value === undefined || value === '') return DEFAULT_TIMEOUT_MS
  if (!/^\d+$/u.test(value)) return null
  const timeoutMs = Number(value)
  return Number.isSafeInteger(timeoutMs) && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS ? timeoutMs : null
}

function resolveConfiguration(environment: EmailEnvironment): { readiness: ManagedSiteEmailReadiness; configuration: ResendConfiguration | null } {
  const missing: string[] = []
  const issues: string[] = []
  const apiKey = environment.NUXT_MANAGED_SITE_EMAIL_API_KEY || ''
  const from = environment.NUXT_MANAGED_SITE_EMAIL_FROM || ''
  const endpoint = environment.NUXT_MANAGED_SITE_EMAIL_ENDPOINT || RESEND_SEND_ENDPOINT
  const allowedOrigins = environment.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS || ''

  if (!apiKey) missing.push('NUXT_MANAGED_SITE_EMAIL_API_KEY')
  else if (apiKey.length < 8 || apiKey.length > 512 || !apiKey.startsWith('re_') || /\s/u.test(apiKey) || CONTROL.test(apiKey)) issues.push('NUXT_MANAGED_SITE_EMAIL_API_KEY 格式無效')
  if (!from) missing.push('NUXT_MANAGED_SITE_EMAIL_FROM')
  else if (!validFrom(from)) issues.push('NUXT_MANAGED_SITE_EMAIL_FROM 格式無效')
  if (!allowedOrigins) missing.push('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS')

  let normalizedEndpoint = ''
  let endpointOrigin = ''
  try {
    if (endpoint !== endpoint.trim()) throw new Error('surrounding whitespace')
    const parsed = new URL(endpoint)
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/emails' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('non-canonical endpoint')
    endpointOrigin = parsed.origin
    normalizedEndpoint = parsed.toString()
  } catch {
    issues.push('NUXT_MANAGED_SITE_EMAIL_ENDPOINT 必須是 HTTPS Resend 相容的 /emails 端點')
  }

  if (allowedOrigins && endpointOrigin) {
    try { assertAllowedManagedSiteProviderOrigin(normalizedEndpoint, allowedOrigins) } catch { issues.push('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS 未允許寄信服務 origin') }
  }

  const timeoutMs = parseTimeout(environment.NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS)
  if (timeoutMs === null) issues.push(`NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS 必須是 ${MIN_TIMEOUT_MS} 到 ${MAX_TIMEOUT_MS} 的整數`)

  const configured = missing.length === 0 && issues.length === 0
  const readiness: ManagedSiteEmailReadiness = {
    configured,
    status: configured ? 'configured' : issues.length ? 'invalid' : 'missing',
    missing,
    issues,
  }
  return {
    readiness,
    configuration: configured ? { endpoint: normalizedEndpoint, apiKey, from, timeoutMs: timeoutMs! } : null,
  }
}

/** Configuration-only readiness check. It never calls Resend and never returns a secret or configured value. */
export function managedSiteEmailReadinessFromEnv(environment: EmailEnvironment = process.env): ManagedSiteEmailReadiness {
  return resolveConfiguration(environment).readiness
}

function validateSendInput(input: Parameters<ManagedSiteEmailTransport['send']>[0]): void {
  if (!validAddress(input.to) || (input.replyTo !== undefined && !validAddress(input.replyTo))) {
    throw createError({ statusCode: 500, statusMessage: '寄信收件地址格式無效。' })
  }
  if (!input.subject || input.subject !== input.subject.trim() || Buffer.byteLength(input.subject, 'utf8') > 200 || CONTROL.test(input.subject)) {
    throw createError({ statusCode: 500, statusMessage: '寄信主旨格式無效。' })
  }
  if (!input.text || Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES || TEXT_CONTROL.test(input.text)) {
    throw createError({ statusCode: 500, statusMessage: '寄信內容格式無效。' })
  }
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw createError({ statusCode: 500, statusMessage: '寄信冪等識別碼格式無效。' })
  }
}

export function managedSiteEmailTransportFromEnv(fetchImpl: typeof fetch = fetch, environment: EmailEnvironment = process.env): ManagedSiteEmailTransport {
  const resolved = resolveConfiguration(environment)
  if (!resolved.configuration) {
    if (resolved.readiness.status === 'invalid') throw createError({ statusCode: 503, statusMessage: '寄信服務設定無效，請由管理員檢查設定。' })
    return { configured: false, async send() { unavailable() } }
  }

  const { endpoint, apiKey, from, timeoutMs } = resolved.configuration
  return {
    configured: true,
    async send(input) {
      validateSendInput(input)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      let raw: string
      try {
        try { response = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
          },
          body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text, ...(input.replyTo ? { reply_to: input.replyTo } : {}) }),
        }) } catch {
          deliveryFailed(controller.signal.aborted
          ? { statusCode: 503, code: 'email_provider_timeout', message: '寄信服務逾時，郵件尚未確認送出，請稍後再試。' }
          : { code: 'email_provider_unreachable' })
        }
        // The deadline covers response bytes too, not just receipt of headers.
        try { raw = await readBoundedManagedSiteResponse(response!, MAX_RESPONSE_BYTES) } catch {
          deliveryFailed(controller.signal.aborted
            ? { statusCode: 503, code: 'email_provider_timeout', message: '寄信服務逾時，郵件尚未確認送出，請稍後再試。' }
            : { code: 'email_provider_response_invalid' })
        }
      } finally {
        clearTimeout(timer)
      }
      if (!response!.ok) {
        if (response!.status === 429 || response!.status >= 500) deliveryFailed({ statusCode: 503, code: 'email_provider_unavailable', message: '寄信服務暫時忙碌，請稍後再試。' })
        deliveryFailed()
      }
      if (!(response!.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) deliveryFailed({ code: 'email_provider_response_invalid' })
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { deliveryFailed({ code: 'email_provider_response_invalid' }) }
      const providerMessageId = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.getPrototypeOf(parsed) === Object.prototype && typeof (parsed as Record<string, unknown>).id === 'string'
        ? String((parsed as Record<string, unknown>).id)
        : ''
      if (!RESEND_MESSAGE_ID.test(providerMessageId)) deliveryFailed({ code: 'email_provider_response_invalid' })
      return { delivered: true, providerMessageId }
    },
  }
}

export function createRecordingManagedSiteEmailTransport(): ManagedSiteEmailTransport & { readonly messages: readonly RecordedManagedSiteEmail[] } {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site recording email transport is test-only.' })
  const messages: RecordedManagedSiteEmail[] = []
  return {
    configured: true,
    get messages() { return messages },
    async send(input) {
      messages.push({
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      })
      return { delivered: true, providerMessageId: `recorded-${messages.length}` }
    },
  }
}
