import type { LearningEvidenceCollection, LearningSourceAuthorization } from '../../server/database/schema'
import type { AuthorizationInsert, CollectionInsert, CollectionLease, LearningClient, LearningLoopRepository, LearningSourcePolicy } from '../../server/learning-loop/types'

const copy = <T>(value: T): T => structuredClone(value)
export class LearningLoopMemoryRepository implements LearningLoopRepository {
  clients: LearningClient[] = []
  sources: LearningSourcePolicy[] = []
  authorizations: LearningSourceAuthorization[] = []
  collections: LearningEvidenceCollection[] = []
  constructor(private now = new Date('2026-10-01T00:00:00Z')) {}
  async transaction<T>(work: (repo: LearningLoopRepository) => Promise<T>): Promise<T> { return work(this) }
  async getClient(owner: number, id: number) { return copy(this.clients.find(row => row.ownerUserId === owner && row.id === id) || null) }
  async getSource(owner: number, id: number) { return copy(this.sources.find(row => row.ownerUserId === owner && row.id === id) || null) }
  async getScope(owner: number, id: number) { const authorization = this.authorizations.find(row => row.ownerUserId === owner && row.id === id); if (!authorization) return null; const client = await this.getClient(owner, authorization.clientId), source = await this.getSource(owner, authorization.sourceId); return client && source ? { authorization: copy(authorization), client, source } : null }
  async listClients(owner: number) { return copy(this.clients.filter(row => row.ownerUserId === owner)) }
  async listSources(owner: number) { return copy(this.sources.filter(row => row.ownerUserId === owner)) }
  async listAuthorizations(owner: number) { return copy(this.authorizations.filter(row => row.ownerUserId === owner)) }
  async findAuthorization(owner: number, key: string) { return copy(this.authorizations.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null) }
  async insertAuthorization(input: AuthorizationInsert) { if (this.authorizations.some(row => row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey)) throw Object.assign(new Error('Duplicate synthetic key'), { code: 'ER_DUP_ENTRY' }); const row = { ...copy(input), id: this.authorizations.length + 1, createdAt: this.now }; this.authorizations.push(row); return copy(row) }
  async revokeAuthorization(owner: number, id: number, now: Date) { const row = this.authorizations.find(row => row.ownerUserId === owner && row.id === id && row.status === 'active'); if (!row) return false; row.status = 'revoked'; row.revokedAt = now; return true }
  async getCollection(owner: number, id: number) { return copy(this.collections.find(row => row.ownerUserId === owner && row.id === id) || null) }
  async findCollection(owner: number, key: string) { return copy(this.collections.find(row => row.ownerUserId === owner && row.idempotencyKey === key) || null) }
  async listCollections(owner: number) { return copy(this.collections.filter(row => row.ownerUserId === owner)) }
  async insertCollection(input: CollectionInsert) { if (this.collections.some(row => row.ownerUserId === input.ownerUserId && row.idempotencyKey === input.idempotencyKey)) throw Object.assign(new Error('Duplicate synthetic key'), { code: 'ER_DUP_ENTRY' }); const row = { ...copy(input), id: this.collections.length + 1, createdAt: this.now }; this.collections.push(row); return copy(row) }
  async recoverCollection(lease: CollectionLease, now: Date, expires: Date) { const row = this.collections.find(row => row.id === lease.id && row.ownerUserId === lease.ownerUserId && row.status === 'collecting' && row.leaseVersion === lease.leaseVersion && (!row.leaseExpiresAt || row.leaseExpiresAt <= now)); if (!row) return null; row.leaseVersion += 1; row.leaseToken = lease.leaseToken; row.leaseExpiresAt = expires; return copy(row) }
  async finalizeCollection(lease: CollectionLease, now: Date, result: { status: 'completed' | 'failed'; projection: unknown; projectionFingerprint: string | null; errorCode: string | null }) { const row = this.collections.find(row => row.id === lease.id && row.ownerUserId === lease.ownerUserId && row.status === 'collecting' && row.leaseToken === lease.leaseToken && row.leaseVersion === lease.leaseVersion && row.leaseExpiresAt && row.leaseExpiresAt > now); if (!row) return null; Object.assign(row, copy(result), { completedAt: now, leaseToken: null, leaseExpiresAt: null }); return copy(row) }
  async reviewCollection(owner: number, id: number, status: 'approved' | 'rejected', reviewFingerprint: string, now: Date) { const row = this.collections.find(row => row.id === id && row.ownerUserId === owner && row.status === 'completed' && row.reviewStatus === 'pending' && row.retentionUntil > now); if (!row) return null; Object.assign(row, { reviewStatus: status, reviewFingerprint, reviewedAt: now }); return copy(row) }
  async purgeExpiredCollectionProjections(owner: number, now: Date, limit: number) {
    const rows = this.collections.filter(row => row.ownerUserId === owner && row.retentionUntil <= now && (row.projection !== null || row.status === 'collecting')).slice(0, limit)
    for (const row of rows) Object.assign(row, { projection: null, projectionFingerprint: null, status: 'failed', errorCode: 'RETENTION_EXPIRED', leaseToken: null, leaseExpiresAt: null })
    return rows.length
  }
}

export function learningFixture() {
  const now = new Date('2026-10-01T00:00:00Z'), repository = new LearningLoopMemoryRepository(now)
  repository.clients.push({ id: 2, ownerUserId: 1, displayName: 'Synthetic customer', canonicalSiteOrigin: 'https://client.acme.taipei', status: 'active' })
  repository.sources.push({ id: 3, ownerUserId: 1, sourceFingerprint: 'd'.repeat(64), sourceUrl: 'https://client.acme.taipei/', canonicalUrl: 'https://client.acme.taipei/', allowedUse: 'training_candidate', reviewStatus: 'approved', termsStatus: 'allows_training', robotsStatus: 'reviewed_allow', copyrightRisk: 'low', piiStatus: 'none_detected', licenceReference: null, retentionUntil: null, removedAt: null, removalRequestedAt: null })
  const input = { clientId: 2, sourceId: 3, rightsBasis: 'owner_authorized', rightsEvidenceHash: 'b'.repeat(64), consentReceiptHash: 'c'.repeat(64), consentVersion: 'model-improvement-v1', expiresAt: '2026-10-31T00:00:00.000Z', retentionDays: 30, idempotencyKey: 'grant-1', modelImprovementConsentConfirmed: true, sourceRightsConfirmed: true }
  return { now, repository, input }
}
