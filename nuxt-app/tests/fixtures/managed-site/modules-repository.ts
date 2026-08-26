import type { ManagedSiteIntegration } from '../../../server/database/schema'
import type { IntegrationRepository, ManagedSiteModuleKey } from '../../../server/managed-sites/modules-types'

type State = { integrations: ManagedSiteIntegration[]; nextId: number }

export function createIntegrationMemoryRepository() {
  const state: State = { integrations: [], nextId: 1 }
  const make = (): IntegrationRepository => ({
    async transaction(work) { return work(make()) },
    async findById(id) { return state.integrations.find(row => row.id === id) || null },
    async findByProjectModule(ownerUserId, projectId, moduleKey: ManagedSiteModuleKey) { return state.integrations.find(row => row.ownerUserId === ownerUserId && row.projectId === projectId && row.moduleKey === moduleKey) || null },
    async findByShopDomain(shopDomain) { return state.integrations.find(row => row.shopDomain === shopDomain && row.moduleKey === 'shopify_commerce') || null },
    async findByIdempotency(ownerUserId, idempotencyKey) { return state.integrations.find(row => row.ownerUserId === ownerUserId && row.idempotencyKey === idempotencyKey) || null },
    async findByFingerprint(ownerUserId, intentFingerprint) { return state.integrations.find(row => row.ownerUserId === ownerUserId && row.intentFingerprint === intentFingerprint) || null },
    async insert(input) {
      if (state.integrations.some(row => row.ownerUserId === input.ownerUserId && (row.idempotencyKey === input.idempotencyKey || row.intentFingerprint === input.intentFingerprint || row.projectId === input.projectId && row.moduleKey === input.moduleKey))) throw Object.assign(new Error('owner-scoped integration conflict'), { statusCode: 409, statusMessage: 'Managed site integration conflicts with an existing owner-scoped record.' })
      const row = { ...input, id: state.nextId++ } as ManagedSiteIntegration; state.integrations.push(row); return row
    },
    async update(id, patch) { const row = state.integrations.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async listByProject(ownerUserId, projectId) { return state.integrations.filter(row => row.ownerUserId === ownerUserId && row.projectId === projectId) },
  })
  return { repository: make(), state }
}


import type { ManagedSiteShopifyAuthorization, ManagedSiteShopifyWebhook } from '../../../server/database/schema'
import type { ShopifyRepository } from '../../../server/managed-sites/shopify-types'

type ShopifyState = { authorizations: ManagedSiteShopifyAuthorization[]; webhooks: ManagedSiteShopifyWebhook[]; nextId: number }

export function createShopifyMemoryRepository() {
  const state: ShopifyState = { authorizations: [], webhooks: [], nextId: 1 }
  let transactionQueue = Promise.resolve()
  const clone = <T>(rows: T[]) => rows.map(row => ({ ...(row as any) }))
  const snapshot = (): ShopifyState => ({ authorizations: clone(state.authorizations), webhooks: clone(state.webhooks), nextId: state.nextId })
  const make = (): ShopifyRepository => ({
    async transaction(work) {
      const previous = transactionQueue
      let release!: () => void
      transactionQueue = new Promise(resolve => { release = resolve })
      await previous
      const saved = snapshot()
      try { return await work(make()) } catch (error) { Object.assign(state, saved); throw error } finally { release() }
    },
    async findAuthorizationByStateHash(stateHash) { return state.authorizations.find(row => row.stateHash === stateHash) || null },
    async insertAuthorization(input) { const row = { ...input, id: state.nextId++ } as ManagedSiteShopifyAuthorization; state.authorizations.push(row); return row },
    async claimAuthorization(stateHash, consumedAt) {
      const row = state.authorizations.find(item => item.stateHash === stateHash && item.status === 'pending' && item.expiresAt.getTime() > consumedAt.getTime())
      if (!row) return null
      Object.assign(row, { status: 'consumed', consumedAt })
      return row
    },
    async findWebhookByIntegrationEvent(integrationId, webhookId) { return state.webhooks.find(row => row.integrationId === integrationId && row.webhookId === webhookId) || null },
    async findWebhookByFingerprint(ownerUserId, eventFingerprint) { return state.webhooks.find(row => row.ownerUserId === ownerUserId && row.eventFingerprint === eventFingerprint) || null },
    async insertWebhook(input) {
      const existing = state.webhooks.find(row => row.integrationId === input.integrationId && row.webhookId === input.webhookId)
      if (existing) return existing
      const row = { ...input, id: state.nextId++, receivedAt: new Date() } as ManagedSiteShopifyWebhook
      state.webhooks.push(row)
      return row
    },
  })
  return { repository: make(), state }
}
