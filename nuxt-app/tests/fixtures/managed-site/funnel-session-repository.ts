import type { ManagedSiteFunnelSession } from '../../../server/database/schema'
import type { FunnelSessionRepository } from '../../../server/managed-sites/funnel/session-repository'

export function createFunnelSessionMemoryRepository() {
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
  }
  return { repository, state }
}
