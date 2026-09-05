import { createError } from 'h3'
import { readBoundedManagedSiteResponse } from '../live-connectors/hmac-broker-transport'
import { assertAllowedManagedSiteProviderOrigin } from '../live-connectors/provider-verifiers'

export type ManagedSiteEmailTransport = {
  configured: boolean
  send(input: { to: string; subject: string; text: string; replyTo?: string }): Promise<{ delivered: true; providerMessageId: string }>
}

type RecordedManagedSiteEmail = { to: string; subject: string; text: string; replyTo?: string }

function unavailable(): never {
  throw createError({ statusCode: 503, statusMessage: '寄信服務尚未開通，暫時無法寄出驗證碼。' })
}

function deliveryFailed(message = '寄信服務暫時無法送出驗證碼，請稍後再試。'): never {
  throw createError({ statusCode: 502, statusMessage: message })
}

export function managedSiteEmailTransportFromEnv(fetchImpl: typeof fetch = fetch): ManagedSiteEmailTransport {
  const endpoint = process.env.NUXT_MANAGED_SITE_EMAIL_ENDPOINT || ''
  const apiKey = process.env.NUXT_MANAGED_SITE_EMAIL_API_KEY || ''
  const from = process.env.NUXT_MANAGED_SITE_EMAIL_FROM || ''
  if (!endpoint || !apiKey || !from) return { configured: false, async send() { unavailable() } }

  assertAllowedManagedSiteProviderOrigin(endpoint)
  const sendEndpoint = new URL(endpoint).toString()
  return {
    configured: true,
    async send(input) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      let response: Response
      try {
        response = await fetchImpl(sendEndpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text, ...(input.replyTo ? { reply_to: input.replyTo } : {}) }),
        })
      } catch {
        deliveryFailed(controller.signal.aborted ? '寄信服務逾時，驗證碼尚未送出，請稍後再試。' : undefined)
      } finally {
        clearTimeout(timer)
      }

      let raw: string
      try { raw = await readBoundedManagedSiteResponse(response!, 16 * 1024) } catch { deliveryFailed() }
      if (!response!.ok) deliveryFailed()
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { deliveryFailed() }
      const providerMessageId = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).id === 'string'
        ? String((parsed as Record<string, unknown>).id)
        : ''
      if (!providerMessageId || providerMessageId.length > 512) deliveryFailed()
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
      messages.push({ to: input.to, subject: input.subject, text: input.text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) })
      return { delivered: true, providerMessageId: `recorded-${messages.length}` }
    },
  }
}
