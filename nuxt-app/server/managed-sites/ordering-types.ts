import type {
  ManagedSiteDraftOrder,
  ManagedSiteLeadIntent,
  ManagedSitePaymentEvent,
  ManagedSitePreview,
  ManagedSiteQuote,
  ManagedSiteQuoteLine,
  ManagedSiteSubscriptionIntent,
} from '../database/schema'
import type { SiteBriefInput, SiteSpec } from './site-spec'
import type { ManagedSiteModuleFulfilmentRepository } from './funnel/module-fulfilment'

export type PreviewRepository = ManagedSiteModuleFulfilmentRepository & {
  transaction<T>(work: (repository: PreviewRepository) => Promise<T>): Promise<T>
  findPreviewById(previewId: number): Promise<ManagedSitePreview | null>
  /** Locking read used as the single serialization point for checkout ownership claims. */
  findPreviewByIdForUpdate(previewId: number): Promise<ManagedSitePreview | null>
  findPreviewByDraftKey(draftKey: string): Promise<ManagedSitePreview | null>
  findPreviewByAccessTokenHash(accessTokenHash: string): Promise<ManagedSitePreview | null>
  findPreviewByFingerprint(fingerprint: string): Promise<ManagedSitePreview | null>
  insertPreview(input: Omit<ManagedSitePreview, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSitePreview>
  updatePreview(previewId: number, patch: Partial<Omit<ManagedSitePreview, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSitePreview | null>
  updateLeadIntent(id: number, patch: Partial<Omit<ManagedSiteLeadIntent, 'id' | 'createdAt'>>): Promise<ManagedSiteLeadIntent | null>
  findQuoteById(quoteId: number): Promise<ManagedSiteQuote | null>
  findQuoteByIdempotency(previewId: number, key: string): Promise<ManagedSiteQuote | null>
  findQuoteByFingerprint(fingerprint: string): Promise<ManagedSiteQuote | null>
  insertQuote(input: Omit<ManagedSiteQuote, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteQuote>
  updateQuote(quoteId: number, patch: Partial<Omit<ManagedSiteQuote, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteQuote | null>
  insertQuoteLine(input: Omit<ManagedSiteQuoteLine, 'id' | 'createdAt'>): Promise<ManagedSiteQuoteLine>
  listQuoteLines(quoteId: number): Promise<ManagedSiteQuoteLine[]>
  findLeadByFingerprint(fingerprint: string): Promise<{ id: number } | null>
  findLeadById(id: number): Promise<{ id: number; name: string; email: string; company: string; website: string | null } | null>
  findLeadIntentById(id: number): Promise<ManagedSiteLeadIntent | null>
  findLeadIntentByLineage(previewId: number, quoteId: number, leadId: number): Promise<ManagedSiteLeadIntent | null>
  insertLead(input: { name: string; email: string; company: string; website: string | null; message: string | null; packageInterest: 'grow'; language: 'zh-hant' | 'en'; privacyConsent: true; recontactConsent: boolean; dedupeKey: string; requestFingerprint: string }): Promise<{ id: number }>
  findLeadIntentByIdempotency(previewId: number, key: string): Promise<ManagedSiteLeadIntent | null>
  findLeadIntentByFingerprint(fingerprint: string): Promise<ManagedSiteLeadIntent | null>
  insertLeadIntent(input: Omit<ManagedSiteLeadIntent, 'id' | 'createdAt'>): Promise<ManagedSiteLeadIntent>
  findDraftOrderById(orderId: number): Promise<ManagedSiteDraftOrder | null>
  listDraftOrders(ownerUserId: number, options?: { status?: ManagedSiteDraftOrder['status']; limit?: number }): Promise<ManagedSiteDraftOrder[]>
  findDraftOrderByIdempotency(previewId: number, key: string): Promise<ManagedSiteDraftOrder | null>
  findDraftOrderByFingerprint(fingerprint: string): Promise<ManagedSiteDraftOrder | null>
  insertDraftOrder(input: Omit<ManagedSiteDraftOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteDraftOrder>
  updateDraftOrder(orderId: number, patch: Partial<Omit<ManagedSiteDraftOrder, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteDraftOrder | null>
  findPaymentEvent(ownerUserId: number | null, providerKey: string, eventId: string): Promise<ManagedSitePaymentEvent | null>
  findPaymentEventByFingerprint(ownerUserId: number, fingerprint: string): Promise<ManagedSitePaymentEvent | null>
  findVerifiedPaymentEventByDraftOrder(draftOrderId: number): Promise<ManagedSitePaymentEvent | null>
  insertPaymentEvent(input: Omit<ManagedSitePaymentEvent, 'id' | 'receivedAt'>): Promise<ManagedSitePaymentEvent>
  updatePaymentEvent(id: number, patch: Partial<Omit<ManagedSitePaymentEvent, 'id' | 'receivedAt'>>): Promise<ManagedSitePaymentEvent | null>
  findSubscriptionIntentByQuote(quoteId: number): Promise<ManagedSiteSubscriptionIntent | null>
  insertSubscriptionIntent(input: Omit<ManagedSiteSubscriptionIntent, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteSubscriptionIntent>
  updateSubscriptionIntent(quoteId: number, patch: Partial<Omit<ManagedSiteSubscriptionIntent, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteSubscriptionIntent | null>
}

export type PreviewGenerationInput = SiteBriefInput
export type PreviewGenerationResult = { preview: ManagedSitePreview; projection: ReturnType<typeof import('./site-spec').buildPreviewProjection>; spec: SiteSpec; accessToken: string | null; replayed: boolean }

export type QuoteLineInput = { lineKey: string; description: string; quantity: number; unitAmountMinor: number }

export type QuoteInput = {
  previewId: number
  previewAccessToken: string
  planKey: 'site_only' | 'site_geo' | 'site_geo_autopost'
  /** Only meaningful for `site_geo_autopost`; other plans normalise to 30 and ignore any client value. */
  cadenceDays?: 3 | 7 | 15 | 30
  domainOption: 'existing' | 'new' | 'assisted'
  designTier?: 'template' | 'designer'
  domainTld?: 'com' | 'com.tw' | 'tw' | 'shop' | 'store'
  moduleKeys?: string[]
  idempotencyKey: string
}

export type LeadInput = {
  previewId: number
  previewAccessToken: string
  quoteId?: number | null
  name: string
  email: string
  company: string
  website?: string | null
  message?: string | null
  privacyConsent: true
  recontactConsent?: boolean
  idempotencyKey: string
}

export type DraftOrderInput = {
  previewId: number
  previewAccessToken: string
  quoteId: number
  leadIntentId: number
  idempotencyKey: string
}

export type PaymentEventInput = {
  providerKey: string
  eventId: string
  providerReference: string
  eventType: 'payment_succeeded'
  draftOrderId: number
  amountMinor: number
  currency: string
  canonicalPayloadHash: string
  idempotencyKey: string
}

export type PaymentVerificationRequest = {
  providerKey: string
  eventId: string
  draftOrderId: number
  amountMinor: number
  currency: string
  eventType: 'payment_succeeded'
  providerReference: string
  canonicalPayloadHash: string
  receivedAt: Date
}

export type PaymentEventVerifier = {
  verify(input: PaymentVerificationRequest): Promise<unknown>
}

export type ManagedSiteCheckoutAuthority = {
  ownerUserId: number
  source: 'existing_lineage' | 'injected_mock'
}

export type ManagedSiteCheckoutAuthorityInput = {
  preview: ManagedSitePreview
  quote: ManagedSiteQuote
  leadIntent: ManagedSiteLeadIntent
  draftOrder: ManagedSiteDraftOrder
  subscriptionIntent: ManagedSiteSubscriptionIntent | null
}

export type ManagedSiteCheckoutAuthorityResolver = {
  resolve(input: ManagedSiteCheckoutAuthorityInput): Promise<ManagedSiteCheckoutAuthority | null>
}

export type ManagedSiteCheckoutClaimInput = {
  previewId: number
  previewAccessToken: string
  quoteId: number
  leadIntentId: number
  draftOrderId: number
}

export type ManagedSiteCheckoutClaimResult = {
  ownerUserId: number
  previewId: number
  quoteId: number
  leadIntentId: number
  draftOrderId: number
  subscriptionQuoteId: number
  replayed: boolean
  claimedAt: Date
}

export type OrderConversionInput = {
  draftOrderId: number
  expectedProjectId?: number | null
  idempotencyKey: string
}
