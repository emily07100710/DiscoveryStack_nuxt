import { createError } from 'h3'
import { and, desc, eq, gt } from 'drizzle-orm'
import { getDatabase } from '../database'
import { managedSiteShopifyAuthorizations, managedSiteShopifyWebhooks } from '../database/schema'
import type { ShopifyRepository } from './shopify-types'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Shopify integration is temporarily unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Shopify integration record could not be recorded.' })
  return id
}

function makeRepository(database: any): ShopifyRepository {
  const repository: ShopifyRepository = {
    async transaction<T>(work: (repository: ShopifyRepository) => Promise<T>): Promise<T> {
      return database.transaction((transaction: any) => work(makeRepository(transaction))) as Promise<T>
    },
    async findAuthorizationByStateHash(stateHash) {
      const [row] = await database.select().from(managedSiteShopifyAuthorizations).where(eq(managedSiteShopifyAuthorizations.stateHash, stateHash)).limit(1)
      return row || null
    },
    async insertAuthorization(input) {
      const id = rowId(await database.insert(managedSiteShopifyAuthorizations).values(input as any))
      const [row] = await database.select().from(managedSiteShopifyAuthorizations).where(eq(managedSiteShopifyAuthorizations.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Shopify authorization record could not be loaded.' })
      return row
    },
    async claimAuthorization(stateHash, consumedAt) {
      const result = await database.update(managedSiteShopifyAuthorizations).set({ status: 'consumed', consumedAt } as any).where(and(eq(managedSiteShopifyAuthorizations.stateHash, stateHash), eq(managedSiteShopifyAuthorizations.status, 'pending'), gt(managedSiteShopifyAuthorizations.expiresAt, consumedAt)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      const [row] = await database.select().from(managedSiteShopifyAuthorizations).where(and(eq(managedSiteShopifyAuthorizations.stateHash, stateHash), eq(managedSiteShopifyAuthorizations.status, 'consumed'))).limit(1)
      return row || null
    },
    async findWebhookByIntegrationEvent(integrationId, webhookId) {
      const [row] = await database.select().from(managedSiteShopifyWebhooks).where(and(eq(managedSiteShopifyWebhooks.integrationId, integrationId), eq(managedSiteShopifyWebhooks.webhookId, webhookId))).limit(1)
      return row || null
    },
    async findWebhookByFingerprint(ownerUserId, eventFingerprint) {
      const [row] = await database.select().from(managedSiteShopifyWebhooks).where(and(eq(managedSiteShopifyWebhooks.ownerUserId, ownerUserId), eq(managedSiteShopifyWebhooks.eventFingerprint, eventFingerprint))).limit(1)
      return row || null
    },
    async insertWebhook(input) {
      try {
        const id = rowId(await database.insert(managedSiteShopifyWebhooks).values(input as any))
        const [row] = await database.select().from(managedSiteShopifyWebhooks).where(eq(managedSiteShopifyWebhooks.id, id)).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Shopify webhook record could not be loaded.' })
        return row
      } catch (error: any) {
        if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) {
          const replay = await repository.findWebhookByIntegrationEvent(input.integrationId, input.webhookId)
          if (replay) return replay
        }
        throw error
      }
    },
  }
  return repository
}

export function getShopifyRepository(): ShopifyRepository { return makeRepository(requireDatabase()) }
