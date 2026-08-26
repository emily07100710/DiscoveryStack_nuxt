import { createError } from 'h3'
import { and, asc, desc, eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { leads, managedSiteDraftOrders, managedSiteLeadIntents, managedSitePaymentEvents, managedSitePreviews, managedSiteQuoteLines, managedSiteQuotes, managedSiteSubscriptionIntents } from '../database/schema'
import type { PreviewRepository } from './ordering-types'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed site ordering is temporarily unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Managed site ordering record could not be recorded.' })
  return id
}

export function makeOrderingRepository(database: any): PreviewRepository {
  const repository: PreviewRepository = {
    async transaction<T>(work: (repository: PreviewRepository) => Promise<T>): Promise<T> {
      return database.transaction((transaction: any) => work(makeOrderingRepository(transaction))) as Promise<T>
    },
    async findPreviewById(previewId) {
      const [row] = await database.select().from(managedSitePreviews).where(eq(managedSitePreviews.id, previewId)).limit(1)
      return row || null
    },
    async findPreviewByDraftKey(draftKey) {
      const [row] = await database.select().from(managedSitePreviews).where(eq(managedSitePreviews.draftKey, draftKey)).limit(1)
      return row || null
    },
    async findPreviewByAccessTokenHash(accessTokenHash) {
      const [row] = await database.select().from(managedSitePreviews).where(eq(managedSitePreviews.accessTokenHash, accessTokenHash)).limit(1)
      return row || null
    },
    async findPreviewByFingerprint(fingerprint) {
      const [row] = await database.select().from(managedSitePreviews).where(eq(managedSitePreviews.previewFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async insertPreview(input) {
      const id = rowId(await database.insert(managedSitePreviews).values(input as any))
      const row = await repository.findPreviewById(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site preview could not be loaded.' })
      return row
    },
    async updatePreview(previewId, patch) {
      await database.update(managedSitePreviews).set(patch as any).where(eq(managedSitePreviews.id, previewId))
      return repository.findPreviewById(previewId)
    },
    async findQuoteById(quoteId) {
      const [row] = await database.select().from(managedSiteQuotes).where(eq(managedSiteQuotes.id, quoteId)).limit(1)
      return row || null
    },
    async findQuoteByIdempotency(previewId, key) {
      const [row] = await database.select().from(managedSiteQuotes).where(and(eq(managedSiteQuotes.previewId, previewId), eq(managedSiteQuotes.idempotencyKey, key))).limit(1)
      return row || null
    },
    async findQuoteByFingerprint(fingerprint) {
      const [row] = await database.select().from(managedSiteQuotes).where(eq(managedSiteQuotes.quoteFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async insertQuote(input) {
      const id = rowId(await database.insert(managedSiteQuotes).values(input as any))
      const row = await repository.findQuoteById(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site quote could not be loaded.' })
      return row
    },
    async updateQuote(quoteId, patch) {
      await database.update(managedSiteQuotes).set(patch as any).where(eq(managedSiteQuotes.id, quoteId))
      return repository.findQuoteById(quoteId)
    },
    async insertQuoteLine(input) {
      const id = rowId(await database.insert(managedSiteQuoteLines).values(input as any))
      const [row] = await database.select().from(managedSiteQuoteLines).where(and(eq(managedSiteQuoteLines.quoteId, input.quoteId), eq(managedSiteQuoteLines.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site quote line could not be loaded.' })
      return row
    },
    async listQuoteLines(quoteId) {
      return database.select().from(managedSiteQuoteLines).where(eq(managedSiteQuoteLines.quoteId, quoteId)).orderBy(asc(managedSiteQuoteLines.id)).limit(100)
    },
    async findLeadByFingerprint(fingerprint) {
      const [row] = await database.select({ id: leads.id }).from(leads).where(eq(leads.requestFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async findLeadById(id) {
      const [row] = await database.select({ id: leads.id, name: leads.name, email: leads.email, company: leads.company, website: leads.website }).from(leads).where(eq(leads.id, id)).limit(1)
      return row || null
    },
    async findLeadIntentById(id) {
      const [row] = await database.select().from(managedSiteLeadIntents).where(eq(managedSiteLeadIntents.id, id)).limit(1)
      return row || null
    },
    async insertLead(input) {
      const id = rowId(await database.insert(leads).values({ ...input, modelImprovementConsent: false }))
      return { id }
    },
    async findLeadIntentByIdempotency(previewId, key) {
      const [row] = await database.select().from(managedSiteLeadIntents).where(and(eq(managedSiteLeadIntents.previewId, previewId), eq(managedSiteLeadIntents.idempotencyKey, key))).limit(1)
      return row || null
    },
    async findLeadIntentByFingerprint(fingerprint) {
      const [row] = await database.select().from(managedSiteLeadIntents).where(eq(managedSiteLeadIntents.requestFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async insertLeadIntent(input) {
      const id = rowId(await database.insert(managedSiteLeadIntents).values(input as any))
      const [row] = await database.select().from(managedSiteLeadIntents).where(and(eq(managedSiteLeadIntents.id, id), eq(managedSiteLeadIntents.idempotencyKey, input.idempotencyKey))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site lead intent could not be loaded.' })
      return row
    },
    async findDraftOrderById(orderId) {
      const [row] = await database.select().from(managedSiteDraftOrders).where(eq(managedSiteDraftOrders.id, orderId)).limit(1)
      return row || null
    },
    async findDraftOrderByIdempotency(previewId, key) {
      const [row] = await database.select().from(managedSiteDraftOrders).where(and(eq(managedSiteDraftOrders.previewId, previewId), eq(managedSiteDraftOrders.idempotencyKey, key))).limit(1)
      return row || null
    },
    async findDraftOrderByFingerprint(fingerprint) {
      const [row] = await database.select().from(managedSiteDraftOrders).where(eq(managedSiteDraftOrders.requestFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async insertDraftOrder(input) {
      const id = rowId(await database.insert(managedSiteDraftOrders).values(input as any))
      const row = await repository.findDraftOrderById(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site draft order could not be loaded.' })
      return row
    },
    async updateDraftOrder(orderId, patch) {
      await database.update(managedSiteDraftOrders).set(patch as any).where(eq(managedSiteDraftOrders.id, orderId))
      return repository.findDraftOrderById(orderId)
    },
    async findPaymentEvent(ownerUserId, providerKey, eventId) {
      const [row] = await database.select().from(managedSitePaymentEvents).where(and(ownerUserId === null ? eq(managedSitePaymentEvents.ownerUserId, -1) : eq(managedSitePaymentEvents.ownerUserId, ownerUserId), eq(managedSitePaymentEvents.providerKey, providerKey), eq(managedSitePaymentEvents.eventId, eventId))).limit(1)
      return row || null
    },
    async findPaymentEventByFingerprint(fingerprint) {
      const [row] = await database.select().from(managedSitePaymentEvents).where(eq(managedSitePaymentEvents.eventFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async insertPaymentEvent(input) {
      const id = rowId(await database.insert(managedSitePaymentEvents).values(input as any))
      const [row] = await database.select().from(managedSitePaymentEvents).where(eq(managedSitePaymentEvents.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site payment event could not be loaded.' })
      return row
    },
    async updatePaymentEvent(id, patch) {
      await database.update(managedSitePaymentEvents).set(patch as any).where(eq(managedSitePaymentEvents.id, id))
      const [row] = await database.select().from(managedSitePaymentEvents).where(eq(managedSitePaymentEvents.id, id)).limit(1)
      return row || null
    },
    async findSubscriptionIntentByQuote(quoteId) {
      const [row] = await database.select().from(managedSiteSubscriptionIntents).where(eq(managedSiteSubscriptionIntents.quoteId, quoteId)).limit(1)
      return row || null
    },
    async insertSubscriptionIntent(input) {
      const id = rowId(await database.insert(managedSiteSubscriptionIntents).values(input as any))
      const [row] = await database.select().from(managedSiteSubscriptionIntents).where(eq(managedSiteSubscriptionIntents.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site subscription intent could not be loaded.' })
      return row
    },
    async updateSubscriptionIntent(quoteId, patch) {
      await database.update(managedSiteSubscriptionIntents).set(patch as any).where(eq(managedSiteSubscriptionIntents.quoteId, quoteId))
      return repository.findSubscriptionIntentByQuote(quoteId)
    },
  }
  return repository
}

export function getPreviewRepository(): PreviewRepository {
  return makeOrderingRepository(requireDatabase())
}
