import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.DS_RUN_SYSTEM_FACTORY_FULL_MIGRATION_DB_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const suite = enabled ? describe : describe.skip
const migrationDirectory = new URL('../server/database/migrations', import.meta.url).pathname
const mapping = JSON.parse(readFileSync(new URL('../server/database/migrations/mysql-identifier-map.json', import.meta.url), 'utf8')) as {
  corrections: Array<{ corrected: string, table: string, column: string, targetTable: string, targetColumn: string }>
}
let connection: mysql.Connection

suite('full-chain disposable MariaDB bootstrap', () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl)
    if (parsed.pathname !== '/discoverystack_full_migration_test') throw new Error('Dedicated disposable full-migration database name is required.')
    connection = await mysql.createConnection(databaseUrl)
    const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES')
    if (tables.length !== 0) throw new Error('Full-migration database must start with zero tables, including no Drizzle migration ledger.')
  })

  afterAll(async () => { await connection?.end() })

  it('applies the official 0000-0031 chain to a truly empty database', async () => {
    await migrate(drizzle(databaseUrl), { migrationsFolder: migrationDirectory })
    const [ledger] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM `__drizzle_migrations`')
    expect(Number(ledger[0]?.count)).toBe(32)

    const representativeTables = [
      'users',
      'publicIntelligenceTrainingRuns',
      'contentOperationCalendarEntries',
      'managedSiteProjects',
      'geoOutcomeModelArtifacts',
      'systemSpecs',
      'systemTenants',
      'systemProvisioningRuns',
      'systemProvisioningAttempts',
      'systemReceipts',
    ]
    const [tables] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
      [representativeTables],
    )
    expect(new Set(tables.map(row => row.tableName))).toEqual(new Set(representativeTables))

    const [constraints] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT CONSTRAINT_NAME AS identifier FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()',
    )
    const [indexes] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT DISTINCT INDEX_NAME AS identifier FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()',
    )
    for (const row of [...constraints, ...indexes]) expect(Buffer.byteLength(String(row.identifier), 'utf8')).toBeLessThanOrEqual(64)

    const [foreignKeys] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT CONSTRAINT_NAME AS constraintName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
              REFERENCED_TABLE_NAME AS targetTable, REFERENCED_COLUMN_NAME AS targetColumn
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
    )
    const actual = new Map(foreignKeys.map(row => [row.constraintName, row]))
    for (const expected of mapping.corrections) {
      expect(actual.get(expected.corrected), expected.corrected).toMatchObject({
        tableName: expected.table,
        columnName: expected.column,
        targetTable: expected.targetTable,
        targetColumn: expected.targetColumn,
      })
    }
  }, 120_000)

  it('is a no-op on a second full-chain migrate call', async () => {
    const [before] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM `__drizzle_migrations`')
    await migrate(drizzle(databaseUrl), { migrationsFolder: migrationDirectory })
    const [after] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count, MAX(created_at) AS latest FROM `__drizzle_migrations`')
    expect(after[0]).toEqual(before[0])
    expect(Number(after[0]?.count)).toBe(32)
  }, 30_000)
})
