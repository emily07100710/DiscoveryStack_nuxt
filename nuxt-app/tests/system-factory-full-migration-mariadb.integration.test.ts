import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../server/database/schema'
import { DrizzleModelOpsRepository } from '../server/geo-outcome-model/modelops-repository-drizzle'
import type { ModelOpsCycle, ModelOpsPolicy } from '../server/geo-outcome-model/modelops-types'

const enabled = process.env.DS_RUN_SYSTEM_FACTORY_FULL_MIGRATION_DB_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const suite = enabled ? describe : describe.skip
const migrationDirectory = new URL('../server/database/migrations', import.meta.url).pathname
const mapping = JSON.parse(readFileSync(new URL('../server/database/migrations/mysql-identifier-map.json', import.meta.url), 'utf8')) as {
  corrections: Array<{ corrected: string, table: string, column: string, targetTable: string, targetColumn: string }>
}
let connection: mysql.Connection
const hash = (value: string) => Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)
function planNodes(value: unknown, output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> { if (Array.isArray(value)) { value.forEach(item => planNodes(item, output)); return output }; if (!value || typeof value !== 'object') return output; const record = value as Record<string, unknown>; if (typeof record.table_name === 'string') output.push(record); Object.values(record).forEach(item => planNodes(item, output)); return output }

suite('full-chain disposable MariaDB bootstrap', () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl)
    if (parsed.pathname !== '/discoverystack_full_migration_test') throw new Error('Dedicated disposable full-migration database name is required.')
    connection = await mysql.createConnection(databaseUrl)
    const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES')
    if (tables.length !== 0) throw new Error('Full-migration database must start with zero tables, including no Drizzle migration ledger.')
  })

  afterAll(async () => { await connection?.end() })

  it('applies the official 0000-0032 chain to a truly empty database', async () => {
    await migrate(drizzle(databaseUrl), { migrationsFolder: migrationDirectory })
    const [ledger] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM `__drizzle_migrations`')
    expect(Number(ledger[0]?.count)).toBe(33)

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
      'geoOutcomeModelopsPolicies',
      'geoOutcomeModelopsCycles',
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
    expect(Number(after[0]?.count)).toBe(33)
  }, 30_000)

  it('enforces durable ModelOps lease fencing under concurrent MariaDB takeover', async () => {
    await connection.query("INSERT INTO users (id,openId,role) VALUES (9001,'modelops-db-owner','admin')")
    let clock = new Date('2030-01-01T00:00:00.000Z')
    const database = drizzle(databaseUrl, { schema, mode: 'default' })
    const repositoryA = new DrizzleModelOpsRepository(database, () => new Date(clock))
    const policy: ModelOpsPolicy = { policyId: 'modelops-db-policy', ownerUserId: 9001, status: 'enabled', cadence: 'weekly', minimumNewVerifiedCandidates: 1, minimumNewQueryGroups: 1, minimumNewWebsites: 1, minimumObservationSpanDays: 1, allowedModelFamilies: ['regularized_logistic_baseline_v1'], maximumTrainingRunsPerCycle: 1, cooldownHours: 0, shadowEvaluationEnabled: true, autonomousExecutionEnabled: true, authorizedByOwnerUserId: 9001, authorizedAt: clock.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z', configurationFingerprint: hash('policy'), createdAt: clock.toISOString(), updatedAt: clock.toISOString(), revokedAt: null }
    await repositoryA.savePolicy(9001, policy)
    const cycle: ModelOpsCycle = { cycleId: 'modelops-db-cycle', ownerUserId: 9001, policyId: policy.policyId, policyFingerprint: policy.configurationFingerprint, trigger: 'scheduled', status: 'planned', readinessSnapshotFingerprint: hash('readiness'), eligibleObservationFingerprints: [], previousApprovedDatasetFingerprint: null, generatedDatasetFingerprint: null, trainingRunId: null, modelArtifactId: null, artifactHash: null, shadowEvaluationFingerprint: null, reasonCodes: [], limitations: [], errorClass: null, startedAt: null, completedAt: null, attempt: 0, leaseOwner: null, leaseExpiresAt: null, leaseVersion: 0, idempotencyKey: 'modelops-db-cycle-key', inputFingerprint: hash('cycle'), createdAt: clock.toISOString(), updatedAt: clock.toISOString() }
    await repositoryA.saveCycle(9001, cycle)
    const first = await repositoryA.claimCycle(9001, cycle.cycleId, 'worker-a', new Date(clock.getTime() + 1_000).toISOString())
    expect(first.outcome).toBe('claimed')
    const staleFence = { leaseOwner: 'worker-a', leaseVersion: first.cycle.leaseVersion, attempt: first.cycle.attempt }
    clock = new Date(clock.getTime() + 2_000)
    const repositoryB = new DrizzleModelOpsRepository(database, () => new Date(clock))
    const repositoryC = new DrizzleModelOpsRepository(database, () => new Date(clock))
    const claims = await Promise.all([repositoryB.claimCycle(9001, cycle.cycleId, 'worker-b', new Date(clock.getTime() + 60_000).toISOString()), repositoryC.claimCycle(9001, cycle.cycleId, 'worker-c', new Date(clock.getTime() + 60_000).toISOString())])
    expect(claims.filter(item => item.outcome === 'stale_recovered')).toHaveLength(1)
    expect(claims.filter(item => item.outcome === 'in_progress')).toHaveLength(1)
    const winner = claims.find(item => item.outcome === 'stale_recovered')!.cycle
    await expect(repositoryA.updateCycle(9001, cycle.cycleId, { reasonCodes: ['stale-write'] }, staleFence)).rejects.toThrow(/fence|stale/i)
    await expect(repositoryA.appendEvent(9001, { eventId: 'stale-db-event', ownerUserId: 9001, cycleId: cycle.cycleId, eventType: 'stale_write', eventPayload: {}, eventFingerprint: hash('stale-event'), createdAt: clock.toISOString() }, staleFence)).rejects.toThrow(/fence|stale/i)
    const winnerFence = { leaseOwner: winner.leaseOwner!, leaseVersion: winner.leaseVersion, attempt: winner.attempt }
    await expect(repositoryB.updateCycle(9001, cycle.cycleId, { reasonCodes: ['winner-write'] }, winnerFence)).resolves.toMatchObject({ reasonCodes: ['winner-write'] })
  }, 30_000)

  it('uses indexes for ModelOps scheduler/fence and publication authority hot paths', async () => {
    const database = drizzle(databaseUrl, { schema, mode: 'default' })
    const queries = [
      sql`SELECT ownerUserId FROM ${schema.geoOutcomeModelopsPolicies} WHERE ${schema.geoOutcomeModelopsPolicies.status} = 'enabled' ORDER BY ${schema.geoOutcomeModelopsPolicies.ownerUserId}, ${schema.geoOutcomeModelopsPolicies.updatedAt} LIMIT 25`,
      sql`SELECT cycleId FROM ${schema.geoOutcomeModelopsCycles} WHERE ${schema.geoOutcomeModelopsCycles.ownerUserId} = 9001 AND ${schema.geoOutcomeModelopsCycles.cycleId} = 'modelops-db-cycle'`,
      sql`SELECT id FROM ${schema.contentOperationMachineAuthorizations} WHERE ${schema.contentOperationMachineAuthorizations.ownerUserId} = 9001 AND ${schema.contentOperationMachineAuthorizations.entryId} = 1`,
      sql`SELECT id FROM ${schema.contentOperationBudgetReservations} WHERE ${schema.contentOperationBudgetReservations.ownerUserId} = 9001 AND ${schema.contentOperationBudgetReservations.policyId} = 'policy' AND ${schema.contentOperationBudgetReservations.kind} = 'publication'`,
      sql`SELECT id FROM ${schema.contentOperationPublicationAttempts} WHERE ${schema.contentOperationPublicationAttempts.ownerUserId} = 9001 AND ${schema.contentOperationPublicationAttempts.status} = 'delivered'`,
    ]
    for (const query of queries) {
      const [rows] = await database.execute(sql`EXPLAIN FORMAT=JSON ${query}`) as unknown as [mysql.RowDataPacket[], unknown]
      const nodes = planNodes(JSON.parse(String(rows[0]?.EXPLAIN)))
      expect(nodes.length).toBeGreaterThan(0)
      expect(nodes.every(node => node.access_type !== 'ALL')).toBe(true)
    }
  })
})
