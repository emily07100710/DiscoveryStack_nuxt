import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { createManagedSiteEmailOutboxRepository } from '../server/managed-sites/email-outbox/repository'
import type { ManagedSiteEmailOutboxItem } from '../server/managed-sites/email-outbox/types'

const dialect = new MySqlDialect()
const now = new Date('2026-10-07T00:00:00.000Z')

function fakeDatabase(candidate: ManagedSiteEmailOutboxItem) {
  const updates: Array<{ values: unknown; whereSql: string }> = []
  const inserts: unknown[] = []
  const selects: string[] = []
  const projections: string[][] = []
  let returnedCandidate = { ...candidate }
  let selectedFields: Record<string, unknown> | undefined
  const database = {
    insert(table: unknown) {
      return { async values(value: unknown) { inserts.push({ table, value }); throw new Error('duplicate key for replay') } }
    },
    select(fields?: Record<string, unknown>) {
      selectedFields = fields
      if (fields) projections.push(Object.keys(fields))
      return {
        from() {
          return {
            where(query: any) {
              selects.push(dialect.sqlToQuery(query).sql)
              return { orderBy() { return this }, async limit() { return [selectedFields ? Object.fromEntries(Object.keys(selectedFields).map(key => [key, key === 'lastErrorCode' ? returnedCandidate.safeCode : (returnedCandidate as any)[key]])) : { ...returnedCandidate }] } }
            },
          }
        },
      }
    },
    update() {
      return {
        set(values: unknown) {
          return { async where(query: any) { updates.push({ values, whereSql: dialect.sqlToQuery(query).sql }); return [{ affectedRows: 1 }] } }
        },
      }
    },
  }
  return { database: database as any, updates, inserts, selects, projections, setCandidate(next: ManagedSiteEmailOutboxItem) { returnedCandidate = { ...next } } }
}

function item(overrides: Partial<ManagedSiteEmailOutboxItem> = {}): ManagedSiteEmailOutboxItem {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000', ownerUserId: 7, projectId: 11, purpose: 'member_invitation', idempotencyKey: 'invite:19',
    authorityFingerprint: 'a'.repeat(64), payloadFingerprint: 'b'.repeat(64), contextFingerprint: 'c'.repeat(64), providerConfigurationFingerprint: 'd'.repeat(64),
    encryptedPayload: 'v1.iv.cipher.tag', status: 'queued', attemptCount: 0, firstAttemptAt: null, nextAttemptAt: now, expiresAt: new Date(now.getTime() + 60_000),
    leaseToken: null, leaseExpiresAt: null, safeCode: null, providerReceiptId: null, acceptedAt: null, createdAt: now, updatedAt: now, ...overrides,
  }
}

