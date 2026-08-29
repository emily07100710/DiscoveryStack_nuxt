import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { drizzle } from 'drizzle-orm/mysql2'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../server/database/schema'
import { DrizzleProvisioningRepository, eligibleProvisioningRunsQuery } from '../server/system-factory/provisioning-repository-drizzle'
import { testRuntimeAuthority } from '../server/system-factory/runtime-authority'

const enabled = process.env.DS_RUN_SYSTEM_FACTORY_DB_INTEGRATION === '1'
const databaseUrl = process.env.DATABASE_URL || ''
const suite = enabled ? describe : describe.skip
let connection: mysql.Connection
let migrationDirectory = ''

function sha(value: number) { return value.toString(16).padStart(64, '0').slice(-64) }

function planTableNodes(value: unknown, output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) { for (const child of value) planTableNodes(child, output); return output }
  if (!value || typeof value !== 'object') return output
  const record = value as Record<string, unknown>
  if (typeof record.table_name === 'string') output.push(record)
  for (const child of Object.values(record)) planTableNodes(child, output)
  return output
}

suite('System Factory 0031-only disposable MariaDB runtime and query plan', () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl)
    if (parsed.pathname !== '/discoverystack_system_factory_test') throw new Error('Disposable System Factory database name is required.')
    connection = await mysql.createConnection(databaseUrl)
    const [existing] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES')
    if (existing.length) throw new Error('Disposable System Factory database must start empty.')
    for (const table of ['users', 'contentOperationClients', 'managedSiteProjects', 'managedSitePreviews', 'managedSiteQuotes', 'managedSiteDraftOrders', 'managedSitePaymentEvents']) {
      await connection.query(`CREATE TABLE \`${table}\` (\`id\` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (\`id\`))`)
    }
    migrationDirectory = mkdtempSync(join(tmpdir(), 'ds-system-factory-migrations-'))
    mkdirSync(join(migrationDirectory, 'meta'))
    const migrationName = basename(new URL('../server/database/migrations/0031_spooky_rocket_racer.sql', import.meta.url).pathname)
    writeFileSync(join(migrationDirectory, migrationName), readFileSync(new URL(`../server/database/migrations/${migrationName}`, import.meta.url)))
    writeFileSync(join(migrationDirectory, 'meta/_journal.json'), JSON.stringify({ version: '7', dialect: 'mysql', entries: [{ idx: 0, version: '5', when: 1787979885726, tag: migrationName.replace(/\.sql$/u, ''), breakpoints: true }] }))
    await migrate(drizzle(databaseUrl), { migrationsFolder: migrationDirectory })

    await connection.query('INSERT INTO users (id) VALUES (1)')
    const clientRows = Array.from({ length: 1000 }, (_, index) => [index + 1])
    await connection.query('INSERT INTO contentOperationClients (id) VALUES ?', [clientRows])
    const now = new Date('2030-01-01T00:00:00.000Z')
    const past = '2029-12-31 23:59:00'; const future = '2030-01-01 00:01:00'
    for (let start = 0; start < 1000; start += 200) {
      const specs = []; const versions = []; const tenants = []; const plans = []
      for (let offset = start; offset < start + 200; offset++) {
        const id = offset + 1
        specs.push([id, `spec-${id}`, 1, id, 'draft', sha(id), `draft-${id}`, now, now])
        versions.push([id, 1, id, 1, 'system-spec-v1', 'system-spec-compiler-v1', '{}', '{}', sha(id + 1000), sha(id + 2000), sha(id + 3000), `version-${id}`, 'server:test', now])
        tenants.push([id, `tenant-${id}`, 1, id, id, id, sha(id + 4000), 'provisioning_planned', 1, sha(id + 1000), sha(id + 2000), sha(id + 5000), now, now])
        plans.push([id, `plan-${id}`, 1, id, id, sha(id + 6000), '[]', 'planned', `plan-${id}`, now, now])
      }
      await connection.query('INSERT INTO systemSpecs (id,specId,ownerUserId,clientId,status,identityFingerprint,creationIdempotencyKey,createdAt,updatedAt) VALUES ?', [specs])
      await connection.query('INSERT INTO systemSpecVersions (id,ownerUserId,systemSpecId,version,schemaVersion,compilerVersion,normalizedSpec,compiledPlan,specFingerprint,compiledPlanFingerprint,requestFingerprint,idempotencyKey,createdByAuthority,createdAt) VALUES ?', [versions])
      await connection.query('INSERT INTO systemTenants (id,systemTenantId,ownerUserId,clientId,systemSpecId,systemSpecVersionId,siteNameHash,state,stateVersion,specFingerprint,compiledPlanFingerprint,projectionFingerprint,createdAt,updatedAt) VALUES ?', [tenants])
      await connection.query('INSERT INTO systemProvisioningPlans (id,planId,ownerUserId,systemTenantId,systemSpecVersionId,planFingerprint,steps,status,idempotencyKey,createdAt,updatedAt) VALUES ?', [plans])
    }
    for (let start = 1000; start < 10000; start += 500) {
      const specs = []
      for (let offset = start; offset < start + 500; offset++) {
        const id = offset + 1; const clientId = offset % 1000 + 1
        specs.push([id, `spec-${id}`, 1, clientId, 'draft', sha(id), `draft-${id}`, now, now])
      }
      await connection.query('INSERT INTO systemSpecs (id,specId,ownerUserId,clientId,status,identityFingerprint,creationIdempotencyKey,createdAt,updatedAt) VALUES ?', [specs])
    }
    for (let start = 0; start < 10000; start += 500) {
      const runs = []
      for (let offset = start; offset < start + 500; offset++) {
        const tenant = offset % 1000 + 1; const kind = offset % 6
        const status = ['queued', 'retry_wait', 'processing', 'retry_wait', 'processing', 'completed'][kind]
        const retryAt = status === 'retry_wait' ? kind === 1 ? past : future : null
        const leaseAt = status === 'processing' ? kind === 2 ? past : future : null
        runs.push([offset + 1, `run-${offset + 1}`, 1, tenant, tenant, status, 0, 3, status === 'processing' ? `prior-${offset}` : null, leaseAt, retryAt, sha(offset + 7000), `run-key-${offset}`, now, now])
      }
      await connection.query('INSERT INTO systemProvisioningRuns (id,runId,ownerUserId,systemTenantId,planId,status,attempt,maxAttempts,leaseOwner,leaseExpiresAt,retryEligibleAt,inputFingerprint,idempotencyKey,createdAt,updatedAt) VALUES ?', [runs])
    }
  }, 30_000)

  afterAll(async () => { await connection?.end(); if (migrationDirectory) rmSync(migrationDirectory, { recursive: true, force: true }) })

  it('applies only generated 0031 and selects one earliest eligible run for 20 distinct tenants', async () => {
    const repository = new DrizzleProvisioningRepository(drizzle(databaseUrl, { schema, mode: 'default' }), testRuntimeAuthority('mariadb-runtime'))
    const rows = await repository.listEligible(new Date('2030-01-01T00:00:00.000Z'), 20)
    expect(rows).toHaveLength(20); expect(new Set(rows.map(row => row.tenantRowId)).size).toBe(20)
    const [selected] = await connection.query<mysql.RowDataPacket[]>('SELECT status FROM systemProvisioningRuns WHERE id IN (?)', [rows.map(row => row.runRowId)])
    expect(new Set(selected.map(row => row.status))).toEqual(new Set(['queued', 'retry_wait', 'processing']))
    const [count] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM systemProvisioningRuns')
    expect(Number(count[0]?.count)).toBe(10_000)
  })

  it('uses covering range/ref scans for scheduler selection and the owner keyset index', async () => {
    const database = drizzle(databaseUrl, { schema, mode: 'default' })
    const now = new Date('2030-01-01T00:00:00.000Z')
    const [schedulerRows] = await database.execute(sql`EXPLAIN FORMAT=JSON ${eligibleProvisioningRunsQuery(now, 20)}`) as unknown as [mysql.RowDataPacket[], unknown]
    const schedulerPlan = JSON.parse(String(schedulerRows[0]?.EXPLAIN))
    const runNodes = planTableNodes(schedulerPlan).filter(node => node.table_name === 'systemProvisioningRuns')
    expect(runNodes).toHaveLength(3)
    expect(runNodes.every(node => node.access_type !== 'ALL')).toBe(true)
    expect(runNodes.every(node => node.using_index === true)).toBe(true)
    expect(runNodes.filter(node => node.key === 'system_provisioning_runs_retry_eligible_idx')).toHaveLength(2)
    expect(runNodes.filter(node => node.key === 'system_provisioning_runs_lease_eligible_idx')).toHaveLength(1)
    expect(new Set(runNodes.map(node => node.access_type))).toEqual(new Set(['ref', 'range']))

    const [ownerRows] = await connection.query<mysql.RowDataPacket[]>(
      `EXPLAIN FORMAT=JSON SELECT id,specId,clientId,websiteId,managedSiteProjectId,status,identityFingerprint,createdAt,updatedAt
         FROM systemSpecs
        WHERE ownerUserId = ? AND (updatedAt < ? OR (updatedAt = ? AND id < ?))
        ORDER BY updatedAt DESC, id DESC LIMIT 51`,
      [1, now, now, 9500],
    )
    const ownerPlan = JSON.parse(String(ownerRows[0]?.EXPLAIN))
    const ownerNode = planTableNodes(ownerPlan).find(node => node.table_name === 'systemSpecs')
    expect(ownerNode).toBeTruthy()
    expect(ownerNode?.access_type).not.toBe('ALL')
    expect(ownerNode?.key).toBe('system_specs_owner_updated_idx')
  })

  it('permits only one concurrent lease and one concurrent operation attempt', async () => {
    const repository = new DrizzleProvisioningRepository(drizzle(databaseUrl, { schema, mode: 'default' }), testRuntimeAuthority('mariadb-concurrency'))
    const [eligible] = await repository.listEligible(new Date('2030-01-01T00:00:00.000Z'), 1); expect(eligible).toBeTruthy()
    const now = new Date('2030-01-01T00:00:00.000Z'); const expires = new Date(now.getTime() + 660_000)
    const claims = await Promise.all([repository.claim(eligible!.runRowId, 'worker-a', now, expires), repository.claim(eligible!.runRowId, 'worker-b', now, expires)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claim = claims.find(Boolean)!; const requestFingerprint = sha(90_001)
    const attempts = await Promise.allSettled([repository.beginAttempt(claim, 'create_site', requestFingerprint, now, 300_000), repository.beginAttempt(claim, 'create_site', requestFingerprint, now, 300_000)])
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1)
    const [processing] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM systemProvisioningAttempts WHERE runId=? AND operation=? AND status=?', [claim.runRowId, 'create_site', 'processing'])
    expect(Number(processing[0]?.count)).toBe(1)
  })

  it('rolls back a lost attempt CAS without changing the run or inserting a receipt', async () => {
    const database = drizzle(databaseUrl, { schema, mode: 'default' }); const repository = new DrizzleProvisioningRepository(database, testRuntimeAuthority('mariadb-cas'))
    const [row] = await repository.listEligible(new Date('2030-01-01T00:00:00.000Z'), 1); const now = new Date('2030-01-01T00:00:00.000Z'); const expires = new Date(now.getTime() + 660_000); const claim = await repository.claim(row!.runRowId, 'worker-cas', now, expires); expect(claim).toBeTruthy()
    const attempt = await repository.beginAttempt(claim!, 'create_site', sha(90_002), now, 300_000)
    const context = { runPublicId: `run-${claim!.runRowId}`, runtimeAuthority: testRuntimeAuthority('mariadb-cas') } as any
    await expect(repository.commitFailure(claim!, context, { ...attempt, attemptNumber: 99 }, { code: 'TIMEOUT', summary: 'bounded timeout', retryable: true, blocked: false, retryAt: new Date(now.getTime() + 1_000) }, now)).rejects.toMatchObject({ code: 'ATTEMPT_CAS' })
    const [runs] = await connection.query<mysql.RowDataPacket[]>('SELECT status,leaseOwner FROM systemProvisioningRuns WHERE id=?', [claim!.runRowId]); expect(runs[0]).toMatchObject({ status: 'processing', leaseOwner: 'worker-cas' })
    const [receipts] = await connection.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM systemReceipts WHERE runId=?', [claim!.runRowId]); expect(Number(receipts[0]?.count)).toBe(0)
  })
})
