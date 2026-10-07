import type { ResendEventType } from './protocol'
import type { EmailProviderEventFacts } from './projection'

/** Verified reduced input only. No provider-supplied owner, address, payload or header is persisted. */
export type EmailProviderEventRecord = {
  id: string
  providerReceiptId: string
  eventType: ResendEventType
  payloadFingerprint: string
  providerConfigurationFingerprint: string
  verificationFingerprint: string
  occurredAt: Date
  receivedAt: Date
}

export interface EmailProviderEventsRepository {
  record(input: EmailProviderEventRecord): Promise<'recorded' | 'replayed' | 'collision'>
  listOwnerFacts(input: { ownerUserId: number; outboxIds: string[] }): Promise<Array<{ outboxId: string; facts: EmailProviderEventFacts }>>
}
