import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent, getManagedSitePublicPreview, getManagedSitePriceCatalog, recordVerifiedPaymentEvent } from '../server/managed-sites/ordering-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import type { ExistingSiteDiagnosisResolver } from '../server/managed-sites/diagnosis-binding'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'

const mockPaymentVerifier: PaymentEventVerifier = { verify: async () => true }

const brief = {
  draftIdentity: 'preview-acme-001',
  brandName: 'Acme Studio',
  audience: '台灣成長型服務企業',
  brief: '建立一個清楚說明服務、展示可信證據並鼓勵諮詢的品牌網站。',
  businessGoals: ['increase_inquiries', 'build_brand', 'improve_search_ai_understanding'],
  siteType: 'brand_blog',
  selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'],
  styleReferences: [{ url: 'https://inspiration.acme.taipei', selectedPreferences: ['color', 'typography_mood', 'homepage_structure'] }],
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

  it('does not accept caller-provided existing-site diagnosis projection', async () => {
    const test = createOrderingMemoryRepository()
    await expect(createManagedSitePreview(7, { ...brief, draftIdentity: 'preview-existing-001', existingSiteUrl: 'https://acme.taipei', diagnosisId: 42, diagnosisProjection: { issueKeys: ['missing_faq'], limitations: ['diagnosis is bounded'] } }, test.repository)).rejects.toMatchObject({ statusCode: 422 })
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
    const first = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', moduleKeys: ['managed_content_admin', 'geo_content_subscription'], idempotencyKey: 'quote-quote-001' }, test.repository)
    const replay = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', moduleKeys: ['managed_content_admin', 'geo_content_subscription'], idempotencyKey: 'quote-quote-001' }, test.repository)
    expect(first.quote.totalMinor).toBeGreaterThan(0)
    expect(first.quote.totalMinor).not.toBe((catalog as any).plans[0].monthlyMinor)
    expect(replay.replayed).toBe(true)
    await expect(createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: 'wrong-token', planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', idempotencyKey: 'quote-quote-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('requires consent and exact lead lineage before creating a draft order', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-order-001' }, test.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo_autopost', cadenceDays: 3, domainOption: 'existing', idempotencyKey: 'quote-order-001' }, test.repository)
    await expect(createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: 'owner@acme.taipei', company: 'Acme', privacyConsent: false, idempotencyKey: 'lead-order-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 422 })
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: 'owner@acme.taipei', company: 'Acme', privacyConsent: true, recontactConsent: true, idempotencyKey: 'lead-order-001' }, test.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'order-order-001' }, test.repository)
    expect(order.order.status).toBe('payment_pending')
    expect(test.state.subscriptionIntents).toHaveLength(1)
    expect(test.state.subscriptionIntents[0]?.status).toBe('draft')
    await expect(createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id + 999, idempotencyKey: 'order-order-bad' }, test.repository)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('accepts only verified mocked payment events and transitions the exact order, quote, and subscription intent', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(null, { ...brief, draftIdentity: 'preview-payment-001' }, test.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo', cadenceDays: 30, domainOption: 'assisted', idempotencyKey: 'quote-payment-001' }, test.repository)
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: 'paying@acme.taipei', company: 'Paying Co', privacyConsent: true, idempotencyKey: 'lead-payment-001' }, test.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'order-payment-001' }, test.repository)
    const paymentInput = { draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'evt_mock_001', providerReference: 'mock_payment_001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'a'.repeat(64) }
    await expect(recordVerifiedPaymentEvent(paymentInput, mockPaymentVerifier, test.repository)).rejects.toMatchObject({ statusCode: 409 })
    const authorityResolver = createInjectedManagedSiteCheckoutAuthorityResolver(1)
    const payment = await recordVerifiedPaymentEvent(paymentInput, mockPaymentVerifier, test.repository, undefined, authorityResolver)
    const replay = await recordVerifiedPaymentEvent(paymentInput, mockPaymentVerifier, test.repository, undefined, authorityResolver)
    expect(payment.order.status).toBe('payment_verified')
    expect(test.state.quotes[0]?.status).toBe('locked')
    expect(test.state.subscriptionIntents[0]?.status).toBe('entitled')
    expect(replay.replayed).toBe(true)
    await expect(recordVerifiedPaymentEvent({ ...paymentInput, eventId: 'evt_unverified', providerReference: 'bad' }, { verify: async () => false }, test.repository, undefined, authorityResolver)).rejects.toMatchObject({ statusCode: 403 })
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


describe('managed site payment hardening', () => {
  async function createPaymentFixture() {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(7, { ...brief, draftIdentity: 'payment-hardening-001' }, test.repository)
    const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo', cadenceDays: 30, domainOption: 'existing', idempotencyKey: `quote-${preview.preview.id}-hardening` }, test.repository)
    const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Owner', email: `owner-${preview.preview.id}@acme.taipei`, company: 'Acme Studio', privacyConsent: true, idempotencyKey: `lead-${preview.preview.id}-hardening` }, test.repository)
    const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: `order-${preview.preview.id}-hardening` }, test.repository)
    const input = { draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: `evt-${preview.preview.id}-hardening`, providerReference: `ref-${preview.preview.id}`, eventType: 'payment_succeeded' as const, amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'c'.repeat(64) }
    return { test, quote, order, input, authorityResolver: createInjectedManagedSiteCheckoutAuthorityResolver(7) }
  }

  it('rejects caller-controlled verification and every non-boolean verifier result', async () => {
    const fixture = await createPaymentFixture()
    await expect(recordVerifiedPaymentEvent({ ...fixture.input, verified: true }, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver)).rejects.toMatchObject({ statusCode: 422 })
    for (const result of ['true', 1, {}, []]) {
      await expect(recordVerifiedPaymentEvent({ ...fixture.input, eventId: `${fixture.input.eventId}-${String(result)}` }, { verify: async () => result }, fixture.test.repository, undefined, fixture.authorityResolver)).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('rejects amount/currency mismatch and preserves event collision semantics', async () => {
    const fixture = await createPaymentFixture()
    await expect(recordVerifiedPaymentEvent({ ...fixture.input, amountMinor: fixture.input.amountMinor + 1 }, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver)).rejects.toMatchObject({ statusCode: 409 })
    const first = await recordVerifiedPaymentEvent(fixture.input, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver)
    expect(first.order.status).toBe('payment_verified')
    await expect(recordVerifiedPaymentEvent({ ...fixture.input, providerReference: `${fixture.input.providerReference}-different` }, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver)).rejects.toMatchObject({ statusCode: 409 })
    const replay = await recordVerifiedPaymentEvent(fixture.input, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver)
    expect(replay.replayed).toBe(true)
  })

  it('serializes concurrent duplicate payment events to one ledger row', async () => {
    const fixture = await createPaymentFixture()
    const [left, right] = await Promise.all([
      recordVerifiedPaymentEvent(fixture.input, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver),
      recordVerifiedPaymentEvent(fixture.input, mockPaymentVerifier, fixture.test.repository, undefined, fixture.authorityResolver),
    ])
    expect(fixture.test.state.paymentEvents).toHaveLength(1)
    expect([left.replayed, right.replayed].sort()).toEqual([false, true])
  })

  it('does not silently replace recontact consent under a replay key', async () => {
    const test = createOrderingMemoryRepository()
    const preview = await createManagedSitePreview(7, { ...brief, draftIdentity: 'consent-lineage-001' }, test.repository)
    const base = { previewId: preview.preview.id, previewAccessToken: preview.accessToken!, name: 'Owner', email: 'consent@acme.taipei', company: 'Acme Studio', privacyConsent: true as const, idempotencyKey: 'lead-consent-001' }
    const first = await createManagedSiteLeadIntent({ ...base, recontactConsent: false }, test.repository)
    expect(first.replayed).toBe(false)
    await expect(createManagedSiteLeadIntent({ ...base, recontactConsent: true }, test.repository)).rejects.toMatchObject({ statusCode: 409 })
  })
})


describe('existing-site diagnosis authority', () => {
  it('binds an existing-site preview to an injected owner Diagnosis and canonical evidence snapshot', async () => {
    const test = createOrderingMemoryRepository()
    const evidenceHash = 'd'.repeat(64)
    const resolver: ExistingSiteDiagnosisResolver = {
      async resolve(ownerUserId: number, input: { existingSiteUrl: string; diagnosisId: number; findingIds?: string[] }) {
        expect(ownerUserId).toBe(7)
        expect(input.existingSiteUrl).toBe('https://acme.taipei/')
        expect(input.diagnosisId).toBe(42)
        return {
          diagnosisId: 42,
          normalizedSiteUrl: input.existingSiteUrl,
          findings: [{ id: 'missing_faq', issueCode: 'content.answer_readiness', area: 'answer_content', severity: 'medium', priority: 'medium', title: 'FAQ', explanation: 'Add answer blocks.', affectedUrls: ['https://acme.taipei/'], evidence: [], recommendationKey: 'add_answer_content', engine: 'deterministic-diagnosis-v1', limitations: ['bounded diagnosis'] }],
          limitations: ['bounded diagnosis'],
          engine: 'deterministic-diagnosis-v1' as const,
          evidenceSnapshot: { refs: [{ sourceId: 7, artifactId: 8, locator: 'https://acme.taipei/about', artifactHash: evidenceHash, approvedAt: '2026-08-01T00:00:00.000Z', reason: 'approved content evidence' }], context: 'approved', hash: evidenceHash, materials: [{ sourceId: 7, artifactId: 8, artifactType: 'html', artifactHash: evidenceHash, reviewedText: 'approved facts' }], approvalTimestamps: ['2026-08-01T00:00:00.000Z'], freshnessBasis: '2026-08-01T00:00:00.000Z' },
        }
      },
    }
    const result = await createManagedSitePreview(7, { ...brief, draftIdentity: 'existing-authority-001', existingSiteUrl: 'https://acme.taipei', diagnosisId: 42, diagnosisFindingIds: ['missing_faq'] }, test.repository, () => new Date('2026-08-27T00:00:00.000Z'), resolver)
    expect(result.preview.sourceMode).toBe('existing_site')
    expect(result.spec.diagnosisBinding).toEqual({ diagnosisId: 42, findingIds: ['missing_faq'] })
    expect(result.spec.contentProvenance).toEqual({ source: 'diagnosis_projection', evidenceSnapshotHash: evidenceHash })
    expect(result.spec.approvedEvidenceReferences[0]?.approvedAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('fails closed when caller supplies a diagnosis projection or unsafe existing URL', async () => {
    const test = createOrderingMemoryRepository()
    const resolver = { resolve: async () => { throw new Error('must not be called') } }
    await expect(createManagedSitePreview(7, { ...brief, draftIdentity: 'existing-client-projection-001', existingSiteUrl: 'https://acme.taipei', diagnosisId: 42, diagnosisProjection: { issueKeys: ['fake'], limitations: [] } }, test.repository, undefined, resolver)).rejects.toMatchObject({ statusCode: 422 })
    await expect(createManagedSitePreview(7, { ...brief, draftIdentity: 'existing-private-001', existingSiteUrl: 'https://127.0.0.1/admin', diagnosisId: 42 }, test.repository, undefined, resolver)).rejects.toMatchObject({ statusCode: 422 })
    await expect(createManagedSitePreview(7, { ...brief, draftIdentity: 'existing-sensitive-001', existingSiteUrl: 'https://acme.taipei/?token=secret', diagnosisId: 42 }, test.repository, undefined, resolver)).rejects.toMatchObject({ statusCode: 422 })
    await expect(createManagedSitePreview(null, { ...brief, draftIdentity: 'existing-anonymous-001', existingSiteUrl: 'https://acme.taipei', diagnosisId: 42 }, test.repository, undefined, resolver)).rejects.toMatchObject({ statusCode: 401 })
  })
})
