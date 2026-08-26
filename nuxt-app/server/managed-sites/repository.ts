import { createError } from 'h3'
import { and, asc, desc, eq, gt } from 'drizzle-orm'
import { getDatabase } from '../database'
import {
  managedSiteAssets,
  managedSiteAuditEvents,
  managedSiteInvitations,
  managedSiteMemberships,
  managedSiteProjects,
  managedSiteSessions,
  managedSiteSubscriptions,
  managedSiteVersions,
} from '../database/schema'
import type {
  ManagedSiteRepository,
} from './types'

function requireManagedSiteDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed site platform is temporarily unavailable.' })
  return database
}

function rowId(result: unknown): number {
  const id = Number((result as { [key: string]: unknown }[] | undefined)?.[0]?.insertId)
  if (!Number.isSafeInteger(id) || id < 1) throw createError({ statusCode: 500, statusMessage: 'Managed site record could not be recorded.' })
  return id
}

export function makeManagedSiteRepository(database: any): ManagedSiteRepository {
  const repository: ManagedSiteRepository = {
    async transaction<T>(work: (repository: ManagedSiteRepository) => Promise<T>): Promise<T> {
      return database.transaction((transaction: any) => work(makeManagedSiteRepository(transaction))) as Promise<T>
    },
    async findProject(ownerUserId, projectId) {
      const [row] = await database.select().from(managedSiteProjects).where(and(eq(managedSiteProjects.ownerUserId, ownerUserId), eq(managedSiteProjects.id, projectId))).limit(1)
      return row || null
    },
    async findProjectByClientIdentity(ownerUserId, canonicalClientIdentity) {
      const [row] = await database.select().from(managedSiteProjects).where(and(eq(managedSiteProjects.ownerUserId, ownerUserId), eq(managedSiteProjects.canonicalClientIdentity, canonicalClientIdentity))).limit(1)
      return row || null
    },
    async findProjectByFingerprint(ownerUserId, projectFingerprint) {
      const [row] = await database.select().from(managedSiteProjects).where(and(eq(managedSiteProjects.ownerUserId, ownerUserId), eq(managedSiteProjects.projectFingerprint, projectFingerprint))).limit(1)
      return row || null
    },
    async findProjectByIdempotency(ownerUserId, idempotencyKey) {
      const [row] = await database.select().from(managedSiteProjects).where(and(eq(managedSiteProjects.ownerUserId, ownerUserId), eq(managedSiteProjects.creationIdempotencyKey, idempotencyKey))).limit(1)
      return row || null
    },
    async listProjects(ownerUserId) {
      return database.select().from(managedSiteProjects).where(eq(managedSiteProjects.ownerUserId, ownerUserId)).orderBy(desc(managedSiteProjects.updatedAt)).limit(100)
    },
    async insertProject(input) {
      const id = rowId(await database.insert(managedSiteProjects).values(input as any))
      const row = await repository.findProject(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site project could not be loaded.' })
      return row
    },
    async updateProject(ownerUserId, projectId, patch) {
      await database.update(managedSiteProjects).set(patch as any).where(and(eq(managedSiteProjects.ownerUserId, ownerUserId), eq(managedSiteProjects.id, projectId)))
      return repository.findProject(ownerUserId, projectId)
    },
    async findVersion(ownerUserId, versionId) {
      const [row] = await database.select().from(managedSiteVersions).where(and(eq(managedSiteVersions.ownerUserId, ownerUserId), eq(managedSiteVersions.id, versionId))).limit(1)
      return row || null
    },
    async listVersions(ownerUserId, projectId) {
      return database.select().from(managedSiteVersions).where(and(eq(managedSiteVersions.ownerUserId, ownerUserId), eq(managedSiteVersions.projectId, projectId))).orderBy(desc(managedSiteVersions.version)).limit(100)
    },
    async insertVersion(input) {
      const id = rowId(await database.insert(managedSiteVersions).values(input as any))
      const row = await repository.findVersion(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site version could not be loaded.' })
      return row
    },
    async findMembership(ownerUserId, membershipId) {
      const [row] = await database.select().from(managedSiteMemberships).where(and(eq(managedSiteMemberships.ownerUserId, ownerUserId), eq(managedSiteMemberships.id, membershipId))).limit(1)
      return row || null
    },
    async findMembershipByEmail(ownerUserId, projectId, principalEmail) {
      const [row] = await database.select().from(managedSiteMemberships).where(and(eq(managedSiteMemberships.ownerUserId, ownerUserId), eq(managedSiteMemberships.projectId, projectId), eq(managedSiteMemberships.principalEmail, principalEmail))).limit(1)
      return row || null
    },
    async listMemberships(ownerUserId, projectId) {
      return database.select().from(managedSiteMemberships).where(and(eq(managedSiteMemberships.ownerUserId, ownerUserId), eq(managedSiteMemberships.projectId, projectId))).orderBy(asc(managedSiteMemberships.createdAt)).limit(100)
    },
    async insertMembership(input) {
      const id = rowId(await database.insert(managedSiteMemberships).values(input as any))
      const row = await repository.findMembership(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site membership could not be loaded.' })
      return row
    },
    async updateMembership(ownerUserId, membershipId, patch) {
      await database.update(managedSiteMemberships).set(patch as any).where(and(eq(managedSiteMemberships.ownerUserId, ownerUserId), eq(managedSiteMemberships.id, membershipId)))
      return repository.findMembership(ownerUserId, membershipId)
    },
    async findInvitationByTokenHash(tokenHash) {
      const [row] = await database.select().from(managedSiteInvitations).where(eq(managedSiteInvitations.tokenHash, tokenHash)).limit(1)
      return row || null
    },
    async findInvitation(ownerUserId, invitationId) {
      const [row] = await database.select().from(managedSiteInvitations).where(and(eq(managedSiteInvitations.ownerUserId, ownerUserId), eq(managedSiteInvitations.id, invitationId))).limit(1)
      return row || null
    },
    async listInvitations(ownerUserId, projectId) {
      return database.select().from(managedSiteInvitations).where(and(eq(managedSiteInvitations.ownerUserId, ownerUserId), eq(managedSiteInvitations.projectId, projectId))).orderBy(desc(managedSiteInvitations.createdAt)).limit(100)
    },
    async insertInvitation(input) {
      const id = rowId(await database.insert(managedSiteInvitations).values(input as any))
      const row = await repository.findInvitation(input.ownerUserId, id)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site invitation could not be loaded.' })
      return row
    },
    async updateInvitation(ownerUserId, invitationId, patch) {
      await database.update(managedSiteInvitations).set(patch as any).where(and(eq(managedSiteInvitations.ownerUserId, ownerUserId), eq(managedSiteInvitations.id, invitationId)))
      return repository.findInvitation(ownerUserId, invitationId)
    },
    async claimInvitation(ownerUserId, invitationId, acceptedAt) {
      await database.update(managedSiteInvitations).set({ status: 'accepted', acceptedAt } as any).where(and(eq(managedSiteInvitations.ownerUserId, ownerUserId), eq(managedSiteInvitations.id, invitationId), eq(managedSiteInvitations.status, 'pending'), gt(managedSiteInvitations.expiresAt, acceptedAt)))
      const claimed = await repository.findInvitation(ownerUserId, invitationId)
      return claimed?.status === 'accepted' && claimed.acceptedAt?.getTime() === acceptedAt.getTime() ? claimed : null
    },
    async insertAsset(input) {
      const id = rowId(await database.insert(managedSiteAssets).values(input as any))
      const [row] = await database.select().from(managedSiteAssets).where(and(eq(managedSiteAssets.ownerUserId, input.ownerUserId), eq(managedSiteAssets.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site asset could not be loaded.' })
      return row
    },
    async listAssets(ownerUserId, projectId) {
      return database.select().from(managedSiteAssets).where(and(eq(managedSiteAssets.ownerUserId, ownerUserId), eq(managedSiteAssets.projectId, projectId))).orderBy(desc(managedSiteAssets.createdAt)).limit(500)
    },
    async findAuditEventByFingerprint(ownerUserId, eventFingerprint) {
      const [row] = await database.select().from(managedSiteAuditEvents).where(and(eq(managedSiteAuditEvents.ownerUserId, ownerUserId), eq(managedSiteAuditEvents.eventFingerprint, eventFingerprint))).limit(1)
      return row || null
    },
    async insertAuditEvent(input) {
      const existing = await repository.findAuditEventByFingerprint(input.ownerUserId, input.eventFingerprint)
      if (existing) return existing
      try {
        const id = rowId(await database.insert(managedSiteAuditEvents).values(input as any))
        const [row] = await database.select().from(managedSiteAuditEvents).where(and(eq(managedSiteAuditEvents.ownerUserId, input.ownerUserId), eq(managedSiteAuditEvents.id, id))).limit(1)
        if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site audit event could not be loaded.' })
        return row
      } catch (error: any) {
        if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) {
          const replay = await repository.findAuditEventByFingerprint(input.ownerUserId, input.eventFingerprint)
          if (replay) return replay
        }
        throw error
      }
    },
    async listAuditEvents(ownerUserId, projectId) {
      return database.select().from(managedSiteAuditEvents).where(and(eq(managedSiteAuditEvents.ownerUserId, ownerUserId), eq(managedSiteAuditEvents.projectId, projectId))).orderBy(desc(managedSiteAuditEvents.occurredAt)).limit(500)
    },
    async findSubscription(ownerUserId, projectId) {
      const [row] = await database.select().from(managedSiteSubscriptions).where(and(eq(managedSiteSubscriptions.ownerUserId, ownerUserId), eq(managedSiteSubscriptions.projectId, projectId))).limit(1)
      return row || null
    },
    async insertSubscription(input) {
      const id = rowId(await database.insert(managedSiteSubscriptions).values(input as any))
      const [row] = await database.select().from(managedSiteSubscriptions).where(and(eq(managedSiteSubscriptions.ownerUserId, input.ownerUserId), eq(managedSiteSubscriptions.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site subscription could not be loaded.' })
      return row
    },
    async updateSubscription(ownerUserId, projectId, patch) {
      await database.update(managedSiteSubscriptions).set(patch as any).where(and(eq(managedSiteSubscriptions.ownerUserId, ownerUserId), eq(managedSiteSubscriptions.projectId, projectId)))
      return repository.findSubscription(ownerUserId, projectId)
    },
    async findSessionByHash(sessionHash) {
      const [row] = await database.select().from(managedSiteSessions).where(eq(managedSiteSessions.sessionHash, sessionHash)).limit(1)
      return row || null
    },
    async insertSession(input) {
      const id = rowId(await database.insert(managedSiteSessions).values(input as any))
      const [row] = await database.select().from(managedSiteSessions).where(and(eq(managedSiteSessions.ownerUserId, input.ownerUserId), eq(managedSiteSessions.id, id))).limit(1)
      if (!row) throw createError({ statusCode: 500, statusMessage: 'Managed site session could not be loaded.' })
      return row
    },
    async updateSession(sessionHash, patch) {
      await database.update(managedSiteSessions).set(patch as any).where(eq(managedSiteSessions.sessionHash, sessionHash))
      return repository.findSessionByHash(sessionHash)
    },
    async revokeSessionsForProject(ownerUserId, projectId, revokedAt) {
      await database.update(managedSiteSessions).set({ revokedAt } as any).where(and(eq(managedSiteSessions.ownerUserId, ownerUserId), eq(managedSiteSessions.projectId, projectId)))
    },
  }
  return repository
}

export function getManagedSiteRepository(): ManagedSiteRepository {
  return makeManagedSiteRepository(requireManagedSiteDatabase())
}
