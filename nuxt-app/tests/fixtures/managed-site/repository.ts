import type {
  ManagedSiteAsset,
  ManagedSiteAuditEvent,
  ManagedSiteInvitation,
  ManagedSiteMembership,
  ManagedSiteProject,
  ManagedSiteSession,
  ManagedSiteSubscription,
  ManagedSiteVersion,
} from '../../../server/database/schema'
import type { ManagedSiteRepository } from '../../../server/managed-sites/types'

type State = {
  projects: ManagedSiteProject[]
  versions: ManagedSiteVersion[]
  assets: ManagedSiteAsset[]
  memberships: ManagedSiteMembership[]
  invitations: ManagedSiteInvitation[]
  audits: ManagedSiteAuditEvent[]
  subscriptions: ManagedSiteSubscription[]
  sessions: ManagedSiteSession[]
  nextId: number
}

function cloneState(state: State): State {
  return {
    projects: state.projects.map(row => ({ ...row })),
    versions: state.versions.map(row => ({ ...row })),
    assets: state.assets.map(row => ({ ...row })),
    memberships: state.memberships.map(row => ({ ...row })),
    invitations: state.invitations.map(row => ({ ...row })),
    audits: state.audits.map(row => ({ ...row })),
    subscriptions: state.subscriptions.map(row => ({ ...row })),
    sessions: state.sessions.map(row => ({ ...row })),
    nextId: state.nextId,
  }
}

function dateDesc<T extends { createdAt?: Date; updatedAt?: Date; occurredAt?: Date }>(rows: T[]) {
  return [...rows].sort((left, right) => (right.updatedAt || right.occurredAt || right.createdAt || 0 as any).getTime() - (left.updatedAt || left.occurredAt || left.createdAt || 0 as any).getTime())
}

export function createManagedSiteMemoryRepository() {
  const state: State = { projects: [], versions: [], assets: [], memberships: [], invitations: [], audits: [], subscriptions: [], sessions: [], nextId: 1 }
  let transactionQueue = Promise.resolve()
  const create = <T extends { id: number }>(rows: T[], input: Omit<T, 'id'>): T => {
    const row = { ...input, id: state.nextId++ } as T
    rows.push(row)
    return row
  }
  const make = (): ManagedSiteRepository => ({
    async transaction(work) {
      const previous = transactionQueue
      let release!: () => void
      transactionQueue = new Promise(resolve => { release = resolve })
      await previous
      const snapshot = cloneState(state)
      try { return await work(make()) } catch (error) {
        Object.assign(state, cloneState(snapshot))
        throw error
      } finally { release() }
    },
    async findProject(ownerUserId, projectId) { return state.projects.find(row => row.ownerUserId === ownerUserId && row.id === projectId) || null },
    async findProjectByClientIdentity(ownerUserId, value) { return state.projects.find(row => row.ownerUserId === ownerUserId && row.canonicalClientIdentity === value) || null },
    async findProjectByFingerprint(ownerUserId, value) { return state.projects.find(row => row.ownerUserId === ownerUserId && row.projectFingerprint === value) || null },
    async findProjectByIdempotency(ownerUserId, value) { return state.projects.find(row => row.ownerUserId === ownerUserId && row.creationIdempotencyKey === value) || null },
    async listProjects(ownerUserId) { return dateDesc(state.projects.filter(row => row.ownerUserId === ownerUserId)) },
    async insertProject(input) { return create(state.projects, input as Omit<ManagedSiteProject, 'id'>) },
    async updateProject(ownerUserId, projectId, patch) {
      const row = state.projects.find(item => item.ownerUserId === ownerUserId && item.id === projectId)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    async findVersion(ownerUserId, versionId) { return state.versions.find(row => row.ownerUserId === ownerUserId && row.id === versionId) || null },
    async listVersions(ownerUserId, projectId) { return [...state.versions.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId)].sort((a, b) => b.version - a.version) },
    async insertVersion(input) { return create(state.versions, input as Omit<ManagedSiteVersion, 'id'>) },
    async findMembership(ownerUserId, membershipId) { return state.memberships.find(row => row.ownerUserId === ownerUserId && row.id === membershipId) || null },
    async findMembershipByEmail(ownerUserId, projectId, principalEmail) { return state.memberships.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId && row.principalEmail === principalEmail) || null },
    async listMemberships(ownerUserId, projectId) { return state.memberships.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId).sort((a, b) => a.id - b.id) },
    async insertMembership(input) { return create(state.memberships, input as Omit<ManagedSiteMembership, 'id'>) },
    async updateMembership(ownerUserId, membershipId, patch) {
      const row = state.memberships.find(item => item.ownerUserId === ownerUserId && item.id === membershipId)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    async findInvitationByTokenHash(value) { return state.invitations.find(row => row.tokenHash === value) || null },
    async findInvitation(ownerUserId, invitationId) { return state.invitations.find(row => row.ownerUserId === ownerUserId && row.id === invitationId) || null },
    async listInvitations(ownerUserId, projectId) { return dateDesc(state.invitations.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId)) },
    async insertInvitation(input) { return create(state.invitations, input as Omit<ManagedSiteInvitation, 'id'>) },
    async updateInvitation(ownerUserId, invitationId, patch) {
      const row = state.invitations.find(item => item.ownerUserId === ownerUserId && item.id === invitationId)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    async claimInvitation(ownerUserId, invitationId, acceptedAt) {
      const row = state.invitations.find(item => item.ownerUserId === ownerUserId && item.id === invitationId && item.status === 'pending' && item.expiresAt.getTime() > acceptedAt.getTime())
      if (!row) return null
      Object.assign(row, { status: 'accepted', acceptedAt })
      return row
    },
    async insertAsset(input) { return create(state.assets, input as Omit<ManagedSiteAsset, 'id'>) },
    async listAssets(ownerUserId, projectId) { return dateDesc(state.assets.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId)) },
    async findAuditEventByFingerprint(ownerUserId, fingerprint) { return state.audits.find(row => row.ownerUserId === ownerUserId && row.eventFingerprint === fingerprint) || null },
    async insertAuditEvent(input) { return state.audits.find(row => row.ownerUserId === input.ownerUserId && row.eventFingerprint === input.eventFingerprint) || create(state.audits, { ...input, occurredAt: new Date() } as Omit<ManagedSiteAuditEvent, 'id'>) },
    async listAuditEvents(ownerUserId, projectId) { return [...state.audits.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId)].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()) },
    async findSubscription(ownerUserId, projectId) { return state.subscriptions.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId) || null },
    async insertSubscription(input) { return create(state.subscriptions, input as Omit<ManagedSiteSubscription, 'id'>) },
    async updateSubscription(ownerUserId, projectId, patch) {
      const row = state.subscriptions.find(item => item.ownerUserId === ownerUserId && item.projectId === projectId)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    async findSessionByHash(sessionHash) { return state.sessions.find(row => row.sessionHash === sessionHash) || null },
    async insertSession(input) { return create(state.sessions, input as Omit<ManagedSiteSession, 'id'>) },
    async updateSession(sessionHash, patch) {
      const row = state.sessions.find(item => item.sessionHash === sessionHash)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    async revokeSessionsForProject(ownerUserId, projectId, revokedAt) {
      for (const row of state.sessions.filter(item => item.ownerUserId === ownerUserId && item.projectId === projectId)) row.revokedAt = revokedAt
    },
  })
  return { repository: make(), state }
}
