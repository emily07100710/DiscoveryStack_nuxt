import { createError } from 'h3'
import { and, asc, desc, eq, isNull, lt, lte, or } from 'drizzle-orm'
import { getDatabase } from '../../database'
import {
  managedSiteConnectorAttempts,
  managedSiteConnectorReceipts,
  managedSiteGenerationCandidates,
  managedSiteProviderConfigurations,
  managedSiteReleaseProjections,
} from '../../database/schema'
import type { ManagedSiteLiveConnectorRepository } from './types'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed-site live connector storage is unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as Array<Record<string, unknown>> | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Managed-site connector record could not be stored.' })
  return id
}

function duplicate(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number; message?: string }
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062 || /duplicate entry|unique constraint/iu.test(candidate?.message || '')
}

export function makeManagedSiteLiveConnectorRepository(database: any): ManagedSiteLiveConnectorRepository {
  const repository: ManagedSiteLiveConnectorRepository = {
    async transaction<T>(work: (repository: ManagedSiteLiveConnectorRepository) => Promise<T>): Promise<T> {
      return database.transaction((transaction: any) => work(makeManagedSiteLiveConnectorRepository(transaction))) as Promise<T>
    },
    async findProviderConfiguration(ownerUserId, capability) {
      const [row] = await database.select().from(managedSiteProviderConfigurations).where(and(eq(managedSiteProviderConfigurations.ownerUserId, ownerUserId), eq(managedSiteProviderConfigurations.capability, capability))).limit(1)
      return row || null
    },
    async listProviderConfigurations(ownerUserId) {
      return database.select().from(managedSiteProviderConfigurations).where(eq(managedSiteProviderConfigurations.ownerUserId, ownerUserId)).orderBy(asc(managedSiteProviderConfigurations.capability)).limit(10)
    },
    async findProviderConfigurationByFingerprint(ownerUserId, fingerprint) {
      const [row] = await database.select().from(managedSiteProviderConfigurations).where(and(eq(managedSiteProviderConfigurations.ownerUserId, ownerUserId), eq(managedSiteProviderConfigurations.configurationFingerprint, fingerprint))).limit(1)
      return row || null
    },
    async insertProviderConfiguration(input) {
      try {
        const id = rowId(await database.insert(managedSiteProviderConfigurations).values(input as any))
        const [row] = await database.select().from(managedSiteProviderConfigurations).where(eq(managedSiteProviderConfigurations.id, id)).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site provider configuration could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findProviderConfiguration(input.ownerUserId, input.capability)
        if (replay && replay.configurationFingerprint === input.configurationFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Managed-site provider configuration collides with an existing owner-scoped record.' })
      }
    },
    async updateProviderConfiguration(id, patch) {
      await database.update(managedSiteProviderConfigurations).set(patch as any).where(eq(managedSiteProviderConfigurations.id, id))
      const [row] = await database.select().from(managedSiteProviderConfigurations).where(eq(managedSiteProviderConfigurations.id, id)).limit(1)
      return row || null
    },
    async findGenerationCandidate(ownerUserId, candidateId) {
      const [row] = await database.select().from(managedSiteGenerationCandidates).where(and(eq(managedSiteGenerationCandidates.ownerUserId, ownerUserId), eq(managedSiteGenerationCandidates.id, candidateId))).limit(1)
      return row || null
    },
    async findGenerationCandidateByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteGenerationCandidates).where(and(eq(managedSiteGenerationCandidates.ownerUserId, ownerUserId), eq(managedSiteGenerationCandidates.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async findGenerationCandidateByRequest(ownerUserId, requestFingerprint) {
      const [row] = await database.select().from(managedSiteGenerationCandidates).where(and(eq(managedSiteGenerationCandidates.ownerUserId, ownerUserId), eq(managedSiteGenerationCandidates.requestFingerprint, requestFingerprint))).limit(1)
      return row || null
    },
    async insertGenerationCandidate(input) {
      try {
        const id = rowId(await database.insert(managedSiteGenerationCandidates).values(input as any))
        const row = await repository.findGenerationCandidate(input.ownerUserId, id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site generation candidate could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findGenerationCandidateByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay && replay.requestFingerprint === input.requestFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Generation candidate identity collides with another request.' })
      }
    },
    async listGenerationCandidates(ownerUserId, projectId) {
      return database.select().from(managedSiteGenerationCandidates).where(and(eq(managedSiteGenerationCandidates.ownerUserId, ownerUserId), eq(managedSiteGenerationCandidates.projectId, projectId))).orderBy(desc(managedSiteGenerationCandidates.createdAt)).limit(100)
    },
    async findRelease(ownerUserId, releaseId) {
      const [row] = await database.select().from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.id, releaseId))).limit(1)
      return row || null
    },
    async findReleaseByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertRelease(input) {
      try {
        const id = rowId(await database.insert(managedSiteReleaseProjections).values(input as any))
        const row = await repository.findRelease(input.ownerUserId, id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site release projection could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findReleaseByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay && replay.projectionFingerprint === input.projectionFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Managed-site release identity collides with another project or version.' })
      }
    },
    async updateRelease(ownerUserId, releaseId, patch) {
      await database.update(managedSiteReleaseProjections).set(patch as any).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.id, releaseId)))
      return repository.findRelease(ownerUserId, releaseId)
    },
    async listReleases(ownerUserId, projectId) {
      return database.select().from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.projectId, projectId))).orderBy(desc(managedSiteReleaseProjections.createdAt)).limit(100)
    },
    async findAttempt(ownerUserId, attemptId) {
      const [row] = await database.select().from(managedSiteConnectorAttempts).where(and(eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId), eq(managedSiteConnectorAttempts.id, attemptId))).limit(1)
      return row || null
    },
    async findAttemptByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteConnectorAttempts).where(and(eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId), eq(managedSiteConnectorAttempts.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertAttempt(input) {
      try {
        const id = rowId(await database.insert(managedSiteConnectorAttempts).values(input as any))
        const row = await repository.findAttempt(input.ownerUserId, id)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site connector attempt could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findAttemptByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay && replay.requestFingerprint === input.requestFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Managed-site connector attempt collides with another request.' })
      }
    },
    async updateAttempt(ownerUserId, attemptId, patch) {
      await database.update(managedSiteConnectorAttempts).set(patch as any).where(and(eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId), eq(managedSiteConnectorAttempts.id, attemptId)))
      return repository.findAttempt(ownerUserId, attemptId)
    },
    async acquireAttemptLease(ownerUserId, attemptId, leaseOwner, now, leaseMs) {
      const result = await database.update(managedSiteConnectorAttempts).set({ status: 'processing', leaseOwner, leaseExpiresAt: new Date(now.getTime() + leaseMs), retryEligibleAt: null } as any).where(and(
        eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId),
        eq(managedSiteConnectorAttempts.id, attemptId),
        or(
          eq(managedSiteConnectorAttempts.status, 'queued'),
          and(eq(managedSiteConnectorAttempts.status, 'retry_wait'), or(isNull(managedSiteConnectorAttempts.retryEligibleAt), lte(managedSiteConnectorAttempts.retryEligibleAt, now))),
          and(eq(managedSiteConnectorAttempts.status, 'processing'), or(isNull(managedSiteConnectorAttempts.leaseExpiresAt), lt(managedSiteConnectorAttempts.leaseExpiresAt, now))),
        ),
      ))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findAttempt(ownerUserId, attemptId)
    },
    async releaseAttemptLease(ownerUserId, attemptId, leaseOwner, patch) {
      const result = await database.update(managedSiteConnectorAttempts).set({ ...patch as any, leaseOwner: null, leaseExpiresAt: null }).where(and(eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId), eq(managedSiteConnectorAttempts.id, attemptId), eq(managedSiteConnectorAttempts.status, 'processing'), eq(managedSiteConnectorAttempts.leaseOwner, leaseOwner)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findAttempt(ownerUserId, attemptId)
    },
    async listAttempts(ownerUserId, projectId) {
      return database.select().from(managedSiteConnectorAttempts).where(and(eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId), eq(managedSiteConnectorAttempts.projectId, projectId))).orderBy(desc(managedSiteConnectorAttempts.createdAt)).limit(200)
    },
    async findReceiptByProviderEvent(providerKey, providerEventId) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.providerKey, providerKey), eq(managedSiteConnectorReceipts.providerEventId, providerEventId))).limit(1)
      return row || null
    },
    async findVerifiedDomainReceipt(canonicalDomain) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.canonicalDomain, canonicalDomain), eq(managedSiteConnectorReceipts.receiptStatus, 'verified'), or(eq(managedSiteConnectorReceipts.receiptType, 'domain_registered'), eq(managedSiteConnectorReceipts.receiptType, 'existing_site_ownership_verified')))).limit(1)
      return row || null
    },
    async findReceiptByFingerprint(ownerUserId, receiptFingerprint) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, ownerUserId), eq(managedSiteConnectorReceipts.receiptFingerprint, receiptFingerprint))).limit(1)
      return row || null
    },
    async insertReceipt(input) {
      const replay = await repository.findReceiptByProviderEvent(input.providerKey, input.providerEventId)
      if (replay) {
        if (replay.receiptFingerprint !== input.receiptFingerprint) throw createError({ statusCode: 409, statusMessage: 'Provider event identity was replayed with different content.' })
        return replay
      }
      try {
        const id = rowId(await database.insert(managedSiteConnectorReceipts).values(input as any))
        const [row] = await database.select().from(managedSiteConnectorReceipts).where(eq(managedSiteConnectorReceipts.id, id)).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site connector receipt could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const concurrent = await repository.findReceiptByProviderEvent(input.providerKey, input.providerEventId)
        if (concurrent?.receiptFingerprint === input.receiptFingerprint) return concurrent
        throw createError({ statusCode: 409, statusMessage: 'Provider receipt collided with an existing immutable event.' })
      }
    },
    async listReceipts(ownerUserId, projectId) {
      return database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, ownerUserId), eq(managedSiteConnectorReceipts.projectId, projectId))).orderBy(desc(managedSiteConnectorReceipts.verifiedAt)).limit(500)
    },
    async listReceiptsByDraftOrder(ownerUserId, draftOrderId) {
      return database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, ownerUserId), eq(managedSiteConnectorReceipts.draftOrderId, draftOrderId))).orderBy(desc(managedSiteConnectorReceipts.verifiedAt)).limit(200)
    },
  }
  return repository
}

export function getManagedSiteLiveConnectorRepository(): ManagedSiteLiveConnectorRepository {
  return makeManagedSiteLiveConnectorRepository(requireDatabase())
}
