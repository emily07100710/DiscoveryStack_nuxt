import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { DrizzleLiveActionRepository } from '../server/learning-loop/live-action-repository'
import type { LivePublicationAction } from '../server/learning-loop/live-action-repository'

const dialect = new MySqlDialect()
const now = new Date('2026-10-07T00:00:00.000Z')
const sha = (char: string) => char.repeat(64)

function action(overrides: Partial<LivePublicationAction> = {}): LivePublicationAction {
  return {
    id: 31, ownerUserId: 7, clientId: 8, authorizationId: 10, entryId: 21, attemptId: 25, runId: 24, targetId: 12, draftId: 18, draftVersion: 3,
    inputFingerprint: sha('a'), draftContentHash: sha('b'), evidenceSnapshotHash: sha('c'), publicationContentHash: sha('d'), publicationIdentityFingerprint: sha('e'), targetConfigurationFingerprint: sha('f'), publicationUrlHash: sha('1'), authorizationFingerprint: sha('2'), sourceFingerprint: sha('3'),
    expectedProjection: { titleHash: sha('4') }, beforeProjection: { titleHash: sha('5') }, afterProjection: null, plannedAction: { changeCount: 2 },
    status: 'before_ready', reasonCode: null, dispatchStartedAt: null, beforeCapturedAt: now, deliveredAt: null, afterCapturedAt: null, nextAttemptAt: null,
    receiptFingerprint: null, evidenceFingerprint: null, afterAttemptCount: 0, leaseToken: 'action-lease', leaseVersion: 4, leaseExpiresAt: new Date(now.getTime() + 60_000), expiresAt: new Date(now.getTime() + 86_400_000),
    reviewStatus: 'pending', reviewFingerprint: null, reviewEvidenceFingerprint: null, reviewReasonHash: null, reviewedAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  }
}

function fakeDatabase(row: LivePublicationAction, affectedRows = 1) {
  const updates: Array<{ values: Record<string, unknown>; whereSql: string }> = []
  const inserts: Array<Record<string, unknown>> = []
  const selects: string[] = []
  let selectionRows: unknown[] = [row]
  const database = {
    insert() {
      return { async values(value: Record<string, unknown>) {
        inserts.push(value)
        if (inserts.length > 1) { const error = new Error('duplicate'); Object.assign(error, { code: 'ER_DUP_ENTRY' }); throw error }
      } }
    },
    select() {
      return {
        from() {
          return {
            where(query: any) {
              selects.push(dialect.sqlToQuery(query).sql)
              return {
                orderBy() { return this },
                limit() { return Promise.resolve(selectionRows) },
                offset() { return this },
              }
            },
          }
        }
      }
    },
    update() {
      return { set(values: Record<string, unknown>) {
        return { async where(query: any) { updates.push({ values, whereSql: dialect.sqlToQuery(query).sql }); return [{ affectedRows }] } }
      } }
    },
  }
  return { database: database as any, updates, inserts, selects, setRows(rows: unknown[]) { selectionRows = rows } }
}

const publicationLease = { runId: 24, leaseToken: 'publication-lease' }
const actionLease = { ownerUserId: 7, id: 31, leaseToken: 'action-lease', leaseVersion: 4 }

