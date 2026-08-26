import type { ManagedSiteDraftOrder, ManagedSiteLeadIntent, ManagedSitePaymentEvent, ManagedSitePreview, ManagedSiteQuote, ManagedSiteQuoteLine, ManagedSiteSubscriptionIntent } from '../../../server/database/schema'
import type { ManagedSiteCheckoutAuthorityResolver, PreviewRepository } from '../../../server/managed-sites/ordering-types'

type State = {
  previews: ManagedSitePreview[]
  quotes: ManagedSiteQuote[]
  lines: ManagedSiteQuoteLine[]
  leadIntents: ManagedSiteLeadIntent[]
  orders: ManagedSiteDraftOrder[]
  paymentEvents: ManagedSitePaymentEvent[]
  subscriptionIntents: ManagedSiteSubscriptionIntent[]
  leads: Array<{ id: number; name: string; email: string; company: string; website: string | null; requestFingerprint: string }>
  nextId: number
}

function copy<T>(rows: T[]): T[] { return rows.map(row => ({ ...(row as any) })) }

export function createInjectedManagedSiteCheckoutAuthorityResolver(ownerUserId: number): ManagedSiteCheckoutAuthorityResolver {
  return { resolve: async () => ({ ownerUserId, source: 'injected_mock' }) }
}

export function createOrderingMemoryRepository() {
  const state: State = { previews: [], quotes: [], lines: [], leadIntents: [], orders: [], paymentEvents: [], subscriptionIntents: [], leads: [], nextId: 1 }
  let transactionQueue = Promise.resolve()
  const snapshot = (): State => ({ previews: copy(state.previews), quotes: copy(state.quotes), lines: copy(state.lines), leadIntents: copy(state.leadIntents), orders: copy(state.orders), paymentEvents: copy(state.paymentEvents), subscriptionIntents: copy(state.subscriptionIntents), leads: copy(state.leads), nextId: state.nextId })
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
    async findUserIdByEmail() { return null },
    async findLeadIntentById(id) { return state.leadIntents.find(row => row.id === id) || null },
    async findLeadIntentByLineage(previewId, quoteId, leadId) { return state.leadIntents.find(row => row.previewId === previewId && row.quoteId === quoteId && row.leadId === leadId) || null },
    async insertLead(input) { const row = { id: state.nextId++, name: input.name, email: input.email, company: input.company, website: input.website, requestFingerprint: input.requestFingerprint }; state.leads.push(row); return { id: row.id } },
    async findLeadIntentByIdempotency(previewId, key) { return state.leadIntents.find(row => row.previewId === previewId && row.idempotencyKey === key) || null },
    async findLeadIntentByFingerprint(fingerprint) { return state.leadIntents.find(row => row.requestFingerprint === fingerprint) || null },
    async insertLeadIntent(input) { return insert(state.leadIntents, input as Omit<ManagedSiteLeadIntent, 'id'>) },
    async findDraftOrderById(id) { return state.orders.find(row => row.id === id) || null },
    async findDraftOrderByIdempotency(previewId, key) { return state.orders.find(row => row.previewId === previewId && row.idempotencyKey === key) || null },
    async findDraftOrderByFingerprint(fingerprint) { return state.orders.find(row => row.requestFingerprint === fingerprint) || null },
    async insertDraftOrder(input) { return insert(state.orders, input as Omit<ManagedSiteDraftOrder, 'id'>) },
    async updateDraftOrder(id, patch) { const row = state.orders.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findPaymentEvent(ownerUserId, providerKey, eventId) { return state.paymentEvents.find(row => row.ownerUserId === ownerUserId && row.providerKey === providerKey && row.eventId === eventId) || null },
    async findPaymentEventByFingerprint(ownerUserId, fingerprint) { return state.paymentEvents.find(row => row.ownerUserId === ownerUserId && row.eventFingerprint === fingerprint) || null },
    async findVerifiedPaymentEventByDraftOrder(draftOrderId) { return state.paymentEvents.find(row => row.draftOrderId === draftOrderId && row.verificationStatus === 'verified') || null },
    async insertPaymentEvent(input) { return insert(state.paymentEvents, { ...input, receivedAt: new Date() } as Omit<ManagedSitePaymentEvent, 'id'>) },
    async updatePaymentEvent(id, patch) { const row = state.paymentEvents.find(item => item.id === id); if (!row) return null; Object.assign(row, patch); return row },
    async findSubscriptionIntentByQuote(quoteId) { return state.subscriptionIntents.find(row => row.quoteId === quoteId) || null },
    async insertSubscriptionIntent(input) { return insert(state.subscriptionIntents, input as Omit<ManagedSiteSubscriptionIntent, 'id'>) },
    async updateSubscriptionIntent(quoteId, patch) { const row = state.subscriptionIntents.find(item => item.quoteId === quoteId); if (!row) return null; Object.assign(row, patch); return row },
  })
  return { repository: make(), state }
}
