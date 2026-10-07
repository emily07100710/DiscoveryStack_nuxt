import { and, asc, count, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { getDatabase } from '../database'
import { contentOperationCalendarEntries, contentOperationPublicationAttempts, contentOperationPublicationTargets, contentOperationRuns, learningPublicationActions } from '../database/schema'
import type { LearningPublicationAction } from '../database/schema'

export type LivePublicationAction = LearningPublicationAction
export type LiveActionInsert = Omit<LivePublicationAction, 'id' | 'createdAt' | 'updatedAt'>
export type ActionLease = { ownerUserId: number; id: number; leaseToken: string; leaseVersion: number }
export type PublicationLease = { runId: number; leaseToken: string }

export interface LiveActionRepository {
  get(ownerUserId: number, id: number): Promise<LivePublicationAction | null>
  findByAttempt(ownerUserId: number, attemptId: number): Promise<LivePublicationAction | null>
  list(ownerUserId: number, limit?: number): Promise<LivePublicationAction[]>
  reserve(input: LiveActionInsert): Promise<{ row: LivePublicationAction; replayed: boolean }>
  saveBefore(lease: ActionLease, now: Date, input: { beforeProjection: unknown; plannedAction: unknown; beforeCapturedAt: Date }, publicationLease: PublicationLease): Promise<LivePublicationAction | null>
  markDispatch(ownerUserId: number, id: number, leaseVersion: number, now: Date, publicationLease: PublicationLease): Promise<LivePublicationAction | null>
  attachReceipt(ownerUserId: number, id: number, input: { inputFingerprint: string; receiptFingerprint: string; deliveredAt: Date }, now: Date): Promise<LivePublicationAction | null>
  claimAfter(ownerUserId: number, id: number, expectedVersion: number, token: string, now: Date, expiresAt: Date): Promise<LivePublicationAction | null>
  finishAfter(lease: ActionLease, now: Date, input: { status: 'observed' | 'awaiting_after' | 'blocked'; afterProjection: unknown | null; afterCapturedAt: Date | null; evidenceFingerprint: string | null; reasonCode: string | null; nextAttemptAt: Date | null }): Promise<LivePublicationAction | null>
  review(ownerUserId: number, id: number, evidenceFingerprint: string, decision: 'approved' | 'rejected', reviewFingerprint: string, reviewReasonHash: string, now: Date): Promise<LivePublicationAction | null>
  clear(ownerUserId: number, id: number, expectedVersion: number, now: Date, reasonCode: string): Promise<boolean>
  purgeExpired(ownerUserId: number, now: Date, limit?: number): Promise<number>
  listLive(ownerUserId: number, offset?: number, limit?: number): Promise<LivePublicationAction[]>
  countLive(ownerUserId: number): Promise<number>
}

type Database = Omit<NonNullable<ReturnType<typeof getDatabase>>, '$client'>
const affected = (value: unknown): number => {
  const row = Array.isArray(value) ? value[0] : value
  return Number((row as { affectedRows?: number; rowsAffected?: number } | undefined)?.affectedRows ?? (row as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0)
}
const safeTime = (value: Date) => value instanceof Date && Number.isFinite(value.getTime())
const sha256 = (value: string) => /^[a-f0-9]{64}$/.test(value)
const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max
const guardClock = (now: Date) => sql`greatest(${now}, CURRENT_TIMESTAMP(3))`
const duplicate = (error: unknown): boolean => {
  const row = error as { code?: string; errno?: number; cause?: unknown }
  return row?.code === 'ER_DUP_ENTRY' || row?.errno === 1062 || Boolean(row?.cause && duplicate(row.cause))
}

/** Correlated SQL predicates keep the publication lease and planned execute attempt in the same CAS as each action transition. */
function activePublicationLease(table: typeof learningPublicationActions, runId: number, token: string, now: Date) {
  const clock = guardClock(now)
  return sql`exists (
    select 1 from ${sql.raw('`contentOperationRuns` as `r`')}
    inner join ${sql.raw('`contentOperationPublicationAttempts` as `a`')} on ${sql.raw('`a`.`runId`')} = ${sql.raw('`r`.`id`')}
    inner join ${sql.raw('`contentOperationCalendarEntries` as `e`')} on ${sql.raw('`e`.`id`')} = ${sql.raw('`a`.`entryId`')}
    inner join ${sql.raw('`contentOperationCalendars` as `c`')} on ${sql.raw('`c`.`id`')} = ${sql.raw('`e`.`calendarId`')}
    inner join ${sql.raw('`contentOperationPublicationTargets` as `t`')} on ${sql.raw('`t`.`id`')} = ${sql.raw('`a`.`targetId`')}
    inner join ${sql.raw('`seoGeoContentDrafts` as `d`')} on ${sql.raw('`d`.`id`')} = ${sql.raw('`e`.`draftId`')}
    where ${sql.raw('`r`.`id`')} = ${runId}
      and ${sql.raw('`r`.`id`')} = ${table.runId}
      and ${sql.raw('`r`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`r`.`entryId`')} = ${table.entryId}
      and ${sql.raw('`r`.`stage`')} = 'publication'
      and ${sql.raw('`r`.`state`')} = 'processing'
      and ${sql.raw('`r`.`leaseOwner`')} = ${token}
      and ${sql.raw('`r`.`leaseExpiresAt`')} > ${clock}
      and ${sql.raw('`a`.`id`')} = ${table.attemptId}
      and ${sql.raw('`a`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`a`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`a`.`entryId`')} = ${table.entryId}
      and ${sql.raw('`a`.`runId`')} = ${table.runId}
      and ${sql.raw('`a`.`targetId`')} = ${table.targetId}
      and ${sql.raw('`a`.`mode`')} = 'execute'
      and ${sql.raw('`a`.`status`')} = 'planned'
      and ${sql.raw('`a`.`contentHash`')} = ${table.draftContentHash}
      and ${sql.raw('`a`.`publicationContentHash`')} = ${table.publicationContentHash}
      and ${sql.raw('`a`.`evidenceSnapshotHash`')} = ${table.evidenceSnapshotHash}
      and ${sql.raw('`e`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`c`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`c`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`e`.`calendarId`')} = ${sql.raw('`c`.`id`')}
      and ${sql.raw('`e`.`jobId`')} = ${sql.raw('`d`.`jobId`')}
      and ${sql.raw('`e`.`draftId`')} = ${table.draftId}
      and ${sql.raw('`e`.`evidenceSnapshotHash`')} = ${table.evidenceSnapshotHash}
      and ${sql.raw('`d`.`version`')} = ${table.draftVersion}
      and ${sql.raw('`d`.`contentHash`')} = ${table.draftContentHash}
      and ${sql.raw('`t`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`t`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`t`.`configurationFingerprint`')} = ${table.targetConfigurationFingerprint}
      and ${sql.raw('`t`.`status`')} = 'active'
      and ${sql.raw('`t`.`executionEnabled`')} = 1
      and (
        (${sql.raw('`t`.`id`')} = ${sql.raw('`e`.`publicationTargetId`')} and ${sql.raw('`e`.`publicationIdentityFingerprint`')} = ${table.publicationIdentityFingerprint} and ${sql.raw('`e`.`publicationContentHash`')} = ${table.publicationContentHash} and ${sql.raw('`a`.`publicationId`')} = concat('publication-', ${sql.raw('`e`.`id`')}) and ${sql.raw('`a`.`publicationSlug`')} = ${sql.raw('`e`.`publicationSlug`')} and ${sql.raw('`a`.`publicationPath`')} = ${sql.raw('`e`.`publicationPath`')})
        or (${sql.raw('`t`.`id`')} <> ${sql.raw('`e`.`publicationTargetId`')} and exists (
          select 1 from ${sql.raw('`contentOperationCalendarEntryTargets` as `b`')}
          where ${sql.raw('`b`.`ownerUserId`')} = ${table.ownerUserId}
            and ${sql.raw('`b`.`clientId`')} = ${table.clientId}
            and ${sql.raw('`b`.`entryId`')} = ${table.entryId}
            and ${sql.raw('`b`.`targetId`')} = ${table.targetId}
        ))
      )
  )`
}

function matchingDeliveredAttempt(table: typeof learningPublicationActions, now: Date, receiptFingerprint: string, deliveredAt: Date) {
  const clock = guardClock(now)
  return sql`exists (
    select 1 from ${sql.raw('`contentOperationPublicationAttempts` as `a`')}
    inner join ${sql.raw('`contentOperationRuns` as `r`')} on ${sql.raw('`r`.`id`')} = ${sql.raw('`a`.`runId`')}
    inner join ${sql.raw('`contentOperationCalendarEntries` as `e`')} on ${sql.raw('`e`.`id`')} = ${sql.raw('`a`.`entryId`')}
    inner join ${sql.raw('`contentOperationCalendars` as `c`')} on ${sql.raw('`c`.`id`')} = ${sql.raw('`e`.`calendarId`')}
    inner join ${sql.raw('`contentOperationPublicationTargets` as `t`')} on ${sql.raw('`t`.`id`')} = ${sql.raw('`a`.`targetId`')}
    inner join ${sql.raw('`seoGeoContentDrafts` as `d`')} on ${sql.raw('`d`.`id`')} = ${sql.raw('`e`.`draftId`')}
    where ${sql.raw('`a`.`id`')} = ${table.attemptId}
      and ${sql.raw('`a`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`a`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`a`.`entryId`')} = ${table.entryId}
      and ${sql.raw('`a`.`runId`')} = ${table.runId}
      and ${sql.raw('`r`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`r`.`entryId`')} = ${table.entryId}
      and ${sql.raw('`r`.`stage`')} = 'publication'
      and ${sql.raw('`r`.`state`')} in ('succeeded', 'retry_wait', 'blocked', 'failed')
      and ${sql.raw('`a`.`targetId`')} = ${table.targetId}
      and ${sql.raw('`a`.`mode`')} = 'execute'
      and ${sql.raw('`a`.`status`')} = 'delivered'
      and ${sql.raw('`a`.`contentHash`')} = ${table.draftContentHash}
      and ${sql.raw('`a`.`publicationContentHash`')} = ${table.publicationContentHash}
      and ${sql.raw('`a`.`evidenceSnapshotHash`')} = ${table.evidenceSnapshotHash}
      and ${sql.raw('`e`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`c`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`c`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`e`.`jobId`')} = ${sql.raw('`d`.`jobId`')}
      and ${sql.raw('`e`.`draftId`')} = ${table.draftId}
      and ${sql.raw('`e`.`evidenceSnapshotHash`')} = ${table.evidenceSnapshotHash}
      and ${sql.raw('`d`.`version`')} = ${table.draftVersion}
      and ${sql.raw('`d`.`contentHash`')} = ${table.draftContentHash}
      and ${sql.raw('`t`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`t`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`t`.`configurationFingerprint`')} = ${table.targetConfigurationFingerprint}
      and ${sql.raw('`t`.`status`')} = 'active'
      and ${sql.raw('`t`.`executionEnabled`')} = 1
      and (
        (${sql.raw('`t`.`id`')} = ${sql.raw('`e`.`publicationTargetId`')} and ${sql.raw('`e`.`publicationIdentityFingerprint`')} = ${table.publicationIdentityFingerprint} and ${sql.raw('`e`.`publicationContentHash`')} = ${table.publicationContentHash} and ${sql.raw('`a`.`publicationId`')} = concat('publication-', ${sql.raw('`e`.`id`')}) and ${sql.raw('`a`.`publicationSlug`')} = ${sql.raw('`e`.`publicationSlug`')} and ${sql.raw('`a`.`publicationPath`')} = ${sql.raw('`e`.`publicationPath`')})
        or (${sql.raw('`t`.`id`')} <> ${sql.raw('`e`.`publicationTargetId`')} and exists (
          select 1 from ${sql.raw('`contentOperationCalendarEntryTargets` as `b`')}
          where ${sql.raw('`b`.`ownerUserId`')} = ${table.ownerUserId}
            and ${sql.raw('`b`.`clientId`')} = ${table.clientId}
            and ${sql.raw('`b`.`entryId`')} = ${table.entryId}
            and ${sql.raw('`b`.`targetId`')} = ${table.targetId}
        ))
      )
      and ${sql.raw('`a`.`receiptFingerprint`')} = ${receiptFingerprint}
      and ${sql.raw('`a`.`completedAt`')} = ${deliveredAt}
      and ${sql.raw('`a`.`completedAt`')} >= ${table.dispatchStartedAt}
      and ${sql.raw('`a`.`completedAt`')} <= ${clock}
  )`
}

function currentDeliveredAttempt(table: typeof learningPublicationActions, now: Date) {
  const clock = guardClock(now)
  return sql`exists (
    select 1 from ${sql.raw('`contentOperationPublicationAttempts` as `a`')}
    inner join ${sql.raw('`contentOperationRuns` as `r`')} on ${sql.raw('`r`.`id`')} = ${sql.raw('`a`.`runId`')}
    inner join ${sql.raw('`contentOperationCalendarEntries` as `e`')} on ${sql.raw('`e`.`id`')} = ${sql.raw('`a`.`entryId`')}
    inner join ${sql.raw('`contentOperationCalendars` as `c`')} on ${sql.raw('`c`.`id`')} = ${sql.raw('`e`.`calendarId`')}
    inner join ${sql.raw('`contentOperationPublicationTargets` as `t`')} on ${sql.raw('`t`.`id`')} = ${sql.raw('`a`.`targetId`')}
    inner join ${sql.raw('`seoGeoContentDrafts` as `d`')} on ${sql.raw('`d`.`id`')} = ${sql.raw('`e`.`draftId`')}
    where ${sql.raw('`a`.`id`')} = ${table.attemptId}
      and ${sql.raw('`a`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`a`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`a`.`entryId`')} = ${table.entryId}
      and ${sql.raw('`a`.`runId`')} = ${table.runId}
      and ${sql.raw('`r`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`r`.`entryId`')} = ${table.entryId}
      and ${sql.raw('`r`.`stage`')} = 'publication'
      and ${sql.raw('`r`.`state`')} in ('succeeded', 'retry_wait', 'blocked', 'failed')
      and ${sql.raw('`a`.`targetId`')} = ${table.targetId}
      and ${sql.raw('`a`.`mode`')} = 'execute'
      and ${sql.raw('`a`.`status`')} = 'delivered'
      and ${sql.raw('`a`.`contentHash`')} = ${table.draftContentHash}
      and ${sql.raw('`a`.`publicationContentHash`')} = ${table.publicationContentHash}
      and ${sql.raw('`a`.`evidenceSnapshotHash`')} = ${table.evidenceSnapshotHash}
      and ${sql.raw('`e`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`c`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`c`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`e`.`jobId`')} = ${sql.raw('`d`.`jobId`')}
      and ${sql.raw('`e`.`draftId`')} = ${table.draftId}
      and ${sql.raw('`e`.`evidenceSnapshotHash`')} = ${table.evidenceSnapshotHash}
      and ${sql.raw('`d`.`version`')} = ${table.draftVersion}
      and ${sql.raw('`d`.`contentHash`')} = ${table.draftContentHash}
      and ${sql.raw('`t`.`ownerUserId`')} = ${table.ownerUserId}
      and ${sql.raw('`t`.`clientId`')} = ${table.clientId}
      and ${sql.raw('`t`.`configurationFingerprint`')} = ${table.targetConfigurationFingerprint}
      and ${sql.raw('`t`.`status`')} = 'active'
      and ${sql.raw('`t`.`executionEnabled`')} = 1
      and (
        (${sql.raw('`t`.`id`')} = ${sql.raw('`e`.`publicationTargetId`')} and ${sql.raw('`e`.`publicationIdentityFingerprint`')} = ${table.publicationIdentityFingerprint} and ${sql.raw('`e`.`publicationContentHash`')} = ${table.publicationContentHash} and ${sql.raw('`a`.`publicationId`')} = concat('publication-', ${sql.raw('`e`.`id`')}) and ${sql.raw('`a`.`publicationSlug`')} = ${sql.raw('`e`.`publicationSlug`')} and ${sql.raw('`a`.`publicationPath`')} = ${sql.raw('`e`.`publicationPath`')})
        or (${sql.raw('`t`.`id`')} <> ${sql.raw('`e`.`publicationTargetId`')} and exists (
          select 1 from ${sql.raw('`contentOperationCalendarEntryTargets` as `b`')}
          where ${sql.raw('`b`.`ownerUserId`')} = ${table.ownerUserId}
            and ${sql.raw('`b`.`clientId`')} = ${table.clientId}
            and ${sql.raw('`b`.`entryId`')} = ${table.entryId}
            and ${sql.raw('`b`.`targetId`')} = ${table.targetId}
        ))
      )
      and ${sql.raw('`a`.`receiptFingerprint`')} = ${table.receiptFingerprint}
      and ${sql.raw('`a`.`completedAt`')} = ${table.deliveredAt}
      and ${sql.raw('`a`.`completedAt`')} >= ${table.dispatchStartedAt}
      and ${sql.raw('`a`.`completedAt`')} <= ${clock}
  )`
}

function createRepository(database: Database): LiveActionRepository {
  const get = async (ownerUserId: number, id: number) => {
    const [row] = await database.select().from(learningPublicationActions).where(and(eq(learningPublicationActions.ownerUserId, ownerUserId), eq(learningPublicationActions.id, id))).limit(1)
    return row || null
  }
  return {
    get,
    async findByAttempt(ownerUserId, attemptId) {
      const [row] = await database.select().from(learningPublicationActions).where(and(eq(learningPublicationActions.ownerUserId, ownerUserId), eq(learningPublicationActions.attemptId, attemptId))).limit(1)
      return row || null
    },
    list(ownerUserId, limit = 50) {
      if (!bounded(ownerUserId, Number.MAX_SAFE_INTEGER) || !bounded(limit, 100)) throw new Error('invalid live action list')
      return database.select().from(learningPublicationActions).where(eq(learningPublicationActions.ownerUserId, ownerUserId)).orderBy(asc(learningPublicationActions.createdAt), asc(learningPublicationActions.id)).limit(limit)
    },
    async reserve(input) {
      if (![input.inputFingerprint, input.draftContentHash, input.evidenceSnapshotHash, input.publicationContentHash, input.publicationIdentityFingerprint, input.targetConfigurationFingerprint, input.publicationUrlHash, input.authorizationFingerprint, input.sourceFingerprint].every(sha256) || ![input.ownerUserId, input.clientId, input.authorizationId, input.entryId, input.attemptId, input.runId, input.targetId, input.draftId, input.draftVersion].every(value => bounded(value, Number.MAX_SAFE_INTEGER)) || !safeTime(input.expiresAt)) throw new Error('invalid live action identity')
      let replayed = false
      try { await database.insert(learningPublicationActions).values(input) } catch (error) {
        if (!duplicate(error)) throw error
        replayed = true
      }
      const row = await this.findByAttempt(input.ownerUserId, input.attemptId)
      if (!row) throw new Error('live action reservation unavailable')
      if (row.inputFingerprint !== input.inputFingerprint) throw new Error('live action identity collision')
      return { row, replayed }
    },
    async saveBefore(lease, now, input, publicationLease) {
      const t = learningPublicationActions
      if (!safeTime(now) || !safeTime(input.beforeCapturedAt) || !lease.leaseToken || !publicationLease.leaseToken) return null
      const result = await database.update(t).set({ beforeProjection: input.beforeProjection, plannedAction: input.plannedAction, beforeCapturedAt: input.beforeCapturedAt, status: 'before_ready', reasonCode: null }).where(and(
        eq(t.ownerUserId, lease.ownerUserId), eq(t.id, lease.id), eq(t.status, 'capturing_before'), eq(t.leaseToken, lease.leaseToken), eq(t.leaseVersion, lease.leaseVersion), sql`${t.leaseExpiresAt} > ${guardClock(now)}`, sql`${t.expiresAt} > ${guardClock(now)}`, sql`${input.beforeCapturedAt} <= ${guardClock(now)}`,
        activePublicationLease(t, publicationLease.runId, publicationLease.leaseToken, now),
      ))
      return affected(result) === 1 ? get(lease.ownerUserId, lease.id) : null
    },
    async markDispatch(ownerUserId, id, leaseVersion, now, publicationLease) {
      const t = learningPublicationActions
      if (!safeTime(now) || !bounded(publicationLease.runId, Number.MAX_SAFE_INTEGER) || !publicationLease.leaseToken) return null
      const clock = guardClock(now)
      const result = await database.update(t).set({ status: 'dispatch_started', dispatchStartedAt: clock, nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null }).where(and(
        eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.leaseVersion, leaseVersion), eq(t.status, 'before_ready'), isNull(t.dispatchStartedAt),
        isNotNull(t.expectedProjection), isNotNull(t.beforeProjection), isNotNull(t.plannedAction), sql`${t.leaseExpiresAt} > ${clock}`, sql`${t.expiresAt} > ${clock}`,
        activePublicationLease(t, publicationLease.runId, publicationLease.leaseToken, now),
      ))
      return affected(result) === 1 ? get(ownerUserId, id) : null
    },
    async attachReceipt(ownerUserId, id, input, now) {
      const t = learningPublicationActions
      if (!sha256(input.inputFingerprint) || !sha256(input.receiptFingerprint) || !safeTime(input.deliveredAt) || !safeTime(now)) return null
      const current = await get(ownerUserId, id)
      if (!current) return null
      if ((current.status === 'awaiting_after' || current.status === 'observed') && current.receiptFingerprint === input.receiptFingerprint && current.deliveredAt?.getTime() === input.deliveredAt.getTime()) {
        const [verified] = await database.select({ id: t.id }).from(t).where(and(
          eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.inputFingerprint, input.inputFingerprint), eq(t.status, current.status),
          eq(t.receiptFingerprint, input.receiptFingerprint), eq(t.deliveredAt, input.deliveredAt), matchingDeliveredAttempt(t, now, input.receiptFingerprint, input.deliveredAt),
        )).limit(1)
        return verified ? current : null
      }
      const result = await database.update(t).set({ status: 'awaiting_after', receiptFingerprint: input.receiptFingerprint, deliveredAt: input.deliveredAt, nextAttemptAt: now, reasonCode: null }).where(and(
        eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.inputFingerprint, input.inputFingerprint), eq(t.status, 'dispatch_started'), sql`${t.expiresAt} > ${guardClock(now)}`,
        matchingDeliveredAttempt(t, now, input.receiptFingerprint, input.deliveredAt),
      ))
      return affected(result) === 1 ? get(ownerUserId, id) : null
    },
    async claimAfter(ownerUserId, id, expectedVersion, token, now, expiresAt) {
      const t = learningPublicationActions
      if (!safeTime(now) || !safeTime(expiresAt) || expiresAt <= now || !token || token.length > 96) return null
      const eligible = or(
        and(eq(t.status, 'awaiting_after'), lte(t.nextAttemptAt, guardClock(now)), or(isNull(t.leaseToken), sql`${t.leaseExpiresAt} <= ${guardClock(now)}`)),
        and(eq(t.status, 'capturing_after'), or(isNull(t.leaseExpiresAt), sql`${t.leaseExpiresAt} <= ${guardClock(now)}`)),
      )
      const result = await database.update(t).set({ status: 'capturing_after', leaseToken: token, leaseVersion: expectedVersion + 1, leaseExpiresAt: expiresAt, afterAttemptCount: sql`${t.afterAttemptCount} + 1`, nextAttemptAt: null }).where(and(
        eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.leaseVersion, expectedVersion), eligible, sql`${t.expiresAt} > ${guardClock(now)}`, sql`${expiresAt} <= ${t.expiresAt}`, sql`${expiresAt} > ${guardClock(now)}`, lte(t.afterAttemptCount, 5),
        currentDeliveredAttempt(t, now),
      ))
      return affected(result) === 1 ? get(ownerUserId, id) : null
    },
    async finishAfter(lease, now, input) {
      const t = learningPublicationActions
      if (!safeTime(now) || (input.status === 'observed' && (!input.afterProjection || !input.afterCapturedAt || !input.evidenceFingerprint || input.reasonCode !== null || input.nextAttemptAt !== null)) || (input.status === 'awaiting_after' && (!input.nextAttemptAt || input.afterProjection !== null || input.afterCapturedAt !== null || input.evidenceFingerprint !== null)) || (input.status === 'blocked' && (input.nextAttemptAt !== null || input.afterProjection !== null && !input.evidenceFingerprint)) || (input.afterCapturedAt !== null && (!safeTime(input.afterCapturedAt) || input.afterCapturedAt > now)) || (input.evidenceFingerprint !== null && !sha256(input.evidenceFingerprint))) return null
      const result = await database.update(t).set({ status: input.status, afterProjection: input.afterProjection, afterCapturedAt: input.afterCapturedAt, evidenceFingerprint: input.evidenceFingerprint, reasonCode: input.reasonCode, nextAttemptAt: input.status === 'awaiting_after' ? input.nextAttemptAt : null, leaseToken: null, leaseExpiresAt: null }).where(and(
        eq(t.ownerUserId, lease.ownerUserId), eq(t.id, lease.id), eq(t.status, 'capturing_after'), eq(t.leaseToken, lease.leaseToken), eq(t.leaseVersion, lease.leaseVersion), sql`${t.leaseExpiresAt} > ${guardClock(now)}`, sql`${t.expiresAt} > ${guardClock(now)}`,
        currentDeliveredAttempt(t, now),
      ))
      return affected(result) === 1 ? get(lease.ownerUserId, lease.id) : null
    },
    async review(ownerUserId, id, evidenceFingerprint, decision, reviewFingerprint, reviewReasonHash, now) {
      const t = learningPublicationActions
      if (![evidenceFingerprint, reviewFingerprint, reviewReasonHash].every(sha256) || !safeTime(now)) return null
      const result = await database.update(t).set({ reviewStatus: decision, reviewFingerprint, reviewEvidenceFingerprint: evidenceFingerprint, reviewReasonHash, reviewedAt: now }).where(and(
        eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.status, 'observed'), eq(t.reviewStatus, 'pending'), eq(t.evidenceFingerprint, evidenceFingerprint), sql`${t.expiresAt} > ${guardClock(now)}`,
      ))
      return affected(result) === 1 ? get(ownerUserId, id) : null
    },
    async clear(ownerUserId, id, expectedVersion, now, reasonCode) {
      if (!safeTime(now) || !/^[A-Z0-9_]{1,80}$/.test(reasonCode)) return false
      const t = learningPublicationActions
      const result = await database.update(t).set({ expectedProjection: null, beforeProjection: null, afterProjection: null, plannedAction: null, status: 'expired', reasonCode, leaseToken: null, leaseExpiresAt: null, leaseVersion: expectedVersion + 1, nextAttemptAt: null }).where(and(eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.leaseVersion, expectedVersion), sql`${t.status} <> 'expired'`))
      return affected(result) === 1
    },
    async purgeExpired(ownerUserId, now, limit = 50) {
      if (!bounded(ownerUserId, Number.MAX_SAFE_INTEGER) || !bounded(limit, 100) || !safeTime(now)) throw new Error('invalid live action cleanup')
      const t = learningPublicationActions
      const rows = await database.select({ id: t.id, leaseVersion: t.leaseVersion }).from(t).where(and(eq(t.ownerUserId, ownerUserId), sql`${t.expiresAt} <= ${guardClock(now)}`, or(isNotNull(t.expectedProjection), isNotNull(t.beforeProjection), isNotNull(t.afterProjection), isNotNull(t.plannedAction)))).orderBy(asc(t.expiresAt), asc(t.id)).limit(limit)
      let cleared = 0
      for (const row of rows) if (await this.clear(ownerUserId, row.id, row.leaseVersion, now, 'RETENTION_EXPIRED')) cleared += 1
      return cleared
    },
    listLive(ownerUserId, offset = 0, limit = 100) {
      if (!bounded(ownerUserId, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(offset) || offset < 0 || !bounded(limit, 100)) throw new Error('invalid live action query')
      const t = learningPublicationActions
      return database.select().from(t).where(and(eq(t.ownerUserId, ownerUserId), sql`${t.expiresAt} > CURRENT_TIMESTAMP(3)`, or(isNotNull(t.expectedProjection), isNotNull(t.beforeProjection), isNotNull(t.afterProjection), isNotNull(t.plannedAction)))).orderBy(asc(t.id)).limit(limit).offset(offset)
    },
    async countLive(ownerUserId) {
      if (!bounded(ownerUserId, Number.MAX_SAFE_INTEGER)) throw new Error('invalid live action owner')
      const t = learningPublicationActions
      const [row] = await database.select({ count: count() }).from(t).where(and(eq(t.ownerUserId, ownerUserId), sql`${t.expiresAt} > CURRENT_TIMESTAMP(3)`, or(isNotNull(t.expectedProjection), isNotNull(t.beforeProjection), isNotNull(t.afterProjection), isNotNull(t.plannedAction))))
      return Number(row?.count || 0)
    },
  }
}

