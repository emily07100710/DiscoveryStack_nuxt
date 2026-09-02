import { createError } from 'h3'
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { getDatabase } from '../../database'
import {
  managedSiteConnectorAttempts,
  managedSiteConnectorReceipts,
  managedSiteDomainClaims,
  managedSiteGateResults,
  managedSiteGenerationCandidates,
  managedSiteProviderConfigurations,
  managedSitePrePurchaseBindings,
  managedSitePaymentWebhookInbox,
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
    async updateProviderConfiguration(ownerUserId, id, patch) {
      await database.update(managedSiteProviderConfigurations).set(patch as any).where(and(eq(managedSiteProviderConfigurations.ownerUserId, ownerUserId), eq(managedSiteProviderConfigurations.id, id)))
      const [row] = await database.select().from(managedSiteProviderConfigurations).where(and(eq(managedSiteProviderConfigurations.ownerUserId, ownerUserId), eq(managedSiteProviderConfigurations.id, id))).limit(1)
      return row || null
    },
    async verifyProviderConfigurationCas(ownerUserId, id, expectedFingerprint, patch) {
      const result = await database.update(managedSiteProviderConfigurations).set(patch as any).where(and(eq(managedSiteProviderConfigurations.ownerUserId, ownerUserId), eq(managedSiteProviderConfigurations.id, id), eq(managedSiteProviderConfigurations.configurationFingerprint, expectedFingerprint), eq(managedSiteProviderConfigurations.readinessStatus, 'configured')))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      const rows = await repository.listProviderConfigurations(ownerUserId)
      return rows.find(item => item.id === id) || null
    },
    async findPrePurchaseBinding(ownerUserId, projectId) {
      const [row] = await database.select().from(managedSitePrePurchaseBindings).where(and(eq(managedSitePrePurchaseBindings.ownerUserId, ownerUserId), eq(managedSitePrePurchaseBindings.projectId, projectId))).limit(1)
      return row || null
    },
    async findPrePurchaseBindingByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSitePrePurchaseBindings).where(and(eq(managedSitePrePurchaseBindings.ownerUserId, ownerUserId), eq(managedSitePrePurchaseBindings.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertPrePurchaseBinding(input) {
      try {
        const id = rowId(await database.insert(managedSitePrePurchaseBindings).values(input as any))
        const [row] = await database.select().from(managedSitePrePurchaseBindings).where(eq(managedSitePrePurchaseBindings.id, id)).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site pre-purchase binding could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findPrePurchaseBindingByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay?.requestFingerprint === input.requestFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Pre-purchase project or order is already bound to different commercial authority.' })
      }
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
    async transitionRelease(ownerUserId, releaseId, expectedStatus, expectedProjectionFingerprint, patch) {
      const result = await database.update(managedSiteReleaseProjections).set(patch as any).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.id, releaseId), eq(managedSiteReleaseProjections.status, expectedStatus), eq(managedSiteReleaseProjections.projectionFingerprint, expectedProjectionFingerprint)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findRelease(ownerUserId, releaseId)
    },
    async listReleases(ownerUserId, projectId) {
      return database.select().from(managedSiteReleaseProjections).where(and(eq(managedSiteReleaseProjections.ownerUserId, ownerUserId), eq(managedSiteReleaseProjections.projectId, projectId))).orderBy(desc(managedSiteReleaseProjections.createdAt)).limit(100)
    },
    async insertGateResult(input) {
      try {
        const id = rowId(await database.insert(managedSiteGateResults).values(input as any))
        const [row] = await database.select().from(managedSiteGateResults).where(and(eq(managedSiteGateResults.ownerUserId, input.ownerUserId), eq(managedSiteGateResults.id, id))).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site gate result could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const rows = await repository.listGateResults(input.ownerUserId, input.releaseId)
        const replay = rows.find(row => row.gateType === input.gateType && row.inputFingerprint === input.inputFingerprint)
        if (replay?.receiptFingerprint === input.receiptFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Managed-site gate result collided with another immutable observation.' })
      }
    },
    async listGateResults(ownerUserId, releaseId) {
      return database.select().from(managedSiteGateResults).where(and(eq(managedSiteGateResults.ownerUserId, ownerUserId), eq(managedSiteGateResults.releaseId, releaseId))).orderBy(asc(managedSiteGateResults.gateType), desc(managedSiteGateResults.observedAt)).limit(100)
    },
    async findDomainClaim(canonicalDomain) {
      const [row] = await database.select().from(managedSiteDomainClaims).where(eq(managedSiteDomainClaims.activeCanonicalDomainKey, canonicalDomain)).limit(1)
      return row || null
    },
    async findDomainClaimByRelease(ownerUserId, releaseId) {
      const [row] = await database.select().from(managedSiteDomainClaims).where(and(eq(managedSiteDomainClaims.ownerUserId, ownerUserId), eq(managedSiteDomainClaims.releaseId, releaseId))).limit(1)
      return row || null
    },
    async findDomainClaimByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteDomainClaims).where(and(eq(managedSiteDomainClaims.ownerUserId, ownerUserId), eq(managedSiteDomainClaims.idempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async insertDomainClaim(input) {
      try {
        const id = rowId(await database.insert(managedSiteDomainClaims).values(input as any))
        const [row] = await database.select().from(managedSiteDomainClaims).where(eq(managedSiteDomainClaims.id, id)).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed-site domain claim could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findDomainClaimByIdempotency(input.ownerUserId, input.idempotencyKey)
        if (replay?.requestFingerprint === input.requestFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Canonical domain is already claimed by another owner, project, or release.' })
      }
    },
    async transitionDomainClaim(ownerUserId, claimId, expectedStatus, expectedProjectionFingerprint, patch) {
      const result = await database.update(managedSiteDomainClaims).set(patch as any).where(and(eq(managedSiteDomainClaims.ownerUserId, ownerUserId), eq(managedSiteDomainClaims.id, claimId), eq(managedSiteDomainClaims.status, expectedStatus), eq(managedSiteDomainClaims.projectionFingerprint, expectedProjectionFingerprint)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      const [row] = await database.select().from(managedSiteDomainClaims).where(and(eq(managedSiteDomainClaims.ownerUserId, ownerUserId), eq(managedSiteDomainClaims.id, claimId))).limit(1)
      return row || null
    },
    async findPaymentWebhookInbox(providerKey, providerEventId) {
      const [row] = await database.select().from(managedSitePaymentWebhookInbox).where(and(eq(managedSitePaymentWebhookInbox.providerKey, providerKey), eq(managedSitePaymentWebhookInbox.providerEventId, providerEventId))).limit(1)
      return row || null
    },
    async insertPaymentWebhookInbox(input) {
      try {
        const id = rowId(await database.insert(managedSitePaymentWebhookInbox).values(input as any))
        const [row] = await database.select().from(managedSitePaymentWebhookInbox).where(eq(managedSitePaymentWebhookInbox.id, id)).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Payment webhook inbox row could not be loaded.' })
        return row
      } catch (error) {
        if (!duplicate(error)) throw error
        const replay = await repository.findPaymentWebhookInbox(input.providerKey, input.providerEventId)
        if (replay?.eventFingerprint === input.eventFingerprint) return replay
        throw createError({ statusCode: 409, statusMessage: 'Payment webhook provider event collided with a different signed payload.' })
      }
    },
    async transitionPaymentWebhookInbox(inboxId, expectedStatus, expectedProcessingFingerprint, patch) {
      const result = await database.update(managedSitePaymentWebhookInbox).set(patch as any).where(and(eq(managedSitePaymentWebhookInbox.id, inboxId), eq(managedSitePaymentWebhookInbox.processingStatus, expectedStatus), eq(managedSitePaymentWebhookInbox.processingFingerprint, expectedProcessingFingerprint)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      const [row] = await database.select().from(managedSitePaymentWebhookInbox).where(eq(managedSitePaymentWebhookInbox.id, inboxId)).limit(1)
      return row || null
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
    async listEligibleRetryAttempts(now, limit, ownerUserId) {
      const eligible = and(eq(managedSiteConnectorAttempts.status, 'retry_wait'), lte(managedSiteConnectorAttempts.retryEligibleAt, now), ...(ownerUserId ? [eq(managedSiteConnectorAttempts.ownerUserId, ownerUserId)] : []))
      return database.select().from(managedSiteConnectorAttempts).where(eligible).orderBy(asc(managedSiteConnectorAttempts.retryEligibleAt), asc(managedSiteConnectorAttempts.id)).limit(Math.min(Math.max(limit, 1), 50))
    },
    async findReceiptByProviderEvent(providerKey, providerEventId) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.providerKey, providerKey), eq(managedSiteConnectorReceipts.providerEventId, providerEventId))).limit(1)
      return row || null
    },
    async findPaymentReceiptsByProviderObjectIds(providerKey, providerObjectIds) {
      const ids = [...new Set(providerObjectIds)].slice(0, 20)
      if (!ids.length) return []
      const metadataId = (key: string) => sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${managedSiteConnectorReceipts.metadata}, ${`$.${key}`}))`
      return database.select().from(managedSiteConnectorReceipts).where(and(
        eq(managedSiteConnectorReceipts.capability, 'payment'),
        eq(managedSiteConnectorReceipts.providerKey, providerKey),
        inArray(managedSiteConnectorReceipts.receiptStatus, ['verified', 'ignored_out_of_order']),
        or(
          inArray(managedSiteConnectorReceipts.externalReference, ids),
          inArray(metadataId('stripeCheckoutSessionId'), ids),
          inArray(metadataId('stripePaymentIntentId'), ids),
          inArray(metadataId('stripeChargeId'), ids),
          inArray(metadataId('stripeInvoiceId'), ids),
          inArray(metadataId('stripeSubscriptionId'), ids),
        ),
      )).orderBy(desc(managedSiteConnectorReceipts.verifiedAt), desc(managedSiteConnectorReceipts.id)).limit(20)
    },
    async findVerifiedDomainReceipt(canonicalDomain) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.canonicalDomain, canonicalDomain), eq(managedSiteConnectorReceipts.receiptStatus, 'verified'), or(eq(managedSiteConnectorReceipts.receiptType, 'domain_registered'), eq(managedSiteConnectorReceipts.receiptType, 'existing_site_ownership_verified')))).limit(1)
      return row || null
    },
    async findReceiptByFingerprint(ownerUserId, receiptFingerprint) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.ownerUserId, ownerUserId), eq(managedSiteConnectorReceipts.receiptFingerprint, receiptFingerprint))).limit(1)
      return row || null
    },
    async findOwnershipChallengeByReference(projectId, canonicalDomain, challengeReference) {
      const [row] = await database.select().from(managedSiteConnectorReceipts).where(and(eq(managedSiteConnectorReceipts.projectId, projectId), eq(managedSiteConnectorReceipts.canonicalDomain, canonicalDomain), eq(managedSiteConnectorReceipts.externalReference, challengeReference), eq(managedSiteConnectorReceipts.receiptType, 'existing_site_challenge_created'), eq(managedSiteConnectorReceipts.receiptStatus, 'verified'))).limit(1)
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
