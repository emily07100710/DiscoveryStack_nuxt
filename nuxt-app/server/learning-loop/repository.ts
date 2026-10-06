import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm'
import { requireAuditDatabase } from '../audit/repository'
import { contentOperationClients, learningEvidenceCollections, learningSourceAuthorizations, publicIntelligenceSources } from '../database/schema'
import type { AuthorizationInsert, CollectionInsert, CollectionLease, LearningLoopRepository } from './types'

type Database = ReturnType<typeof requireAuditDatabase>
function affected(value: unknown): number {
  const row = Array.isArray(value) ? value[0] : value
  return Number((row as { affectedRows?: number; rowsAffected?: number })?.affectedRows ?? (row as { rowsAffected?: number })?.rowsAffected ?? 0)
}

export class DrizzleLearningLoopRepository implements LearningLoopRepository {
  constructor(private readonly database: Database = requireAuditDatabase()) {}
  async transaction<T>(callback: (repository: LearningLoopRepository) => Promise<T>): Promise<T> {
    return this.database.transaction(transaction => callback(new DrizzleLearningLoopRepository(transaction as unknown as Database)))
  }
  async getClient(ownerUserId: number, clientId: number) {
    const [row] = await this.database.select().from(contentOperationClients).where(and(eq(contentOperationClients.ownerUserId, ownerUserId), eq(contentOperationClients.id, clientId))).limit(1)
    return row || null
  }
  async getSource(ownerUserId: number, sourceId: number) {
    const [row] = await this.database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.ownerUserId, ownerUserId), eq(publicIntelligenceSources.id, sourceId))).limit(1)
    return row || null
  }
  async getScope(ownerUserId: number, authorizationId: number) {
    const [authorization] = await this.database.select().from(learningSourceAuthorizations).where(and(eq(learningSourceAuthorizations.ownerUserId, ownerUserId), eq(learningSourceAuthorizations.id, authorizationId))).limit(1)
    if (!authorization) return null
    const [client, source] = await Promise.all([this.getClient(ownerUserId, authorization.clientId), this.getSource(ownerUserId, authorization.sourceId)])
    return client && source ? { authorization, client, source } : null
  }
  listClients(ownerUserId: number) { return this.database.select().from(contentOperationClients).where(eq(contentOperationClients.ownerUserId, ownerUserId)).orderBy(desc(contentOperationClients.id)).limit(200) }
  listSources(ownerUserId: number) { return this.database.select().from(publicIntelligenceSources).where(and(eq(publicIntelligenceSources.ownerUserId, ownerUserId), isNull(publicIntelligenceSources.removedAt))).orderBy(desc(publicIntelligenceSources.id)).limit(200) }
  listAuthorizations(ownerUserId: number) { return this.database.select().from(learningSourceAuthorizations).where(eq(learningSourceAuthorizations.ownerUserId, ownerUserId)).orderBy(desc(learningSourceAuthorizations.id)).limit(200) }
  async findAuthorization(ownerUserId: number, idempotencyKey: string) {
    const [row] = await this.database.select().from(learningSourceAuthorizations).where(and(eq(learningSourceAuthorizations.ownerUserId, ownerUserId), eq(learningSourceAuthorizations.idempotencyKey, idempotencyKey))).limit(1)
    return row || null
  }
  async insertAuthorization(input: AuthorizationInsert) {
    await this.database.insert(learningSourceAuthorizations).values(input)
    const row = await this.findAuthorization(input.ownerUserId, input.idempotencyKey)
    if (!row) throw new Error('Learning authorization insert failed.')
    return row
  }
  async revokeAuthorization(ownerUserId: number, id: number, now: Date) {
    return affected(await this.database.update(learningSourceAuthorizations).set({ status: 'revoked', revokedAt: now }).where(and(eq(learningSourceAuthorizations.ownerUserId, ownerUserId), eq(learningSourceAuthorizations.id, id), eq(learningSourceAuthorizations.status, 'active'), isNull(learningSourceAuthorizations.revokedAt)))) === 1
  }
  async getCollection(ownerUserId: number, id: number) {
    const [row] = await this.database.select().from(learningEvidenceCollections).where(and(eq(learningEvidenceCollections.ownerUserId, ownerUserId), eq(learningEvidenceCollections.id, id))).limit(1)
    return row || null
  }
  async findCollection(ownerUserId: number, idempotencyKey: string) {
    const [row] = await this.database.select().from(learningEvidenceCollections).where(and(eq(learningEvidenceCollections.ownerUserId, ownerUserId), eq(learningEvidenceCollections.idempotencyKey, idempotencyKey))).limit(1)
    return row || null
  }
  listCollections(ownerUserId: number) { return this.database.select().from(learningEvidenceCollections).where(eq(learningEvidenceCollections.ownerUserId, ownerUserId)).orderBy(desc(learningEvidenceCollections.id)).limit(200) }
  async insertCollection(input: CollectionInsert) {
    await this.database.insert(learningEvidenceCollections).values(input)
    const row = await this.findCollection(input.ownerUserId, input.idempotencyKey)
    if (!row) throw new Error('Learning collection insert failed.')
    return row
  }
  async recoverCollection(lease: CollectionLease, now: Date, expiresAt: Date) {
    const table = learningEvidenceCollections
    const result = await this.database.update(table).set({ leaseToken: lease.leaseToken, leaseVersion: lease.leaseVersion + 1, leaseExpiresAt: expiresAt }).where(and(eq(table.ownerUserId, lease.ownerUserId), eq(table.id, lease.id), eq(table.status, 'collecting'), eq(table.leaseVersion, lease.leaseVersion), or(isNull(table.leaseExpiresAt), lte(table.leaseExpiresAt, now))))
    return affected(result) === 1 ? this.getCollection(lease.ownerUserId, lease.id) : null
  }
  async finalizeCollection(lease: CollectionLease, now: Date, result: { status: 'completed' | 'failed'; projection: unknown; projectionFingerprint: string | null; errorCode: string | null }) {
    const table = learningEvidenceCollections
    const written = await this.database.update(table).set({ ...result, completedAt: now, leaseToken: null, leaseExpiresAt: null }).where(and(eq(table.ownerUserId, lease.ownerUserId), eq(table.id, lease.id), eq(table.status, 'collecting'), eq(table.leaseToken, lease.leaseToken), eq(table.leaseVersion, lease.leaseVersion), gt(table.leaseExpiresAt, now)))
    return affected(written) === 1 ? this.getCollection(lease.ownerUserId, lease.id) : null
  }
  async reviewCollection(ownerUserId: number, id: number, status: 'approved' | 'rejected', reviewFingerprint: string, now: Date) {
    const table = learningEvidenceCollections
    const result = await this.database.update(table).set({ reviewStatus: status, reviewFingerprint, reviewedAt: now }).where(and(eq(table.ownerUserId, ownerUserId), eq(table.id, id), eq(table.status, 'completed'), eq(table.reviewStatus, 'pending'), gt(table.retentionUntil, now)))
    return affected(result) === 1 ? this.getCollection(ownerUserId, id) : null
  }
  async purgeExpiredCollectionProjections(ownerUserId: number, now: Date, limit: number) {
    const table = learningEvidenceCollections
    const eligible = and(eq(table.ownerUserId, ownerUserId), lte(table.retentionUntil, now), or(isNotNull(table.projection), eq(table.status, 'collecting')))
    const rows = await this.database.select({ id: table.id }).from(table).where(eligible).orderBy(asc(table.id)).limit(Math.max(1, Math.min(100, Math.trunc(limit))))
    let purged = 0
    for (const row of rows) {
      // Retain hash-only consent/review history; erase the expired derived feature projection.
      // Fence a stuck collector so it cannot put the projection back after retention expiry.
      purged += affected(await this.database.update(table).set({ projection: null, projectionFingerprint: null, status: 'failed', errorCode: 'RETENTION_EXPIRED', leaseToken: null, leaseExpiresAt: null }).where(and(eq(table.id, row.id), eligible)))
    }
    return purged
  }
}
