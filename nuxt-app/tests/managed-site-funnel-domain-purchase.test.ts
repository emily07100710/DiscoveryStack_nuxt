import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFunnelDomainDelegationForSession, assertFunnelDomainMutationAuthority, createFunnelDomainRegistrationDelegation, purchaseFunnelDomain } from '../server/managed-sites/funnel/domain-purchase-authority'
import { advancePaidManagedSiteFunnel } from '../server/managed-sites/funnel/fulfilment-advancer'
import { projectFunnelQuote } from '../server/managed-sites/funnel/quote-projection'
import type { FunnelAnswers } from '../server/managed-sites/funnel/session-service'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createMockManagedSiteDeploymentAdapter } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter } from '../server/managed-sites/live-connectors/domain-connectors'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { configureManagedSiteProvider, resolveManagedSiteProviderAuthority } from '../server/managed-sites/live-connectors/provider-registry'
import type { ManagedSiteDomainAdapter, ManagedSiteDomainReceipt } from '../server/managed-sites/live-connectors/types'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const registrant = { firstName: 'Customer', lastName: 'Example', organization: '', address1: '1 Main Road', city: 'Taipei', state: '', postalCode: '100', country: 'TW', phoneCountryCode: '886', phone: '912345678', email: 'customer@example.invalid' }
const secret = 'auto-domain-payment-test'
afterEach(() => { vi.unstubAllEnvs() })

async function fixture() {
  vi.stubEnv('MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON', JSON.stringify({ com: { currency: 'USD', maxAmountMinor: 1500 } }))
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'delegated-acme.com' })
  let now = new Date(managedSiteFixedNow)
  async function payment(eventType = 'checkout_succeeded') {
    const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: `auto-domain-${eventType}`, eventType })
    const rawBody = Buffer.from(JSON.stringify(event))
    return processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader: createHmac('sha256', secret).update(rawBody).digest('hex'), credentialReference: 'vault:auto-domain-webhook', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true, value: secret }), clock: () => now })
  }
  await payment()
  const release = line.live.state.releases[0]!
  const answers: FunnelAnswers = {
    existingSite: { hasSite: false }, company: { brandName: 'Delegated Acme', whatWeDo: 'Brand consulting', feelings: ['專業'], mainOffer: '顧問', conversionGoals: ['increase_inquiries'] },
    style: { referenceUrls: [], stylePreset: 'premium', designTier: 'template' }, siteType: 'brand_blog', modules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'],
    domain: { option: 'new', name: 'delegated-acme', tld: 'com' }, plan: { planKey: 'site_geo', cadenceDays: 7 },
  }
  const providerAuthority = await resolveManagedSiteProviderAuthority(1, 'domain_registration', 'mocked', line.live.repository)
  const base = createMockManagedSiteDomainAdapter({ now: () => now })
  const acceptedQuote = await base.quote({ ownerUserId: 1, projectId: release.projectId, releaseId: release.id, canonicalDomain: release.canonicalDomain, providerAuthority, requestFingerprint: 'a'.repeat(64), timeoutMs: 15_000 })
  const customerQuote = projectFunnelQuote(answers, 7)
  const delegation = createFunnelDomainRegistrationDelegation({ sessionId: 7, canonicalDomain: release.canonicalDomain, registrant, quote: acceptedQuote, customerPrice: { amountMinor: customerQuote.totals.domainFirstYearMinor, currency: customerQuote.currency }, acceptedAt: now.toISOString() })
  const candidate = { id: 7, ownerUserId: 1, projectId: release.projectId, releaseId: release.id, draftOrderId: release.draftOrderId, quoteId: release.quoteId, previewId: release.previewId }
  const funnel = createFunnelSessionMemoryRepository({ fulfilmentCandidates: () => [candidate] })
  const session = { ...candidate, answers, consentSnapshot: { scrolledToBottom: true, domainRegistration: delegation }, status: 'checkout_pending' } as any
  funnel.state.sessions.push(session)
  const quote = vi.fn(base.quote)
  const create = vi.fn<ManagedSiteDomainAdapter['createPurchaseIntent']>(async input => {
    await input.beforeMutation?.()
    const result: ManagedSiteDomainReceipt = { providerKey: 'mock-domain', providerEventId: 'actual-registrar-order-17', providerReference: 'actual-registrar-order-17', canonicalDomain: input.quote.canonicalDomain, status: 'registered', providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: 'actual-registrar-and-contact-readback:17' }
    if (!input.reconcileOnly) await input.onRegistrationCreated?.({ ...result, status: 'purchase_intent_created', exactResponseIdentity: 'actual-registrar-create:17' })
    await input.beforeMutation?.()
    return result
  })
  const domainAdapter = vi.fn(async () => ({ quote, createPurchaseIntent: create }))
  const dependencies = { funnelRepository: funnel.repository, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, productionTransaction: line.productionTransaction, domainAdapter, executionMode: 'mocked' as const, clock: () => now, activateGeoOperations: (async (_ownerUserId: number, input: { releaseId: number }) => ({ release: await line.live.repository.findRelease(1, input.releaseId), replayed: false })) as any, bootstrapCustomerWorkspace: (async () => ({ replayed: false })) as any, notifyCustomerWorkspace: (async () => ({ sent: true, replayed: false, receiptFingerprint: 'a'.repeat(64) })) as any }
  return { line, release, answers, session, delegation, dependencies, base, quote, create, domainAdapter, payment, now: () => now, advanceClock: (ms: number) => { now = new Date(now.getTime() + ms) } }
}

