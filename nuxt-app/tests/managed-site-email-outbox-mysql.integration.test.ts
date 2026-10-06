import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createManagedSiteEmailOutboxRepository } from '../server/managed-sites/email-outbox/repository'
import { createManagedSiteEmailOutboxService } from '../server/managed-sites/email-outbox/service'

const enabled = process.env.DS_RUN_PLATFORM_EMAIL_OUTBOX_MYSQL_INTEGRATION === '1'
const NOW = new Date('2026-10-07T00:00:00.123Z')
const SECRET = 'synthetic-independent-mysql-outbox-key-over-32-bytes'
const CONFIG = 'a'.repeat(64)
const UUID = '123e4567-e89b-42d3-a456-426614174000'
let pool: mysql.Pool
let database: MySql2Database<Record<string, unknown>>
const context = (ownerUserId = 7) => ({ purpose: 'member_invitation' as const, ownerUserId, projectId: 11, authority: { invitationId: 19, tokenHash: 'b'.repeat(64) }, expiresAt: new Date(NOW.getTime() + 60_000) })
const message = (key: string, text = 'private-one-time-token') => ({ to: 'synthetic@example.test', subject: 'Synthetic invitation', text, idempotencyKey: key })
const repository = () => createManagedSiteEmailOutboxRepository(database as Parameters<typeof createManagedSiteEmailOutboxRepository>[0])
function runtime(repo = repository(), afterAccept?: () => Promise<void>) {
  const send = vi.fn(async () => ({ delivered: true as const, providerMessageId: UUID }))
  return { send, service: createManagedSiteEmailOutboxService({ repository: repo, encryptionSecret: SECRET, providerConfigurationFingerprint: CONFIG, transport: { configured: true, send }, resolveAuthority: async () => ({ current: true, afterAccept }), clock: () => new Date(NOW), executionEnabled: true }) }
}

