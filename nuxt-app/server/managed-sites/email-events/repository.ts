import { and, eq, inArray, isNotNull, ne, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { managedSiteEmailOutbox, managedSiteEmailProviderEvents } from '../../database/schema'
import { RESEND_EVENT_TYPES } from './protocol'
import type { EmailProviderEventRecord, EmailProviderEventsRepository } from './types'

type Database = NonNullable<ReturnType<typeof getDatabase>>
const HASH = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime()) && value.getUTCFullYear() >= 1000 && value.getUTCFullYear() <= 9999
function duplicate(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; errno?: unknown; cause?: unknown }
    if (value.code === 'ER_DUP_ENTRY' || value.errno === 1062) return true
    current = value.cause
  }
  return false
}
function validRecord(input: EmailProviderEventRecord) {
  if (!input || ![input.id, input.payloadFingerprint, input.providerConfigurationFingerprint, input.verificationFingerprint].every(value => typeof value === 'string' && HASH.test(value)) || !UUID.test(input.providerReceiptId) || !RESEND_EVENT_TYPES.includes(input.eventType) || !validDate(input.occurredAt) || !validDate(input.receivedAt)) throw new Error('Invalid email event record.')
}

export function createEmailProviderEventsRepository(database: Database | null = getDatabase()): EmailProviderEventsRepository {
  if (!database) throw createError({ statusCode: 503, statusMessage: '郵件事件資料庫暫時不可用。' })
  return {
    async record(input) {
      validRecord(input)
      let replay = false
      try {
        // Never spread provider input into a persistence model.
        await database.insert(managedSiteEmailProviderEvents).values({ id: input.id, providerReceiptId: input.providerReceiptId, eventType: input.eventType, payloadFingerprint: input.payloadFingerprint, providerConfigurationFingerprint: input.providerConfigurationFingerprint, verificationFingerprint: input.verificationFingerprint, occurredAt: input.occurredAt, receivedAt: input.receivedAt })
      } catch (error) {
        if (!duplicate(error)) throw error
        replay = true
      }
      const [row] = await database.select().from(managedSiteEmailProviderEvents).where(eq(managedSiteEmailProviderEvents.id, input.id)).limit(1)
      if (!row) throw new Error('Email event persistence unavailable.')
      // A replay can have a new attempt timestamp/signing-key proof, but not a new event or private payload.
      if (row.providerReceiptId !== input.providerReceiptId || row.eventType !== input.eventType || row.payloadFingerprint !== input.payloadFingerprint || row.providerConfigurationFingerprint !== input.providerConfigurationFingerprint || row.occurredAt.getTime() !== input.occurredAt.getTime()) return 'collision'
      return replay ? 'replayed' : 'recorded'
    },
    async listOwnerFacts(input) {
      if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0 || !Array.isArray(input.outboxIds) || input.outboxIds.length > 50 || input.outboxIds.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Invalid owner email event query.')
      const ids = [...new Set(input.outboxIds)]
      if (!ids.length) return []
      const events = managedSiteEmailProviderEvents, outbox = managedSiteEmailOutbox
      const conflicting = alias(managedSiteEmailOutbox, 'emailReceiptConflict')
      const eventFlag = (type: string) => sql<number>`MAX(CASE WHEN ${events.eventType} = ${type} THEN 1 ELSE 0 END)`.mapWith(Number)
      // One SQL snapshot resolves ownership and receipt ambiguity. A provider's JSON never supplies either.
      const rows = await database.select({
        outboxId: outbox.id,
        eventCount: sql<number>`COUNT(*)`.mapWith(Number),
        sent: eventFlag('email.sent'), delivered: eventFlag('email.delivered'), deliveryDelayed: eventFlag('email.delivery_delayed'), bounced: eventFlag('email.bounced'), complained: eventFlag('email.complained'), failed: eventFlag('email.failed'), suppressed: eventFlag('email.suppressed'),
        // Drizzle's mysql2 session intentionally returns DATETIME as strings; reuse
        // the column's UTC decoder for computed aggregates as well as normal rows.
        lastEventAt: sql<Date>`MAX(${events.occurredAt})`.mapWith(events.occurredAt),
        deliveredAt: sql<Date | null>`MAX(CASE WHEN ${events.eventType} = 'email.delivered' THEN ${events.occurredAt} ELSE NULL END)`.mapWith(events.occurredAt),
      }).from(outbox).innerJoin(events, and(eq(events.providerReceiptId, outbox.providerReceiptId), eq(events.providerConfigurationFingerprint, outbox.providerConfigurationFingerprint)))
        .where(and(eq(outbox.ownerUserId, input.ownerUserId), inArray(outbox.id, ids), isNotNull(outbox.acceptedAt), notExists(database.select({ id: conflicting.id }).from(conflicting).where(and(ne(conflicting.id, outbox.id), eq(conflicting.providerReceiptId, outbox.providerReceiptId), eq(conflicting.providerConfigurationFingerprint, outbox.providerConfigurationFingerprint), isNotNull(conflicting.acceptedAt))))))
        .groupBy(outbox.id)
      return rows.map(row => {
        if (!validDate(row.lastEventAt) || row.deliveredAt !== null && !validDate(row.deliveredAt)) throw new Error('Invalid email event aggregate.')
        return { outboxId: row.outboxId, facts: { eventCount: row.eventCount, sent: row.sent === 1, delivered: row.delivered === 1, deliveryDelayed: row.deliveryDelayed === 1, bounced: row.bounced === 1, complained: row.complained === 1, failed: row.failed === 1, suppressed: row.suppressed === 1, lastEventAt: row.lastEventAt, deliveredAt: row.deliveredAt } }
      })
    },
  }
}
