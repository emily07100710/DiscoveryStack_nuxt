import { and, asc, eq, gt, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { getDatabase } from '../../database'
import { managedSiteAuditEvents, managedSiteConnectorReceipts, managedSiteDomainClaims, managedSiteDraftOrders, managedSiteFunnelSessions, managedSiteProjects, managedSiteReleaseProjections, type ManagedSiteFunnelSession } from '../../database/schema'

export const MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION = 'funnel_build_quota_reserved'
export type FunnelFulfilmentCandidate = Pick<ManagedSiteFunnelSession, 'id' | 'projectId' | 'releaseId' | 'draftOrderId' | 'previewId' | 'quoteId'> & { ownerUserId: number }

export type FunnelSessionRepository = {
  findSession(sessionId: number): Promise<ManagedSiteFunnelSession | null>
  findSessionByToken(sessionId: number, sessionTokenHash: string): Promise<ManagedSiteFunnelSession | null>
  insertSession(input: Omit<ManagedSiteFunnelSession, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteFunnelSession>
  updateSession(sessionId: number, patch: Partial<Omit<ManagedSiteFunnelSession, 'id' | 'sessionTokenHash' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteFunnelSession | null>
  transitionSession(sessionId: number, expectedStatus: ManagedSiteFunnelSession['status'], patch: Partial<Omit<ManagedSiteFunnelSession, 'id' | 'sessionTokenHash' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteFunnelSession | null>
  countBuildReservationsSince(since: Date): Promise<number>
  listPaidBuildsForFulfilment(afterId: number, limit: number): Promise<FunnelFulfilmentCandidate[]>
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
    async countBuildReservationsSince(since) {
      // EXISTS counts a project once even when it has several retry reservations.
      const renewedReservation = sql`exists (select 1 from ${managedSiteAuditEvents} where ${managedSiteAuditEvents.projectId} = ${managedSiteProjects.id} and ${managedSiteAuditEvents.ownerUserId} = ${managedSiteProjects.ownerUserId} and ${managedSiteAuditEvents.action} = ${MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION} and ${gte(managedSiteAuditEvents.occurredAt, since)})`
      const [row] = await database.select({ count: sql<number>`count(*)` }).from(managedSiteProjects).where(or(gte(managedSiteProjects.createdAt, since), renewedReservation))
      const count = Number(row?.count)
      if (!Number.isSafeInteger(count) || count < 0) throw createError({ statusCode: 503, statusMessage: 'Managed site funnel is temporarily unavailable.' })
      return count
    },
    async listPaidBuildsForFulfilment(afterId, requestedLimit) {
      if (!Number.isSafeInteger(afterId) || afterId < 0) throw createError({ statusCode: 422, statusMessage: 'Funnel fulfilment cursor is invalid.' })
      const limit = Math.min(Math.max(Number.isSafeInteger(requestedLimit) ? requestedLimit : 20, 1), 50)
      const workspaceNotBootstrapped = sql`not exists (select 1 from ${managedSiteConnectorReceipts} where ${managedSiteConnectorReceipts.ownerUserId} = ${managedSiteDraftOrders.ownerUserId} and ${managedSiteConnectorReceipts.projectId} = ${managedSiteFunnelSessions.projectId} and ${managedSiteConnectorReceipts.releaseId} = ${managedSiteReleaseProjections.id} and ${managedSiteConnectorReceipts.contentHash} = ${managedSiteReleaseProjections.contentHash} and ${managedSiteConnectorReceipts.canonicalDomain} = ${managedSiteReleaseProjections.canonicalDomain} and ${managedSiteConnectorReceipts.receiptType} = 'customer_workspace_bootstrapped' and ${managedSiteConnectorReceipts.receiptStatus} = 'verified')`
      const customerNotNotified = sql`not exists (select 1 from ${managedSiteConnectorReceipts} where ${managedSiteConnectorReceipts.ownerUserId} = ${managedSiteDraftOrders.ownerUserId} and ${managedSiteConnectorReceipts.projectId} = ${managedSiteFunnelSessions.projectId} and ${managedSiteConnectorReceipts.releaseId} = ${managedSiteReleaseProjections.id} and ${managedSiteConnectorReceipts.contentHash} = ${managedSiteReleaseProjections.contentHash} and ${managedSiteConnectorReceipts.canonicalDomain} = ${managedSiteReleaseProjections.canonicalDomain} and ${managedSiteConnectorReceipts.receiptType} = 'customer_workspace_notification_sent' and ${managedSiteConnectorReceipts.receiptStatus} = 'verified')`
      // No token/answer projection, and paid obligations remain eligible after browser-token expiry.
      return database.select({ id: managedSiteFunnelSessions.id, projectId: managedSiteFunnelSessions.projectId, releaseId: managedSiteFunnelSessions.releaseId, draftOrderId: managedSiteFunnelSessions.draftOrderId, previewId: managedSiteFunnelSessions.previewId, quoteId: managedSiteFunnelSessions.quoteId, ownerUserId: managedSiteDraftOrders.ownerUserId })
        .from(managedSiteFunnelSessions)
        .innerJoin(managedSiteDraftOrders, and(eq(managedSiteDraftOrders.id, managedSiteFunnelSessions.draftOrderId), eq(managedSiteDraftOrders.projectId, managedSiteFunnelSessions.projectId), eq(managedSiteDraftOrders.previewId, managedSiteFunnelSessions.previewId), eq(managedSiteDraftOrders.quoteId, managedSiteFunnelSessions.quoteId)))
        .innerJoin(managedSiteReleaseProjections, and(eq(managedSiteReleaseProjections.id, managedSiteFunnelSessions.releaseId), eq(managedSiteReleaseProjections.ownerUserId, managedSiteDraftOrders.ownerUserId), eq(managedSiteReleaseProjections.projectId, managedSiteFunnelSessions.projectId), eq(managedSiteReleaseProjections.draftOrderId, managedSiteDraftOrders.id)))
        .leftJoin(managedSiteDomainClaims, and(eq(managedSiteDomainClaims.releaseId, managedSiteReleaseProjections.id), eq(managedSiteDomainClaims.ownerUserId, managedSiteDraftOrders.ownerUserId), eq(managedSiteDomainClaims.projectId, managedSiteFunnelSessions.projectId), eq(managedSiteDomainClaims.canonicalDomain, managedSiteReleaseProjections.canonicalDomain), eq(managedSiteDomainClaims.status, 'verified')))
        .where(and(gt(managedSiteFunnelSessions.id, afterId), inArray(managedSiteFunnelSessions.status, ['checkout_pending', 'converted']), eq(managedSiteDraftOrders.status, 'payment_verified'), eq(managedSiteReleaseProjections.releaseKind, 'generated_site'), or(inArray(managedSiteReleaseProjections.status, ['payment_verified', 'provisioning', 'retry_wait', 'deployment_pending']), and(inArray(managedSiteReleaseProjections.status, ['live_verified', 'geo_active']), or(workspaceNotBootstrapped, customerNotNotified))), or(isNotNull(managedSiteDomainClaims.id), sql`(json_unquote(json_extract(${managedSiteFunnelSessions.answers}, '$.domain.option')) = 'new' and json_unquote(json_extract(${managedSiteFunnelSessions.consentSnapshot}, '$.domainRegistration.delegated')) = 'true')`)))
        .orderBy(asc(managedSiteFunnelSessions.id)).limit(limit)
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
