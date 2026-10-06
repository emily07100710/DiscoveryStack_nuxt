import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'
import { managedSiteEmailOutbox } from '../server/database/schema'

const read = (file: string) => readFileSync(new URL(`../server/database/migrations/${file}`, import.meta.url), 'utf8')
const schema = readFileSync(new URL('../server/database/schema.ts', import.meta.url), 'utf8')
const migration = read('0046_managed_email_outbox_v1.sql')
const previous = JSON.parse(read('meta/0045_snapshot.json'))
const current = JSON.parse(read('meta/0046_snapshot.json'))
const journal = JSON.parse(read('meta/_journal.json'))

describe('platform email additive migration', () => {
  it('appends exactly one isolated queue table without changing existing snapshot tables', () => {
    expect(current.prevId).toBe(previous.id)
    expect(Object.keys(current.tables).filter(name => !Object.hasOwn(previous.tables, name))).toEqual(['managedSiteEmailOutbox'])
    // Drizzle snapshots exclude the separate __drizzle_migrations ledger table.
    expect(Object.keys(previous.tables)).toHaveLength(194)
    expect(Object.keys(current.tables)).toHaveLength(195)
    for (const [name, table] of Object.entries(previous.tables)) expect(current.tables[name], name).toEqual(table)
    expect(journal.entries.at(-1)).toMatchObject({ idx: 46, tag: '0046_managed_email_outbox_v1' })
  })
  it('contains only the reviewed table and two indexes, with no business-data mutations', () => {
    const statements = migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
    expect(statements).toHaveLength(3)
    expect(statements[0]).toMatch(/^CREATE TABLE `managedSiteEmailOutbox`/u)
    expect(statements[1]).toMatch(/^CREATE INDEX `managed_email_outbox_due_idx` ON `managedSiteEmailOutbox`/u)
    expect(statements[2]).toMatch(/^CREATE INDEX `managed_email_outbox_owner_idx` ON `managedSiteEmailOutbox`/u)
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|INSERT|ALTER)\b/iu)
  })
  it('preserves ciphertext capacity, millisecond leases and immutable-key uniqueness in SQL, snapshot and schema', () => {
    const table = getTableConfig(managedSiteEmailOutbox)
    const columns = Object.fromEntries(table.columns.map(column => [column.name, column.getSQLType()]))
    expect(columns.encryptedPayload).toBe('longtext')
    for (const name of ['firstAttemptAt', 'nextAttemptAt', 'expiresAt', 'leaseExpiresAt', 'acceptedAt']) {
      expect(columns[name]).toBe('datetime(3)')
      expect(current.tables.managedSiteEmailOutbox.columns[name].type).toBe('datetime(3)')
      expect(migration).toContain(`\`${name}\` datetime(3)`)
    }
    expect(current.tables.managedSiteEmailOutbox.columns.encryptedPayload.type).toBe('longtext')
    expect(migration).toContain('`encryptedPayload` longtext')
    expect(migration).toContain('UNIQUE(`purpose`,`idempotencyKey`)')
    // Drizzle Kit omits precision in this clause; real MySQL requires it to match timestamp(3).
    expect(migration).toContain('ON UPDATE CURRENT_TIMESTAMP(3)')
  })
  it('uses explicit millisecond CURRENT_TIMESTAMP defaults for both timestamp columns in schema, snapshot and SQL', () => {
    const outboxSchema = schema.slice(schema.indexOf('export const managedSiteEmailOutbox = mysqlTable'))
    expect(outboxSchema).toMatch(/createdAt:\s*timestamp\('createdAt',\s*\{\s*fsp:\s*3\s*\}\)\.default\(sql`CURRENT_TIMESTAMP\(3\)`\)\.notNull\(\)/u)
    expect(outboxSchema).toMatch(/updatedAt:\s*timestamp\('updatedAt',\s*\{\s*fsp:\s*3\s*\}\)\.default\(sql`CURRENT_TIMESTAMP\(3\)`\)\.onUpdateNow\(\)\.notNull\(\)/u)

    const snapshot = current.tables.managedSiteEmailOutbox.columns
    for (const name of ['createdAt', 'updatedAt']) {
      expect(snapshot[name].type).toBe('timestamp(3)')
      expect(snapshot[name].default).toMatch(/CURRENT_TIMESTAMP\(3\)/u)
    }
    expect(snapshot.updatedAt.onUpdate).toBe(true)

    expect(migration).toMatch(/`createdAt` timestamp\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)/u)
    expect(migration).toMatch(/`updatedAt` timestamp\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\) ON UPDATE CURRENT_TIMESTAMP\(3\)/u)
  })
})
