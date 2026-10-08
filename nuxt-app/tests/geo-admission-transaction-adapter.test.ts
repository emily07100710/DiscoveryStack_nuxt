import { describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from '../server/database/schema'
import { createAdmissionReadFacade, getGeoObservationAdmissionWorkspace } from '../server/geo-outcome-model/admission'
import type { GeoOutcomeDrizzleDatabase } from '../server/geo-outcome-model/repository-drizzle'

function mockMysqlClient(options: { failSelect?: boolean } = {}) {
  const statements: string[] = []
  const client = {
    async query(query: string | { sql: string }) {
      const statement = typeof query === 'string' ? query : query.sql
      statements.push(statement)
      if (options.failSelect && /^select\b/iu.test(statement)) throw new Error('synthetic read failure')
      if (/^select\b/iu.test(statement)) return [[], []]
      return [{ affectedRows: 0 }, []]
    },
  }
  return { client, statements }
}

function mysqlDatabase(client: ReturnType<typeof mockMysqlClient>['client']) {
  return drizzle(client as never, { schema, mode: 'default' })
}

describe('GEO admission MySQL transaction boundary', () => {
  it('uses supported consistent-snapshot transaction SQL and only selects for an empty workspace', async () => {
    const mocked = mockMysqlClient()
    const database = mysqlDatabase(mocked.client)

    await expect(getGeoObservationAdmissionWorkspace(42, {}, database)).resolves.toEqual({
      sources: [],
      nextCursor: null,
      selectedSource: null,
    })

    const statements = mocked.statements.map(statement => statement.replace(/\s+/gu, ' ').trim())
    expect(statements[0]?.toLowerCase()).toBe('set transaction isolation level repeatable read')
    expect(statements[1]?.toLowerCase()).toBe('start transaction with consistent snapshot')
    expect(statements.some(statement => /^select\b/iu.test(statement))).toBe(true)
    expect(statements.at(-1)?.toLowerCase()).toBe('commit')
    expect(statements.some(statement => /\b(read only|insert|update|delete)\b/iu.test(statement))).toBe(false)
  })

  it('rolls back and fails closed when a snapshot read errors', async () => {
    const mocked = mockMysqlClient({ failSelect: true })
    const database = mysqlDatabase(mocked.client)

    await expect(getGeoObservationAdmissionWorkspace(42, {}, database)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'GEO admission storage is unavailable.',
    })

    expect(mocked.statements.at(-1)?.toLowerCase()).toBe('rollback')
    expect(mocked.statements.some(statement => /\b(insert|update|delete)\b/iu.test(statement))).toBe(false)
  })

  it('passes a select-only capability into the admission collector', () => {
    const select = vi.fn()
    const database = {
      select,
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      $client: {},
    } as unknown as GeoOutcomeDrizzleDatabase

    const facade = createAdmissionReadFacade(database)
    expect(Object.keys(facade)).toEqual(['select'])
    expect(facade.select).toBeTypeOf('function')
    for (const capability of ['insert', 'update', 'delete', 'execute', 'transaction', '$client']) {
      expect(facade).not.toHaveProperty(capability)
    }
  })
})
