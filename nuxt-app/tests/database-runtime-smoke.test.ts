import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDatabase } from '../server/database'

const databaseUrl = process.env.DATABASE_URL

describe('managed MySQL runtime smoke test', () => {
  it.skipIf(!databaseUrl)('executes a read-only health query when the managed database is configured', async () => {
    const database = getDatabase()
    expect(database).not.toBeNull()
    const result = await database!.execute(sql`SELECT 1 AS healthy`)
    expect(result[0]).toHaveLength(1)
    expect((result[0][0] as { healthy: number }).healthy).toBe(1)
  })
})
