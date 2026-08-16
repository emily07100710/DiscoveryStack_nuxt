import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDatabase } from '../server/database'

const databaseUrl = process.env.DATABASE_URL

describe('managed MySQL runtime smoke test', () => {
  it.skipIf(!databaseUrl)('executes a read-only health query when the managed database is configured', async () => {
    const database = getDatabase()
    expect(database).not.toBeNull()
    const [rows] = await database!.execute(sql`SELECT 1 AS healthy`) as unknown as [{ healthy: number }[], unknown]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.healthy).toBe(1)
  })
})
