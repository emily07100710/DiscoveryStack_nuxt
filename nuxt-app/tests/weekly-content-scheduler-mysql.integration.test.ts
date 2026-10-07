import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWeeklyContentRepositoryFromDatabase } from '../server/weekly-content/repository'
import { createContentOperationsRepositoryFromDatabase } from '../server/content-operations/repository'

const requested = process.env.DS_RUN_WEEKLY_SCHEDULER_MYSQL_INTEGRATION === '1'
const explicitTestUrl = process.env.DS_WEEKLY_SCHEDULER_MYSQL_URL || ''
let pool: mysql.Pool | undefined
let database: MySql2Database<Record<string, unknown>>
let schemaReady = false
const ownerIds: number[] = []
const configIds: number[] = []
const outboxIds: number[] = []
const calendarIds: number[] = []
let nextConfigId = 1_900_000_000 + (Date.now() % 100_000)
let nextClientId = 1

function parseDedicatedUrl(value: string): URL {
  const url = new URL(value)
  const port = url.port === '' ? 3306 : Number(url.port)
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !/^\/ds_weekly_cursor_[a-z0-9_]+$/u.test(url.pathname) || url.search || url.hash) {
    throw new Error('Only the explicitly supplied isolated loopback weekly-cursor database is permitted.')
  }
  return url
}

async function hasTable(tableName: string): Promise<boolean> {
  const [rows] = await pool!.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS `n` FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [tableName],
  )
  return Number(rows[0]?.n) === 1
}

async function hasForeignKey(tableName: string, constraintName: string): Promise<boolean> {
  const [rows] = await pool!.execute<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS `n` FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_name = ? AND constraint_type = \'FOREIGN KEY\'',
    [tableName, constraintName],
  )
  return Number(rows[0]?.n) === 1
}

function generatedCreate(sourceFile: string, tableName: string): string {
  const source = readFileSync(new URL(`../server/database/migrations/${sourceFile}`, import.meta.url), 'utf8')
  const statement = source.split('--> statement-breakpoint').map(value => value.trim()).find(value => value.startsWith(`CREATE TABLE \`${tableName}\``))
  if (!statement) throw new Error(`Expected generated CREATE TABLE for ${tableName}.`)
  return statement
}

async function ensureFixtureSchema(): Promise<void> {
  if (!await hasTable('users')) await pool!.query(generatedCreate('0000_amusing_maelstrom.sql', 'users'))
  if (!await hasTable('weeklyContentConfigs')) await pool!.query(generatedCreate('0044_peaceful_lethal_legion.sql', 'weeklyContentConfigs'))
  if (!await hasTable('weeklyContentOutbox')) await pool!.query(generatedCreate('0044_peaceful_lethal_legion.sql', 'weeklyContentOutbox'))
  // Exact calendar columns for read-scope verification only, not its unrelated parent/FK migration.
  if (!await hasTable('contentOperationCalendars')) await pool!.query(generatedCreate('0014_tan_stone_men.sql', 'contentOperationCalendars'))

  const migration = readFileSync(new URL('../server/database/migrations/0050_weekly_content_scheduler_cursor_v1.sql', import.meta.url), 'utf8')
  const statements = migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
  if (statements.length !== 2 || !statements[0]!.startsWith('CREATE TABLE `weeklyContentSchedulerCursors`')
    || !statements[1]!.startsWith('ALTER TABLE `weeklyContentSchedulerCursors` ADD CONSTRAINT `weekly_scheduler_cursor_owner_fk`')) {
    throw new Error('Unexpected generated weekly scheduler cursor migration.')
  }
  if (!await hasTable('weeklyContentSchedulerCursors')) await pool!.query(statements[0]!)
  if (!await hasForeignKey('weeklyContentSchedulerCursors', 'weekly_scheduler_cursor_owner_fk')) await pool!.query(statements[1]!)
}

function repository() {
  return createWeeklyContentRepositoryFromDatabase(database as Parameters<typeof createWeeklyContentRepositoryFromDatabase>[0])
}

async function insertOwner(): Promise<number> {
  const [result] = await pool!.execute<mysql.ResultSetHeader>('INSERT INTO users (openId) VALUES (?)', [`weekly-cursor-synthetic:${randomUUID()}`])
  const id = Number(result.insertId)
  ownerIds.push(id)
  return id
}

