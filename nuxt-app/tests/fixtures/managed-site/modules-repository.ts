import type { ManagedSiteIntegration } from '../../../server/database/schema'
import type { IntegrationRepository, ManagedSiteModuleKey } from '../../../server/managed-sites/modules-types'

type State = { integrations: ManagedSiteIntegration[]; nextId: number }

export function createIntegrationMemoryRepository() {
  const state: State = { integrations: [], nextId: 1 }
  const make = (): IntegrationRepository => ({
    async transaction(work) { return work(make()) },
    async findById(id) { return state.integrations.find(row => row.id === id) || null },
    async findByProjectModule(projectId, moduleKey: ManagedSiteModuleKey) { return state.integrations.find(row => row.projectId === projectId && row.moduleKey === moduleKey) || null },
    async findByIdempotency(ownerUserId, idempotencyKey) { return state.integrations.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === idempotencyKey) || null },
    async findByFingerprint(intentFingerprint) { return state.integrations.find(row => row.intentFingerprint === intentFingerprint) || null },
    async insert(input) { const row = { ...input, id: state.nextId++ } as ManagedSiteIntegration; state.integrations.push(row); return row },
    async update(id, patch) { const row = state.integrations.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async listByProject(ownerUserId, projectId) { return state.integrations.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
  })
  return { repository: make(), state }
}
