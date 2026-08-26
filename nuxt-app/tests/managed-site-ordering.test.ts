import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent, getManagedSitePublicPreview, getManagedSitePriceCatalog, recordVerifiedMockedPaymentEvent } from '../server/managed-sites/ordering-service'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'

const brief = {
  draftIdentity: 'preview-acme-001',
  brandName: 'Acme Studio',
  audience: '台灣成長型服務企業',
  brief: '建立一個清楚說明服務、展示可信證據並鼓勵諮詢的品牌網站。',
  businessGoals: ['increase_inquiries', 'build_brand', 'improve_search_ai_understanding'],
  siteType: 'brand_blog',
  selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'],
  styleReferences: [{ url: 'https://example.com/inspiration', selectedPreferences: ['color', 'typography_mood', 'homepage_structure'] }],
} as any

describe('managed site preview and ordering flow', () => {
  it('generates a controlled SiteSpec and preview with explicit non-execution claims', async () => {
    const test = createOrderingMemoryRepository()
    const result = await createManagedSitePreview(null, brief, test.repository)
    expect(result.replayed).toBe(false)
    expect(result.accessToken).toBeTruthy()
    expect(result.spec.schemaVersion).toBe('site-spec-v1')
    expect(result.spec.selectedModules).toContain('geo_content_subscription')
    expect(result.preview.status).toBe('generated')
    expect(result.projection.claims).toEqual({ paymentVerified: false, domainPurchased: false, dnsVerified: false, deployed: false })
    expect(result.spec.styleReferenceProfile?.limitations.join(' ')).toContain('never copied')
    expect(result.preview.accessTokenHash).not.toBe(result.accessToken)
  })

  it('supports existing-site diagnosis input without fetching or copying a reference site', async () => {
    const test = createOrderingMemoryRepository()
    const result = await createManagedSitePreview(7, { ...brief, draftIdentity: 'preview-existing-001', existingSiteUrl: 'https://client.example.test', diagnosisProjection: { issueKeys: ['missing_faq'], limitations: ['diagnosis is bounded'] } }, test.repository)
    expect(result.preview.sourceMode).toBe('existing_site')
    expect(result.preview.existingSiteUrl).toBe('https://client.example.test')
    expect(result.spec.contentProvenance.source).toBe('diagnosis_projection')
    expect((result.preview.styleProfile as any).sources[0].captureStatus).toBe('not_fetched')
  })

  it('rejects private reference URLs and unsupported modules before persistence', async () => {
    const test = createOrderingMemoryRepository()
    await expect(createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-private-001', styleReferences: [{ url: 'http://127.0.0.1:3000/admin', selectedPreferences: ['color'] }] }, test.repository)).rejects.toMatchObject({ statusCode: 422 })
    await expect(createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-module-001', selectedModules: ['arbitrary_code_execution'] }, test.repository)).rejects.toMatchObject({ statusCode: 422 })
    expect(test.state.previews).toHaveLength(0)
  })

  it('prices only from the server catalog and rejects wrong preview access tokens', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-quote-001' }, test.repository)
    const catalog = getManagedSitePriceCatalog()
    const first = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', moduleKeys: ['managed_content_admin', 'geo_content_subscription'], idempotencyKey: 'quote-quote-001' }, test.repository)
    const replay = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', moduleKeys: ['managed_content_admin', 'geo_content_subscription'], idempotencyKey: 'quote-quote-001' }, test.repository)
    expect(first.quote.totalMinor).toBeGreaterThan(0)
    expect(first.quote.totalMinor).not.toBe((catalog as any).plans[0].siteBuildMinor)
    expect(replay.replayed).toBe(true)
    await expect(createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: 'wrong-token', planKey: 'basic', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'quote-quote-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('requires consent and exact lead lineage before creating a draft order', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-order-001' }, test.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'business', cadenceDays: 3, domainOption: 'existing', idempotencyKey: 'quote-order-001' }, test.repository)
    await expect(createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: 'owner@example.test', company: 'Acme', privacyConsent: false, idempotencyKey: 'lead-order-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 422 })
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: 'owner@example.test', company: 'Acme', privacyConsent: true, recontactConsent: true, idempotencyKey: 'lead-order-001' }, test.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'order-order-001' }, test.repository)
    expect(order.order.status).toBe('payment_pending')
    expect(test.state.subscriptionIntents).toHaveLength(1)
    expect(test.state.subscriptionIntents[0]?.status).toBe('draft')
    await expect(createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id + 999, idempotencyKey: 'order-order-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('accepts only verified mocked payment events and transitions the exact order, quote, and subscription intent', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-payment-001' }, test.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 30, domainOption: 'assisted', idempotencyKey: 'quote-payment-001' }, test.repository)
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: 'pay@example.test', company: 'Paying Co', privacyConsent: true, idempotencyKey: 'lead-payment-001' }, test.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'order-payment-001' }, test.repository)
    const payment = await recordVerifiedMockedPaymentEvent({ draftOrderId: order.order.id, eventId: 'evt_mock_001', providerReference: 'mock_payment_001', eventType: 'payment_succeeded', verified: true, idempotencyKey: 'payment-event-001' }, test.repository)
    const replay = await recordVerifiedMockedPaymentEvent({ draftOrderId: order.order.id, eventId: 'evt_mock_001', providerReference: 'mock_payment_001', eventType: 'payment_succeeded', verified: true, idempotencyKey: 'payment-event-replay' }, test.repository)
    expect(payment.order.status).toBe('payment_verified')
    expect(test.state.quotes[0]?.status).toBe('locked')
    expect(test.state.subscriptionIntents[0]?.status).toBe('entitled')
    expect(replay.replayed).toBe(true)
    await expect(recordVerifiedMockedPaymentEvent({ draftOrderId: order.order.id, eventId: 'evt_unverified', providerReference: 'bad', eventType: 'payment_succeeded', verified: false, idempotencyKey: 'payment-event-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('returns a safe token-bound preview projection and rejects a different tenant token', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-public-001' }, test.repository)
    const projection = await getManagedSitePublicPreview(preview.preview.id, preview.accessToken!, test.repository)
    expect(projection.previewOnly).toBe(true)
    expect(projection.accessTokenRequired).toBe(true)
    await expect(getManagedSitePublicPreview(preview.preview.id, 'wrong-token', test.repository)).rejects.toMatchObject({ statusCode: 404 })
  })
})
