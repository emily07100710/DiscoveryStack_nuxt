import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectEmailProviderObservation, type EmailProviderEventFacts } from '../server/managed-sites/email-events/projection'
import { createEmailProviderEventsRepository } from '../server/managed-sites/email-events/repository'
import type { EmailProviderEventRecord } from '../server/managed-sites/email-events/types'

const requested = process.env.DS_RUN_MANAGED_SITE_EMAIL_EVENTS_MYSQL_INTEGRATION === '1'
const explicitTestUrl = process.env.DS_MANAGED_SITE_EMAIL_EVENTS_MYSQL_TEST_URL
const enabled = requested && Boolean(explicitTestUrl)
const CONFIG = 'a'.repeat(64)
const OTHER_CONFIG = 'b'.repeat(64)
const NOW = new Date('2026-10-07T00:00:00.123Z')
let pool: mysql.Pool | undefined
let database: MySql2Database<Record<string, unknown>>
const eventIds: string[] = []
const outboxIds: string[] = []
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const newUuid = () => randomUUID()
const repository = () => createEmailProviderEventsRepository(database as Parameters<typeof createEmailProviderEventsRepository>[0])

function parseDedicatedUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !/^\/ds_managed_site_email_events_[a-z0-9_]+$/u.test(url.pathname) || url.search || url.hash) {
    throw new Error('Only the explicitly supplied isolated loopback email-events database is permitted.')
  }
  return url
}

async function hasTable(tableName: string): Promise<boolean> {
  const [rows] = await pool!.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [tableName])
  return Number(rows[0]?.n) === 1
}

async function hasIndex(tableName: string, indexName: string): Promise<boolean> {
  const [rows] = await pool!.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [tableName, indexName])
  return Number(rows[0]?.n) > 0
}

