import { describe, expect, it } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { createWeeklyContentRepositoryFromDatabase } from '../server/weekly-content/repository'
import { weeklyContentConfigs, weeklyContentSchedulerCursors } from '../server/database/schema'
import type { WeeklyConfig } from '../server/weekly-content/types'

type Cursor = { ownerUserId: number; afterConfigId: number; updatedAt: Date }
function harness(seed: { configs?: WeeklyConfig[]; cursors?: Cursor[]; overLimit?: boolean; unsafeRows?: boolean; reverseRows?: boolean } = {}) {
  const configRows = structuredClone(seed.configs || [])
  const cursorRows = new Map((seed.cursors || []).map(row => [row.ownerUserId, structuredClone(row)]))
  const trace: Array<{ operation: string; table?: unknown; query?: string; params?: unknown[]; value?: unknown; locked?: boolean; limit?: number }> = []
  let failCommit = false
  let transactionTail: Promise<void> = Promise.resolve()
  const dialect = new MySqlDialect()
  const database: any = {
    insert(table: unknown) { return { values(value: Cursor) { return { onDuplicateKeyUpdate({ set }: { set: Partial<Cursor> }) {
      trace.push({ operation: 'insert', table, value: structuredClone(value) })
      if (!cursorRows.has(value.ownerUserId)) cursorRows.set(value.ownerUserId, { ...value, updatedAt: new Date(0) })
      else if (set.ownerUserId !== undefined) cursorRows.get(value.ownerUserId)!.ownerUserId = set.ownerUserId
      return Promise.resolve([])
    } } } } },
    select() {
      let table: unknown, predicate: any, locked = false, maximum = 0
      const builder: any = {
        from(value: unknown) { table = value; return builder },
        where(value: any) { predicate = value; return builder },
        orderBy() { return builder },
        limit(value: number) { maximum = value; return builder },
        for(mode: string) { locked = mode === 'update'; return builder },
        then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
          const execute = async () => {
          const rendered = dialect.sqlToQuery(predicate)
          trace.push({ operation: 'select', table, query: rendered.sql, params: rendered.params, locked, limit: maximum })
          if (table === weeklyContentSchedulerCursors) {
            const owner = Number(rendered.params[0])
            const row = cursorRows.get(owner)
            return row ? [structuredClone(row)].slice(0, maximum) : []
          }
          const [owner, status, boundary] = rendered.params as [number, string, number]
          const isAfter = rendered.sql.includes('`id` > ?')
          const rows = (seed.unsafeRows ? configRows : configRows.filter(row => row.ownerUserId === owner && row.status === status && (isAfter ? row.id > boundary : row.id <= boundary)))
            .sort((a, b) => a.id - b.id).map(row => structuredClone(row))
          if (seed.reverseRows) rows.reverse()
          return seed.overLimit ? rows : rows.slice(0, maximum)
          }
          return execute().then(resolve, reject)
        },
      }
      return builder
    },
    update(table: unknown) { return { set(value: Partial<Cursor>) { return { where: async (predicate: any) => {
      const rendered = dialect.sqlToQuery(predicate)
      trace.push({ operation: 'update', table, query: rendered.sql, params: rendered.params, value: structuredClone(value) })
      const row = cursorRows.get(Number(rendered.params[0]))
      if (row) Object.assign(row, value)
      return [{ affectedRows: row ? 1 : 0 }]
    } } } } },
    async transaction(work: (tx: unknown) => Promise<unknown>) {
      const previous = transactionTail
      let unlock!: () => void
      transactionTail = new Promise<void>(resolve => { unlock = resolve })
      await previous
      const oldCursors = structuredClone([...cursorRows.entries()])
      try { const result = await work(database); if (failCommit) throw new Error('synthetic transaction rollback'); return result }
      catch (error) { cursorRows.clear(); for (const [owner, row] of oldCursors) cursorRows.set(owner, row); throw error }
      finally { unlock() }
    },
  }
  return {
    repo: createWeeklyContentRepositoryFromDatabase(database), trace, cursorRows,
    rollback() { failCommit = true },
  }
}
function config(id: number, ownerUserId = 1, status: WeeklyConfig['status'] = 'active', clientId = id + 100): WeeklyConfig {
  return { id, ownerUserId, clientId, status, publicationTargetId: 7, policyId: 'policy', policyConfigurationFingerprint: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64), idempotencyKey: `config-${id}`, cadenceDays: 7, reviewTtlHours: 72, createdAt: new Date(0), updatedAt: new Date(0) }
}

