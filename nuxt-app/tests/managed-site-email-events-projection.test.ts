import { describe, expect, it } from 'vitest'
import { projectEmailProviderObservation, type EmailProviderEventFacts, type EmailProviderState } from '../server/managed-sites/email-events/projection'

type EventKind = keyof Pick<EmailProviderEventFacts, 'sent' | 'delivered' | 'deliveryDelayed' | 'bounced' | 'complained' | 'failed' | 'suppressed'>
const eventOrder: EventKind[] = ['sent', 'delivered', 'deliveryDelayed', 'bounced', 'complained', 'failed', 'suppressed']
const priority: Array<[EventKind, EmailProviderState]> = [
  ['complained', 'complained'],
  ['bounced', 'bounced'],
  ['suppressed', 'suppressed'],
  ['failed', 'failed'],
  ['delivered', 'delivered_to_server'],
  ['deliveryDelayed', 'delivery_delayed'],
  ['sent', 'sent'],
]
const baseTime = Date.UTC(2026, 9, 7, 0, 0, 0)
const at = (offset: number) => new Date(baseTime + offset * 1000)

function factsFromEvents(events: EventKind[]): EmailProviderEventFacts {
  const timestamps = new Map<EventKind, Date>(eventOrder.map((kind, index) => [kind, at(index + 1)]))
  const facts = Object.fromEntries(eventOrder.map(kind => [kind, false])) as Record<EventKind, boolean>
  let lastEventAt: Date | null = null
  let deliveredAt: Date | null = null
  for (const kind of events) {
    facts[kind] = true
    const timestamp = timestamps.get(kind)!
    if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp
    if (kind === 'delivered') deliveredAt = timestamp
  }
  return { eventCount: events.length, ...facts, lastEventAt, deliveredAt }
}

function shuffle<T>(values: T[], seed: number): T[] {
  const result = [...values]
  let state = seed >>> 0
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const other = state % (index + 1)
    ;[result[index], result[other]] = [result[other]!, result[index]!]
  }
  return result
}

describe('email provider observation projection', () => {
  it('projects missing evidence as unknown, never as success', () => {
    expect(projectEmailProviderObservation(null)).toEqual({
      providerState: 'unknown',
      providerEventCount: 0,
      providerLastEventAt: null,
      providerReportedDeliveredAt: null,
      providerAttentionRequired: false,
      inboxDeliveryVerified: false,
    })
  })

  it('is stable across randomized arrival orders for every supported event-fact combination', () => {
    for (let mask = 1; mask < 1 << eventOrder.length; mask++) {
      const selected = eventOrder.filter((_, index) => (mask & (1 << index)) !== 0)
      const canonical = projectEmailProviderObservation(factsFromEvents(selected))
      for (let seed = 1; seed <= 12; seed++) {
        expect(projectEmailProviderObservation(factsFromEvents(shuffle(selected, seed)))).toEqual(canonical)
      }
      const expected = priority.find(([kind]) => selected.includes(kind))![1]
      expect(canonical.providerState).toBe(expected)
      expect(canonical.inboxDeliveryVerified).toBe(false)
    }
  })

  it('keeps adverse and delivered facts above late sent or delayed facts', () => {
    for (const adverse of ['bounced', 'complained', 'suppressed', 'failed'] as const) {
      const state = priority.find(([kind]) => kind === adverse)![1]
      const events: EventKind[] = [adverse, 'sent', 'deliveryDelayed']
      expect(projectEmailProviderObservation(factsFromEvents(events)).providerState).toBe(state)
      expect(projectEmailProviderObservation(factsFromEvents(shuffle(events, 42))).providerState).toBe(state)
    }
    expect(projectEmailProviderObservation(factsFromEvents(['delivered', 'sent', 'deliveryDelayed']))).toMatchObject({
      providerState: 'delivered_to_server',
      providerReportedDeliveredAt: at(2).toISOString(),
      providerAttentionRequired: false,
      inboxDeliveryVerified: false,
    })
  })

  it('keeps provider-reported delivery time independent from later adverse state', () => {
    const result = projectEmailProviderObservation(factsFromEvents(['delivered', 'bounced', 'complained']))
    expect(result).toEqual({
      providerState: 'complained',
      providerEventCount: 3,
      providerLastEventAt: at(5).toISOString(),
      providerReportedDeliveredAt: at(2).toISOString(),
      providerAttentionRequired: true,
      inboxDeliveryVerified: false,
    })
  })

  it('rejects malformed or inconsistent aggregates with one safe error', () => {
    const valid = factsFromEvents(['delivered'])
    const invalid: unknown[] = [
      { ...valid, eventCount: -1 },
      { ...valid, eventCount: 1.5 },
      { ...valid, eventCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, lastEventAt: new Date(Number.NaN) },
      { ...valid, deliveredAt: null },
      { ...valid, deliveredAt: at(3) },
      { ...valid, lastEventAt: at(1) },
      { ...valid, delivered: false },
      { ...valid, eventCount: 0 },
      { ...valid, complained: 'yes' },
    ]
    for (const item of invalid) {
      expect(() => projectEmailProviderObservation(item as EmailProviderEventFacts)).toThrowError('Invalid email provider event facts.')
    }
  })

  it('returns only the fixed safe projection, even if a repository object has private extras', () => {
    const result = projectEmailProviderObservation({
      ...factsFromEvents(['sent']),
      providerReceiptId: 'private-receipt-id',
      recipient: 'private@example.test',
      payloadFingerprint: 'private-fingerprint',
      rawBody: 'private-body',
    } as EmailProviderEventFacts)
    expect(Object.keys(result).sort()).toEqual([
      'inboxDeliveryVerified',
      'providerAttentionRequired',
      'providerEventCount',
      'providerLastEventAt',
      'providerReportedDeliveredAt',
      'providerState',
    ].sort())
    const json = JSON.stringify(result)
    for (const secret of ['private-receipt-id', 'private@example.test', 'private-fingerprint', 'private-body']) expect(json).not.toContain(secret)
  })
})
