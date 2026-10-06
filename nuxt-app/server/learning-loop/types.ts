import type { LearningEvidenceCollection, LearningSourceAuthorization, publicIntelligenceSources } from '../database/schema'
import type { ContentOperationClientRow } from '../content-operations/types'

export type LearningSourcePolicy = Pick<typeof publicIntelligenceSources.$inferSelect, 'id' | 'ownerUserId' | 'sourceFingerprint' | 'sourceUrl' | 'canonicalUrl' | 'allowedUse' | 'reviewStatus' | 'termsStatus' | 'robotsStatus' | 'copyrightRisk' | 'piiStatus' | 'licenceReference' | 'retentionUntil' | 'removedAt' | 'removalRequestedAt'>
export type LearningClient = Pick<ContentOperationClientRow, 'id' | 'ownerUserId' | 'canonicalSiteOrigin' | 'displayName' | 'status'>
export type LearningScope = { authorization: LearningSourceAuthorization; client: LearningClient; source: LearningSourcePolicy }
export type AuthorizationInsert = Omit<LearningSourceAuthorization, 'id' | 'createdAt'>
export type CollectionInsert = Omit<LearningEvidenceCollection, 'id' | 'createdAt'>
export type CollectionLease = { id: number; ownerUserId: number; leaseToken: string; leaseVersion: number }

export interface LearningLoopRepository {
  transaction<T>(callback: (repository: LearningLoopRepository) => Promise<T>): Promise<T>
  getClient(ownerUserId: number, clientId: number): Promise<LearningClient | null>
  getSource(ownerUserId: number, sourceId: number): Promise<LearningSourcePolicy | null>
  getScope(ownerUserId: number, authorizationId: number): Promise<LearningScope | null>
  listClients(ownerUserId: number): Promise<LearningClient[]>
  listSources(ownerUserId: number): Promise<LearningSourcePolicy[]>
  listAuthorizations(ownerUserId: number): Promise<LearningSourceAuthorization[]>
  findAuthorization(ownerUserId: number, idempotencyKey: string): Promise<LearningSourceAuthorization | null>
  insertAuthorization(input: AuthorizationInsert): Promise<LearningSourceAuthorization>
  revokeAuthorization(ownerUserId: number, id: number, now: Date): Promise<boolean>
  getCollection(ownerUserId: number, id: number): Promise<LearningEvidenceCollection | null>
  findCollection(ownerUserId: number, idempotencyKey: string): Promise<LearningEvidenceCollection | null>
  listCollections(ownerUserId: number): Promise<LearningEvidenceCollection[]>
  insertCollection(input: CollectionInsert): Promise<LearningEvidenceCollection>
  recoverCollection(lease: CollectionLease, now: Date, expiresAt: Date): Promise<LearningEvidenceCollection | null>
  finalizeCollection(lease: CollectionLease, now: Date, result: { status: 'completed' | 'failed'; projection: unknown; projectionFingerprint: string | null; errorCode: string | null }): Promise<LearningEvidenceCollection | null>
  reviewCollection(ownerUserId: number, id: number, status: 'approved' | 'rejected', reviewFingerprint: string, now: Date): Promise<LearningEvidenceCollection | null>
  purgeExpiredCollectionProjections(ownerUserId: number, now: Date, limit: number): Promise<number>
}
