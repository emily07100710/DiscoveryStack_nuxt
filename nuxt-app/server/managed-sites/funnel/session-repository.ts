import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { managedSiteFunnelSessions, type ManagedSiteFunnelSession } from '../../database/schema'

export type FunnelSessionRepository = {
  findSession(sessionId: number): Promise<ManagedSiteFunnelSession | null>
  findSessionByToken(sessionId: number, sessionTokenHash: string): Promise<ManagedSiteFunnelSession | null>
  insertSession(input: Omit<ManagedSiteFunnelSession, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteFunnelSession>
  updateSession(sessionId: number, patch: Partial<Omit<ManagedSiteFunnelSession, 'id' | 'sessionTokenHash' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteFunnelSession | null>
  transitionSession(sessionId: number, expectedStatus: ManagedSiteFunnelSession['status'], patch: Partial<Omit<ManagedSiteFunnelSession, 'id' | 'sessionTokenHash' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteFunnelSession | null>
}

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed site funnel is temporarily unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Managed site funnel session could not be recorded.' })
  return id
}

export function makeFunnelSessionRepository(database: any): FunnelSessionRepository {
  const repository: FunnelSessionRepository = {
    async findSession(sessionId) {
      const [row] = await database.select().from(managedSiteFunnelSessions).where(eq(managedSiteFunnelSessions.id, sessionId)).limit(1)
      return row || null
    },
    async findSessionByToken(sessionId, sessionTokenHash) {
      const [row] = await database.select().from(managedSiteFunnelSessions).where(and(eq(managedSiteFunnelSessions.id, sessionId), eq(managedSiteFunnelSessions.sessionTokenHash, sessionTokenHash))).limit(1)
      return row || null
    },
    async insertSession(input) {
      const id = rowId(await database.insert(managedSiteFunnelSessions).values(input as any))
      const row = await repository.findSession(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site funnel session could not be loaded.' })
      return row
    },
    async updateSession(sessionId, patch) {
      await database.update(managedSiteFunnelSessions).set(patch as any).where(eq(managedSiteFunnelSessions.id, sessionId))
      return repository.findSession(sessionId)
    },
    async transitionSession(sessionId, expectedStatus, patch) {
      const result = await database.update(managedSiteFunnelSessions).set(patch as any).where(and(eq(managedSiteFunnelSessions.id, sessionId), eq(managedSiteFunnelSessions.status, expectedStatus)))
      const affectedRows = Number((result as any)?.[0]?.affectedRows ?? (result as any)?.affectedRows ?? 0)
      return affectedRows === 1 ? repository.findSession(sessionId) : null
    },
  }
  return repository
}

let testRepository: FunnelSessionRepository | null = null

export function setManagedSiteFunnelRepositoryForTests(repository: FunnelSessionRepository | null): void {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site funnel dependency injection is test-only.' })
  testRepository = repository
}

export function getFunnelSessionRepository(): FunnelSessionRepository {
  return process.env.NODE_ENV === 'test' && testRepository ? testRepository : makeFunnelSessionRepository(requireDatabase())
}
