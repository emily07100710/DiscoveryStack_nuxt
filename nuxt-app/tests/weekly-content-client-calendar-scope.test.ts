import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { describe, expect, it, vi } from 'vitest'
import { createContentOperationsRepositoryFromDatabase } from '../server/content-operations/repository'

function calendar(id: number, ownerUserId: number, clientId: number) {
  return { id, ownerUserId, clientId, createdAt: new Date(`2026-10-${String((id % 28) + 1).padStart(2, '0')}T00:00:00.000Z`) }
}

describe('weekly calendar history query scope', () => {
  it('keeps the legacy owner-only query unchanged and applies client scope before the 101-row sentinel', async () => {
    const clauses: unknown[] = [], limits: number[] = [], steps: string[] = []
    const query = {
      from() { steps.push('from'); return this },
      where(clause: unknown) { clauses.push(clause); steps.push('where'); return this },
      orderBy() { steps.push('orderBy'); return this },
      async limit(count: number) {
        limits.push(count); steps.push('limit')
        return count === 101 ? [calendar(1, 7, 22)] : []
      },
    }
    const repository = createContentOperationsRepositoryFromDatabase({ select: () => query } as never)

    await repository.listCalendars(7)
    expect(limits).toEqual([100])
    const legacySql = new MySqlDialect().sqlToQuery(clauses[0] as never)
    expect(legacySql.sql).toContain('ownerUserId')
    expect(legacySql.sql).not.toContain('clientId')
    expect(legacySql.params).toEqual([7])

    steps.length = 0
    await repository.listCalendars(7, 22)
    expect(limits).toEqual([100, 101])
    expect(steps.indexOf('where')).toBeLessThan(steps.indexOf('limit'))
    const scopedSql = new MySqlDialect().sqlToQuery(clauses[1] as never)
    expect(scopedSql.sql).toContain('ownerUserId')
    expect(scopedSql.sql).toContain('clientId')
    expect(scopedSql.params).toEqual([7, 22])
  })

  it('rejects invalid owner/client scope before issuing SQL', async () => {
    const select = vi.fn(() => { throw new Error('SQL must not run for invalid scope') })
    const repository = createContentOperationsRepositoryFromDatabase({ select } as never)
    const invalidScopes = [[0, 2], [1.5, 2], [Number.MAX_SAFE_INTEGER + 1, 2], [7, 0], [7, 2.5], [7, Number.MAX_SAFE_INTEGER + 1]] as const
    for (const [owner, client] of invalidScopes) {
      await expect(repository.listCalendars(owner, client)).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Client calendar scope is invalid.' })
    }
    expect(select).not.toHaveBeenCalled()
  })

  it('fails closed on the 101st client calendar instead of returning a truncated history', async () => {
    const selected = Array.from({ length: 101 }, (_, index) => calendar(101 - index, 7, 22))
    const query = {
      from() { return this }, where() { return this }, orderBy() { return this },
      async limit(count: number) { expect(count).toBe(101); return selected },
    }
    const repository = createContentOperationsRepositoryFromDatabase({ select: () => query } as never)
    await expect(repository.listCalendars(7, 22)).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: 'Client calendar history exceeds the safe weekly processing limit.',
    })
  })
})
