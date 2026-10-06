import { afterEach, describe, expect, it, vi } from 'vitest'
import { managedSiteEmailReadinessFromEnv, managedSiteEmailTransportFromEnv } from '../server/managed-sites/contact-inbox/email-transport'

const MESSAGE_ID = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794'
const environment = {
  NUXT_MANAGED_SITE_EMAIL_API_KEY: 're_test_1234567890',
  NUXT_MANAGED_SITE_EMAIL_FROM: 'DiscoveryStack <notifications@example.com>',
  DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: 'https://api.resend.com',
}

function successResponse(): Response {
  return new Response(JSON.stringify({ id: MESSAGE_ID }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('managed-site Resend email transport', () => {
  it('reports safe configuration readiness without returning secret values', () => {
    const missing = managedSiteEmailReadinessFromEnv({})
    expect(missing).toEqual({
      configured: false,
      status: 'missing',
      missing: [
        'NUXT_MANAGED_SITE_EMAIL_API_KEY',
        'NUXT_MANAGED_SITE_EMAIL_FROM',
        'DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS',
      ],
      issues: [],
    })

    const secret = 'not-a-resend-key SECRET-MUST-NOT-LEAK'
    const invalid = managedSiteEmailReadinessFromEnv({
      ...environment,
      NUXT_MANAGED_SITE_EMAIL_API_KEY: secret,
      NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS: '999999',
    })
    expect(invalid.configured).toBe(false)
    expect(invalid.status).toBe('invalid')
    expect(invalid.issues).toHaveLength(2)
    expect(JSON.stringify(invalid)).not.toContain(secret)
    expect(managedSiteEmailReadinessFromEnv(environment)).toEqual({ configured: true, status: 'configured', missing: [], issues: [] })
  })

  it('uses the official Resend request shape and carries a bounded idempotency key', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse())
    const transport = managedSiteEmailTransportFromEnv(fetchImpl as typeof fetch, environment)

    await expect(transport.send({
      to: 'owner@example.com',
      replyTo: 'visitor@example.net',
      subject: '網站收到新訊息',
      text: '您好，這是一封測試郵件。',
      idempotencyKey: 'managed-site-contact-form:71:42:abcdef',
    })).resolves.toEqual({ delivered: true, providerMessageId: MESSAGE_ID })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(url).toBe('https://api.resend.com/emails')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(headers.get('authorization')).toBe(`Bearer ${environment.NUXT_MANAGED_SITE_EMAIL_API_KEY}`)
    expect(headers.get('idempotency-key')).toBe('managed-site-contact-form:71:42:abcdef')
    expect(JSON.parse(String(init?.body))).toEqual({
      from: environment.NUXT_MANAGED_SITE_EMAIL_FROM,
      to: ['owner@example.com'],
      subject: '網站收到新訊息',
      text: '您好，這是一封測試郵件。',
      reply_to: 'visitor@example.net',
    })
  })

  it('supports an explicitly allowlisted Resend-compatible /emails endpoint', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => successResponse())
    const customEnvironment = {
      ...environment,
      NUXT_MANAGED_SITE_EMAIL_ENDPOINT: 'https://email.acme.com/emails',
      DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS: 'https://email.acme.com',
    }
    expect(managedSiteEmailReadinessFromEnv(customEnvironment).configured).toBe(true)
    await managedSiteEmailTransportFromEnv(fetchImpl as typeof fetch, customEnvironment).send({ to: 'owner@example.com', subject: '測試', text: '內容' })
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://email.acme.com/emails')
  })

  it('rejects header injection and an invalid idempotency key before making a request', async () => {
    const fetchImpl = vi.fn(async () => successResponse())
    const transport = managedSiteEmailTransportFromEnv(fetchImpl as typeof fetch, environment)
    await expect(transport.send({ to: 'owner@example.com\r\nBcc: victim@example.com', subject: '測試', text: '內容' })).rejects.toMatchObject({ statusCode: 500 })
    await expect(transport.send({ to: 'owner@example.com', subject: '測試', text: '內容', idempotencyKey: 'contains spaces' })).rejects.toMatchObject({ statusCode: 500 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never exposes a provider error body and maps retryable provider failures to 503', async () => {
    const providerSecret = 'provider-debug-secret-must-not-leak'
    const rejected = managedSiteEmailTransportFromEnv(
      vi.fn(async () => new Response(JSON.stringify({ message: providerSecret }), { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      environment,
    )
    const rejectedError = await rejected.send({ to: 'owner@example.com', subject: '測試', text: '內容' }).catch(error => error)
    expect(rejectedError).toMatchObject({ statusCode: 502, data: { code: 'email_provider_rejected' } })
    expect(JSON.stringify(rejectedError)).not.toContain(providerSecret)

    const unavailable = managedSiteEmailTransportFromEnv(
      vi.fn(async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      environment,
    )
    await expect(unavailable.send({ to: 'owner@example.com', subject: '測試', text: '內容' })).rejects.toMatchObject({ statusCode: 503, data: { code: 'email_provider_unavailable' } })
  })

  it('rejects oversized or malformed success responses', async () => {
    const oversized = managedSiteEmailTransportFromEnv(
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(16 * 1024 + 1) } })) as typeof fetch,
      environment,
    )
    await expect(oversized.send({ to: 'owner@example.com', subject: '測試', text: '內容' })).rejects.toMatchObject({ statusCode: 502, data: { code: 'email_provider_response_invalid' } })

    const malformed = managedSiteEmailTransportFromEnv(
      vi.fn(async () => new Response(JSON.stringify({ id: 'not-a-resend-id' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      environment,
    )
    await expect(malformed.send({ to: 'owner@example.com', subject: '測試', text: '內容' })).rejects.toMatchObject({ statusCode: 502, data: { code: 'email_provider_response_invalid' } })
  })

  it('aborts a hung provider request at the configured timeout without a real send', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const transport = managedSiteEmailTransportFromEnv(fetchImpl as typeof fetch, { ...environment, NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS: '1000' })
    const result = transport.send({ to: 'owner@example.com', subject: '測試', text: '內容' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toMatchObject({ statusCode: 503, data: { code: 'email_provider_timeout' } })
  })

  it('keeps the timeout active when the provider sends headers but stalls its response body', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
      },
    }), { headers: { 'content-type': 'application/json' } }))
    const transport = managedSiteEmailTransportFromEnv(fetchImpl as typeof fetch, { ...environment, NUXT_MANAGED_SITE_EMAIL_TIMEOUT_MS: '1000' })
    const result = transport.send({ to: 'owner@example.com', subject: '測試', text: '內容' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toMatchObject({ statusCode: 503, data: { code: 'email_provider_timeout' } })
  })
})
