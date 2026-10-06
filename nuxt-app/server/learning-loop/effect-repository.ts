import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { requireAuditDatabase } from '../audit/repository'
import { learningOutcomeModels, type LearningOutcomeModel } from '../database/schema'

export type OutcomeModelInsert = Omit<LearningOutcomeModel, 'id' | 'createdAt'>
export type OutcomeModelLease = { ownerUserId: number; id: number; leaseToken: string; leaseVersion: number }
export interface OutcomeModelRepository {
  list(ownerUserId: number): Promise<LearningOutcomeModel[]>
  countLive(ownerUserId: number): Promise<number>
  listLive(ownerUserId: number, offset: number): Promise<LearningOutcomeModel[]>
  nextPending(ownerUserId: number, now: Date): Promise<LearningOutcomeModel | null>
  get(ownerUserId: number, id: number): Promise<LearningOutcomeModel | null>
  findRelease(ownerUserId: number, datasetDigest: string, lineageFingerprint: string): Promise<LearningOutcomeModel | null>
  reserve(input: OutcomeModelInsert): Promise<LearningOutcomeModel>
  claim(ownerUserId: number, id: number, expectedVersion: number, token: string, now: Date, expiresAt: Date): Promise<LearningOutcomeModel | null>
  finalize(lease: OutcomeModelLease, now: Date, result: Pick<LearningOutcomeModel, 'status' | 'artifact' | 'artifactHash' | 'metrics' | 'reasonCode'>): Promise<LearningOutcomeModel | null>
  revoke(ownerUserId: number, id: number, expectedVersion: number, now: Date, reasonCode: string): Promise<boolean>
}
type Database = ReturnType<typeof requireAuditDatabase>
const affected = (value: unknown): number => { const row = Array.isArray(value) ? value[0] : value; return Number((row as { affectedRows?: number })?.affectedRows || 0) }

/** No memory fallback, no external training provider, no production-model authority. */
export class DrizzleOutcomeModelRepository implements OutcomeModelRepository {
  constructor(private readonly database: Database = requireAuditDatabase()) {}
  list(ownerUserId: number) { return this.database.select().from(learningOutcomeModels).where(eq(learningOutcomeModels.ownerUserId, ownerUserId)).orderBy(desc(learningOutcomeModels.id)).limit(100) }
  async countLive(ownerUserId: number) { const t = learningOutcomeModels; const [row] = await this.database.select({ count: sql<number>`count(*)` }).from(t).where(and(eq(t.ownerUserId, ownerUserId), isNull(t.revokedAt))); return Number(row?.count || 0) }
  listLive(ownerUserId: number, offset: number) { const t = learningOutcomeModels; return this.database.select().from(t).where(and(eq(t.ownerUserId, ownerUserId), isNull(t.revokedAt))).orderBy(asc(t.id)).limit(100).offset(Math.max(0, Math.trunc(offset))) }
  async nextPending(ownerUserId: number, now: Date) { const t = learningOutcomeModels; const [row] = await this.database.select().from(t).where(and(eq(t.ownerUserId, ownerUserId), isNull(t.revokedAt), or(eq(t.status, 'queued'), and(eq(t.status, 'training'), or(isNull(t.leaseExpiresAt), lte(t.leaseExpiresAt, now)))))).orderBy(asc(t.id)).limit(1); return row || null }
  async get(ownerUserId: number, id: number) { const [row] = await this.database.select().from(learningOutcomeModels).where(and(eq(learningOutcomeModels.ownerUserId, ownerUserId), eq(learningOutcomeModels.id, id))).limit(1); return row || null }
  async findRelease(ownerUserId: number, datasetDigest: string, lineageFingerprint: string) { const [row] = await this.database.select().from(learningOutcomeModels).where(and(eq(learningOutcomeModels.ownerUserId, ownerUserId), eq(learningOutcomeModels.datasetDigest, datasetDigest), eq(learningOutcomeModels.lineageFingerprint, lineageFingerprint))).limit(1); return row || null }
  async reserve(input: OutcomeModelInsert) {
    try { await this.database.insert(learningOutcomeModels).values(input) } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY' && (error as { cause?: { code?: string } }).cause?.code !== 'ER_DUP_ENTRY') throw error
    }
    const winner = await this.findRelease(input.ownerUserId, input.datasetDigest, input.lineageFingerprint)
    if (!winner) throw new Error('Outcome model reservation unavailable.')
    return winner
  }
  async claim(ownerUserId: number, id: number, expectedVersion: number, token: string, now: Date, expiresAt: Date) {
    const t = learningOutcomeModels
    const written = await this.database.update(t).set({ status: 'training', leaseVersion: expectedVersion + 1, leaseToken: token, leaseExpiresAt: expiresAt }).where(and(eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.leaseVersion, expectedVersion), isNull(t.revokedAt), or(eq(t.status, 'queued'), and(eq(t.status, 'training'), or(isNull(t.leaseExpiresAt), lte(t.leaseExpiresAt, now))))))
    return affected(written) === 1 ? this.get(ownerUserId, id) : null
  }
  async finalize(lease: OutcomeModelLease, now: Date, result: Pick<LearningOutcomeModel, 'status' | 'artifact' | 'artifactHash' | 'metrics' | 'reasonCode'>) {
    const t = learningOutcomeModels
    const written = await this.database.update(t).set({ ...result, completedAt: now, leaseToken: null, leaseExpiresAt: null }).where(and(eq(t.ownerUserId, lease.ownerUserId), eq(t.id, lease.id), eq(t.status, 'training'), eq(t.leaseToken, lease.leaseToken), eq(t.leaseVersion, lease.leaseVersion), gt(t.leaseExpiresAt, now), isNull(t.revokedAt)))
    return affected(written) === 1 ? this.get(lease.ownerUserId, lease.id) : null
  }
  async revoke(ownerUserId: number, id: number, expectedVersion: number, now: Date, reasonCode: string) {
    const t = learningOutcomeModels
    // Erase derived weights on invalid lineage, retaining only hash-only approval history.
    const result = await this.database.update(t).set({ status: 'revoked', revokedAt: now, artifact: null, artifactHash: null, metrics: null, leaseToken: null, leaseExpiresAt: null, leaseVersion: expectedVersion + 1, reasonCode }).where(and(eq(t.ownerUserId, ownerUserId), eq(t.id, id), eq(t.leaseVersion, expectedVersion), isNull(t.revokedAt)))
    return affected(result) === 1
  }
}
