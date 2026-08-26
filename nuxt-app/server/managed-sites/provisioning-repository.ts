import { createError } from 'h3'
import { and, asc, desc, eq, isNull, lt, lte, or } from 'drizzle-orm'
import { getDatabase } from '../database'
import { managedSiteDomainIntents, managedSiteProvisioningEvents, managedSiteProvisioningPlans, managedSiteProvisioningSteps } from '../database/schema'
import type { ProvisioningRepository, ProvisioningStepKey } from './provisioning-types'

function requireDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed site provisioning is temporarily unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Managed site provisioning record could not be recorded.' })
  return id
}

function makeRepository(database: any): ProvisioningRepository {
  const repository: ProvisioningRepository = {
    async transaction<T>(work: (repository: ProvisioningRepository) => Promise<T>): Promise<T> {
      return database.transaction((transaction: any) => work(makeRepository(transaction))) as Promise<T>
    },
    async findDomainIntentById(id) {
      const [row] = await database.select().from(managedSiteDomainIntents).where(eq(managedSiteDomainIntents.id, id)).limit(1)
      return row || null
    },
    async findDomainIntentByProject(projectId) {
      const [row] = await database.select().from(managedSiteDomainIntents).where(eq(managedSiteDomainIntents.projectId, projectId)).limit(1)
      return row || null
    },
    async findDomainIntentByIdempotency(idempotencyKey) {
      const [row] = await database.select().from(managedSiteDomainIntents).where(eq(managedSiteDomainIntents.idempotencyKey, idempotencyKey)).limit(1)
      return row || null
    },
    async insertDomainIntent(input) {
      const id = rowId(await database.insert(managedSiteDomainIntents).values(input as any))
      const row = await repository.findDomainIntentById(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site domain intent could not be loaded.' })
      return row
    },
    async updateDomainIntent(id, patch) {
      await database.update(managedSiteDomainIntents).set(patch as any).where(eq(managedSiteDomainIntents.id, id))
      return repository.findDomainIntentById(id)
    },
    async findPlanById(id) {
      const [row] = await database.select().from(managedSiteProvisioningPlans).where(eq(managedSiteProvisioningPlans.id, id)).limit(1)
      return row || null
    },
    async findPlanByFingerprint(fingerprint) {
      const [row] = await database.select().from(managedSiteProvisioningPlans).where(eq(managedSiteProvisioningPlans.intentFingerprint, fingerprint)).limit(1)
      return row || null
    },
    async findPlanByIdempotency(idempotencyKey) {
      const [row] = await database.select().from(managedSiteProvisioningPlans).where(eq(managedSiteProvisioningPlans.idempotencyKey, idempotencyKey)).limit(1)
      return row || null
    },
    async insertPlan(input) {
      const id = rowId(await database.insert(managedSiteProvisioningPlans).values(input as any))
      const row = await repository.findPlanById(id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site provisioning plan could not be loaded.' })
      return row
    },
    async updatePlan(id, patch) {
      await database.update(managedSiteProvisioningPlans).set(patch as any).where(eq(managedSiteProvisioningPlans.id, id))
      return repository.findPlanById(id)
    },
    async acquirePlanLease(ownerUserId, planId, leaseOwner, now, leaseMs) {
      const leaseExpiresAt = new Date(now.getTime() + leaseMs)
      const result = await database.update(managedSiteProvisioningPlans).set({ status: 'processing', leaseOwner, leaseExpiresAt, retryEligibleAt: null, updatedAt: now } as any).where(and(
        eq(managedSiteProvisioningPlans.ownerUserId, ownerUserId),
        eq(managedSiteProvisioningPlans.id, planId),
        or(
          eq(managedSiteProvisioningPlans.status, 'draft'),
          eq(managedSiteProvisioningPlans.status, 'awaiting_authorization'),
          eq(managedSiteProvisioningPlans.status, 'queued'),
          and(eq(managedSiteProvisioningPlans.status, 'retry_wait'), or(isNull(managedSiteProvisioningPlans.retryEligibleAt), lte(managedSiteProvisioningPlans.retryEligibleAt, now))),
          and(eq(managedSiteProvisioningPlans.status, 'processing'), or(isNull(managedSiteProvisioningPlans.leaseExpiresAt), lt(managedSiteProvisioningPlans.leaseExpiresAt, now))),
        ),
      ))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findPlanById(planId)
    },
    async releasePlanLease(ownerUserId, planId, leaseOwner, patch) {
      const result = await database.update(managedSiteProvisioningPlans).set({ ...patch as any, leaseOwner: null, leaseExpiresAt: null }).where(and(eq(managedSiteProvisioningPlans.ownerUserId, ownerUserId), eq(managedSiteProvisioningPlans.id, planId), eq(managedSiteProvisioningPlans.status, 'processing'), eq(managedSiteProvisioningPlans.leaseOwner, leaseOwner)))
      if (Number(result?.[0]?.affectedRows || 0) !== 1) return null
      return repository.findPlanById(planId)
    },
    async findStep(planId, stepKey: ProvisioningStepKey) {
      const [row] = await database.select().from(managedSiteProvisioningSteps).where(and(eq(managedSiteProvisioningSteps.planId, planId), eq(managedSiteProvisioningSteps.stepKey, stepKey))).limit(1)
      return row || null
    },
    async listSteps(planId) {
      return database.select().from(managedSiteProvisioningSteps).where(eq(managedSiteProvisioningSteps.planId, planId)).orderBy(asc(managedSiteProvisioningSteps.ordinal)).limit(20)
    },
    async insertStep(input) {
      const id = rowId(await database.insert(managedSiteProvisioningSteps).values(input as any))
      const [row] = await database.select().from(managedSiteProvisioningSteps).where(eq(managedSiteProvisioningSteps.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site provisioning step could not be loaded.' })
      return row
    },
    async updateStep(id, patch) {
      await database.update(managedSiteProvisioningSteps).set(patch as any).where(eq(managedSiteProvisioningSteps.id, id))
      const [row] = await database.select().from(managedSiteProvisioningSteps).where(eq(managedSiteProvisioningSteps.id, id)).limit(1)
      return row || null
    },
    async findEventByFingerprint(ownerUserId, fingerprint) {
      const [row] = await database.select().from(managedSiteProvisioningEvents).where(and(eq(managedSiteProvisioningEvents.ownerUserId, ownerUserId), eq(managedSiteProvisioningEvents.receiptFingerprint, fingerprint))).limit(1)
      return row || null
    },
    async insertEvent(input) {
      const existing = await repository.findEventByFingerprint(input.ownerUserId, input.receiptFingerprint)
      if (existing) return existing
      const id = rowId(await database.insert(managedSiteProvisioningEvents).values(input as any))
      const [row] = await database.select().from(managedSiteProvisioningEvents).where(eq(managedSiteProvisioningEvents.id, id)).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site provisioning event could not be loaded.' })
      return row
    },
    async listEvents(ownerUserId, planId) {
      return database.select().from(managedSiteProvisioningEvents).where(and(eq(managedSiteProvisioningEvents.ownerUserId, ownerUserId), eq(managedSiteProvisioningEvents.planId, planId))).orderBy(desc(managedSiteProvisioningEvents.occurredAt)).limit(100)
    },
  }
  return repository
}

export function getProvisioningRepository(): ProvisioningRepository {
  return makeRepository(requireDatabase())
}
