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

export type PreviewRepository = {
  transaction<T>(work: (repository: PreviewRepository) => Promise<T>): Promise<T>
  findPreviewById(previewId: number): Promise<ManagedSitePreview | null>
  findPreviewByDraftKey(draftKey: string): Promise<ManagedSitePreview | null>
  findPreviewByAccessTokenHash(accessTokenHash: string): Promise<ManagedSitePreview | null>
  findPreviewByFingerprint(fingerprint: string): Promise<ManagedSitePreview | null>
  insertPreview(input: Omit<ManagedSitePreview, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSitePreview>
  updatePreview(previewId: number, patch: Partial<Omit<ManagedSitePreview, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSitePreview | null>
  findQuoteById(quoteId: number): Promise<ManagedSiteQuote | null>
  findQuoteByFingerprint(fingerprint: string): Promise<ManagedSiteQuote | null>
  insertQuote(input: Omit<ManagedSiteQuote, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteQuote>
  updateQuote(quoteId: number, patch: Partial<Omit<ManagedSiteQuote, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteQuote | null>
  insertQuoteLine(input: Omit<ManagedSiteQuoteLine, 'id' | 'createdAt'>): Promise<ManagedSiteQuoteLine>
  listQuoteLines(quoteId: number): Promise<ManagedSiteQuoteLine[]>
  findLeadByFingerprint(fingerprint: string): Promise<{ id: number } | null>
  findLeadIntentById(id: number): Promise<ManagedSiteLeadIntent | null>
  insertLead(input: { name: string; email: string; company: string; website: string | null; message: string | null; packageInterest: 'grow'; language: 'zh-hant' | 'en'; privacyConsent: true; recontactConsent: boolean; dedupeKey: string; requestFingerprint: string }): Promise<{ id: number }>
  findLeadIntentByIdempotency(key: string): Promise<ManagedSiteLeadIntent | null>
  findLeadIntentByFingerprint(fingerprint: string): Promise<ManagedSiteLeadIntent | null>
  insertLeadIntent(input: Omit<ManagedSiteLeadIntent, 'id' | 'createdAt'>): Promise<ManagedSiteLeadIntent>
  findDraftOrderById(orderId: number): Promise<ManagedSiteDraftOrder | null>
  findDraftOrderByIdempotency(key: string): Promise<ManagedSiteDraftOrder | null>
  findDraftOrderByFingerprint(fingerprint: string): Promise<ManagedSiteDraftOrder | null>
  insertDraftOrder(input: Omit<ManagedSiteDraftOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<ManagedSiteDraftOrder>
  updateDraftOrder(orderId: number, patch: Partial<Omit<ManagedSiteDraftOrder, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ManagedSiteDraftOrder | null>
  findPaymentEvent(eventId: string): Promise<ManagedSitePaymentEvent | null>
  findPaymentEventByFingerprint(fingerprint: string): Promise<ManagedSitePaymentEvent | null>
  insertPaymentEvent(input: Omit<ManagedSitePaymentEvent, 'id' | 'receivedAt'>): Promise<ManagedSitePaymentEvent>
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
  planKey: 'basic' | 'business'
  cadenceDays: 3 | 7 | 15 | 30
  domainOption: 'existing' | 'new' | 'assisted'
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

export type VerifiedPaymentEventInput = {
  eventId: string
  providerReference: string
  eventType: 'payment_succeeded'
  draftOrderId: number
  verified: true
  idempotencyKey: string
}