describe('paid customer delegated domain registration', () => {
  it('automatically purchases the exact paid selection with customer delegation and an order-locked receipt, then safely replays', async () => {
    const f = await fixture()
    const lock = vi.spyOn(f.line.ordering.repository, 'findDraftOrderByIdForUpdate')
    const result = await purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)
    expect(result.claim).toMatchObject({ status: 'verified', canonicalDomain: 'delegated-acme.com' })
    const receipt = f.line.live.state.receipts.find(row => row.receiptType === 'domain_registered')!
    expect(receipt.metadata).toMatchObject({ purchaseAuthority: { kind: 'customer_domain_delegation_v1', sessionId: 7, delegationFingerprint: f.delegation.consentFingerprint }, paymentReceiptFingerprint: expect.any(String) })
    expect(receipt.metadata).not.toHaveProperty('ownerConfirmationFingerprint')
    expect(JSON.stringify(receipt.metadata)).not.toContain(registrant.email)
    expect(f.line.live.state.receipts.some(row => row.receiptType === 'domain_registration_submitted' && row.externalReference === 'actual-registrar-order-17')).toBe(true)
    expect(lock).toHaveBeenCalledWith(f.release.draftOrderId)
    expect(await purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).toMatchObject({ replayed: true })
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.quote).toHaveBeenCalledTimes(1)
    expect(f.quote).toHaveBeenCalledWith(expect.objectContaining({ requireAutomaticEligibility: true }))
  })

  it('fulfils payment through new-domain registration, DNS and production without a browser or manual owner confirmation', async () => {
    const f = await fixture()
    const deploy = vi.fn(createMockManagedSiteDeploymentAdapter({ now: f.now }).deployProduction)
    const dns = vi.fn(createMockManagedSiteDnsTlsAdapter().configureAndVerify)
    expect(await advancePaidManagedSiteFunnel({}, { ...f.dependencies, deploymentAdapter: async () => ({ ...createMockManagedSiteDeploymentAdapter({ now: f.now }), deployProduction: deploy }), dnsTlsAdapter: async () => ({ configureAndVerify: dns }) })).toMatchObject({ advanced: 1, failed: 0 })
    expect(f.line.live.state.releases[0]!.status).toBe('live_verified')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(dns).toHaveBeenCalledTimes(1)
    expect(deploy).toHaveBeenCalledTimes(1)
    expect(f.line.live.state.candidates).toHaveLength(1)
    expect(f.line.live.state.receipts.filter(row => row.receiptType === 'checkout_session_created')).toHaveLength(1)
  })

  it('never allows a verified Stripe test receipt to spend real registrar funds', async () => {
    const f = await fixture()
    const receipt = f.line.live.state.receipts.find(row => row.receiptType === 'checkout_succeeded')!
    receipt.providerKey = 'stripe'
    receipt.metadata = { ...(receipt.metadata as any), capabilityIdentity: 'stripe-balance:test' }
    await expect(purchaseFunnelDomain(1, f.release.id, 7, { ...f.dependencies, executionMode: 'live' })).rejects.toMatchObject({ statusCode: 409, data: { code: 'FUNNEL_DOMAIN_AUTHORITY_BLOCKED' } })
    expect(f.domainAdapter).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each(['domain', 'price', 'delegation', 'missing_policy', 'policy_cap', 'provider'] as const)('blocks changed %s authority before registrar purchase', async reason => {
    const f = await fixture()
    if (reason === 'domain') f.session.answers.domain.name = 'someone-else'
    if (reason === 'price') f.session.consentSnapshot.domainRegistration.customerPrice.amountMinor++
    if (reason === 'delegation') f.session.consentSnapshot.domainRegistration.registrant.email = 'other@example.invalid'
    if (reason === 'missing_policy') vi.stubEnv('MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON', '')
    if (reason === 'policy_cap') vi.stubEnv('MANAGED_SITE_FUNNEL_DOMAIN_PROCUREMENT_POLICY_JSON', JSON.stringify({ com: { currency: 'USD', maxAmountMinor: 1100 } }))
    if (reason === 'provider') await configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'mock-domain', readinessStatus: 'mock', credentialReference: 'vault:rotated-registrar', transportConfiguration: {}, idempotencyKey: 'rotate-registrar' }, f.line.live.repository)
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: expect.any(Number) })
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each(['price_increase', 'currency', 'domain', 'provider', 'expired'] as const)('rejects fresh supplier %s without changing accepted price or purchasing', async reason => {
    const f = await fixture()
    f.quote.mockImplementation(async input => { const quote = await f.base.quote(input); return { ...quote, ...(reason === 'price_increase' ? { amountMinor: 1201 } : reason === 'currency' ? { currency: 'EUR' } : reason === 'domain' ? { canonicalDomain: 'someone-else.com' } : reason === 'provider' ? { providerAuthorityFingerprint: 'b'.repeat(64) } : { expiresAt: f.now().toISOString() }) } })
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.line.live.state.domainClaims).toHaveLength(0)
  })

  it('persists a customer-visible block if the paid domain becomes unavailable instead of polling forever', async () => {
    const f = await fixture()
    f.quote.mockRejectedValue(Object.assign(new Error('domain no longer available'), { statusCode: 409 }))
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, failed: 1 })
    expect(f.line.live.state.releases[0]).toMatchObject({ status: 'blocked', blockedReasonCode: 'DOMAIN_DELEGATION_REVIEW_REQUIRED', nextSafeAction: 'review_domain_registration_authority' })
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    expect(f.quote).toHaveBeenCalledTimes(1)
    expect(f.create).not.toHaveBeenCalled()
  })

  it('allows a transient supplier quote outage to recover without another purchase key', async () => {
    const f = await fixture()
    f.quote.mockRejectedValueOnce(Object.assign(new Error('temporary quote outage'), { statusCode: 503 }))
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, failed: 1 })
    expect(f.line.live.state.releases[0]!.status).toBe('payment_verified')
    expect(f.create).not.toHaveBeenCalled()
    await purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('retains an accepted expired quote cap after payment but obtains a fresh quote before purchase', async () => {
    const f = await fixture()
    f.advanceClock(2 * 60 * 60_000)
    expect(() => assertFunnelDomainDelegationForSession(f.session, f.now)).toThrow()
    expect(() => assertFunnelDomainDelegationForSession(f.session, f.now, { allowExpiredAcceptedQuote: true })).not.toThrow()
    await purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)
    expect(f.quote).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('persists the actual registrar order before contact failure and retries only reconciliation with that receipt', async () => {
    const f = await fixture()
    const firstImplementation = f.create.getMockImplementation()!
    f.create.mockImplementationOnce(async input => {
      await input.beforeMutation?.()
      await input.onRegistrationCreated?.({ providerKey: 'mock-domain', providerEventId: 'actual-registrar-order-17', providerReference: 'actual-registrar-order-17', canonicalDomain: input.quote.canonicalDomain, status: 'purchase_intent_created', providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: 'actual-registrar-create:17' })
      throw new Error('contact update transport lost')
    })
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toThrow('contact update transport lost')
    expect(f.line.live.state.domainClaims[0]!.status).toBe('pending')
    expect(f.line.live.state.receipts.filter(row => row.receiptType === 'domain_registration_submitted')).toHaveLength(1)
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ data: { code: 'FUNNEL_DOMAIN_WAITING' } })
    f.advanceClock(2 * 60 * 60_000)
    // A fresh adapter instance receives durable state; no in-process purchase cache is required.
    const replay = vi.fn(firstImplementation)
    await purchaseFunnelDomain(1, f.release.id, 7, { ...f.dependencies, domainAdapter: async () => ({ quote: f.quote, createPurchaseIntent: replay }) })
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ reconcileOnly: true, registrationReceipt: expect.objectContaining({ providerReference: 'actual-registrar-order-17' }), idempotencyKey: f.create.mock.calls[0]![0].idempotencyKey }))
    expect(f.quote).toHaveBeenCalledTimes(1)
    expect(f.line.live.state.domainClaims[0]!.status).toBe('verified')
  })

  it('marks an unknown registration outcome reconciliation-only even without a local receipt', async () => {
    const f = await fixture()
    f.create.mockRejectedValueOnce(new Error('create response lost'))
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toThrow()
    f.advanceClock(30_001)
    f.create.mockImplementationOnce(async input => { expect(input.reconcileOnly).toBe(true); expect(input.registrationReceipt).toBeUndefined(); throw new Error('registrar outcome unknown; no create permitted') })
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toThrow('registrar outcome unknown')
    expect(f.quote).toHaveBeenCalledTimes(1)
    expect(f.line.live.state.domainClaims[0]!.status).toBe('pending')
  })

  it.each(['payment_refunded', 'payment_disputed'])('rechecks %s before the next registrar write and never accepts a verified claim', async eventType => {
    const f = await fixture()
    const nextWrite = vi.fn()
    f.create.mockImplementationOnce(async input => {
      await input.beforeMutation?.()
      await f.payment(eventType)
      await input.beforeMutation?.()
      nextWrite()
      throw new Error('unexpected next write')
    })
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(nextWrite).not.toHaveBeenCalled()
    expect(f.line.live.state.domainClaims[0]!.status).toBe('pending')
    expect(f.line.live.state.receipts.some(row => row.receiptType === 'domain_registered')).toBe(false)
  })

  it('rejects a refund arriving after registrar success inside the locked final receipt acceptance', async () => {
    const f = await fixture()
    const implementation = f.create.getMockImplementation()!
    f.create.mockImplementationOnce(async input => { const receipt = await implementation(input); await f.payment('payment_refunded'); return receipt })
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    expect(f.line.live.state.receipts.some(row => row.receiptType === 'domain_registered')).toBe(false)
    expect(f.line.live.state.domainClaims[0]!.status).toBe('pending')
  })

  it('rejects provider drift between registration and registrant contact update', async () => {
    const f = await fixture()
    f.create.mockImplementationOnce(async input => {
      await configureManagedSiteProvider(1, { capability: 'domain_registration', providerKey: 'mock-domain', readinessStatus: 'mock', credentialReference: 'vault:rotated-mid-purchase', transportConfiguration: {}, idempotencyKey: 'rotate-mid-purchase' }, f.line.live.repository)
      await input.beforeMutation?.()
      throw new Error('unexpected contact mutation')
    })
    await expect(purchaseFunnelDomain(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: 409, data: { code: 'FUNNEL_DOMAIN_AUTHORITY_BLOCKED' } })
    expect(f.line.live.state.domainClaims[0]!.status).toBe('pending')
  })

  it('requires the exact owner and paid order for the DNS mutation authority helper', async () => {
    const f = await fixture()
    await expect(assertFunnelDomainMutationAuthority(2, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
    f.session.draftOrderId++
    await expect(assertFunnelDomainMutationAuthority(1, f.release.id, 7, f.dependencies)).rejects.toMatchObject({ statusCode: 409 })
  })
})
