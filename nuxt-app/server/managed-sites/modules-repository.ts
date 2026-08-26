import { and, desc, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../database'
import { managedSiteIntegrations } from '../database/schema'
import type { IntegrationRepository, ManagedSiteModuleKey } from './modules-types'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed site integrations are temporarily unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Managed site integration could not be recorded.' })
  return id
}

function makeRepository(database: any): IntegrationRepository {
  const repository: IntegrationRepository = {
    async transaction<T>(work: (repository: IntegrationRepository) => Promise<T>): Promise<T> { return database.transaction((transaction: any) => work(makeRepository(transaction))) as Promise<T> },
    async findById(id) {
      const [row] = await database.select().from(managedSiteIntegrations).where(eq(managedSiteIntegrations.id, id)).limit(1)
      return row || null
    },
    async findByProjectModule(projectId, moduleKey: ManagedSiteModuleKey) {
      const [row] = await database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.projectId, projectId), eq(managedSiteIntegrations.moduleKey, moduleKey))).limit(1)
      return row || null
    },
    async findByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.ownerUserId, ownerUserId), eq(managedSiteIntegrations.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async findByFingerprint(intentFingerprint) {
      const [row] = await database.select().from(managedSiteIntegrations).where(eq(managedSiteIntegrations.intentFingerprint, intentFingerprint)).limit(1)
      return row || null
    },
    async insert(input) {
      const id = rowId(await database.insert(managedSiteIntegrations).values(input as any))
      const row = await repository.findById(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site integration could not be loaded.' })
      return row
    },
    async update(id, patch) {
      await database.update(managedSiteIntegrations).set(patch as any).where(eq(managedSiteIntegrations.id, id))
      return repository.findById(id)
    },
    async listByProject(ownerUserId, projectId) {
      return database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.ownerUserId, ownerUserId), eq(managedSiteIntegrations.projectId, projectId))).orderBy(desc(managedSiteIntegrations.createdAt)).limit(50)
    },
  }
  return repository
}

export function getIntegrationRepository(): IntegrationRepository { return makeRepository(requireDatabase()) }