describe('learning live publication action repository SQL fences', () => {
  it('saves before projection only under both active leases and the exact planned execute identity', async () => {
    const db = fakeDatabase(action())
    const repository = new DrizzleLiveActionRepository(db.database)
    const result = await repository.saveBefore(actionLease, now, { beforeProjection: { bodyHash: sha('5') }, plannedAction: { changed: 1 }, beforeCapturedAt: now }, publicationLease)
    expect(result?.id).toBe(31)
    const query = db.updates[0]!.whereSql
    for (const exactGuard of ['`status` = ?', '`leaseToken` = ?', '`leaseVersion` = ?', 'CURRENT_TIMESTAMP(3)', '`r`.`stage`', '`r`.`state`', '`r`.`leaseOwner`', '`r`.`leaseExpiresAt`', '`a`.`mode`', '`a`.`status`', '`a`.`publicationId`', '`a`.`publicationSlug`', '`a`.`publicationPath`', '`a`.`publicationContentHash`', '`a`.`evidenceSnapshotHash`', '`e`.`publicationIdentityFingerprint`', '`d`.`version`', '`t`.`configurationFingerprint`', '`t`.`status`', '`t`.`executionEnabled`']) expect(query).toContain(exactGuard)
    expect(query).toContain('`t`.`id` <> `e`.`publicationTargetId`')
    expect(query).toContain('`b`.`ownerUserId`')
    expect(query).toContain('`b`.`clientId`')
    expect(query).toContain('`b`.`entryId`')
    expect(query).toContain('`b`.`targetId`')
    expect(query).not.toContain('`a`.`draftId`')
    expect(query).not.toContain('`a`.`jobId`')
    expect(query).not.toContain('`a`.`publicationIdentityFingerprint`')
    expect(query).not.toContain('`e`.`clientId`')
    expect(db.updates[0]!.values.status).toBe('before_ready')
  })

  it('records dispatch boundary with database wall clock and forbids dispatch without before/expected/planned projections', async () => {
    const db = fakeDatabase(action())
    const repository = new DrizzleLiveActionRepository(db.database)
    await repository.markDispatch(7, 31, 4, now, publicationLease)
    const update = db.updates[0]!
    expect(update.values.status).toBe('dispatch_started')
    expect(update.values.leaseToken).toBeNull()
    expect(update.values.leaseExpiresAt).toBeNull()
    expect(dialect.sqlToQuery(update.values.dispatchStartedAt as any).sql).toContain('greatest')
    expect(update.whereSql).toContain('`dispatchStartedAt` is null')
    expect(update.whereSql).toContain('`expectedProjection` is not null')
    expect(update.whereSql).toContain('`beforeProjection` is not null')
    expect(update.whereSql).toContain('`plannedAction` is not null')
    expect(update.whereSql).toContain('CURRENT_TIMESTAMP(3)')
    expect(update.whereSql).toContain('`a`.`status`')
  })

  it('keeps a secondary target valid through its owner/client/entry binding without comparing it to primary-only entry columns', async () => {
    const db = fakeDatabase(action({ targetId: 99, publicationIdentityFingerprint: sha('0') }))
    const repository = new DrizzleLiveActionRepository(db.database)
    await repository.saveBefore(actionLease, now, { beforeProjection: { bodyHash: sha('5') }, plannedAction: { changed: 1 }, beforeCapturedAt: now }, publicationLease)
    const query = db.updates[0]!.whereSql
    expect(query).toContain('`t`.`id` <> `e`.`publicationTargetId`')
    expect(query).toContain('`b`.`ownerUserId`')
    expect(query).toContain('`b`.`clientId`')
    expect(query).toContain('`b`.`entryId`')
    expect(query).toContain('`b`.`targetId`')
    expect(query).not.toContain('`e`.`publicationTargetId` = `learningPublicationActions`.`targetId`')
  })

  it('attaches only the exact formal delivered receipt and replays only an identical receipt', async () => {
    const db = fakeDatabase(action({ status: 'dispatch_started', dispatchStartedAt: now }))
    const repository = new DrizzleLiveActionRepository(db.database)
    const deliveredAt = new Date(now.getTime() + 250)
    await repository.attachReceipt(7, 31, { inputFingerprint: sha('a'), receiptFingerprint: sha('9'), deliveredAt }, new Date(now.getTime() + 300))
    const where = db.updates[0]!.whereSql
    expect(where).toContain('`status` = ?')
    expect(where).toContain('`inputFingerprint` = ?')
    expect(where).toContain('`a`.`status`')
    expect(where).toContain('`a`.`receiptFingerprint`')
    expect(where).toContain('`a`.`completedAt`')
    expect(where).toContain('`e`.`draftId`')
    expect(where).toContain('`d`.`version`')
    expect(where).toContain('`t`.`configurationFingerprint`')
    expect(where).toContain("`r`.`state` in ('succeeded', 'retry_wait', 'blocked', 'failed')")
    expect(where).not.toContain("`r`.`state` = 'processing'")
    expect(where).not.toContain("`r`.`state` = 'queued'")
    expect(where).not.toContain("`r`.`state` = 'cancelled'")
    expect(where).toContain('`a`.`publicationId`')
    expect(where).toContain('`a`.`publicationSlug`')
    expect(where).toContain('`a`.`publicationPath`')
    expect(where).toContain('`t`.`id` <> `e`.`publicationTargetId`')
    expect(where).not.toContain('`a`.`draftId`')
    expect(where).not.toContain('`a`.`jobId`')
    expect(where).not.toContain('`e`.`clientId`')
    expect(where).toContain('CURRENT_TIMESTAMP(3)')
    expect(db.updates[0]!.values.status).toBe('awaiting_after')
  })

  it('claims post-capture with status/version/lease/retention/receipt fences and caps attempts at six', async () => {
    const db = fakeDatabase(action({ status: 'awaiting_after', dispatchStartedAt: now, receiptFingerprint: sha('9'), deliveredAt: now, nextAttemptAt: now }))
    const repository = new DrizzleLiveActionRepository(db.database)
    await repository.claimAfter(7, 31, 4, 'worker-lease', now, new Date(now.getTime() + 20_000))
    const query = db.updates[0]!.whereSql
    expect(query).toContain('`leaseVersion` = ?')
    expect(query).toContain('`afterAttemptCount` <= ?')
    expect(query).toContain('`receiptFingerprint`')
    expect(query).toContain('`a`.`status`')
    expect(query).toContain('CURRENT_TIMESTAMP(3)')
    expect((db.updates[0]!.values.afterAttemptCount as any).queryChunks).toBeDefined()
  })

  it('finishes only with the current action lease, unexpired retention and still-matching formal receipt', async () => {
    const db = fakeDatabase(action({ status: 'capturing_after', dispatchStartedAt: now, receiptFingerprint: sha('9'), deliveredAt: now, leaseToken: 'worker-lease', leaseVersion: 5 }))
    const repository = new DrizzleLiveActionRepository(db.database)
    const result = await repository.finishAfter({ ...actionLease, leaseToken: 'worker-lease', leaseVersion: 5 }, new Date(now.getTime() + 2), { status: 'observed', afterProjection: { bodyHash: sha('6') }, afterCapturedAt: new Date(now.getTime() + 1), evidenceFingerprint: sha('8'), reasonCode: null, nextAttemptAt: null })
    expect(result?.id).toBe(31)
    const query = db.updates[0]!.whereSql
    expect(query).toContain('`status` = ?')
    expect(query).toContain('`leaseToken` = ?')
    expect(query).toContain('`leaseVersion` = ?')
    expect(query).toContain('`leaseExpiresAt`')
    expect(query).toContain('`a`.`receiptFingerprint`')
    expect(query).toContain('`a`.`completedAt`')
    expect(query).toContain('`e`.`evidenceSnapshotHash`')
    expect(query).toContain('`a`.`completedAt` >= `learningPublicationActions`.`dispatchStartedAt`')
    expect(query).toContain('`e`.`draftId`')
    expect(query).toContain('`d`.`version`')
    expect(query).toContain('`t`.`configurationFingerprint`')
    expect(query).toContain('`t`.`id` <> `e`.`publicationTargetId`')
    expect(query).not.toContain('`a`.`draftId`')
    expect(query).not.toContain('`a`.`jobId`')
    expect(query).not.toContain('`e`.`clientId`')
    expect(query).toContain('CURRENT_TIMESTAMP(3)')
    expect(db.updates[0]!.values.leaseToken).toBeNull()
  })

  it('makes owner review immutable and binds it to the exact current evidence fingerprint', async () => {
    const db = fakeDatabase(action({ status: 'observed', evidenceFingerprint: sha('8') }))
    const repository = new DrizzleLiveActionRepository(db.database)
    await repository.review(7, 31, sha('8'), 'approved', sha('7'), sha('6'), now)
    expect(db.updates[0]!.whereSql).toContain('`ownerUserId` = ?')
    expect(db.updates[0]!.whereSql).toContain('`status` = ?')
    expect(db.updates[0]!.whereSql).toContain('`reviewStatus` = ?')
    expect(db.updates[0]!.whereSql).toContain('`evidenceFingerprint` = ?')
    expect(db.updates[0]!.whereSql).toContain('CURRENT_TIMESTAMP(3)')
    expect(db.updates[0]!.values.reviewEvidenceFingerprint).toBe(sha('8'))
  })

  it('clears all private projections under owner/version CAS and bounded purge selects only expired owned rows', async () => {
    const db = fakeDatabase(action())
    const repository = new DrizzleLiveActionRepository(db.database)
    expect(await repository.clear(7, 31, 4, now, 'RETENTION_EXPIRED')).toBe(true)
    expect(db.updates[0]!.whereSql).toContain('`ownerUserId` = ?')
    expect(db.updates[0]!.whereSql).toContain('`leaseVersion` = ?')
    expect(db.updates[0]!.values).toMatchObject({ expectedProjection: null, beforeProjection: null, afterProjection: null, plannedAction: null, status: 'expired', leaseToken: null, leaseExpiresAt: null, leaseVersion: 5 })
    db.setRows([{ id: 31, leaseVersion: 5 }])
    await repository.purgeExpired(7, now, 20)
    expect(db.selects.at(-1)).toContain('`ownerUserId` = ?')
    expect(db.selects.at(-1)).toContain('`expiresAt` <= greatest(?, CURRENT_TIMESTAMP(3))')
    expect(db.updates[1]!.values.beforeProjection).toBeNull()
  })

  it('enforces unique-attempt replay and rejects a differing identity fingerprint under concurrent reservations', async () => {
    const stored = action({ status: 'capturing_before', beforeProjection: null, plannedAction: null, expectedProjection: null })
    let winner: LivePublicationAction | null = null
    const db = {
      insert() {
        return { async values(value: LivePublicationAction) {
          await Promise.resolve()
          if (winner) { const error = new Error('duplicate'); Object.assign(error, { code: 'ER_DUP_ENTRY' }); throw error }
          winner = { ...value, id: 99, createdAt: now, updatedAt: now }
        } }
      },
      select() {
        return { from() {
          return { where() { return { async limit() { return winner ? [winner] : [] } } } }
        } }
      },
    } as any
    const repository = new DrizzleLiveActionRepository(db)
    const input = { ...stored, id: undefined, createdAt: undefined, updatedAt: undefined } as any
    const results = await Promise.all([repository.reserve(input), repository.reserve(input)])
    expect(results.filter(result => result.replayed)).toHaveLength(1)
    await expect(repository.reserve({ ...input, inputFingerprint: sha('0') })).rejects.toThrow('identity collision')
  })
})