async function ensureGeneratedSchema(): Promise<void> {
  const baseMigration = readFileSync(new URL('../server/database/migrations/0046_managed_email_outbox_v1.sql', import.meta.url), 'utf8')
  const eventMigration = readFileSync(new URL('../server/database/migrations/0048_managed_email_provider_events_v1.sql', import.meta.url), 'utf8')
  if (!await hasTable('managedSiteEmailOutbox')) {
    for (const statement of baseMigration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await pool!.query(statement)
  }
  const statements = eventMigration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
  if (!await hasTable('managedSiteEmailProviderEvents')) await pool!.query(statements[0]!)
  for (const statement of statements.slice(1)) {
    const match = statement.match(/^CREATE INDEX `([^`]+)` ON `([^`]+)`/u)
    if (!match) throw new Error('Unexpected generated email event index statement.')
    if (!await hasIndex(match[2]!, match[1]!)) await pool!.query(statement)
  }
}

function event(seed: string, fields: Partial<EmailProviderEventRecord> = {}): EmailProviderEventRecord {
  const id = hash(`message-id:${seed}`)
  if (!eventIds.includes(id)) eventIds.push(id)
  return {
    id,
    providerReceiptId: newUuid(),
    eventType: 'email.sent',
    payloadFingerprint: hash(`payload:${seed}`),
    providerConfigurationFingerprint: CONFIG,
    verificationFingerprint: hash(`verification:${seed}`),
    occurredAt: new Date(NOW),
    receivedAt: new Date(NOW),
    ...fields,
  }
}

async function insertAcceptedOutbox(input: { ownerUserId: number | null; receipt: string; configuration?: string; acceptedAt?: Date | null }): Promise<string> {
  const id = newUuid()
  outboxIds.push(id)
  const acceptedAt = input.acceptedAt === undefined ? NOW : input.acceptedAt
  await pool!.execute(
    'INSERT INTO managedSiteEmailOutbox (id, ownerUserId, projectId, purpose, idempotencyKey, authorityFingerprint, payloadFingerprint, contextFingerprint, providerConfigurationFingerprint, status, nextAttemptAt, expiresAt, providerReceiptId, acceptedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.ownerUserId, input.ownerUserId === null ? null : 23, 'member_invitation', `synthetic:${id}`, hash(`authority:${id}`), hash(`outbox-payload:${id}`), hash(`context:${id}`), input.configuration || CONFIG, acceptedAt ? 'accepted' : 'reconcile_pending', NOW, new Date(NOW.getTime() + 60_000), input.receipt, acceptedAt],
  )
  return id
}

async function cleanupSyntheticRows(): Promise<void> {
  for (const id of eventIds.splice(0)) await pool!.execute('DELETE FROM managedSiteEmailProviderEvents WHERE id = ?', [id])
  for (const id of outboxIds.splice(0)) await pool!.execute('DELETE FROM managedSiteEmailOutbox WHERE id = ?', [id])
}

describe.skipIf(!enabled)('isolated managed site email events MySQL integration (never production)', () => {
  beforeAll(async () => {
    const url = parseDedicatedUrl(explicitTestUrl!)
    pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1), timezone: 'Z', connectionLimit: 4 })
    database = drizzle(pool)
    await ensureGeneratedSchema()
  })

  afterAll(async () => {
    if (pool) {
      await cleanupSyntheticRows()
      await pool.end()
    }
  })

  it('uses the generated event table, 8 columns, and all three intended indexes', async () => {
    const [columns] = await pool!.execute<mysql.RowDataPacket[]>(
      'SELECT column_name AS name, data_type AS type, datetime_precision AS precisionDigits FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
      ['managedSiteEmailProviderEvents'],
    )
    expect(columns.map(row => row.name)).toEqual(['id', 'providerReceiptId', 'eventType', 'payloadFingerprint', 'providerConfigurationFingerprint', 'verificationFingerprint', 'occurredAt', 'receivedAt'])
    expect(columns.find(row => row.name === 'occurredAt')).toMatchObject({ type: 'datetime', precisionDigits: 3 })
    expect(columns.find(row => row.name === 'receivedAt')).toMatchObject({ type: 'datetime', precisionDigits: 3 })
    expect(await hasIndex('managedSiteEmailProviderEvents', 'managed_email_event_receipt_idx')).toBe(true)
    expect(await hasIndex('managedSiteEmailProviderEvents', 'managed_email_event_received_idx')).toBe(true)
    expect(await hasIndex('managedSiteEmailOutbox', 'managed_email_outbox_receipt_idx')).toBe(true)
  })

  it('uses the SQL unique key for concurrent record, immutable rotation replay, and same-ID collision', async () => {
    const providerReceiptId = newUuid()
    const first = event(randomUUID(), { providerReceiptId })
    const concurrent = await Promise.all([repository().record(first), repository().record({ ...first })])
    expect(concurrent.sort()).toEqual(['recorded', 'replayed'])

    const rotated = { ...first, verificationFingerprint: hash('rotated-verification-proof'), receivedAt: new Date(NOW.getTime() + 700) }
    expect(await repository().record(rotated)).toBe('replayed')
    const [persisted] = await pool!.execute<mysql.RowDataPacket[]>('SELECT verificationFingerprint, receivedAt FROM managedSiteEmailProviderEvents WHERE id = ?', [first.id])
    expect(persisted![0]!.verificationFingerprint).toBe(first.verificationFingerprint)
    expect((persisted![0]!.receivedAt as Date).getTime()).toBe(first.receivedAt.getTime())

    expect(await repository().record({ ...first, eventType: 'email.failed' })).toBe('collision')
    expect(await repository().record({ ...first, payloadFingerprint: hash('different-payload') })).toBe('collision')
    const [afterCollision] = await pool!.execute<mysql.RowDataPacket[]>('SELECT id, providerReceiptId, eventType, payloadFingerprint, providerConfigurationFingerprint, verificationFingerprint, occurredAt, receivedAt FROM managedSiteEmailProviderEvents WHERE id = ?', [first.id])
    expect(afterCollision[0]).toMatchObject({
      id: first.id,
      providerReceiptId: first.providerReceiptId,
      eventType: first.eventType,
      payloadFingerprint: first.payloadFingerprint,
      providerConfigurationFingerprint: first.providerConfigurationFingerprint,
      verificationFingerprint: first.verificationFingerprint,
      occurredAt: first.occurredAt,
      receivedAt: first.receivedAt,
    })
  })

  it('retains a callback that arrived before durable acceptance and projects it only after acceptance', async () => {
    const receipt = newUuid()
    const stored = event(randomUUID(), { providerReceiptId: receipt, eventType: 'email.delivered', occurredAt: new Date('2026-10-07T00:00:00.456Z') })
    expect(await repository().record(stored)).toBe('recorded')
    const [unassigned] = await pool!.execute<mysql.RowDataPacket[]>('SELECT id FROM managedSiteEmailProviderEvents WHERE id = ?', [stored.id])
    expect(unassigned).toHaveLength(1)

    const rowId = await insertAcceptedOutbox({ ownerUserId: 7, receipt, acceptedAt: null })
    expect(await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [rowId] })).toEqual([])

    await pool!.execute('UPDATE managedSiteEmailOutbox SET status = ?, acceptedAt = ? WHERE id = ?', ['accepted', NOW, rowId])
    const rows = await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [rowId] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.outboxId).toBe(rowId)
    expect(rows[0]!.facts).toMatchObject({ eventCount: 1, delivered: true, lastEventAt: new Date('2026-10-07T00:00:00.456Z'), deliveredAt: new Date('2026-10-07T00:00:00.456Z') })
    expect(projectEmailProviderObservation(rows[0]!.facts)).toMatchObject({ providerState: 'delivered_to_server', providerReportedDeliveredAt: '2026-10-07T00:00:00.456Z', inboxDeliveryVerified: false })
  })

  it('requires exact receipt and configuration, accepted owner scope, and rejects null-owner or ambiguous receipts', async () => {
    const receiptA = newUuid(), receiptB = newUuid(), receiptC = newUuid(), receiptD = newUuid(), receiptE = newUuid()
    const ownerA = await insertAcceptedOutbox({ ownerUserId: 7, receipt: receiptA })
    const ownerB = await insertAcceptedOutbox({ ownerUserId: 8, receipt: receiptB })
    const nullOwner = await insertAcceptedOutbox({ ownerUserId: null, receipt: receiptC })
    const ambiguousA = await insertAcceptedOutbox({ ownerUserId: 7, receipt: receiptD })
    const ambiguousB = await insertAcceptedOutbox({ ownerUserId: 9, receipt: receiptD })
    const sameReceiptConfigA = await insertAcceptedOutbox({ ownerUserId: 7, receipt: receiptE, configuration: CONFIG })
    const sameReceiptConfigB = await insertAcceptedOutbox({ ownerUserId: 9, receipt: receiptE, configuration: OTHER_CONFIG })
    await repository().record(event(randomUUID(), { providerReceiptId: receiptA, providerConfigurationFingerprint: OTHER_CONFIG }))
    await repository().record(event(randomUUID(), { providerReceiptId: receiptB, providerConfigurationFingerprint: CONFIG }))
    await repository().record(event(randomUUID(), { providerReceiptId: receiptC, providerConfigurationFingerprint: CONFIG }))
    await repository().record(event(randomUUID(), { providerReceiptId: receiptD, providerConfigurationFingerprint: CONFIG }))
    await repository().record(event(randomUUID(), { providerReceiptId: receiptE, providerConfigurationFingerprint: CONFIG }))

    expect(await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [ownerA, ownerB, nullOwner, ambiguousA, ambiguousB] })).toEqual([])
    expect(await repository().listOwnerFacts({ ownerUserId: 8, outboxIds: [ownerB] })).toHaveLength(1)
    expect(await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [ownerB] })).toEqual([])
    expect(await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [nullOwner] })).toEqual([])
    expect(await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [sameReceiptConfigA, sameReceiptConfigB] })).toMatchObject([{ outboxId: sameReceiptConfigA, facts: { eventCount: 1, sent: true } }])
    expect(await repository().listOwnerFacts({ ownerUserId: 9, outboxIds: [sameReceiptConfigB] })).toEqual([])
  })

  it('aggregates out-of-order events with independent millisecond delivery time and conservative priority', async () => {
    const receipt = newUuid(), rowId = await insertAcceptedOutbox({ ownerUserId: 7, receipt })
    const events = [
      event(randomUUID(), { providerReceiptId: receipt, eventType: 'email.complained', occurredAt: new Date('2026-10-07T00:00:00.987Z') }),
      event(randomUUID(), { providerReceiptId: receipt, eventType: 'email.sent', occurredAt: new Date('2026-10-07T00:00:00.123Z') }),
      event(randomUUID(), { providerReceiptId: receipt, eventType: 'email.delivered', occurredAt: new Date('2026-10-07T00:00:00.456Z') }),
      event(randomUUID(), { providerReceiptId: receipt, eventType: 'email.bounced', occurredAt: new Date('2026-10-07T00:00:00.789Z') }),
      event(randomUUID(), { providerReceiptId: receipt, eventType: 'email.delivery_delayed', occurredAt: new Date('2026-10-07T00:00:00.234Z') }),
    ]
    for (const index of [0, 1, 2, 3, 4]) await repository().record(events[index]!)
    const [row] = await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [rowId] })
    expect(row!.facts).toMatchObject({ eventCount: 5, sent: true, delivered: true, deliveryDelayed: true, bounced: true, complained: true, lastEventAt: new Date('2026-10-07T00:00:00.987Z'), deliveredAt: new Date('2026-10-07T00:00:00.456Z') })
    expect(projectEmailProviderObservation(row!.facts)).toMatchObject({ providerState: 'complained', providerLastEventAt: '2026-10-07T00:00:00.987Z', providerReportedDeliveredAt: '2026-10-07T00:00:00.456Z', providerAttentionRequired: true, inboxDeliveryVerified: false })
    const [precision] = await pool!.execute<mysql.RowDataPacket[]>('SELECT DATE_FORMAT(occurredAt, "%Y-%m-%d %H:%i:%s.%f") AS exactTime FROM managedSiteEmailProviderEvents WHERE id = ?', [events[2]!.id])
    expect(precision[0]!.exactTime).toMatch(/\.456000$/u)
  })

  it('bounds owner facts input before SQL aggregation', async () => {
    await expect(repository().listOwnerFacts({ ownerUserId: 0, outboxIds: [] })).rejects.toThrow('Invalid owner email event query.')
    await expect(repository().listOwnerFacts({ ownerUserId: 7, outboxIds: Array.from({ length: 51 }, () => newUuid()) })).rejects.toThrow('Invalid owner email event query.')
    expect(await repository().listOwnerFacts({ ownerUserId: 7, outboxIds: [] })).toEqual([])
  })

  it('rejects non-Date and invalid-year timestamps before any event row is written', async () => {
    const missingDate = event(randomUUID(), { occurredAt: undefined as unknown as Date })
    const invalidDate = event(randomUUID(), { occurredAt: new Date('invalid year') })
    const unsupportedYear = event(randomUUID(), { occurredAt: new Date('0001-01-01T00:00:00.000Z') })
    await expect(repository().record(missingDate)).rejects.toThrow('Invalid email event record.')
    await expect(repository().record(invalidDate)).rejects.toThrow('Invalid email event record.')
    const nonDate = event(randomUUID(), { receivedAt: '2026-10-07T00:00:00.123Z' as unknown as Date })
    await expect(repository().record(nonDate)).rejects.toThrow('Invalid email event record.')
    await expect(repository().record(unsupportedYear)).rejects.toThrow()
    for (const id of [missingDate.id, invalidDate.id, nonDate.id, unsupportedYear.id]) {
      const [rows] = await pool!.execute<mysql.RowDataPacket[]>('SELECT id FROM managedSiteEmailProviderEvents WHERE id = ?', [id])
      expect(rows).toHaveLength(0)
    }
  })
})