type ConfigFixture = { id: number; status: 'active' | 'paused'; clientId?: number }
async function insertConfigs(ownerUserId: number, fixtures: ConfigFixture[]): Promise<Array<ConfigFixture & { clientId: number }>> {
  const rows = fixtures.map(row => ({ ...row, clientId: row.clientId ?? nextClientId++ }))
  for (const row of rows) {
    await pool!.execute(
      'INSERT INTO weeklyContentConfigs (id, ownerUserId, clientId, publicationTargetId, policyId, policyConfigurationFingerprint, configurationFingerprint, status, idempotencyKey, cadenceDays, reviewTtlHours) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, ownerUserId, row.clientId, 1, 'synthetic-policy', 'a'.repeat(64), 'b'.repeat(64), row.status, `weekly-cursor:${randomUUID()}`, 7, 72],
    )
    configIds.push(row.id)
  }
  return rows
}

async function insertSyntheticOutbox(ownerUserId: number): Promise<number> {
  const requestRowId = Math.floor(Math.random() * 2_000_000_000) + 1
  const [result] = await pool!.execute<mysql.ResultSetHeader>(
    'INSERT INTO weeklyContentOutbox (ownerUserId, clientId, requestRowId, bindingId, status, payloadFingerprint) VALUES (?, ?, ?, ?, ?, ?)',
    [ownerUserId, 987_654, requestRowId, 654_321, 'queued', 'c'.repeat(64)],
  )
  const id = Number(result.insertId)
  outboxIds.push(id)
  return id
}

async function cursorFor(ownerUserId: number): Promise<mysql.RowDataPacket | undefined> {
  const [rows] = await pool!.execute<mysql.RowDataPacket[]>(
    'SELECT ownerUserId AS `ownerUserId`, afterConfigId AS `afterConfigId`, updatedAt AS `updatedAt` FROM weeklyContentSchedulerCursors WHERE ownerUserId = ?',
    [ownerUserId],
  )
  return rows[0]
}

async function insertCalendars(ownerUserId: number, clientId: number, count: number, createdAt: Date): Promise<number[]> {
  const result: number[] = []
  for (let index = 0; index < count; index++) {
    const [inserted] = await pool!.execute<mysql.ResultSetHeader>(
      'INSERT INTO contentOperationCalendars (ownerUserId, clientId, productionPlanId, engineVersion, status, planStartDate, planEndDate, timeZone, publishLocalTime, cadenceDays, monthlyBudgetUnits, defaultCostUnits, maxItemsPerCalendarMonth, maximumTotalItems, catchUpPolicy, evidenceSnapshotHash, revision, planFingerprint, normalizedRequestSnapshot, resultSnapshot, idempotencyKey, createdAt) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 7, 4, 1, 1, 1, ?, ?, 1, ?, ?, ?, ?, ?)',
      [ownerUserId, clientId, 'synthetic-weekly-history-v1', 'archived', '2026-10-01', '2026-10-01', 'UTC', '10:00', 'skip_missed', 'a'.repeat(64), 'b'.repeat(64), '{}', '{}', `synthetic-calendar:${randomUUID()}`, createdAt],
    )
    const id = Number(inserted.insertId)
    calendarIds.push(id); result.push(id)
  }
  return result
}

async function cleanupSyntheticRows(): Promise<void> {
  if (calendarIds.length) await pool!.execute(`DELETE FROM contentOperationCalendars WHERE id IN (${calendarIds.map(() => '?').join(',')})`, calendarIds)
  if (outboxIds.length) await pool!.execute(`DELETE FROM weeklyContentOutbox WHERE id IN (${outboxIds.map(() => '?').join(',')})`, outboxIds)
  if (configIds.length) await pool!.execute(`DELETE FROM weeklyContentConfigs WHERE id IN (${configIds.map(() => '?').join(',')})`, configIds)
  if (ownerIds.length) {
    await pool!.execute(`DELETE FROM weeklyContentSchedulerCursors WHERE ownerUserId IN (${ownerIds.map(() => '?').join(',')})`, ownerIds)
    await pool!.execute(`DELETE FROM users WHERE id IN (${ownerIds.map(() => '?').join(',')})`, ownerIds)
  }
}

