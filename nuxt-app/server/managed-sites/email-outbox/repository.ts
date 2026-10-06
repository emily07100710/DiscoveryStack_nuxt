import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { getDatabase } from '../../database'
import { managedSiteEmailOutbox } from '../../database/schema'
import type { ManagedSiteEmailOutboxClaim, ManagedSiteEmailOutboxInsert, ManagedSiteEmailOutboxItem, ManagedSiteEmailOutboxRepository, ManagedSiteEmailOutboxSafeMetadata } from './types'

type Database = NonNullable<ReturnType<typeof getDatabase>>
function affectedRows(result: unknown): number {
  if (Array.isArray(result) && result[0] && typeof result[0] === 'object' && 'affectedRows' in result[0]) return Number((result[0] as { affectedRows: unknown }).affectedRows)
  if (result && typeof result === 'object' && 'affectedRows' in result) return Number((result as { affectedRows: unknown }).affectedRows)
  return 0
}

function createRepository(database: Database): ManagedSiteEmailOutboxRepository {
  return {
    async insertOrGet(input: ManagedSiteEmailOutboxInsert) {
      try {
        await database.insert(managedSiteEmailOutbox).values({ ...input, status: 'queued', attemptCount: 0 })
      } catch {
        // A duplicate is the expected replay path; the immutable fingerprints are checked by the service.
      }
      const [row] = await database.select().from(managedSiteEmailOutbox).where(and(eq(managedSiteEmailOutbox.purpose, input.purpose), eq(managedSiteEmailOutbox.idempotencyKey, input.idempotencyKey))).limit(1)
      if (!row) throw new Error('outbox insert failed')
      return row as ManagedSiteEmailOutboxItem
    },
    async getById(id) {
      const [row] = await database.select().from(managedSiteEmailOutbox).where(eq(managedSiteEmailOutbox.id, id)).limit(1)
      return row ? row as ManagedSiteEmailOutboxItem : null
    },
    async listSafeMetadata(input) {
      if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || (input.projectId !== undefined && (!Number.isSafeInteger(input.projectId) || input.projectId <= 0))) throw new Error('invalid owner outbox query')
      const rows = await database.select({
        id: managedSiteEmailOutbox.id,
        purpose: managedSiteEmailOutbox.purpose,
        status: managedSiteEmailOutbox.status,
        createdAt: managedSiteEmailOutbox.createdAt,
        updatedAt: managedSiteEmailOutbox.updatedAt,
        nextAttemptAt: managedSiteEmailOutbox.nextAttemptAt,
        attemptCount: managedSiteEmailOutbox.attemptCount,
        expiresAt: managedSiteEmailOutbox.expiresAt,
        lastErrorCode: managedSiteEmailOutbox.safeCode,
        payloadFingerprint: managedSiteEmailOutbox.payloadFingerprint,
        providerConfigurationFingerprint: managedSiteEmailOutbox.providerConfigurationFingerprint,
      }).from(managedSiteEmailOutbox).where(and(eq(managedSiteEmailOutbox.ownerUserId, input.ownerUserId), input.projectId === undefined ? undefined : eq(managedSiteEmailOutbox.projectId, input.projectId))).orderBy(desc(managedSiteEmailOutbox.createdAt), desc(managedSiteEmailOutbox.id)).limit(input.limit)
      return rows as ManagedSiteEmailOutboxSafeMetadata[]
    },
    async cancelExpired(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('invalid cleanup limit')
      const reconcileExpiredLease = and(eq(managedSiteEmailOutbox.status, 'reconcile_pending'), or(isNull(managedSiteEmailOutbox.leaseToken), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now)))
      const eligible = or(eq(managedSiteEmailOutbox.status, 'queued'), reconcileExpiredLease, and(eq(managedSiteEmailOutbox.status, 'processing'), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now)))
      const candidates = await database.select({ id: managedSiteEmailOutbox.id, status: managedSiteEmailOutbox.status, leaseToken: managedSiteEmailOutbox.leaseToken, acceptedAt: managedSiteEmailOutbox.acceptedAt }).from(managedSiteEmailOutbox).where(and(lte(managedSiteEmailOutbox.expiresAt, input.now), eligible)).orderBy(asc(managedSiteEmailOutbox.expiresAt), asc(managedSiteEmailOutbox.id)).limit(input.limit)
      let cancelled = 0
      for (const row of candidates) {
        const finalStatus = row.acceptedAt ? 'manual_required' : 'cancelled'
        const leaseFence = row.status === 'processing'
          ? and(eq(managedSiteEmailOutbox.leaseToken, row.leaseToken!), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now))
          : row.status === 'reconcile_pending'
            ? and(eq(managedSiteEmailOutbox.status, 'reconcile_pending'), or(isNull(managedSiteEmailOutbox.leaseToken), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now)))
          : eq(managedSiteEmailOutbox.status, row.status)
        const result = await database.update(managedSiteEmailOutbox).set({ status: finalStatus, encryptedPayload: null, safeCode: 'outbox_expired', leaseToken: null, leaseExpiresAt: null, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, row.id), lte(managedSiteEmailOutbox.expiresAt, input.now), leaseFence))
        cancelled += affectedRows(result)
      }
      return cancelled
    },
    async claimOne(input) {
      const dueQueued = and(eq(managedSiteEmailOutbox.status, 'queued'), lte(managedSiteEmailOutbox.nextAttemptAt, input.now))
      const dueReconcile = and(eq(managedSiteEmailOutbox.status, 'reconcile_pending'), lte(managedSiteEmailOutbox.nextAttemptAt, input.now), or(isNull(managedSiteEmailOutbox.leaseToken), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now)))
      const expiredLease = and(eq(managedSiteEmailOutbox.status, 'processing'), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now))
      const predicate = and(or(and(dueQueued, sql`${managedSiteEmailOutbox.attemptCount} < ${input.maxAttempts}`), dueReconcile, expiredLease), input.id ? eq(managedSiteEmailOutbox.id, input.id) : undefined)
      const [candidate] = await database.select().from(managedSiteEmailOutbox).where(predicate).orderBy(asc(managedSiteEmailOutbox.nextAttemptAt), asc(managedSiteEmailOutbox.id)).limit(1)
      if (!candidate) return null
      const expectedStatus = candidate.status
      const cas = expectedStatus === 'queued'
        ? and(eq(managedSiteEmailOutbox.id, candidate.id), eq(managedSiteEmailOutbox.status, 'queued'), lte(managedSiteEmailOutbox.nextAttemptAt, input.now))
        : expectedStatus === 'reconcile_pending'
          ? and(eq(managedSiteEmailOutbox.id, candidate.id), eq(managedSiteEmailOutbox.status, 'reconcile_pending'), lte(managedSiteEmailOutbox.nextAttemptAt, input.now), or(isNull(managedSiteEmailOutbox.leaseToken), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now)))
          : and(eq(managedSiteEmailOutbox.id, candidate.id), eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.leaseToken, candidate.leaseToken!), lte(managedSiteEmailOutbox.leaseExpiresAt, input.now))
      const result = await database.update(managedSiteEmailOutbox).set({ status: 'processing', leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now }).where(cas)
      if (affectedRows(result) !== 1) return null
      const row = await this.getById(candidate.id)
      return row ? { item: row, leaseToken: input.leaseToken } satisfies ManagedSiteEmailOutboxClaim : null
    },
    async beginAttempt(input) {
      const row = await this.getById(input.id)
      if (!row || row.status !== 'processing' || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= input.now) return null
      const result = await database.update(managedSiteEmailOutbox).set({ attemptCount: sql`${managedSiteEmailOutbox.attemptCount} + 1`, firstAttemptAt: row.firstAttemptAt || input.now, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, input.id), eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.leaseToken, input.leaseToken), sql`${managedSiteEmailOutbox.leaseExpiresAt} > ${input.now}`))
      if (affectedRows(result) !== 1) return null
      return this.getById(input.id)
    },
    async renew(input) {
      const result = await database.update(managedSiteEmailOutbox).set({ leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, input.id), or(eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.status, 'reconcile_pending')), eq(managedSiteEmailOutbox.leaseToken, input.leaseToken), sql`${managedSiteEmailOutbox.leaseExpiresAt} > ${input.now}`))
      return affectedRows(result) === 1
    },
    async accepted(input) {
      const result = await database.update(managedSiteEmailOutbox).set({ status: 'reconcile_pending', providerReceiptId: input.providerReceiptId, acceptedAt: input.now, safeCode: null, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, input.id), eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.leaseToken, input.leaseToken), sql`${managedSiteEmailOutbox.leaseExpiresAt} > ${input.now}`))
      return affectedRows(result) === 1
    },
    async reconciliationComplete(input) {
      const result = await database.update(managedSiteEmailOutbox).set({ status: 'accepted', encryptedPayload: null, leaseToken: null, leaseExpiresAt: null, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, input.id), or(eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.status, 'reconcile_pending')), sql`${managedSiteEmailOutbox.providerReceiptId} is not null`, eq(managedSiteEmailOutbox.leaseToken, input.leaseToken), sql`${managedSiteEmailOutbox.leaseExpiresAt} > ${input.now}`))
      return affectedRows(result) === 1
    },
    async retry(input) {
      const result = await database.update(managedSiteEmailOutbox).set({ status: sql`case when ${managedSiteEmailOutbox.acceptedAt} is null then 'queued' else 'reconcile_pending' end`, nextAttemptAt: input.nextAttemptAt, safeCode: input.safeCode, leaseToken: null, leaseExpiresAt: null, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, input.id), or(eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.status, 'reconcile_pending')), eq(managedSiteEmailOutbox.leaseToken, input.leaseToken), sql`${managedSiteEmailOutbox.leaseExpiresAt} > ${input.now}`))
      return affectedRows(result) === 1
    },
    async finish(input) {
      const result = await database.update(managedSiteEmailOutbox).set({ status: input.status, encryptedPayload: null, safeCode: input.safeCode, leaseToken: null, leaseExpiresAt: null, updatedAt: input.now }).where(and(eq(managedSiteEmailOutbox.id, input.id), or(eq(managedSiteEmailOutbox.status, 'processing'), eq(managedSiteEmailOutbox.status, 'reconcile_pending')), eq(managedSiteEmailOutbox.leaseToken, input.leaseToken), sql`${managedSiteEmailOutbox.leaseExpiresAt} > ${input.now}`))
      return affectedRows(result) === 1
    },
  }
}

export function createManagedSiteEmailOutboxRepository(database?: Database): ManagedSiteEmailOutboxRepository {
  const shared = database || getDatabase()
  if (!shared) throw new Error('outbox database unavailable')
  return createRepository(shared)
}
