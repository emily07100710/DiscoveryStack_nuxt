import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it } from 'vitest'
import { createContentOperationsRepositoryFromDatabase } from '../server/content-operations/repository'

describe('governed outcome read capacity', () => {
  it('keeps the existing workbench default, admits learning-sized reads, and caps every owner-scoped query', async () => {
    const limits: number[] = [], clauses: unknown[] = [], ordering: unknown[][] = []
    const query = {
      from() { return this }, where(clause: unknown) { clauses.push(clause); return this },
      orderBy(...columns: unknown[]) { ordering.push(columns); return this },
      async limit(count: number) { limits.push(count); return [] },
    }
    const repository = createContentOperationsRepositoryFromDatabase({ select: () => query } as never)
    await repository.listOutcomes(7)
    await repository.listOutcomes(7, 500)
    await repository.listOutcomes(7, 10000)
    await repository.listOutcomes(7, -2)
    await repository.listOutcomes(7, Number.NaN)
    expect(limits).toEqual([100, 500, 500, 1, 100])
    const dialect = new MySqlDialect()
    for (const clause of clauses) {
      const sql = dialect.sqlToQuery(clause as never)
      expect(sql.sql).toContain('ownerUserId'); expect(sql.params).toEqual([7])
    }
    expect(ordering.every(columns => columns.length === 2)).toBe(true)
  })
})
