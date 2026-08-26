import { describe, expect, it } from 'vitest'
import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote } from '../server/managed-sites/ordering-service'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'

describe('managed-site payment conversion orchestration', () => {
  it('resolves a public order owner from an injected existing account and binds all lineage before conversion', async () => {
    const ordering = createOrderingMemoryRepository()
    const managed = createManagedSiteMemoryRepository()
    const preview = await createManagedSitePreview(null, { draftIdentity: 'orchestration-public-001', brandName: 'Public Client', audience: 'Taiwan customers', brief: 'A public managed-site brief.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription'], styleReferences: [] }, ordering.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'orchestration-quote-001' }, ordering.repository)
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Public Owner', email: 'public-owner@acme.taipei', company: 'Public Client', privacyConsent: true, idempotencyKey: 'orchestration-lead-001' }, ordering.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'orchestration-order-001' }, ordering.repository)
    const paymentVerifier: PaymentEventVerifier = { verify: async request => request.draftOrderId === order.order.id }
    const authorityResolver = createInjectedManagedSiteCheckoutAuthorityResolver(1)

    const result = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'orchestration-payment-001', providerReference: 'orchestration-reference-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'a'.repeat(64), idempotencyKey: 'orchestration-conversion-001' }, paymentVerifier, { ordering: ordering.repository, managed: managed.repository }, authorityResolver)

    expect(result.authority).toMatchObject({ ownerUserId: 1, source: 'injected_mock' })
    expect(result.order.status).toBe('payment_verified')
    expect(result.project.status).toBe('active')
    expect(ordering.state.previews[0]?.ownerUserId).toBe(1)
    expect(ordering.state.quotes[0]?.ownerUserId).toBe(1)
    expect(ordering.state.leadIntents[0]?.ownerUserId).toBe(1)
    expect(ordering.state.orders[0]?.ownerUserId).toBe(1)
    expect(ordering.state.subscriptionIntents[0]?.ownerUserId).toBe(1)
    expect(ordering.state.paymentEvents).toHaveLength(1)
  })

  it('replays payment and conversion independently after a process interruption between the two stages', async () => {
    const ordering = createOrderingMemoryRepository()
    const managed = createManagedSiteMemoryRepository()
    const preview = await createManagedSitePreview(7, { draftIdentity: 'orchestration-recovery-001', brandName: 'Recovery Client', audience: 'Taiwan customers', brief: 'A recovery-safe managed-site brief.', businessGoals: ['increase_inquiries'], siteType: 'one_page', selectedModules: ['managed_content_admin'], styleReferences: [] }, ordering.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 30, domainOption: 'existing', idempotencyKey: 'orchestration-recovery-quote' }, ordering.repository)
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Recovery Owner', email: 'recovery@acme.taipei', company: 'Recovery Client', privacyConsent: true, idempotencyKey: 'orchestration-recovery-lead' }, ordering.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'orchestration-recovery-order' }, ordering.repository)
    const input = { draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'orchestration-recovery-payment', providerReference: 'orchestration-recovery-reference', eventType: 'payment_succeeded' as const, amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'b'.repeat(64), idempotencyKey: 'orchestration-recovery-conversion' }
    const verifier: PaymentEventVerifier = { verify: async () => true }

    const authorityResolver = createInjectedManagedSiteCheckoutAuthorityResolver(7)
    const firstPayment = await import('../server/managed-sites/ordering-service').then(module => module.recordVerifiedPaymentEvent(input, verifier, ordering.repository, undefined, authorityResolver))
    expect(firstPayment.replayed).toBe(false)
    expect(ordering.state.paymentEvents).toHaveLength(1)

    const recovered = await processManagedSitePaymentAndConversion(input, verifier, { ordering: ordering.repository, managed: managed.repository }, authorityResolver)
    expect(recovered.paymentReplayed).toBe(true)
    expect(recovered.conversionReplayed).toBe(false)
    expect(recovered.project.status).toBe('active')
    expect(ordering.state.paymentEvents).toHaveLength(1)

    const replay = await processManagedSitePaymentAndConversion(input, verifier, { ordering: ordering.repository, managed: managed.repository }, authorityResolver)
    expect(replay.paymentReplayed).toBe(true)
    expect(replay.conversionReplayed).toBe(true)
    expect(managed.state.projects).toHaveLength(1)
    expect(managed.state.versions).toHaveLength(1)
  })
})

