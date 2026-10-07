import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDatabase } from '../../database'
import { managedSiteEmailManualReviews, managedSiteEmailOutbox } from '../../database/schema'
import { emailManualReviewVersion, parseEmailManualReviewCommand, validateEmailManualReviewRecord } from './model'
import type { EmailManualReviewRecord, EmailManualReviewRepository, EmailManualReviewSnapshot } from './types'

type Database = NonNullable<ReturnType<typeof getDatabase>>
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const fields = {
  outboxId: managedSiteEmailManualReviews.outboxId,
  ownerUserId: managedSiteEmailManualReviews.ownerUserId,
  requestId: managedSiteEmailManualReviews.requestId,
  outboxVersion: managedSiteEmailManualReviews.outboxVersion,
  reason: managedSiteEmailManualReviews.reason,
  closedAt: managedSiteEmailManualReviews.closedAt,
}

function duplicateKey(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as { errno?: unknown; code?: unknown; cause?: unknown }
    if (candidate.errno === 1062 || candidate.code === 'ER_DUP_ENTRY') return true
    current = candidate.cause
  }
  return false
}

function validOwner(ownerUserId: number): boolean {
  return Number.isSafeInteger(ownerUserId) && ownerUserId > 0
}

export function createEmailManualReviewRepository(database?: Database): EmailManualReviewRepository {
  const shared = database || getDatabase()
  if (!shared) throw new Error('Email review storage is unavailable.')
  return {
    async close(input) {
      if (!validOwner(input.ownerUserId)) throw new Error('Invalid email review owner.')
      const command = parseEmailManualReviewCommand(input.command)
      const proposed: EmailManualReviewRecord = { outboxId: command.itemId, ownerUserId: input.ownerUserId, requestId: command.requestId, outboxVersion: command.expectedVersion, reason: command.reason, closedAt: input.closedAt }
      if (!validateEmailManualReviewRecord(proposed)) throw new Error('Invalid email review record.')
      try {
        return await shared.transaction(async transaction => {
          // Only reduced, terminal-state metadata is read; no message, token, receipt or sending key.
          const [source] = await transaction.select({
            id: managedSiteEmailOutbox.id,
            purpose: managedSiteEmailOutbox.purpose,
            status: managedSiteEmailOutbox.status,
            updatedAt: managedSiteEmailOutbox.updatedAt,
            expiresAt: managedSiteEmailOutbox.expiresAt,
            attemptCount: managedSiteEmailOutbox.attemptCount,
            lastErrorCode: managedSiteEmailOutbox.safeCode,
            leaseFree: sql<boolean>`(${managedSiteEmailOutbox.leaseToken} IS NULL AND ${managedSiteEmailOutbox.leaseExpiresAt} IS NULL)`.mapWith(value => Number(value) === 1),
          }).from(managedSiteEmailOutbox).where(and(eq(managedSiteEmailOutbox.id, command.itemId), eq(managedSiteEmailOutbox.ownerUserId, input.ownerUserId))).limit(1).for('update')
          if (!source) return { status: 'not_found' } as const
          const version = emailManualReviewVersion(source as EmailManualReviewSnapshot)
          const [existing] = await transaction.select(fields).from(managedSiteEmailManualReviews).where(eq(managedSiteEmailManualReviews.outboxId, command.itemId)).limit(1)
          if (existing) {
            if (!validateEmailManualReviewRecord(existing) || existing.ownerUserId !== input.ownerUserId || !source.leaseFree || !version || existing.outboxVersion !== version) return { status: 'conflict' } as const
            const exactReplay = existing.requestId === command.requestId && existing.outboxVersion === command.expectedVersion && existing.reason === command.reason
            return exactReplay ? { status: 'replayed', record: existing } as const : { status: 'conflict' } as const
          }
          if (!version || !source.leaseFree) return { status: 'not_eligible' } as const
          if (version !== command.expectedVersion) return { status: 'conflict' } as const
          await transaction.insert(managedSiteEmailManualReviews).values(proposed)
          return { status: 'recorded', record: proposed } as const
        })
      } catch (error) {
        // A competing owner/request command cannot overwrite the first closure.
        if (duplicateKey(error)) return { status: 'conflict' }
        throw error
      }
    },
    async listOwnerReviews(input) {
      if (!validOwner(input.ownerUserId) || !Array.isArray(input.outboxIds) || input.outboxIds.length > 50 || input.outboxIds.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('Invalid owner email review query.')
      if (!input.outboxIds.length) return []
      return shared.select(fields).from(managedSiteEmailManualReviews)
        .innerJoin(managedSiteEmailOutbox, and(eq(managedSiteEmailOutbox.id, managedSiteEmailManualReviews.outboxId), eq(managedSiteEmailOutbox.ownerUserId, input.ownerUserId)))
        .where(and(eq(managedSiteEmailManualReviews.ownerUserId, input.ownerUserId), inArray(managedSiteEmailManualReviews.outboxId, [...new Set(input.outboxIds)]))).limit(50)
    },
  }
}
