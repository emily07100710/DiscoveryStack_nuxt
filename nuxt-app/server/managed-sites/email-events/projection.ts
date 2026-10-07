export type EmailProviderEventFacts = {
  eventCount: number
  sent: boolean
  delivered: boolean
  deliveryDelayed: boolean
  bounced: boolean
  complained: boolean
  failed: boolean
  suppressed: boolean
  lastEventAt: Date | null
  deliveredAt: Date | null
}

export type EmailProviderState =
  | 'unknown'
  | 'sent'
  | 'delivery_delayed'
  | 'delivered_to_server'
  | 'failed'
  | 'suppressed'
  | 'bounced'
  | 'complained'

export type EmailProviderObservation = {
  providerState: EmailProviderState
  providerEventCount: number
  providerLastEventAt: string | null
  providerReportedDeliveredAt: string | null
  providerAttentionRequired: boolean
  inboxDeliveryVerified: false
}

const INVALID_FACTS_MESSAGE = 'Invalid email provider event facts.'
const eventKinds = ['sent', 'delivered', 'deliveryDelayed', 'bounced', 'complained', 'failed', 'suppressed'] as const

function validDate(value: unknown): value is Date | null {
  return value === null || value instanceof Date && Number.isFinite(value.getTime())
}

function safeDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function validateFacts(value: EmailProviderEventFacts): void {
  if (!Number.isSafeInteger(value.eventCount) || value.eventCount < 0) throw new Error(INVALID_FACTS_MESSAGE)
  for (const key of eventKinds) {
    if (typeof value[key] !== 'boolean') throw new Error(INVALID_FACTS_MESSAGE)
  }
  if (!validDate(value.lastEventAt) || !validDate(value.deliveredAt)) throw new Error(INVALID_FACTS_MESSAGE)

  const observedKinds = eventKinds.filter(key => value[key]).length
  if (value.eventCount === 0) {
    if (observedKinds || value.lastEventAt !== null || value.deliveredAt !== null) throw new Error(INVALID_FACTS_MESSAGE)
    return
  }
  if (observedKinds === 0 || value.eventCount < observedKinds || value.lastEventAt === null) throw new Error(INVALID_FACTS_MESSAGE)
  if (value.delivered !== (value.deliveredAt !== null)) throw new Error(INVALID_FACTS_MESSAGE)
  if (value.deliveredAt && value.lastEventAt.getTime() < value.deliveredAt.getTime()) throw new Error(INVALID_FACTS_MESSAGE)
}

/**
 * Projects reduced provider facts into a privacy-safe owner status. Invalid or
 * internally inconsistent aggregates throw one generic error without echoing input.
 */
export function projectEmailProviderObservation(facts: EmailProviderEventFacts | null): EmailProviderObservation {
  if (facts === null) {
    return {
      providerState: 'unknown',
      providerEventCount: 0,
      providerLastEventAt: null,
      providerReportedDeliveredAt: null,
      providerAttentionRequired: false,
      inboxDeliveryVerified: false,
    }
  }

  try {
    validateFacts(facts)
  } catch {
    throw new Error(INVALID_FACTS_MESSAGE)
  }

  const providerState: EmailProviderState = facts.complained ? 'complained'
    : facts.bounced ? 'bounced'
      : facts.suppressed ? 'suppressed'
        : facts.failed ? 'failed'
          : facts.delivered ? 'delivered_to_server'
            : facts.deliveryDelayed ? 'delivery_delayed'
              : facts.sent ? 'sent'
                : 'unknown'
  const providerAttentionRequired = ['delivery_delayed', 'failed', 'suppressed', 'bounced', 'complained'].includes(providerState)

  return {
    providerState,
    providerEventCount: facts.eventCount,
    providerLastEventAt: safeDate(facts.lastEventAt),
    providerReportedDeliveredAt: safeDate(facts.deliveredAt),
    providerAttentionRequired,
    inboxDeliveryVerified: false,
  }
}
