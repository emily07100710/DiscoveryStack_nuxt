import type { ManagedSiteDraftOrder, ManagedSiteLeadIntent, ManagedSiteModuleFulfilment, ManagedSitePaymentEvent, ManagedSitePreview, ManagedSiteQuote, ManagedSiteQuoteLine, ManagedSiteSubscriptionIntent } from '../../../server/database/schema'
import type { ManagedSiteCheckoutAuthorityResolver, PreviewRepository } from '../../../server/managed-sites/ordering-types'

type State = {
  previews: ManagedSitePreview[]
  quotes: ManagedSiteQuote[]
  lines: ManagedSiteQuoteLine[]
  leadIntents: ManagedSiteLeadIntent[]
  orders: ManagedSiteDraftOrder[]
  paymentEvents: ManagedSitePaymentEvent[]
  moduleFulfilments: ManagedSiteModuleFulfilment[]
  subscriptionIntents: ManagedSiteSubscriptionIntent[]
  leads: Array<{ id: number; name: string; email: string; company: string; website: string | null; requestFingerprint: string }>
  nextId: number
}

function copy<T>(rows: T[]): T[] { return rows.map(row => ({ ...(row as any) })) }
const DRAFT_ORDER_STATUSES = ['draft', 'payment_pending', 'payment_verified', 'refunded', 'disputed', 'cancelled', 'expired'] as const satisfies readonly ManagedSiteDraftOrder['status'][]

export function createInjectedManagedSiteCheckoutAuthorityResolver(ownerUserId: number): ManagedSiteCheckoutAuthorityResolver {
  return { resolve: async () => ({ ownerUserId, source: 'injected_mock' }) }
}

