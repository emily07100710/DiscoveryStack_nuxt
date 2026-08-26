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

function isDuplicateError(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; message?: string }
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062 || /duplicate entry|unique constraint/i.test(candidate?.message || '')
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
    async findByProjectModule(ownerUserId, projectId, moduleKey: ManagedSiteModuleKey) {
      const [row] = await database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.ownerUserId, ownerUserId), eq(managedSiteIntegrations.projectId, projectId), eq(managedSiteIntegrations.moduleKey, moduleKey))).limit(1)
      return row || null
    },
    async findByShopDomain(shopDomain) {
      const [row] = await database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.shopDomain, shopDomain), eq(managedSiteIntegrations.moduleKey, 'shopify_commerce'))).limit(1)
      return row || null
    },
    async findByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.ownerUserId, ownerUserId), eq(managedSiteIntegrations.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async findByFingerprint(ownerUserId, intentFingerprint) {
      const [row] = await database.select().from(managedSiteIntegrations).where(and(eq(managedSiteIntegrations.ownerUserId, ownerUserId), eq(managedSiteIntegrations.intentFingerprint, intentFingerprint))).limit(1)
      return row || null
    },
    async insert(input) {
      try {
        const id = rowId(await database.insert(managedSiteIntegrations).values(input as any))
        const row = await repository.findById(id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site integration could not be loaded.' })
        return row
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        const replay = await repository.findByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay) {
          if (replay.projectId === input.projectId && replay.moduleKey === input.moduleKey && replay.intentFingerprint === input.intentFingerprint) return replay
          throw createError({ statusCode: 409, statusMessage: 'Managed site integration idempotency key is associated with a different configuration.' })
        }
        const sameProjectModule = await repository.findByProjectModule(input.ownerUserId, input.projectId, input.moduleKey)
        if (sameProjectModule) throw createError({ statusCode: 409, statusMessage: 'This project already has a different integration intent for the selected module.' })
        const sameFingerprint = await repository.findByFingerprint(input.ownerUserId, input.intentFingerprint)
        if (sameFingerprint) throw createError({ statusCode: 409, statusMessage: 'Managed site integration fingerprint is already associated with another project.' })
        throw createError({ statusCode: 409, statusMessage: 'Managed site integration could not be created because a unique owner-scoped record is already present.' })
      }
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
