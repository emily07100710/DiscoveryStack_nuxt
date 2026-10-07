import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createManagedSiteEmailOutboxRepository } from '../server/managed-sites/email-outbox/repository'
import { createEmailManualReviewRepository } from '../server/managed-sites/email-review/repository'
import { emailManualReviewVersion } from '../server/managed-sites/email-review/model'
import type { EmailManualReviewCommand, EmailManualReviewReason, EmailManualReviewSnapshot } from '../server/managed-sites/email-review/types'

const enabled = process.env.DS_RUN_MANAGED_SITE_EMAIL_REVIEW_MYSQL_INTEGRATION === '1'
const testUrl = process.env.DS_MANAGED_SITE_EMAIL_REVIEW_MYSQL_TEST_URL || ''
const NOW = new Date('2026-10-07T12:00:00.123Z')
const TEST_CIPHERTEXT = 'synthetic-review-ciphertext-only'
const HASHES: readonly [string, string, string, string] = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)]
let pool: mysql.Pool
let database: MySql2Database<Record<string, unknown>>
const createdOutboxIds: string[] = []

function repository() {
  return createEmailManualReviewRepository(database as Parameters<typeof createEmailManualReviewRepository>[0])
}

function outboxRepository() {
  return createManagedSiteEmailOutboxRepository(database as Parameters<typeof createManagedSiteEmailOutboxRepository>[0])
}

async function insertOutbox(input: {
  ownerUserId?: number | null
  projectId?: number | null
  status?: 'queued' | 'processing' | 'reconcile_pending' | 'accepted' | 'cancelled' | 'manual_required'
  leaseToken?: string | null
  leaseExpiresAt?: Date | null
  acceptedAt?: Date | null
  providerReceiptId?: string | null
  attemptCount?: number
} = {}) {
  const id = randomUUID()
  createdOutboxIds.push(id)
  await pool.execute(
    'INSERT INTO managedSiteEmailOutbox (id, ownerUserId, projectId, purpose, idempotencyKey, authorityFingerprint, payloadFingerprint, contextFingerprint, providerConfigurationFingerprint, encryptedPayload, status, attemptCount, firstAttemptAt, nextAttemptAt, expiresAt, leaseToken, leaseExpiresAt, safeCode, providerReceiptId, acceptedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.ownerUserId === undefined ? 71 : input.ownerUserId, input.projectId === undefined ? null : input.projectId, 'customer_reaccess', `synthetic-review:${randomUUID()}`, HASHES[0], HASHES[1], HASHES[2], HASHES[3], TEST_CIPHERTEXT, input.status || 'manual_required', input.attemptCount ?? 2, new Date(NOW.getTime() - 1000), NOW, new Date(NOW.getTime() + 60_000), input.leaseToken ?? null, input.leaseExpiresAt ?? null, 'retry_window_expired', input.providerReceiptId ?? null, input.acceptedAt ?? null],
  )
  return id
}

async function exactOutboxRow(id: string): Promise<Record<string, unknown>> {
  const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM managedSiteEmailOutbox WHERE id = ?', [id])
  if (rows.length !== 1) throw new Error('Synthetic outbox fixture was not found')
  return Object.fromEntries(Object.entries(rows[0]!).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]))
}

async function waitForOutboxLockWait(timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS `waiting` FROM performance_schema.data_lock_waits AS waits INNER JOIN performance_schema.data_locks AS requested ON waits.REQUESTING_ENGINE_LOCK_ID = requested.ENGINE_LOCK_ID AND waits.ENGINE = requested.ENGINE WHERE requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = 'managedSiteEmailOutbox'")
    if (Number(rows[0]?.waiting) > 0) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  return false
}

async function versionFor(id: string): Promise<string> {
  const row = await outboxRepository().getById(id)
  if (!row) throw new Error('Synthetic outbox fixture was not found')
  const snapshot: EmailManualReviewSnapshot = {
    id: row.id,
    purpose: row.purpose,
    status: row.status,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    attemptCount: row.attemptCount,
    lastErrorCode: row.safeCode,
  }
  const version = emailManualReviewVersion(snapshot)
  if (!version) throw new Error('Synthetic manual-review snapshot was not eligible')
  return version
}