export function createOrderingMemoryRepository() {
  const state: State = { previews: [], quotes: [], lines: [], leadIntents: [], orders: [], paymentEvents: [], moduleFulfilments: [], subscriptionIntents: [], leads: [], nextId: 1 }
  let transactionQueue = Promise.resolve()
  const snapshot = (): State => ({ previews: copy(state.previews), quotes: copy(state.quotes), lines: copy(state.lines), leadIntents: copy(state.leadIntents), orders: copy(state.orders), paymentEvents: copy(state.paymentEvents), moduleFulfilments: copy(state.moduleFulfilments), subscriptionIntents: copy(state.subscriptionIntents), leads: copy(state.leads), nextId: state.nextId })
  const restore = (saved: State) => { Object.assign(state, saved) }
  const insert = <T extends { id: number }>(rows: T[], input: Omit<T, 'id'>): T => { const row = { ...input, id: state.nextId++ } as T; rows.push(row); return row }
  const make = (): PreviewRepository => ({
    async transaction(work) {
      const previous = transactionQueue
      let release!: () => void
      transactionQueue = new Promise(resolve => { release = resolve })
      await previous
      const saved = snapshot()
      try { return await work(make()) } catch (error) { restore(saved); throw error } finally { release() }
    },
    async findPreviewById(id) { return state.previews.find(row => row.id === id) || null },
    async findPreviewByIdForUpdate(id) { return state.previews.find(row => row.id === id) || null },
    async findPreviewByDraftKey(key) { return state.previews.find(row => row.draftKey === key) || null },
    async findPreviewByAccessTokenHash(hash) { return state.previews.find(row => row.accessTokenHash === hash) || null },
    async findPreviewByFingerprint(fingerprint) { return state.previews.find(row => row.previewFingerprint === fingerprint) || null },
    async insertPreview(input) { return insert(state.previews, input as Omit<ManagedSitePreview, 'id'>) },
    async updatePreview(id, patch) { const row = state.previews.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async updateLeadIntent(id, patch) { const row = state.leadIntents.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findQuoteById(id) { return state.quotes.find(row => row.id === id) || null },
    async findQuoteByIdempotency(previewId, key) { return state.quotes.find(row => row.previewId === previewId && row.idempotencyKey === key) || null },
    async findQuoteByFingerprint(fingerprint) { return state.quotes.find(row => row.quoteFingerprint === fingerprint) || null },
    async insertQuote(input) { return insert(state.quotes, input as Omit<ManagedSiteQuote, 'id'>) },
    async updateQuote(id, patch) { const row = state.quotes.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async insertQuoteLine(input) { return insert(state.lines, input as Omit<ManagedSiteQuoteLine, 'id'>) },
    async listQuoteLines(quoteId) { return state.lines.filter(row => row.quoteId === quoteId).sort((a, b) => a.id - b.id) },
    async findLeadByFingerprint(fingerprint) { return state.leads.find(row => row.requestFingerprint === fingerprint) || null },
    async findLeadById(id) { return (state.leads.find(row => row.id === id) as any) || null },
    async findLeadIntentById(id) { return state.leadIntents.find(row => row.id === id) || null },
    async findLeadIntentByLineage(previewId, quoteId, leadId) { return state.leadIntents.find(row => row.previewId === previewId && row.quoteId === quoteId && row.leadId === leadId) || null },
    async insertLead(input) { const row = { id: state.nextId++, name: input.name, email: input.email, company: input.company, website: input.website, requestFingerprint: input.requestFingerprint }; state.leads.push(row); return { id: row.id } },
    async findLeadIntentByIdempotency(previewId, key) { return state.leadIntents.find(row => row.previewId === previewId && row.idempotencyKey === key) || null },
    async findLeadIntentByFingerprint(fingerprint) { return state.leadIntents.find(row => row.requestFingerprint === fingerprint) || null },
    async insertLeadIntent(input) { return insert(state.leadIntents, input as Omit<ManagedSiteLeadIntent, 'id'>) },
    async findDraftOrderById(id) { return state.orders.find(row => row.id === id) || null },
    async listDraftOrders(ownerUserId, options = {}) { const limit = Math.min(Math.max(Number.isSafeInteger(options.limit) ? Number(options.limit) : 100, 1), 100); return state.orders.filter(row => row.ownerUserId === ownerUserId && (!options.status || row.status === options.status)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id).slice(0, limit) },
    async findDraftOrderByIdempotency(previewId, key) { return state.orders.find(row => row.previewId === previewId && row.idempotencyKey === key) || null },
    async findDraftOrderByFingerprint(fingerprint) { return state.orders.find(row => row.requestFingerprint === fingerprint) || null },
    async insertDraftOrder(input) { return insert(state.orders, input as Omit<ManagedSiteDraftOrder, 'id'>) },
    async updateDraftOrder(id, patch) { const row = state.orders.find(item => item.id === id); if (!row) return null; if (patch.status !== undefined && !(DRAFT_ORDER_STATUSES as readonly string[]).includes(patch.status)) throw new Error('unsupported managed-site draft order status'); Object.assign(row, patch); return row },
    async findPaymentEvent(ownerUserId, providerKey, eventId) { return state.paymentEvents.find(row => row.ownerUserId === ownerUserId && row.providerKey === providerKey && row.eventId === eventId) || null },
    async findPaymentEventByFingerprint(ownerUserId, fingerprint) { return state.paymentEvents.find(row => row.ownerUserId === ownerUserId && row.eventFingerprint === fingerprint) || null },
    async findVerifiedPaymentEventByDraftOrder(draftOrderId) { return state.paymentEvents.find(row => row.draftOrderId === draftOrderId && row.verificationStatus === 'verified') || null },
    async insertPaymentEvent(input) { return insert(state.paymentEvents, { ...input, receivedAt: new Date() } as Omit<ManagedSitePaymentEvent, 'id'>) },
    async updatePaymentEvent(id, patch) { const row = state.paymentEvents.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findModuleFulfilment(ownerUserId, draftOrderId, moduleKey) { return state.moduleFulfilments.find(row => row.ownerUserId === ownerUserId && row.draftOrderId === draftOrderId && row.moduleKey === moduleKey) || null },
    async insertModuleFulfilment(input) { const existing = state.moduleFulfilments.find(row => row.draftOrderId === input.draftOrderId && row.moduleKey === input.moduleKey); if (existing) { if (existing.ownerUserId === input.ownerUserId && existing.quoteId === input.quoteId && existing.mode === input.mode) return existing; throw Object.assign(new Error('module fulfilment collision'), { statusCode: 409 }) } const now = new Date(); return insert(state.moduleFulfilments, { ...input, createdAt: now, updatedAt: now } as Omit<ManagedSiteModuleFulfilment, 'id'>) },
    async listModuleFulfilmentsByDraftOrder(ownerUserId, draftOrderId) { return state.moduleFulfilments.filter(row => row.ownerUserId === ownerUserId && row.draftOrderId === draftOrderId).sort((left, right) => left.id - right.id) },
    async listPendingManualModuleFulfilments(ownerUserId) { return state.moduleFulfilments.filter(row => row.ownerUserId === ownerUserId && row.status === 'pending_manual_setup').sort((left, right) => left.id - right.id) },
    async closePendingManualModuleFulfilment(ownerUserId, draftOrderId, moduleKey, completedAt) { const row = state.moduleFulfilments.find(item => item.ownerUserId === ownerUserId && item.draftOrderId === draftOrderId && item.moduleKey === moduleKey && item.status === 'pending_manual_setup'); if (!row) return null; Object.assign(row, { status: 'manual_setup_completed', customerVisibleStatus: '客服已完成設定', ownerActionRequired: false, completedAt, updatedAt: completedAt }); return row },
    async findSubscriptionIntentByQuote(quoteId) { return state.subscriptionIntents.find(row => row.quoteId === quoteId) || null },
    async insertSubscriptionIntent(input) { return insert(state.subscriptionIntents, input as Omit<ManagedSiteSubscriptionIntent, 'id'>) },
    async updateSubscriptionIntent(quoteId, patch) { const row = state.subscriptionIntents.find(item => item.quoteId === quoteId); if (!row) return null; Object.assign(row, patch); return row },
  })
  return { repository: make(), state }
}
