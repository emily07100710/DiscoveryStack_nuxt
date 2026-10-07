import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'
import { managedSiteEmailOutbox, managedSiteEmailProviderEvents } from '../server/database/schema'

const read = (path: string) => readFileSync(new URL(`../server/database/${path}`, import.meta.url), 'utf8')
const migration = read('migrations/0048_managed_email_provider_events_v1.sql')
const previous = JSON.parse(read('migrations/meta/0047_snapshot.json'))
const current = JSON.parse(read('migrations/meta/0048_snapshot.json'))
const journal = JSON.parse(read('migrations/meta/_journal.json'))

describe('managed site email provider event migration', () => {
  it('adds only the provider event table and receipt lookup index to the previous snapshot', () => {
    expect(current.prevId).toBe(previous.id)
    const comparable = structuredClone(current)
    delete comparable.tables.managedSiteEmailProviderEvents
    delete comparable.tables.managedSiteEmailOutbox.indexes.managed_email_outbox_receipt_idx
    comparable.id = previous.id
    comparable.prevId = previous.prevId
    expect(comparable).toEqual(previous)
    expect(Object.keys(current.tables.managedSiteEmailProviderEvents.columns)).toEqual([
      'id',
      'providerReceiptId',
      'eventType',
      'payloadFingerprint',
      'providerConfigurationFingerprint',
      'verificationFingerprint',
      'occurredAt',
      'receivedAt',
    ])
  })

  it('matches the typed schema, including eight columns and exactly three additive indexes', () => {
    const eventTable = getTableConfig(managedSiteEmailProviderEvents)
    const outboxTable = getTableConfig(managedSiteEmailOutbox)
    expect(eventTable.columns.map(column => column.name)).toEqual(Object.keys(current.tables.managedSiteEmailProviderEvents.columns))
    expect(eventTable.columns.find(column => column.name === 'occurredAt')?.getSQLType()).toBe('datetime(3)')
    expect(eventTable.columns.find(column => column.name === 'receivedAt')?.getSQLType()).toBe('datetime(3)')
    expect(Object.keys(current.tables.managedSiteEmailProviderEvents.indexes)).toEqual([
      'managed_email_event_receipt_idx',
      'managed_email_event_received_idx',
    ])
    expect(current.tables.managedSiteEmailOutbox.indexes.managed_email_outbox_receipt_idx.columns).toEqual(['providerConfigurationFingerprint', 'providerReceiptId'])
    expect(eventTable.indexes.map(index => index.config.name).sort()).toEqual(['managed_email_event_receipt_idx', 'managed_email_event_received_idx'])
    expect(outboxTable.indexes.map(index => index.config.name)).toContain('managed_email_outbox_receipt_idx')
  })

  it('contains four additive SQL statements and appends the migration journal entry', () => {
    const statements = migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
    expect(statements).toHaveLength(4)
    expect(statements[0]).toMatch(/^CREATE TABLE `managedSiteEmailProviderEvents`/u)
    expect(statements[0]).toContain('`occurredAt` datetime(3) NOT NULL')
    expect(statements[0]).toContain('`receivedAt` datetime(3) NOT NULL')
    expect(statements[1]).toMatch(/^CREATE INDEX `managed_email_event_receipt_idx` ON `managedSiteEmailProviderEvents`/u)
    expect(statements[2]).toMatch(/^CREATE INDEX `managed_email_event_received_idx` ON `managedSiteEmailProviderEvents`/u)
    expect(statements[3]).toMatch(/^CREATE INDEX `managed_email_outbox_receipt_idx` ON `managedSiteEmailOutbox`/u)
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/iu)

    const index = journal.entries.findIndex((entry: { idx: number }) => entry.idx === 48)
    expect(index).toBeGreaterThan(0)
    expect(journal.entries[index]).toMatchObject({ idx: 48, tag: '0048_managed_email_provider_events_v1', breakpoints: true })
    expect(journal.entries[index - 1]).toMatchObject({ idx: 47, tag: '0047_live_publication_actions_v1' })
    expect(journal.entries[index + 1]).toMatchObject({ idx: 49, tag: '0049_managed_email_manual_review_v1', breakpoints: true })
  })
})