describe.skipIf(!requested || !explicitTestUrl)('isolated weekly scheduler cursor MySQL integration (never production)', () => {
  beforeAll(async () => {
    const url = parseDedicatedUrl(explicitTestUrl)
    pool = mysql.createPool({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      timezone: 'Z',
      connectionLimit: 8,
    })
    database = drizzle(pool)
    await ensureFixtureSchema()
    schemaReady = true
  })

  afterAll(async () => {
    if (pool) {
      if (schemaReady) await cleanupSyntheticRows()
      await pool.end()
    }
  })

  it('installs the exact three-column cursor, owner primary key, FK, default and millisecond precision', async () => {
    const [columns] = await pool!.execute<mysql.RowDataPacket[]>(
      'SELECT COLUMN_NAME AS `columnName`, DATA_TYPE AS `dataType`, COLUMN_TYPE AS `columnType`, COLUMN_DEFAULT AS `columnDefault`, IS_NULLABLE AS `isNullable`, DATETIME_PRECISION AS `precisionDigits` FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
      ['weeklyContentSchedulerCursors'],
    )
    expect(columns.map(row => row.columnName)).toEqual(['ownerUserId', 'afterConfigId', 'updatedAt'])
    expect(columns.map(row => row.isNullable)).toEqual(['NO', 'NO', 'NO'])
    expect(columns.find(row => row.columnName === 'ownerUserId')).toMatchObject({ dataType: 'int' })
    expect(columns.find(row => row.columnName === 'afterConfigId')).toMatchObject({ dataType: 'int', columnDefault: '0' })
    const timestamp = columns.find(row => row.columnName === 'updatedAt')!
    expect(timestamp).toMatchObject({ dataType: 'timestamp', precisionDigits: 3 })
    expect(String(timestamp.columnDefault).toLowerCase()).toBe('current_timestamp(3)')

    const [indexes] = await pool!.execute<mysql.RowDataPacket[]>(
      'SELECT INDEX_NAME AS `indexName`, COLUMN_NAME AS `columnName`, NON_UNIQUE AS `nonUnique` FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY seq_in_index',
      ['weeklyContentSchedulerCursors'],
    )
    expect(indexes).toHaveLength(1)
    expect(indexes[0]).toMatchObject({ indexName: 'PRIMARY', columnName: 'ownerUserId', nonUnique: 0 })

    const [foreignKeys] = await pool!.execute<mysql.RowDataPacket[]>(
      'SELECT COLUMN_NAME AS `columnName`, REFERENCED_TABLE_NAME AS `referencedTable`, REFERENCED_COLUMN_NAME AS `referencedColumn` FROM information_schema.key_column_usage WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_name = ?',
      ['weeklyContentSchedulerCursors', 'weekly_scheduler_cursor_owner_fk'],
    )
    expect(foreignKeys).toEqual([{ columnName: 'ownerUserId', referencedTable: 'users', referencedColumn: 'id' }])

    const owner = await insertOwner()
    await pool!.execute('INSERT INTO weeklyContentSchedulerCursors (ownerUserId) VALUES (?)', [owner])
    const cursor = await cursorFor(owner)
    expect(cursor).toMatchObject({ ownerUserId: owner, afterConfigId: 0 })
    expect(cursor!.updatedAt).toBeInstanceOf(Date)
    const exactTime = new Date('2026-10-07T15:00:00.123Z')
    await pool!.execute('UPDATE weeklyContentSchedulerCursors SET updatedAt = ? WHERE ownerUserId = ?', [exactTime, owner])
    expect((await cursorFor(owner))!.updatedAt).toEqual(exactTime)
    await expect(pool!.execute('INSERT INTO weeklyContentSchedulerCursors (ownerUserId) VALUES (?)', [2_147_000_000])).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' })
  })

  it('skips a paused prefix, traverses sparse active IDs, and wraps deterministically', async () => {
    const owner = await insertOwner()
    const base = nextConfigId
    nextConfigId += 10_000
    const fixtures: ConfigFixture[] = Array.from({ length: 55 }, (_, index) => ({ id: base + (index + 1) * 10, status: 'paused' }))
    fixtures.push(...[1001, 1101, 1201, 1401].map(offset => ({ id: base + offset, status: 'active' as const })))
    const inserted = await insertConfigs(owner, fixtures)
    const first = await repository().claimSchedulerConfigs(owner, 3)
    expect(first.map(row => row.id)).toEqual([base + 1001, base + 1101, base + 1201])
    expect(first.every(row => row.status === 'active' && row.ownerUserId === owner)).toBe(true)
    expect((await cursorFor(owner))?.afterConfigId).toBe(base + 1201)

    const wrapped = await repository().claimSchedulerConfigs(owner, 3)
    expect(wrapped.map(row => row.id)).toEqual([base + 1401, base + 1001, base + 1101])
    expect(wrapped.every(row => row.status === 'active')).toBe(true)
    expect((await cursorFor(owner))?.afterConfigId).toBe(base + 1101)
    expect(inserted.filter(row => row.status === 'paused')).toHaveLength(55)
  })

  it('keeps cursor state owner-scoped and durable across fresh repository instances', async () => {
    const ownerA = await insertOwner(), ownerB = await insertOwner()
    const base = nextConfigId
    nextConfigId += 1_000
    const rowsA = await insertConfigs(ownerA, [10, 30, 90].map(offset => ({ id: base + offset, status: 'active' as const })))
    const rowsB = await insertConfigs(ownerB, [{ id: base + 20, status: 'active' }])

    expect((await repository().claimSchedulerConfigs(ownerA, 2)).map(row => row.id)).toEqual(rowsA.slice(0, 2).map(row => row.id))
    expect((await createWeeklyContentRepositoryFromDatabase(drizzle(pool!) as Parameters<typeof createWeeklyContentRepositoryFromDatabase>[0]).claimSchedulerConfigs(ownerA, 1)).map(row => row.id)).toEqual([rowsA[2]!.id])
    expect((await repository().claimSchedulerConfigs(ownerB, 1)).map(row => row.id)).toEqual([rowsB[0]!.id])
    expect((await cursorFor(ownerA))?.afterConfigId).toBe(rowsA[2]!.id)
    expect((await cursorFor(ownerB))?.afterConfigId).toBe(rowsB[0]!.id)
  })

  it('serializes two claims for one owner into disjoint batches', async () => {
    const owner = await insertOwner()
    const base = nextConfigId
    nextConfigId += 1_000
    const rows = await insertConfigs(owner, Array.from({ length: 6 }, (_, index) => ({ id: base + (index + 1) * 10, status: 'active' as const })))
    const [left, right] = await Promise.all([repository().claimSchedulerConfigs(owner, 3), repository().claimSchedulerConfigs(owner, 3)])
    expect(left).toHaveLength(3)
    expect(right).toHaveLength(3)
    expect(new Set([...left, ...right].map(row => row.id)).size).toBe(6)
    expect([...left, ...right].map(row => row.id).sort((a, b) => a - b)).toEqual(rows.map(row => row.id).sort((a, b) => a - b))
  })

  it('rolls back an actual cursor update when the containing transaction fails and leaves outbox unchanged', async () => {
    const owner = await insertOwner()
    const base = nextConfigId
    nextConfigId += 1_000
    const rows = await insertConfigs(owner, [1, 2, 3].map(offset => ({ id: base + offset, status: 'active' })))
    await repository().claimSchedulerConfigs(owner, 1)
    const beforeCursor = await cursorFor(owner)
    const outboxId = await insertSyntheticOutbox(owner)
    const [beforeOutboxRows] = await pool!.execute<mysql.RowDataPacket[]>('SELECT * FROM weeklyContentOutbox WHERE id = ?', [outboxId])
    const [beforeOutboxCount] = await pool!.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `rowCount` FROM weeklyContentOutbox')
    const realDatabase = database
    const failingDatabase = {
      transaction<T>(work: (transaction: unknown) => Promise<T>) {
        return realDatabase.transaction(async transaction => {
          await work(transaction)
          throw new Error('synthetic failure after scheduler cursor update')
        })
      },
    }
    const failingRepository = createWeeklyContentRepositoryFromDatabase(failingDatabase as Parameters<typeof createWeeklyContentRepositoryFromDatabase>[0])
    await expect(failingRepository.claimSchedulerConfigs(owner, 1)).rejects.toThrow('synthetic failure after scheduler cursor update')

    expect(await cursorFor(owner)).toEqual(beforeCursor)
    const [afterOutboxRows] = await pool!.execute<mysql.RowDataPacket[]>('SELECT * FROM weeklyContentOutbox WHERE id = ?', [outboxId])
    const [afterOutboxCount] = await pool!.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS `rowCount` FROM weeklyContentOutbox')
    expect(afterOutboxRows).toEqual(beforeOutboxRows)
    expect(afterOutboxCount[0]!.rowCount).toBe(beforeOutboxCount[0]!.rowCount)
    expect(rows.map(row => row.id)).toContain((await cursorFor(owner))!.afterConfigId)
  })

  it('does not advance across paused-only data, rejects cursor drift, and rejects invalid scope/cap before cursor creation', async () => {
    const owner = await insertOwner()
    const base = nextConfigId
    nextConfigId += 1_000
    await insertConfigs(owner, Array.from({ length: 4 }, (_, index) => ({ id: base + (index + 1) * 10, status: 'paused' })))
    expect(await repository().claimSchedulerConfigs(owner, 3)).toEqual([])
    expect(await cursorFor(owner)).toMatchObject({ ownerUserId: owner, afterConfigId: 0 })
    const [cursorRowsBeforeInvalid] = await pool!.execute<mysql.RowDataPacket[]>('SELECT ownerUserId FROM weeklyContentSchedulerCursors ORDER BY ownerUserId')
    await expect(repository().claimSchedulerConfigs(0, 1)).rejects.toMatchObject({ statusCode: 422 })
    await expect(repository().claimSchedulerConfigs(owner, 11)).rejects.toMatchObject({ statusCode: 422 })
    const [cursorRowsAfterInvalid] = await pool!.execute<mysql.RowDataPacket[]>('SELECT ownerUserId FROM weeklyContentSchedulerCursors ORDER BY ownerUserId')
    expect(cursorRowsAfterInvalid).toEqual(cursorRowsBeforeInvalid)

    await pool!.execute('UPDATE weeklyContentSchedulerCursors SET afterConfigId = -1 WHERE ownerUserId = ?', [owner])
    await expect(repository().claimSchedulerConfigs(owner, 1)).rejects.toMatchObject({ statusCode: 503 })
    expect((await cursorFor(owner))?.afterConfigId).toBe(-1)
  })

  it('loads an older exact-client calendar even when 103 newer other-client calendars fill the owner UI window', async () => {
    const owner = await insertOwner(), otherOwner = await insertOwner()
    const target = await insertCalendars(owner, 400_001, 1, new Date('2026-10-01T00:00:00Z'))
    await insertCalendars(owner, 400_002, 103, new Date('2026-10-07T00:00:00Z'))
    await insertCalendars(otherOwner, 400_001, 1, new Date('2026-10-07T00:00:00Z'))
    const operations = createContentOperationsRepositoryFromDatabase(database)
    const legacy = await operations.listCalendars(owner)
    expect(legacy).toHaveLength(100)
    expect(legacy.some(row => row.id === target[0])).toBe(false)
    const scoped = await operations.listCalendars(owner, 400_001)
    expect(scoped.map(row => row.id)).toEqual(target)
    expect(scoped.every(row => row.ownerUserId === owner && row.clientId === 400_001)).toBe(true)
  })

  it('refuses the real 101-calendar scoped history instead of returning 100 as complete', async () => {
    const owner = await insertOwner()
    await insertCalendars(owner, 500_001, 101, new Date('2026-10-07T00:00:00Z'))
    const [before] = await pool!.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM contentOperationCalendars WHERE ownerUserId = ? AND clientId = ?', [owner, 500_001])
    await expect(createContentOperationsRepositoryFromDatabase(database).listCalendars(owner, 500_001)).rejects.toMatchObject({
      statusCode: 409, statusMessage: 'Client calendar history exceeds the safe weekly processing limit.',
    })
    const [after] = await pool!.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS n FROM contentOperationCalendars WHERE ownerUserId = ? AND clientId = ?', [owner, 500_001])
    expect(after).toEqual(before)
    expect(Number(after[0]!.n)).toBe(101)
  })
})