describe.skipIf(!enabled)('isolated platform email MySQL integration (never production)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DS_PLATFORM_EMAIL_OUTBOX_MYSQL_TEST_URL || '')
    // The explicitly opted-in rehearsal can never accept a remote or ordinary app DB target.
    if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !/^\/ds_email_outbox_[a-z0-9_]+$/u.test(url.pathname) || url.search || url.hash) throw new Error('Only an isolated loopback rehearsal database is permitted')
    pool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: 'Z', connectionLimit: 4 })
    database = drizzle(pool)
    for (const statement of readFileSync(new URL('../server/database/migrations/0046_managed_email_outbox_v1.sql', import.meta.url), 'utf8').split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await pool.query(statement)
    await pool.query('CREATE TABLE emailSourceTest (id varchar(128) PRIMARY KEY, tokenHash varchar(64) NOT NULL)')
  })
  afterAll(async () => { await pool?.end() })

  it('round-trips a full-size encrypted message and millisecond expiry through the real table', async () => {
    const key = `mysql-large:${randomUUID()}`
    const first = runtime()
    const staged = await first.service.enqueueOnly({ idempotencyKey: key, context: context(), message: message(key, '"'.repeat(64 * 1024)) })
    expect(staged.itemId).toBeTruthy()
    const row = await repository().getById(staged.itemId!)
    expect(row?.expiresAt.getTime()).toBe(NOW.getTime() + 60_000)
    expect(row?.encryptedPayload?.length).toBeGreaterThan(65_535)
    expect(JSON.stringify(row)).not.toContain('synthetic@example.test')
    expect(await first.service.attempt(staged.itemId!)).toMatchObject({ accepted: true })
    expect(first.send).toHaveBeenCalledTimes(1)
    expect((await repository().getById(staged.itemId!))?.encryptedPayload).toBeNull()
  })

  it('applies explicit millisecond defaults when an isolated synthetic insert omits createdAt and updatedAt', async () => {
    const id = randomUUID()
    const key = `mysql-defaults:${randomUUID()}`
    const [beforeRows] = await pool.query<mysql.RowDataPacket[]>('SELECT CURRENT_TIMESTAMP(3) AS observedAt')
    await pool.execute(
      'INSERT INTO managedSiteEmailOutbox (id, purpose, idempotencyKey, authorityFingerprint, payloadFingerprint, contextFingerprint, providerConfigurationFingerprint, status, attemptCount, nextAttemptAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, 'member_invitation', key, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), 'queued', 0, new Date(NOW.getTime() + 60_000), new Date(NOW.getTime() + 120_000)],
    )
    const [rowSet] = await pool.query<mysql.RowDataPacket[]>('SELECT createdAt, updatedAt FROM managedSiteEmailOutbox WHERE id = ?', [id])
    const [afterRows] = await pool.query<mysql.RowDataPacket[]>('SELECT CURRENT_TIMESTAMP(3) AS observedAt')
    expect(rowSet).toHaveLength(1)
    const createdAt = rowSet[0]!.createdAt as Date
    const updatedAt = rowSet[0]!.updatedAt as Date
    const before = (beforeRows[0]!.observedAt as Date).getTime()
    const after = (afterRows[0]!.observedAt as Date).getTime()
    expect(createdAt).toBeInstanceOf(Date)
    expect(updatedAt).toBeInstanceOf(Date)
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before - 1)
    expect(createdAt.getTime()).toBeLessThanOrEqual(after + 1)
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before - 1)
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after + 1)
    expect(Math.abs(createdAt.getTime() - updatedAt.getTime())).toBeLessThanOrEqual(1)
    const [precisionRows] = await pool.query<mysql.RowDataPacket[]>('SELECT DATE_FORMAT(createdAt, "%Y-%m-%d %H:%i:%s.%f") AS createdAtPrecision, DATE_FORMAT(updatedAt, "%Y-%m-%d %H:%i:%s.%f") AS updatedAtPrecision FROM managedSiteEmailOutbox WHERE id = ?', [id])
    expect(precisionRows[0]!.createdAtPrecision).toMatch(/\.\d{3}000$/u)
    expect(precisionRows[0]!.updatedAtPrecision).toMatch(/\.\d{3}000$/u)
  })

  it('claims one delivery across two workers using actual MySQL CAS, not a memory mutex', async () => {
    const key = `mysql-race:${randomUUID()}`
    const first = runtime(), second = runtime()
    const staged = await first.service.enqueueOnly({ idempotencyKey: key, context: context(), message: message(key) })
    const results = await Promise.all([first.service.attempt(staged.itemId!), second.service.attempt(staged.itemId!)])
    expect(results.some(result => result.accepted)).toBe(true)
    expect(first.send.mock.calls.length + second.send.mock.calls.length).toBe(1)
    expect((await repository().getById(staged.itemId!))?.status).toBe('accepted')
  })

  it('recovers a persisted provider acceptance without sending again after callback failure', async () => {
    const key = `mysql-reconcile:${randomUUID()}`
    const first = runtime(repository(), async () => { throw new Error('synthetic callback outage') })
    const staged = await first.service.enqueueOnly({ idempotencyKey: key, context: context(), message: message(key) })
    expect(await first.service.attempt(staged.itemId!)).toMatchObject({ accepted: false, status: 'queued' })
    const accepted = await repository().getById(staged.itemId!)
    expect(accepted).toMatchObject({ status: 'reconcile_pending', providerReceiptId: UUID })
    await pool.execute('UPDATE managedSiteEmailOutbox SET nextAttemptAt = ? WHERE id = ?', [NOW, staged.itemId])
    const restarted = runtime()
    expect(await restarted.service.attempt(staged.itemId!)).toMatchObject({ accepted: true })
    expect(first.send).toHaveBeenCalledTimes(1)
    expect(restarted.send).not.toHaveBeenCalled()
  })

  it('cannot overwrite a current lease with a stale acknowledgement or active-lease cleanup', async () => {
    const key = `mysql-lease:${randomUUID()}`
    const current = runtime()
    const staged = await current.service.enqueueOnly({ idempotencyKey: key, context: context(), message: message(key) })
    const repo = repository()
    const leaseToken = randomUUID()
    expect(await repo.claimOne({ id: staged.itemId!, now: NOW, leaseToken, leaseExpiresAt: new Date(NOW.getTime() + 120_000), maxAttempts: 6 })).not.toBeNull()
    await repo.beginAttempt({ id: staged.itemId!, leaseToken, now: NOW })
    expect(await repo.accepted({ id: staged.itemId!, leaseToken, now: NOW, providerReceiptId: UUID })).toBe(true)
    await repo.cancelExpired({ now: new Date(NOW.getTime() + 60_000), limit: 50 })
    expect((await repo.getById(staged.itemId!))?.leaseToken).toBe(leaseToken)
    expect(await repo.reconciliationComplete({ id: staged.itemId!, leaseToken: randomUUID(), now: NOW })).toBe(false)
    expect(await repo.reconciliationComplete({ id: staged.itemId!, leaseToken, now: NOW })).toBe(true)
  })

  it('rolls back the source token hash and encrypted queue in the same real SQL transaction', async () => {
    const key = `mysql-rollback:${randomUUID()}`
    let itemId = ''
    await expect(database.transaction(async tx => {
      await tx.execute(sql`INSERT INTO emailSourceTest (id, tokenHash) VALUES (${key}, ${'c'.repeat(64)})`)
      const txRepo = createManagedSiteEmailOutboxRepository(tx as unknown as Parameters<typeof createManagedSiteEmailOutboxRepository>[0])
      const queued = await runtime(txRepo).service.enqueueOnly({ idempotencyKey: key, context: context(), message: message(key) })
      expect(queued.itemId).toBeTruthy()
      itemId = queued.itemId!
      throw new Error('synthetic rollback')
    })).rejects.toThrow('synthetic rollback')
    const [source] = await pool.execute<mysql.RowDataPacket[]>('SELECT id FROM emailSourceTest WHERE id = ?', [key])
    expect(source).toHaveLength(0)
    expect(await repository().getById(itemId)).toBeNull()
  })

  it('lists only exact-owner reduced metadata and can clear expired data without any provider', async () => {
    const key = `mysql-owner:${randomUUID()}`
    const current = runtime()
    const staged = await current.service.enqueueOnly({ idempotencyKey: key, context: context(8), message: message(key) })
    const rows = await repository().listSafeMetadata({ ownerUserId: 8, limit: 50 })
    expect(rows.map(row => row.id)).toEqual([staged.itemId])
    const output = JSON.stringify(rows)
    for (const privateField of ['synthetic@example.test', 'private-one-time-token', 'encryptedPayload', 'providerReceiptId', 'idempotencyKey']) expect(output).not.toContain(privateField)
    await repository().cancelExpired({ now: new Date(NOW.getTime() + 60_000), limit: 50 })
    expect((await repository().getById(staged.itemId!))?.encryptedPayload).toBeNull()
    expect(current.send).not.toHaveBeenCalled()
  })
})
