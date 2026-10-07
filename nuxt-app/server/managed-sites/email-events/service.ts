import { createHash, createHmac } from 'node:crypto'
import { createError } from 'h3'
import { isResendWebhookSecret, parseResendWebhookEvent, RESEND_EVENTS_MAX_BYTES, verifyResendWebhookSignature } from './protocol'
import type { EmailProviderEventsRepository } from './types'

export type EmailProviderEventDependencies = {
  enabled: boolean
  configured: boolean
  signingSecret: string | undefined
  encryptionSecret: string | undefined
  providerConfigurationFingerprint: string
  getRepository: () => EmailProviderEventsRepository | Promise<EmailProviderEventsRepository>
  clock?: () => Date
}

/** Passive lifecycle observation. This function has no send/retry/business-reconciliation capability. */
export async function processResendEmailProviderEvent(input: { rawBody: Uint8Array; svixId: unknown; svixTimestamp: unknown; svixSignature: unknown }, deps: EmailProviderEventDependencies) {
  if (!deps.enabled) return { status: 'disabled' as const, recorded: false }
  if (!deps.configured || !isResendWebhookSecret(deps.signingSecret) || !deps.encryptionSecret || Buffer.byteLength(deps.encryptionSecret, 'utf8') < 32 || Buffer.byteLength(deps.encryptionSecret, 'utf8') > 4096 || !/^[a-f0-9]{64}$/u.test(deps.providerConfigurationFingerprint)) throw createError({ statusCode: 503, statusMessage: '郵件事件驗證尚未開通。' })
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength > RESEND_EVENTS_MAX_BYTES) throw createError({ statusCode: 413, statusMessage: '郵件事件內容過大。' })
  const now = deps.clock?.() || new Date()
  if (!verifyResendWebhookSignature({ ...input, secret: deps.signingSecret, now })) throw createError({ statusCode: 401, statusMessage: '郵件事件簽章無效。' })
  const event = parseResendWebhookEvent(input.rawBody, now)
  if (!event) return { status: 'ignored' as const, recorded: false, providerObservationOnly: true as const, inboxDeliveryVerified: false as const }
  const keyed = (prefix: string, value: Uint8Array | string) => createHmac('sha256', deps.encryptionSecret!).update(prefix).update(value).digest('hex')
  let result: 'recorded' | 'replayed' | 'collision'
  try {
    const repository = await deps.getRepository()
    result = await repository.record({ id: createHash('sha256').update(`resend-message-v1:${input.svixId as string}`).digest('hex'), providerReceiptId: event.providerReceiptId, eventType: event.type, payloadFingerprint: keyed('resend-private-payload-v1:', input.rawBody), providerConfigurationFingerprint: deps.providerConfigurationFingerprint, verificationFingerprint: keyed('resend-verification-v1:', deps.signingSecret!), occurredAt: event.occurredAt, receivedAt: now })
  } catch {
    throw createError({ statusCode: 503, statusMessage: '郵件事件暫時無法保存，請稍後重送事件。' })
  }
  if (result === 'collision') throw createError({ statusCode: 409, statusMessage: '郵件事件識別不一致，請由管理員核對。' })
  return { status: result, recorded: true, providerObservationOnly: true as const, inboxDeliveryVerified: false as const }
}
