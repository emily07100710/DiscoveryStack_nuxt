import type { LearningPublicationAction } from '../../server/database/schema'
import type { ActionLease, LiveActionInsert, LiveActionRepository, PublicationLease } from '../../server/learning-loop/live-action-repository'

const clone = <T>(value: T): T => structuredClone(value)
const safeDate = (value: Date) => value instanceof Date && Number.isFinite(value.getTime())

/** A small in-memory CAS repository for service lifecycle tests; it mirrors the public repository contract. */
export class LiveActionMemoryRepository implements LiveActionRepository {
  readonly rows: LearningPublicationAction[] = []
  private nextId = 1

  async get(ownerUserId: number, id: number) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.id === id)
    return clone(row || null)
  }

  async findByAttempt(ownerUserId: number, attemptId: number) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.attemptId === attemptId)
    return clone(row || null)
  }

  async list(ownerUserId: number, limit = 100) {
    return clone(this.rows.filter(item => item.ownerUserId === ownerUserId).sort((a, b) => a.id - b.id).slice(0, limit))
  }

  async reserve(input: LiveActionInsert) {
    const existing = this.rows.find(row => row.ownerUserId === input.ownerUserId && row.attemptId === input.attemptId)
    if (existing) return { row: clone(existing), replayed: true }
    const now = new Date()
    const row: LearningPublicationAction = { ...clone(input), id: this.nextId++, createdAt: now, updatedAt: now }
    this.rows.push(row)
    return { row: clone(row), replayed: false }
  }

  async saveBefore(lease: ActionLease, now: Date, input: { beforeProjection: unknown; plannedAction: unknown; beforeCapturedAt: Date }, publicationLease: PublicationLease) {
    const row = this.matchLease(lease)
    if (!row || row.status !== 'capturing_before' || row.expiresAt <= now || !publicationLease.leaseToken || publicationLease.runId !== row.runId
      || !safeDate(input.beforeCapturedAt) || input.beforeCapturedAt > now || !input.beforeProjection || !input.plannedAction) return null
    Object.assign(row, { status: 'before_ready', beforeProjection: clone(input.beforeProjection), plannedAction: clone(input.plannedAction), beforeCapturedAt: input.beforeCapturedAt, updatedAt: now })
    return clone(row)
  }

  async markDispatch(ownerUserId: number, id: number, leaseVersion: number, now: Date, publicationLease: PublicationLease) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.id === id)
    if (!row || row.status !== 'before_ready' || row.leaseVersion !== leaseVersion || row.expiresAt <= now || row.runId !== publicationLease.runId || !publicationLease.leaseToken
      || !row.expectedProjection || !row.beforeProjection || !row.plannedAction || row.dispatchStartedAt) return null
    Object.assign(row, { status: 'dispatch_started', dispatchStartedAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
    return clone(row)
  }

  async attachReceipt(ownerUserId: number, id: number, input: { inputFingerprint: string; receiptFingerprint: string; deliveredAt: Date }, now: Date) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.id === id)
    if (!row || !safeDate(input.deliveredAt) || row.inputFingerprint !== input.inputFingerprint || row.expiresAt <= now) return null
    if ((row.status === 'awaiting_after' || row.status === 'observed') && row.receiptFingerprint === input.receiptFingerprint && row.deliveredAt?.getTime() === input.deliveredAt.getTime()) return clone(row)
    if (row.status !== 'dispatch_started' || !row.dispatchStartedAt || input.deliveredAt < row.dispatchStartedAt || input.deliveredAt > now) return null
    Object.assign(row, { status: 'awaiting_after', receiptFingerprint: input.receiptFingerprint, deliveredAt: input.deliveredAt, nextAttemptAt: now, reasonCode: null, updatedAt: now })
    return clone(row)
  }

  async claimAfter(ownerUserId: number, id: number, expectedVersion: number, token: string, now: Date, expiresAt: Date) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.id === id)
    if (!row || !token || row.leaseVersion !== expectedVersion || row.expiresAt <= now || !safeDate(expiresAt) || expiresAt <= now || expiresAt > row.expiresAt
      || !row.receiptFingerprint || !row.deliveredAt || row.afterAttemptCount >= 6) return null
    const isDue = row.status === 'awaiting_after' && row.nextAttemptAt !== null && row.nextAttemptAt <= now
    const leaseFree = !row.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= now
    const reclaim = row.status === 'capturing_after' && leaseFree
    if (!(isDue && leaseFree) && !reclaim) return null
    Object.assign(row, { status: 'capturing_after', leaseToken: token, leaseVersion: expectedVersion + 1, leaseExpiresAt: expiresAt, afterAttemptCount: row.afterAttemptCount + 1, nextAttemptAt: null, updatedAt: now })
    return clone(row)
  }

  async finishAfter(lease: ActionLease, now: Date, input: { status: 'observed' | 'awaiting_after' | 'blocked'; afterProjection: unknown | null; afterCapturedAt: Date | null; evidenceFingerprint: string | null; reasonCode: string | null; nextAttemptAt: Date | null }) {
    const row = this.matchLease(lease)
    if (!row || row.status !== 'capturing_after' || !row.leaseExpiresAt || row.leaseExpiresAt <= now || row.expiresAt <= now || !row.receiptFingerprint) return null
    if (input.status === 'observed' && (!input.afterProjection || !input.afterCapturedAt || input.afterCapturedAt > now || !input.evidenceFingerprint || input.reasonCode !== null || input.nextAttemptAt !== null)) return null
    if (input.status === 'awaiting_after' && (!input.nextAttemptAt || input.nextAttemptAt <= now || input.afterProjection !== null || input.afterCapturedAt !== null || input.evidenceFingerprint !== null)) return null
    if (input.status === 'blocked' && (input.nextAttemptAt !== null || input.afterProjection !== null || input.afterCapturedAt !== null || input.evidenceFingerprint !== null)) return null
    Object.assign(row, { ...clone(input), status: input.status, leaseToken: null, leaseExpiresAt: null, updatedAt: now })
    return clone(row)
  }

  async review(ownerUserId: number, id: number, evidenceFingerprint: string, decision: 'approved' | 'rejected', reviewFingerprint: string, reviewReasonHash: string, now: Date) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.id === id && item.status === 'observed' && item.reviewStatus === 'pending' && item.evidenceFingerprint === evidenceFingerprint && item.expiresAt > now)
    if (!row) return null
    Object.assign(row, { reviewStatus: decision, reviewFingerprint, reviewEvidenceFingerprint: evidenceFingerprint, reviewReasonHash, reviewedAt: now, updatedAt: now })
    return clone(row)
  }

  async clear(ownerUserId: number, id: number, expectedVersion: number, now: Date, reasonCode: string) {
    const row = this.rows.find(item => item.ownerUserId === ownerUserId && item.id === id && item.leaseVersion === expectedVersion && item.status !== 'expired')
    if (!row) return false
    Object.assign(row, { expectedProjection: null, beforeProjection: null, afterProjection: null, plannedAction: null, status: 'expired', reasonCode, leaseToken: null, leaseExpiresAt: null, leaseVersion: expectedVersion + 1, nextAttemptAt: null, updatedAt: now })
    return true
  }

  async purgeExpired(ownerUserId: number, now: Date, limit = 50) {
    const expired = this.rows.filter(row => row.ownerUserId === ownerUserId && row.expiresAt <= now && (row.expectedProjection !== null || row.beforeProjection !== null || row.afterProjection !== null || row.plannedAction !== null)).slice(0, limit)
    let cleared = 0
    for (const row of expired) if (await this.clear(ownerUserId, row.id, row.leaseVersion, now, 'RETENTION_EXPIRED')) cleared++
    return cleared
  }

  async listLive(ownerUserId: number, offset = 0, limit = 100) {
    return clone(this.rows.filter(row => row.ownerUserId === ownerUserId && row.expiresAt > new Date() && (row.expectedProjection !== null || row.beforeProjection !== null || row.afterProjection !== null || row.plannedAction !== null)).sort((a, b) => a.id - b.id).slice(offset, offset + limit))
  }

  async countLive(ownerUserId: number) {
    return (await this.listLive(ownerUserId)).length
  }

  private matchLease(lease: ActionLease) {
    return this.rows.find(row => row.ownerUserId === lease.ownerUserId && row.id === lease.id && row.leaseToken === lease.leaseToken && row.leaseVersion === lease.leaseVersion)
  }
}