describe('managed-site email outbox MySQL repository', () => {
  it('uses persisted unique-key replay lookup and only stores ciphertext and fingerprints', async () => {
    const row = item()
    const db = fakeDatabase(row)
    const repository = createManagedSiteEmailOutboxRepository(db.database)
    const loaded = await repository.insertOrGet({
      id: row.id, ownerUserId: row.ownerUserId, projectId: row.projectId, purpose: row.purpose, idempotencyKey: row.idempotencyKey,
      authorityFingerprint: row.authorityFingerprint, payloadFingerprint: row.payloadFingerprint, contextFingerprint: row.contextFingerprint,
      providerConfigurationFingerprint: row.providerConfigurationFingerprint, encryptedPayload: row.encryptedPayload,
      nextAttemptAt: row.nextAttemptAt, expiresAt: row.expiresAt,
    })
    expect(loaded.id).toBe(row.id)
    expect(db.selects[0]).toContain('`purpose` = ?')
    expect(db.selects[0]).toContain('`idempotencyKey` = ?')
    const stored = (db.inserts[0] as { value: Record<string, unknown> }).value
    expect(stored.encryptedPayload).toBe('v1.iv.cipher.tag')
    expect(Object.keys(stored)).not.toContain('to')
    expect(Object.keys(stored)).not.toContain('subject')
    expect(Object.keys(stored)).not.toContain('text')
  })

  it('claims one due row with status/lease compare-and-swap and increments attempt under the same lease', async () => {
    const row = item()
    const db = fakeDatabase(row)
    const repository = createManagedSiteEmailOutboxRepository(db.database)
    const claim = await repository.claimOne({ now, leaseToken: 'new-lease-token', leaseExpiresAt: new Date(now.getTime() + 60_000), maxAttempts: 6, id: row.id })
    expect(claim).toMatchObject({ item: { id: row.id }, leaseToken: 'new-lease-token' })
    expect(db.updates[0]?.whereSql).toContain('`status` = ?')
    expect(db.updates[0]?.whereSql).toContain('`nextAttemptAt` <= ?')
    db.setCandidate({ ...row, status: 'processing', leaseToken: 'new-lease-token', leaseExpiresAt: new Date(now.getTime() + 60_000) })
    await repository.beginAttempt({ id: row.id, leaseToken: 'new-lease-token', now })
    expect(db.updates[1]?.whereSql).toContain('`status` = ?')
    expect(db.updates[1]?.whereSql).toContain('`leaseToken` = ?')
    expect(db.updates[1]?.whereSql).toContain('`leaseExpiresAt` > ?')
  })

  it('does not make an accepted callback visible for reclaim until its current lease expires', async () => {
    const row = item({ status: 'reconcile_pending', acceptedAt: now, providerReceiptId: '123e4567-e89b-42d3-a456-426614174000', leaseToken: 'active-lease', leaseExpiresAt: new Date(now.getTime() + 60_000) })
    const db = fakeDatabase(row)
    const repository = createManagedSiteEmailOutboxRepository(db.database)
    await repository.claimOne({ now, leaseToken: 'other-worker', leaseExpiresAt: new Date(now.getTime() + 60_000), maxAttempts: 6, id: row.id })
    expect(db.selects[0]).toContain('`leaseExpiresAt` <= ?')
    expect(db.selects[0]).toContain('`leaseToken` is null')
    expect(db.updates[0]?.whereSql).toContain('`leaseExpiresAt` <= ?')
    expect(db.updates[0]?.whereSql).toContain('`leaseToken` is null')
  })

  it('does not clear an expired accepted payload while its reconciliation lease is active', async () => {
    const row = item({ status: 'reconcile_pending', acceptedAt: now, providerReceiptId: '123e4567-e89b-42d3-a456-426614174000', leaseToken: 'active-lease', leaseExpiresAt: new Date(now.getTime() + 60_000), expiresAt: new Date(now.getTime() - 1) })
    const db = fakeDatabase(row)
    const repository = createManagedSiteEmailOutboxRepository(db.database)
    await repository.cancelExpired({ now, limit: 50 })
    expect(db.selects[0]).toContain('`leaseExpiresAt` <= ?')
    expect(db.selects[0]).toContain('`leaseToken` is null')
    expect(db.updates[0]?.whereSql).toContain('`leaseExpiresAt` <= ?')
    expect(db.updates[0]?.whereSql).toContain('`leaseToken` is null')
    expect((db.updates[0]?.values as Record<string, unknown>).encryptedPayload).toBeNull()
  })

  it('fences provider acceptance and clears ciphertext only at reconciliation completion', async () => {
    const row = item({ status: 'processing', leaseToken: 'lease-1', leaseExpiresAt: new Date(now.getTime() + 60_000) })
    const db = fakeDatabase(row)
    const repository = createManagedSiteEmailOutboxRepository(db.database)
    await repository.accepted({ id: row.id, leaseToken: 'lease-1', now, providerReceiptId: '123e4567-e89b-42d3-a456-426614174000' })
    expect(db.updates[0]?.whereSql).toContain('`leaseToken` = ?')
    expect(db.updates[0]?.whereSql).toContain('`leaseExpiresAt` > ?')
    expect(db.updates[0]?.whereSql).not.toContain('`encryptedPayload`')
    await repository.reconciliationComplete({ id: row.id, leaseToken: 'lease-1', now })
    expect((db.updates[1]?.values as Record<string, unknown>).encryptedPayload).toBeNull()
    expect(db.updates[1]?.whereSql).toContain('`providerReceiptId` is not null')
    expect(db.updates[1]?.whereSql).toContain('`leaseToken` = ?')
  })

  it('lists only bounded owner-scoped safe metadata without arbitrary null-owner lookup', async () => {
    const row = item()
    const db = fakeDatabase(row)
    const repository = createManagedSiteEmailOutboxRepository(db.database)
    const rows = await repository.listSafeMetadata({ ownerUserId: 7, projectId: 11, limit: 25 })
    expect(rows[0]).toMatchObject({ id: row.id, purpose: row.purpose, payloadFingerprint: row.payloadFingerprint })
    expect(db.selects.at(-1)).toContain('`ownerUserId` = ?')
    expect(db.selects.at(-1)).toContain('`projectId` = ?')
    expect(db.projections.at(-1)).toEqual(expect.arrayContaining(['id', 'purpose', 'status', 'lastErrorCode', 'payloadFingerprint', 'providerConfigurationFingerprint']))
    expect(db.projections.at(-1)).not.toEqual(expect.arrayContaining(['ownerUserId', 'projectId', 'idempotencyKey', 'encryptedPayload', 'providerReceiptId']))
    await expect(repository.listSafeMetadata({ ownerUserId: 0, limit: 25 })).rejects.toThrow()
    await expect(repository.listSafeMetadata({ ownerUserId: 7, limit: 1000 })).rejects.toThrow()
  })
})
