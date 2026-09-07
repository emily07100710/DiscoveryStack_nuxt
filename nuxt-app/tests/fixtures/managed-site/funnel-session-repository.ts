import type { ManagedSiteFunnelSession } from '../../../server/database/schema'
import { MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION, type FunnelFulfilmentCandidate, type FunnelSessionRepository } from '../../../server/managed-sites/funnel/session-repository'

export function createFunnelSessionMemoryRepository(options?: {
  projects?: () => ReadonlyArray<{ id: number; ownerUserId: number; createdAt: Date }>
  audits?: () => ReadonlyArray<{ projectId: number; ownerUserId: number; action: string; occurredAt: Date }>
  fulfilmentCandidates?: () => ReadonlyArray<FunnelFulfilmentCandidate>
}) {
  const state: { sessions: ManagedSiteFunnelSession[]; nextId: number } = { sessions: [], nextId: 1 }
  const repository: FunnelSessionRepository = {
    async findSession(sessionId) {
      return state.sessions.find(session => session.id === sessionId) || null
    },
    async findSessionByToken(sessionId, sessionTokenHash) {
      return state.sessions.find(session => session.id === sessionId && session.sessionTokenHash === sessionTokenHash) || null
    },
    async insertSession(input) {
      const now = new Date()
      const session = { ...input, id: state.nextId++, createdAt: now, updatedAt: now } as ManagedSiteFunnelSession
      state.sessions.push(session)
      return session
    },
    async updateSession(sessionId, patch) {
      const session = state.sessions.find(row => row.id === sessionId)
      if (!session) return null
      Object.assign(session, structuredClone(patch), { updatedAt: new Date() })
      return session
    },
    async transitionSession(sessionId, expectedStatus, patch) {
      const session = state.sessions.find(row => row.id === sessionId && row.status === expectedStatus)
      if (!session) return null
      Object.assign(session, structuredClone(patch), { updatedAt: new Date() })
      return session
    },
    async countBuildReservationsSince(since) {
      return (options?.projects?.() ?? []).filter(row => row.createdAt.getTime() >= since.getTime() || (options?.audits?.() ?? []).some(event => event.projectId === row.id && event.ownerUserId === row.ownerUserId && event.action === MANAGED_SITE_FUNNEL_BUILD_RESERVATION_ACTION && event.occurredAt.getTime() >= since.getTime())).length
    },
    async listPaidBuildsForFulfilment(afterId, limit) {
      return [...(options?.fulfilmentCandidates?.() ?? [])].filter(row => row.id > afterId).sort((left, right) => left.id - right.id).slice(0, Math.min(Math.max(limit, 1), 50))
    },
  }
  return { repository, state }
}
