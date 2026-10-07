import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../server/database/migrations/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, root), 'utf8')
const before = JSON.parse(read('meta/0049_snapshot.json'))
const after = JSON.parse(read('meta/0050_snapshot.json'))
const journal = JSON.parse(read('meta/_journal.json'))
const migration = read('0050_weekly_content_scheduler_cursor_v1.sql')
const statements = migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
const table = after.tables.weeklyContentSchedulerCursors

describe('weekly scheduler cursor additive migration', () => {
  it('adds only the cursor and preserves every existing table, including both mail increments', () => {
    expect(after.prevId).toBe(before.id)
    expect(Object.keys(after.tables)).toHaveLength(Object.keys(before.tables).length + 1)
    expect(Object.keys(after.tables).filter(name => !Object.hasOwn(before.tables, name))).toEqual(['weeklyContentSchedulerCursors'])
    expect(Object.keys(before.tables).filter(name => !Object.hasOwn(after.tables, name))).toEqual([])
    for (const [name, previous] of Object.entries(before.tables)) expect(after.tables[name], name).toEqual(previous)
    expect(createHash('sha256').update(read('0048_managed_email_provider_events_v1.sql')).digest('hex')).toBe('bd687006de112d142e59b6e5a7b88d3a9568ef160a95528ebc0e0212676e3027')
    expect(createHash('sha256').update(read('0049_managed_email_manual_review_v1.sql')).digest('hex')).toBe('01967d3f66dfc060d9ce658e184587150f32d70c425e31d74f5e6dcbae187218')
  })

  it('has exactly three non-sensitive columns, an owner primary key and a noncascading owner foreign key', () => {
    expect(Object.keys(table.columns)).toEqual(['ownerUserId', 'afterConfigId', 'updatedAt'])
    expect(table.columns.ownerUserId).toMatchObject({ type: 'int', notNull: true, autoincrement: false })
    expect(table.columns.afterConfigId).toMatchObject({ type: 'int', notNull: true, default: 0 })
    expect(table.columns.updatedAt).toMatchObject({ type: 'timestamp(3)', notNull: true, default: 'CURRENT_TIMESTAMP(3)' })
    expect(table.columns.updatedAt.onUpdate).toBeUndefined()
    expect(Object.values(table.compositePrimaryKeys)).toEqual([{ name: 'weeklyContentSchedulerCursors_ownerUserId', columns: ['ownerUserId'] }])
    expect(table.foreignKeys).toEqual({ weekly_scheduler_cursor_owner_fk: {
      name: 'weekly_scheduler_cursor_owner_fk', tableFrom: 'weeklyContentSchedulerCursors', tableTo: 'users',
      columnsFrom: ['ownerUserId'], columnsTo: ['id'], onDelete: 'no action', onUpdate: 'no action',
    } })
    expect(table.indexes).toEqual({})
    expect(table.uniqueConstraints).toEqual({})
  })

  it('contains exactly a new table and its foreign key, with no data or existing table changes', () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe('CREATE TABLE `weeklyContentSchedulerCursors` (\n\t`ownerUserId` int NOT NULL,\n\t`afterConfigId` int NOT NULL DEFAULT 0,\n\t`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\n\tCONSTRAINT `weeklyContentSchedulerCursors_ownerUserId` PRIMARY KEY(`ownerUserId`)\n);')
    expect(statements[1]).toBe('ALTER TABLE `weeklyContentSchedulerCursors` ADD CONSTRAINT `weekly_scheduler_cursor_owner_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;')
    expect(statements.some(value => /^(?:DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/iu.test(value))).toBe(false)
  })

  it('appends index 50 after the exact manual-review journal entry without rewriting historical entries', () => {
    const position = journal.entries.findIndex((entry: { idx: number }) => entry.idx === 50)
    expect(position).toBe(50)
    expect(journal.entries[position - 1]).toMatchObject({ idx: 49, tag: '0049_managed_email_manual_review_v1', breakpoints: true })
    expect(journal.entries[position]).toMatchObject({ idx: 50, tag: '0050_weekly_content_scheduler_cursor_v1', breakpoints: true })
    expect(journal.entries[position].when).toBeGreaterThan(journal.entries[position - 1].when)
  })
})