function command(itemId: string, expectedVersion: string, requestId = randomUUID(), reason: EmailManualReviewReason = 'reviewed_no_resend'): EmailManualReviewCommand {
  return { itemId, expectedVersion, requestId, reason, confirmNoResend: true }
}

describe.skipIf(!enabled || !testUrl)('isolated managed site email review MySQL integration (never production)', () => {
  beforeAll(async () => {
    const url = new URL(testUrl)
    // Explicit opt-in plus a narrowly named loopback database; never fall back to DATABASE_URL.
    if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !/^\/ds_managed_site_email_review_[a-z0-9_]+$/u.test(url.pathname) || url.search || url.hash) throw new Error('Only an isolated loopback email-review rehearsal database is permitted')
    pool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: 'Z', connectionLimit: 8 })
    database = drizzle(pool)
    for (const file of ['0046_managed_email_outbox_v1.sql', '0049_managed_email_manual_review_v1.sql']) {
      const source = readFileSync(new URL(`../server/database/migrations/${file}`, import.meta.url), 'utf8')
      for (const statement of source.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await pool.query(statement)
    }
  })

  afterAll(async () => {
    if (pool && createdOutboxIds.length) {
      const placeholders = createdOutboxIds.map(() => '?').join(',')
      await pool.execute(`DELETE FROM managedSiteEmailManualReviews WHERE outboxId IN (${placeholders})`, createdOutboxIds)
      await pool.execute(`DELETE FROM managedSiteEmailOutbox WHERE id IN (${placeholders})`, createdOutboxIds)
    }
    await pool?.end()
  })

  it('installs the exact six-column ledger and expected primary/unique/owner-time indexes in MySQL', async () => {
    const [columns] = await pool.query<mysql.RowDataPacket[]>("SELECT COLUMN_NAME AS `columnName`, DATA_TYPE AS `dataType`, COLUMN_TYPE AS `columnType`, DATETIME_PRECISION AS `datetimePrecision`, IS_NULLABLE AS `isNullable` FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'managedSiteEmailManualReviews' ORDER BY ordinal_position")
    expect(columns.map(column => column.columnName)).toEqual(['outboxId', 'ownerUserId', 'requestId', 'outboxVersion', 'reason', 'closedAt'])
    expect(columns.map(column => column.isNullable)).toEqual(['NO', 'NO', 'NO', 'NO', 'NO', 'NO'])
    expect(columns.find(column => column.columnName === 'closedAt')).toMatchObject({ dataType: 'datetime', datetimePrecision: 3 })
    expect(columns.find(column => column.columnName === 'reason')?.columnType).toBe("enum('reviewed_no_resend','handled_outside_platform')")

    const [indexes] = await pool.query<mysql.RowDataPacket[]>("SELECT INDEX_NAME AS `indexName`, NON_UNIQUE AS `nonUnique`, SEQ_IN_INDEX AS `seqInIndex`, COLUMN_NAME AS `columnName` FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'managedSiteEmailManualReviews' ORDER BY index_name, seq_in_index")
    const grouped = new Map<string, mysql.RowDataPacket[]>()
    for (const index of indexes) grouped.set(String(index.indexName), [...(grouped.get(String(index.indexName)) || []), index])
    expect([...grouped.keys()].sort()).toEqual(['PRIMARY', 'managed_email_review_owner_idx', 'managed_email_review_request_uq'])
    expect(grouped.get('PRIMARY')?.map(index => index.columnName)).toEqual(['outboxId'])
    expect(grouped.get('managed_email_review_request_uq')?.map(index => index.columnName)).toEqual(['ownerUserId', 'requestId'])
    expect(grouped.get('managed_email_review_request_uq')?.every(index => Number(index.nonUnique) === 0)).toBe(true)
    expect(grouped.get('managed_email_review_owner_idx')?.map(index => index.columnName)).toEqual(['ownerUserId', 'closedAt', 'outboxId'])
  })

  it('closes an owned null-project reaccess row, replays immutably, and does not mutate any outbox column', async () => {
    const id = await insertOutbox({ ownerUserId: 71, projectId: null, acceptedAt: NOW, providerReceiptId: randomUUID() })
    const before = await exactOutboxRow(id)
    const requestId = randomUUID()
    const first = await repository().close({ ownerUserId: 71, command: command(id, await versionFor(id), requestId), closedAt: NOW })
    expect(first).toMatchObject({ status: 'recorded', record: { outboxId: id, ownerUserId: 71, requestId, reason: 'reviewed_no_resend', closedAt: NOW } })
    const replayed = await repository().close({ ownerUserId: 71, command: command(id, await versionFor(id), requestId), closedAt: new Date(NOW.getTime() + 9000) })
    expect(first.status).toBe('recorded')
    if (first.status !== 'recorded') throw new Error('Expected first synthetic closure to be recorded')
    expect(replayed).toEqual({ status: 'replayed', record: first.record })
    expect(await exactOutboxRow(id)).toEqual(before)
    const serialized = JSON.stringify([first, replayed])
    for (const forbidden of [TEST_CIPHERTEXT, 'idempotencyKey', 'providerReceiptId', 'payloadFingerprint', 'private@example']) expect(serialized).not.toContain(forbidden)
  })

  it('treats foreign, null-owner and missing rows identically while allowing only their actual owner', async () => {
    const owned = await insertOutbox({ ownerUserId: 71, projectId: null })
    const foreign = await insertOutbox({ ownerUserId: 72 })
    const unowned = await insertOutbox({ ownerUserId: null })
    const expectedVersion = await versionFor(owned)
    const ownedResult = await repository().close({ ownerUserId: 71, command: command(owned, expectedVersion), closedAt: NOW })
    expect(ownedResult.status).toBe('recorded')
    const inaccessible = await Promise.all([foreign, unowned, randomUUID()].map(itemId => repository().close({ ownerUserId: 71, command: command(itemId, 'a'.repeat(64)), closedAt: NOW })))
    expect(inaccessible.map(result => result.status)).toEqual(['not_found', 'not_found', 'not_found'])
  })

  it('rejects all non-manual statuses and manual rows carrying either lease field', async () => {
    for (const status of ['queued', 'processing', 'reconcile_pending', 'accepted', 'cancelled'] as const) {
      const id = await insertOutbox({ ownerUserId: 71, status })
      const result = await repository().close({ ownerUserId: 71, command: command(id, 'a'.repeat(64)), closedAt: NOW })
      expect(result.status, status).toBe('not_eligible')
    }
    for (const lease of [{ leaseToken: randomUUID() }, { leaseExpiresAt: new Date(NOW.getTime() + 5000) }]) {
      const id = await insertOutbox({ ownerUserId: 71, ...lease })
      const result = await repository().close({ ownerUserId: 71, command: command(id, await versionFor(id)), closedAt: NOW })
      expect(result.status).toBe('not_eligible')
    }
  })

  it('makes same-item and owner-global request collisions immutable', async () => {
    const id = await insertOutbox({ ownerUserId: 71 })
    const other = await insertOutbox({ ownerUserId: 71 })
    const version = await versionFor(id)
    const requestId = randomUUID()
    const first = await repository().close({ ownerUserId: 71, command: command(id, version, requestId), closedAt: NOW })
    expect(first.status).toBe('recorded')
    const [reviewBefore] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM managedSiteEmailManualReviews WHERE outboxId = ?', [id])
    expect((await repository().close({ ownerUserId: 71, command: command(id, version, requestId, 'handled_outside_platform'), closedAt: NOW })).status).toBe('conflict')
    expect((await repository().close({ ownerUserId: 71, command: command(id, version), closedAt: NOW })).status).toBe('conflict')
    expect((await repository().close({ ownerUserId: 71, command: command(other, await versionFor(other), requestId), closedAt: NOW })).status).toBe('conflict')
    const [reviewAfter] = await pool.execute<mysql.RowDataPacket[]>('SELECT * FROM managedSiteEmailManualReviews WHERE outboxId = ?', [id])
    expect(reviewAfter).toEqual(reviewBefore)
    expect((await pool.query('SELECT outboxId FROM managedSiteEmailManualReviews WHERE ownerUserId = ? AND requestId = ?', [71, requestId]))[0]).toHaveLength(1)
  })

  it('lets SQL uniqueness decide parallel replay and distinct-command races', async () => {
    const replayId = await insertOutbox({ ownerUserId: 71 })
    const replayCommand = command(replayId, await versionFor(replayId))
    const sameRequest = await Promise.all([1, 2].map(() => repository().close({ ownerUserId: 71, command: replayCommand, closedAt: NOW })))
    expect(sameRequest.map(result => result.status).sort()).toEqual(['recorded', 'replayed'])

    const oneClosureId = await insertOutbox({ ownerUserId: 71 })
    const version = await versionFor(oneClosureId)
    const distinctRequests = await Promise.all([randomUUID(), randomUUID()].map(requestId => repository().close({ ownerUserId: 71, command: command(oneClosureId, version, requestId), closedAt: NOW })))
    expect(distinctRequests.map(result => result.status).sort()).toEqual(['conflict', 'recorded'])
    const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT outboxId FROM managedSiteEmailManualReviews WHERE outboxId = ?', [oneClosureId])
    expect(rows).toHaveLength(1)

    const globalA = await insertOutbox({ ownerUserId: 71 })
    const globalB = await insertOutbox({ ownerUserId: 71 })
    const sharedRequestId = randomUUID()
    const globalRace = await Promise.all([globalA, globalB].map(async id => repository().close({ ownerUserId: 71, command: command(id, await versionFor(id), sharedRequestId), closedAt: NOW })))
    expect(globalRace.map(result => result.status).sort()).toEqual(['conflict', 'recorded'])
  })

  it('fails closed for snapshot drift and malformed commands before creating a review', async () => {
    const staleId = await insertOutbox({ ownerUserId: 71 })
    const staleVersion = await versionFor(staleId)
    await pool.execute('UPDATE managedSiteEmailOutbox SET attemptCount = attemptCount + 1, updatedAt = ? WHERE id = ?', [new Date(NOW.getTime() + 1000), staleId])
    expect((await repository().close({ ownerUserId: 71, command: command(staleId, staleVersion), closedAt: NOW })).status).toBe('conflict')

    const invalidId = await insertOutbox({ ownerUserId: 71 })
    const valid = command(invalidId, await versionFor(invalidId))
    const malformed: unknown[] = [
      { ...valid, extra: 'ignored-fields-are-not-allowed' },
      { ...valid, requestId: 'not-a-uuid' },
      { ...valid, expectedVersion: 'not-a-hash' },
      { ...valid, reason: 'sent_successfully' },
      { ...valid, confirmNoResend: false },
    ]
    for (const value of malformed) await expect(repository().close({ ownerUserId: 71, command: value as EmailManualReviewCommand, closedAt: NOW })).rejects.toBeDefined()
    const [rows] = await pool.execute<mysql.RowDataPacket[]>('SELECT outboxId FROM managedSiteEmailManualReviews WHERE outboxId IN (?, ?)', [staleId, invalidId])
    expect(rows).toHaveLength(0)
  })

  it('rolls a real SQL review insert back when the enclosing transaction fails', async () => {
    const id = await insertOutbox({ ownerUserId: 71, acceptedAt: NOW, providerReceiptId: randomUUID() })
    const before = await exactOutboxRow(id)
    const expectedVersion = await versionFor(id)
    const rollbackDatabase = {
      transaction: (callback: (transaction: unknown) => Promise<unknown>) => database.transaction(async transaction => {
        await callback(transaction)
        throw new Error('synthetic-email-review-rollback')
      }),
    } as unknown as Parameters<typeof createEmailManualReviewRepository>[0]
    const rollbackRepository = createEmailManualReviewRepository(rollbackDatabase)

    await expect(rollbackRepository.close({ ownerUserId: 71, command: command(id, expectedVersion), closedAt: NOW })).rejects.toThrow('synthetic-email-review-rollback')
    const [reviews] = await pool.execute<mysql.RowDataPacket[]>('SELECT outboxId FROM managedSiteEmailManualReviews WHERE outboxId = ?', [id])
    expect(reviews).toHaveLength(0)
    expect(await exactOutboxRow(id)).toEqual(before)
  })

  it('rechecks a snapshot after waiting for a real MySQL row lock and refuses the stale command', async () => {
    const id = await insertOutbox({ ownerUserId: 71 })
    const before = await exactOutboxRow(id)
    const expectedVersion = await versionFor(id)
    const changedAt = new Date(NOW.getTime() + 5000)
    const connection = await pool.getConnection()
    let transactionOpen = false
    let closePromise: ReturnType<ReturnType<typeof repository>['close']> | null = null
    let result: Awaited<ReturnType<ReturnType<typeof repository>['close']>> | null = null
    let observedLockWait = false
    try {
      await connection.beginTransaction()
      transactionOpen = true
      await connection.execute('SELECT id FROM managedSiteEmailOutbox WHERE id = ? FOR UPDATE', [id])
      closePromise = repository().close({ ownerUserId: 71, command: command(id, expectedVersion), closedAt: NOW })
      observedLockWait = await waitForOutboxLockWait()
      await connection.execute('UPDATE managedSiteEmailOutbox SET attemptCount = attemptCount + 1, updatedAt = ? WHERE id = ?', [changedAt, id])
      await connection.commit()
      transactionOpen = false
      result = await closePromise
    } finally {
      if (transactionOpen) await connection.rollback()
      connection.release()
      if (closePromise && result === null) await closePromise.catch(() => undefined)
    }
    expect(observedLockWait).toBe(true)
    expect(result?.status).toBe('conflict')
    const [reviews] = await pool.execute<mysql.RowDataPacket[]>('SELECT outboxId FROM managedSiteEmailManualReviews WHERE outboxId = ?', [id])
    expect(reviews).toHaveLength(0)
    const after = await exactOutboxRow(id)
    expect(after).toEqual({ ...before, attemptCount: Number(before.attemptCount) + 1, updatedAt: changedAt.toISOString() })
  })

  it('lists a bounded exact owner projection without exposing request or outbox-private data', async () => {
    const owned: string[] = []
    for (let i = 0; i < 50; i++) {
      const id = await insertOutbox({ ownerUserId: 71, projectId: null })
      owned.push(id)
      await repository().close({ ownerUserId: 71, command: command(id, await versionFor(id)), closedAt: new Date(NOW.getTime() + i) })
    }
    const foreignId = await insertOutbox({ ownerUserId: 72 })
    await repository().close({ ownerUserId: 72, command: command(foreignId, await versionFor(foreignId)), closedAt: NOW })
    const mixed = await repository().listOwnerReviews({ ownerUserId: 71, outboxIds: [...owned.slice(0, 49), foreignId] })
    expect(mixed).toHaveLength(49)
    expect(mixed.every(row => row.ownerUserId === 71 && owned.includes(row.outboxId))).toBe(true)
    const result = await repository().listOwnerReviews({ ownerUserId: 71, outboxIds: owned })
    expect(result).toHaveLength(50)
    expect(result.every(row => row.ownerUserId === 71 && owned.includes(row.outboxId))).toBe(true)
    const serialized = JSON.stringify(result)
    for (const forbidden of [TEST_CIPHERTEXT, 'idempotencyKey', 'encryptedPayload', 'providerReceiptId', 'payloadFingerprint', 'private@example']) expect(serialized).not.toContain(forbidden)
    await expect(repository().listOwnerReviews({ ownerUserId: 71, outboxIds: [...owned, randomUUID()] })).rejects.toBeDefined()
  })
})
