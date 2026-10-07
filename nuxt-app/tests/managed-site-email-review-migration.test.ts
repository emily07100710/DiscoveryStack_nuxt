import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'
import { managedSiteEmailManualReviews } from '../server/database/schema'

const read = (path: string) => readFileSync(new URL(`../server/database/${path}`, import.meta.url), 'utf8')
const migration = read('migrations/0049_managed_email_manual_review_v1.sql')
const previousMigration = read('migrations/0048_managed_email_provider_events_v1.sql')
const previous = JSON.parse(read('migrations/meta/0048_snapshot.json'))
const current = JSON.parse(read('migrations/meta/0049_snapshot.json'))
const journal = JSON.parse(read('migrations/meta/_journal.json'))

function indexColumnName(column: unknown): string {
  if (column && typeof column === 'object' && 'name' in column && typeof column.name === 'string') return column.name
  throw new Error('Email review index must reference a named schema column')
}

describe('managed site email manual review migration', () => {
  it('keeps the complete 0048 snapshot unchanged except for the new review table', () => {
    expect(createHash('sha256').update(previousMigration).digest('hex')).toBe('bd687006de112d142e59b6e5a7b88d3a9568ef160a95528ebc0e0212676e3027')
    expect(current.prevId).toBe(previous.id)

    const comparable = structuredClone(current)
    delete comparable.tables.managedSiteEmailManualReviews
    comparable.id = previous.id
    comparable.prevId = previous.prevId
    expect(comparable).toEqual(previous)
    expect(Object.keys(current.tables.managedSiteEmailManualReviews.columns)).toEqual([
      'outboxId',
      'ownerUserId',
      'requestId',
      'outboxVersion',
      'reason',
      'closedAt',
    ])
  })

  it('matches the six-column typed schema and exactly two indexes', () => {
    const snapshotTable = current.tables.managedSiteEmailManualReviews
    const table = getTableConfig(managedSiteEmailManualReviews)
    const columns = Object.fromEntries(table.columns.map(column => [column.name, column.getSQLType()]))

    expect(Object.keys(columns)).toEqual(['outboxId', 'ownerUserId', 'requestId', 'outboxVersion', 'reason', 'closedAt'])
    expect(columns).toEqual({
      outboxId: 'varchar(36)',
      ownerUserId: 'int',
      requestId: 'varchar(36)',
      outboxVersion: 'varchar(64)',
      reason: "enum('reviewed_no_resend','handled_outside_platform')",
      closedAt: 'datetime(3)',
    })
    expect(table.columns.find(column => column.name === 'outboxId')?.primary).toBe(true)
    expect(table.foreignKeys).toHaveLength(0)
    expect(Object.keys(snapshotTable.indexes).sort()).toEqual(['managed_email_review_owner_idx', 'managed_email_review_request_uq'])
    expect(snapshotTable.indexes.managed_email_review_request_uq).toMatchObject({ columns: ['ownerUserId', 'requestId'], isUnique: true })
    expect(snapshotTable.indexes.managed_email_review_owner_idx.columns).toEqual(['ownerUserId', 'closedAt', 'outboxId'])
    expect(Object.keys(snapshotTable.foreignKeys)).toHaveLength(0)
    expect(table.indexes.map(index => index.config.name).sort()).toEqual(['managed_email_review_owner_idx', 'managed_email_review_request_uq'])
    expect(table.indexes.map(index => ({ name: index.config.name, unique: index.config.unique, columns: index.config.columns.map(indexColumnName) }))).toEqual([
      { name: 'managed_email_review_request_uq', unique: true, columns: ['ownerUserId', 'requestId'] },
      { name: 'managed_email_review_owner_idx', unique: false, columns: ['ownerUserId', 'closedAt', 'outboxId'] },
    ])
    expect(table.columns.find(column => column.name === 'closedAt')?.getSQLType()).toBe('datetime(3)')
  })

  it('contains only one additive table and its two indexes, with journal entry 49', () => {
    const statements = migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
    // Drizzle emits the primary key and owner/request uniqueness inside CREATE TABLE.
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^CREATE TABLE `managedSiteEmailManualReviews`/u)
    expect(statements[0]).toContain('`closedAt` datetime(3) NOT NULL')
    expect(statements[0]).toContain('CONSTRAINT `managedSiteEmailManualReviews_outboxId` PRIMARY KEY(`outboxId`)')
    expect(statements[0]).toContain('CONSTRAINT `managed_email_review_request_uq` UNIQUE(`ownerUserId`,`requestId`)')
    expect(statements[1]).toMatch(/^CREATE INDEX `managed_email_review_owner_idx` ON `managedSiteEmailManualReviews`/u)
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|INSERT|UPDATE|ALTER)\b/iu)

    const index = journal.entries.findIndex((entry: { idx: number }) => entry.idx === 49)
    expect(index).toBeGreaterThan(0)
    expect(journal.entries[index - 1]).toMatchObject({ idx: 48, tag: '0048_managed_email_provider_events_v1', breakpoints: true })
    expect(journal.entries[index]).toMatchObject({ idx: 49, tag: '0049_managed_email_manual_review_v1', breakpoints: true })
  })
})
