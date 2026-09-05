import type { ManagedSiteContactInboxBinding } from '../../../server/database/schema'
import type { ManagedSiteContactInboxBindingRepository } from '../../../server/managed-sites/contact-inbox/binding-repository'

export function createContactInboxBindingMemoryRepository() {
  const state: { bindings: ManagedSiteContactInboxBinding[]; nextId: number } = { bindings: [], nextId: 1 }
  let transactionQueue = Promise.resolve()

  const make = (): ManagedSiteContactInboxBindingRepository => ({
    async transaction(work) {
      const previous = transactionQueue
      let release!: () => void
      transactionQueue = new Promise(resolve => { release = resolve })
      await previous
      const saved = structuredClone(state)
      try { return await work(make()) } catch (error) { state.bindings = saved.bindings; state.nextId = saved.nextId; throw error } finally { release() }
    },
    async listForSession(sessionId) {
      return state.bindings.filter(row => row.funnelSessionId === sessionId).sort((left, right) => right.id - left.id)
    },
    async insertBinding(input) {
      const now = new Date()
      const row = { ...structuredClone(input), id: state.nextId++, createdAt: now, updatedAt: now } as ManagedSiteContactInboxBinding
      state.bindings.push(row)
      return row
    },
    async updateBinding(bindingId, expectedStatus, patch) {
      const row = state.bindings.find(binding => binding.id === bindingId && binding.status === expectedStatus)
      if (!row) return null
      Object.assign(row, structuredClone(patch), { updatedAt: new Date() })
      return row
    },
    async supersedeStatus(sessionId, status, exceptBindingId) {
      for (const row of state.bindings) {
        if (row.funnelSessionId !== sessionId || row.status !== status || row.id === exceptBindingId) continue
        Object.assign(row, { status: 'superseded', codeHash: null, codeExpiresAt: null, updatedAt: new Date() })
      }
    },
  })

  return { repository: make(), state }
}