describe('weekly scheduler persistent keyset cursor', () => {
  it('advances through bounded active config pages and wraps sparse ids without duplicate selection', async () => {
    const h = harness({ configs: [config(2), config(50), config(900), config(1_000)] })
    expect((await h.repo.claimSchedulerConfigs(1, 2)).map(row => row.id)).toEqual([2, 50])
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(50)
    expect((await h.repo.claimSchedulerConfigs(1, 2)).map(row => row.id)).toEqual([900, 1_000])
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(1_000)
    expect((await h.repo.claimSchedulerConfigs(1, 2)).map(row => row.id)).toEqual([2, 50])
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(50)
  })
  it('moves past paused rows and reaches the active tail beyond the former first-50 window', async () => {
    const configs = [...Array.from({ length: 50 }, (_, i) => config(i + 1, 1, 'paused')), config(51), config(52)]
    const h = harness({ configs })
    expect((await h.repo.claimSchedulerConfigs(1, 1)).map(row => row.id)).toEqual([51])
    expect((await h.repo.claimSchedulerConfigs(1, 1)).map(row => row.id)).toEqual([52])
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(52)
    expect(h.trace.filter(item => item.operation === 'select' && item.table === weeklyContentConfigs).every(item => item.limit === 1)).toBe(true)
  })
  it('keeps independent owner cursor state and SQL-scopes both cursor and config scans', async () => {
    const h = harness({ configs: [config(1, 1), config(2, 1), config(1, 2), config(3, 2)] })
    expect((await h.repo.claimSchedulerConfigs(1, 1)).map(row => row.id)).toEqual([1])
    expect((await h.repo.claimSchedulerConfigs(2, 1)).map(row => row.id)).toEqual([1])
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(1); expect(h.cursorRows.get(2)?.afterConfigId).toBe(1)
    const scans = h.trace.filter(item => item.operation === 'select' && item.table === weeklyContentConfigs)
    for (const scan of scans) { expect(scan.query).toContain('`ownerUserId` = ?'); expect(scan.params?.[0]).toBe(scan.params?.[0] === 1 ? 1 : 2); expect(scan.query).toContain('`status` = ?') }
    expect(h.trace.filter(item => item.operation === 'select' && item.table === weeklyContentSchedulerCursors).every(item => item.locked)).toBe(true)
  })
  it.each([
    ['foreign owner', [config(1, 9)]],
    ['paused row', [config(1, 1, 'paused')]],
    ['invalid id', [{ ...config(1), id: 0 } as WeeklyConfig]],
  ] as const)('fails closed on %s returned data without advancing the cursor', async (_label, rows) => {
    const h = harness({ configs: [...rows], unsafeRows: true })
    const prior = h.cursorRows.get(1)?.afterConfigId
    await expect(h.repo.claimSchedulerConfigs(1, 1)).rejects.toMatchObject({ statusCode: 503 })
    expect(h.cursorRows.get(1)?.afterConfigId ?? prior).toBe(prior)
  })
  it.each([
    ['duplicate ids', [config(1), config(1, 1, 'active', 999)]],
    ['duplicate clients', [config(1), config(2, 1, 'active', 101)]],
  ] as const)('fails closed on %s returned data', async (_label, rows) => {
    const h = harness({ configs: [...rows], unsafeRows: true })
    await expect(h.repo.claimSchedulerConfigs(1, 2)).rejects.toMatchObject({ statusCode: 503 })
  })
  it('fails closed if the driver violates the bounded page size', async () => {
    const h = harness({ configs: [config(1), config(2)], overLimit: true })
    await expect(h.repo.claimSchedulerConfigs(1, 1)).rejects.toMatchObject({ statusCode: 503 })
    expect(h.cursorRows.has(1)).toBe(false)
  })
  it('rejects unordered or out-of-range rows before cursor advancement', async () => {
    const unordered = harness({ configs: [config(1), config(2)], unsafeRows: true, reverseRows: true })
    await expect(unordered.repo.claimSchedulerConfigs(1, 2)).rejects.toMatchObject({ statusCode: 503 })
    expect(unordered.cursorRows.has(1)).toBe(false)
    const outOfRange = harness({ configs: [config(4)], cursors: [{ ownerUserId: 1, afterConfigId: 10, updatedAt: new Date(0) }], unsafeRows: true })
    await expect(outOfRange.repo.claimSchedulerConfigs(1, 1)).rejects.toMatchObject({ statusCode: 503 })
    expect(outOfRange.cursorRows.get(1)?.afterConfigId).toBe(10)
  })
  it.each([[0, 1], [1.5, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [1, 0], [1, 11], [1, 2.1]] as const)(
    'rejects invalid owner/limit (%s, %s) before opening a transaction', async (owner, limit) => {
      const h = harness()
      await expect(h.repo.claimSchedulerConfigs(owner, limit)).rejects.toMatchObject({ statusCode: 422 })
      expect(h.trace).toHaveLength(0)
    },
  )
  it('inserts first without resetting an existing cursor, locks exact owner row and updates only that cursor atomically', async () => {
    const h = harness({ configs: [config(9)], cursors: [{ ownerUserId: 1, afterConfigId: 2, updatedAt: new Date(0) }, { ownerUserId: 2, afterConfigId: 0, updatedAt: new Date(0) }] })
    expect((await h.repo.claimSchedulerConfigs(1, 1)).map(row => row.id)).toEqual([9])
    expect(h.trace[0]).toMatchObject({ operation: 'insert', value: { ownerUserId: 1, afterConfigId: 0 } })
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(9); expect(h.cursorRows.get(2)?.afterConfigId).toBe(0)
    const cursorLock = h.trace.find(item => item.operation === 'select' && item.table === weeklyContentSchedulerCursors)!
    expect(cursorLock.locked).toBe(true); expect(cursorLock.params).toContain(1)
  })
  it('rolls back cursor creation/advancement when the transaction fails', async () => {
    const h = harness({ configs: [config(1)] }); h.rollback()
    await expect(h.repo.claimSchedulerConfigs(1, 1)).rejects.toThrow('synthetic transaction rollback')
    expect(h.cursorRows.size).toBe(0)
  })
  it('serializes concurrent ticks for one owner so pages do not collide or skip', async () => {
    const h = harness({ configs: [config(4), config(8), config(12)] })
    const batches = await Promise.all([h.repo.claimSchedulerConfigs(1, 1), h.repo.claimSchedulerConfigs(1, 1), h.repo.claimSchedulerConfigs(1, 1)])
    expect(batches.map(batch => batch[0]?.id)).toEqual([4, 8, 12])
    expect(h.cursorRows.get(1)?.afterConfigId).toBe(12)
  })
})