export class DrizzleLiveActionRepository implements LiveActionRepository {
  private readonly repository: LiveActionRepository
  constructor(database?: Database) {
    const shared = database || getDatabase()
    if (!shared) throw new Error('live action database unavailable')
    this.repository = createRepository(shared)
  }
  get(...args: Parameters<LiveActionRepository['get']>) { return this.repository.get(...args) }
  findByAttempt(...args: Parameters<LiveActionRepository['findByAttempt']>) { return this.repository.findByAttempt(...args) }
  list(...args: Parameters<LiveActionRepository['list']>) { return this.repository.list(...args) }
  reserve(...args: Parameters<LiveActionRepository['reserve']>) { return this.repository.reserve(...args) }
  saveBefore(...args: Parameters<LiveActionRepository['saveBefore']>) { return this.repository.saveBefore(...args) }
  markDispatch(...args: Parameters<LiveActionRepository['markDispatch']>) { return this.repository.markDispatch(...args) }
  attachReceipt(...args: Parameters<LiveActionRepository['attachReceipt']>) { return this.repository.attachReceipt(...args) }
  claimAfter(...args: Parameters<LiveActionRepository['claimAfter']>) { return this.repository.claimAfter(...args) }
  finishAfter(...args: Parameters<LiveActionRepository['finishAfter']>) { return this.repository.finishAfter(...args) }
  review(...args: Parameters<LiveActionRepository['review']>) { return this.repository.review(...args) }
  clear(...args: Parameters<LiveActionRepository['clear']>) { return this.repository.clear(...args) }
  purgeExpired(...args: Parameters<LiveActionRepository['purgeExpired']>) { return this.repository.purgeExpired(...args) }
  listLive(...args: Parameters<LiveActionRepository['listLive']>) { return this.repository.listLive(...args) }
  countLive(...args: Parameters<LiveActionRepository['countLive']>) { return this.repository.countLive(...args) }
}

export { activePublicationLease, createRepository as createLiveActionRepositoryForTest, matchingDeliveredAttempt, currentDeliveredAttempt }
