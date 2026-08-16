import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'

let database: ReturnType<typeof drizzle<typeof schema>> | undefined

/** Lazily open the managed MySQL/TiDB connection; routes fail closed when the database is unavailable. */
export function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return null
  if (!database) database = drizzle(databaseUrl, { schema, mode: 'default' })
  return database
}
