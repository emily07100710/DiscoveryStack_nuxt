import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedSiteCheckoutSession } from '../server/managed-sites/live-connectors/checkout-session'
import { processManagedSiteVerifiedPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { reconcileManagedSiteStripePayment } from '../server/managed-sites/live-connectors/payment-reconciliation'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { createStripeCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/stripe-adapters'
import type { ManagedSiteVerifiedPaymentWebhook } from '../server/managed-sites/live-connectors/types'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const savedProviderOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const savedCheckoutOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
afterEach(() => {
  if (savedProviderOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS; else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = savedProviderOrigins
  if (savedCheckoutOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS; else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = savedCheckoutOrigins
})

async function stripeLine(canonicalDomain: string) {
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain, createCheckout: false })
  const credential = randomBytes(32).toString('hex'); const credentialReference = 'vault:stripe-reconcile-test'
  const resolveCredential = async (reference: string) => reference === credentialReference ? { ok: true as const, value: credential } : { ok: false as const, reason: 'missing_reference' as const }
  const returnOrigin = 'https://merchant.example.com'
  await configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'configured', credentialReference, transportConfiguration: { endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin }, idempotencyKey: `stripe-reconcile-config-${canonicalDomain}` }, line.live.repository, () => managedSiteFixedNow)
  const stripeSlug = canonicalDomain.replace(/[^A-Za-z0-9_]/gu, '_')
  await verifyManagedSiteProviderConfiguration(line.ownerUserId, 'payment', line.live.repository, resolveCredential, () => managedSiteFixedNow, undefined, async () => new Response(JSON.stringify({ object: 'balance', available: [], pending: [], livemode: false }), { status: 200, headers: { 'request-id': `req_${stripeSlug}` } }))
  let checkoutMetadata: Record<string, string> = {}
  const sessionId = `cs_reconcile_${stripeSlug}`
  const checkoutAdapter = createStripeCheckoutSessionAdapter({ endpointOrigin: 'https://api.stripe.com', checkoutOrigin: 'https://checkout.stripe.com', returnOrigin, credentialReference, resolveCredential, fetchImpl: async (_url, init) => {
    const body = new URLSearchParams(String(init?.body || ''))
    checkoutMetadata = Object.fromEntries(['ds_draft_order_id', 'ds_release_id', 'ds_owner_user_id', 'ds_configuration_fingerprint', 'ds_verification_receipt_fingerprint', 'ds_checkout_receipt_fingerprint', 'ds_snapshot_fingerprint'].map(key => [key, String(body.get(`metadata[${key}]`) || '')]))
    return new Response(JSON.stringify({ id: sessionId, object: 'checkout_session', url: `https://checkout.stripe.com/c/pay/${sessionId}#fidkdWxOYHwnPyd1blpxYHZxWjA0`, amount_total: line.quote.quote.totalMinor, currency: line.quote.quote.currency.toLowerCase(), metadata: checkoutMetadata }), { status: 200 })
  } })
  await createManagedSiteCheckoutSession(line.ownerUserId, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'live', idempotencyKey: `stripe-reconcile-checkout-${canonicalDomain}` }, checkoutAdapter, { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, credentialResolver: resolveCredential, clock: () => managedSiteFixedNow })
  const configuration = await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment')
  const checkout = line.live.state.receipts.find(receipt => receipt.receiptType === 'checkout_session_created')!
  const paymentIntentId = `pi_reconcile_${stripeSlug}`; const chargeId = `ch_reconcile_${stripeSlug}`
  const verifiedSuccess = (providerEventId: string): ManagedSiteVerifiedPaymentWebhook => ({ providerKey: 'stripe', providerEventId, providerReference: sessionId, eventType: 'checkout_succeeded', draftOrderId: line.order.order.id, ownerUserId: line.ownerUserId, releaseId: line.release.release.id, amountMinor: line.quote.quote.totalMinor, currency: line.quote.quote.currency, occurredAt: managedSiteFixedNow.toISOString(), exactResponseIdentity: `stripe-event:${providerEventId}`, canonicalPayloadHash: 'a'.repeat(64), configurationFingerprint: configuration!.configurationFingerprint, verificationReceiptFingerprint: configuration!.verificationReceiptFingerprint!, checkoutReceiptFingerprint: checkout.receiptFingerprint, snapshotFingerprint: line.prePurchase.commerceSnapshotFingerprint, stripePaymentIntentId: paymentIntentId })
  const processSuccess = (providerEventId: string) => processManagedSiteVerifiedPaymentWebhook({ verifiedEvent: verifiedSuccess(providerEventId), executionMode: 'live' }, { jointTransaction: line.jointTransaction, credentialResolver: resolveCredential, clock: () => managedSiteFixedNow })
  const reconciliationFetch = (state: 'paid' | 'unpaid' | 'disputed' | 'refunded'): typeof fetch => async input => {
    const url = String(input)
    if (url.endsWith(`/v1/checkout/sessions/${sessionId}`)) return new Response(JSON.stringify({ id: sessionId, object: 'checkout_session', created: Math.floor(managedSiteFixedNow.getTime() / 1000) - 30, status: state === 'unpaid' ? 'open' : 'complete', payment_status: state === 'unpaid' ? 'unpaid' : 'paid', amount_total: line.quote.quote.totalMinor, currency: line.quote.quote.currency.toLowerCase(), payment_intent: state === 'unpaid' ? null : paymentIntentId }))
    if (url.endsWith(`/v1/payment_intents/${paymentIntentId}`)) return new Response(JSON.stringify({ id: paymentIntentId, object: 'payment_intent', created: Math.floor(managedSiteFixedNow.getTime() / 1000) - 20, status: 'succeeded', amount_received: line.quote.quote.totalMinor, currency: line.quote.quote.currency.toLowerCase(), latest_charge: chargeId }))
    if (url.endsWith(`/v1/charges/${chargeId}`)) return new Response(JSON.stringify({ id: chargeId, object: 'charge', created: Math.floor(managedSiteFixedNow.getTime() / 1000) - 10, amount: line.quote.quote.totalMinor, amount_refunded: state === 'refunded' ? Math.floor(line.quote.quote.totalMinor / 2) : 0, currency: line.quote.quote.currency.toLowerCase(), refunded: state === 'refunded', disputed: state === 'disputed' }))
    throw new Error(`unexpected Stripe read: ${url}`)
  }
  const reconcile = (state: 'paid' | 'unpaid' | 'disputed' | 'refunded', key: string) => reconcileManagedSiteStripePayment(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, idempotencyKey: key }, { repository: line.live.repository, orderingRepository: line.ordering.repository, jointTransaction: line.jointTransaction, credentialResolver: resolveCredential, fetchImpl: reconciliationFetch(state), clock: () => managedSiteFixedNow })
  return { ...line, reconcile, processSuccess }
}

describe('managed-site Stripe payment reconciliation', () => {
  it('turns a provider-observed paid order into one verified payment and suppresses a later webhook', async () => {
    const line = await stripeLine('reconcile-paid.acme.taipei')
    const reconciled = await line.reconcile('paid', 'reconcile-paid-001')
    expect(reconciled).toMatchObject({ reported: { lifecycle: 'paid' }, agreesWithLocalState: false, transition: { effective: true } })
    expect(line.ordering.state.orders.find(order => order.id === line.order.order.id)?.status).toBe('payment_verified')
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'provisioning_armed')).toHaveLength(1)
    const laterWebhook = await line.processSuccess('evt_real_webhook_after_reconcile')
    expect(laterWebhook.effective).toBe(false)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'provisioning_armed')).toHaveLength(1)
  })

  it('records evidence only when the webhook already established paid state', async () => {
    const line = await stripeLine('reconcile-webhook-first.acme.taipei')
    expect((await line.processSuccess('evt_webhook_first')).effective).toBe(true)
    const reconciled = await line.reconcile('paid', 'reconcile-webhook-first-001')
    expect(reconciled).toMatchObject({ agreesWithLocalState: true, transition: null })
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'payment_reconciliation')).toHaveLength(1)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'provisioning_armed')).toHaveLength(1)
  })

  it('records unpaid provider evidence without changing local order, release, project, or subscription', async () => {
    const line = await stripeLine('reconcile-unpaid.acme.taipei')
    const before = structuredClone({ order: line.ordering.state.orders, releases: line.live.state.releases, projects: line.managed.state.projects, subscriptions: line.managed.state.subscriptions })
    const reconciled = await line.reconcile('unpaid', 'reconcile-unpaid-001')
    expect(reconciled).toMatchObject({ reported: { lifecycle: 'unpaid' }, transition: null })
    expect({ order: line.ordering.state.orders, releases: line.live.state.releases, projects: line.managed.state.projects, subscriptions: line.managed.state.subscriptions }).toEqual(before)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'payment_reconciliation')).toHaveLength(1)
  })

  it('uses read-only Charge evidence to apply an unbindable dispute exactly once', async () => {
    const line = await stripeLine('reconcile-dispute.acme.taipei')
    expect((await line.processSuccess('evt_paid_before_dispute')).effective).toBe(true)
    const first = await line.reconcile('disputed', 'reconcile-dispute-001')
    expect(first).toMatchObject({ reported: { lifecycle: 'disputed', chargeDisputed: true }, transition: { effective: true } })
    expect(line.ordering.state.orders.find(order => order.id === line.order.order.id)?.status).toBe('disputed')
    expect(line.live.state.releases.find(release => release.id === line.release.release.id)).toMatchObject({ status: 'blocked', blockedReasonCode: 'PAYMENT_DISPUTED' })
    const second = await line.reconcile('disputed', 'reconcile-dispute-002')
    expect(second).toMatchObject({ agreesWithLocalState: true, transition: null })
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'payment_disputed')).toHaveLength(1)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'payment_reconciliation')).toHaveLength(2)
  })

  it('uses the actual refunded amount from the read-only Charge response', async () => {
    const line = await stripeLine('reconcile-refund.acme.taipei')
    expect((await line.processSuccess('evt_paid_before_refund')).effective).toBe(true)
    const result = await line.reconcile('refunded', 'reconcile-refund-001')
    expect(result).toMatchObject({ reported: { lifecycle: 'refunded', chargeRefunded: true }, transition: { effective: true } })
    expect(line.ordering.state.orders.find(order => order.id === line.order.order.id)?.status).toBe('refunded')
    expect(line.live.state.releases.find(release => release.id === line.release.release.id)).toMatchObject({ status: 'blocked', blockedReasonCode: 'PAYMENT_REFUNDED' })
    expect(line.live.state.receipts.find(receipt => receipt.receiptType === 'payment_refunded')?.metadata).toMatchObject({ fullAmount: false, amountMinor: Math.floor(line.quote.quote.totalMinor / 2) })
  })

  it('replays a deterministic out-of-order reconciliation instead of colliding on a fresh local timestamp', async () => {
    const line = await stripeLine('reconcile-out-of-order-refund.acme.taipei')
    const first = await line.reconcile('refunded', 'reconcile-out-of-order-refund-001')
    expect(first).toMatchObject({ reported: { lifecycle: 'refunded' }, agreesWithLocalState: false, transition: { replayed: false, effective: false } })
    expect(line.ordering.state.orders.find(order => order.id === line.order.order.id)?.status).toBe('payment_pending')
    const second = await line.reconcile('refunded', 'reconcile-out-of-order-refund-002')
    expect(second).toMatchObject({ reported: { lifecycle: 'refunded' }, agreesWithLocalState: false, transition: { replayed: true, effective: false } })
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'payment_refunded')).toHaveLength(1)
    expect(line.live.state.receipts.find(receipt => receipt.receiptType === 'payment_refunded')?.metadata).toMatchObject({ occurredAt: new Date((Math.floor(managedSiteFixedNow.getTime() / 1000) - 10) * 1000).toISOString() })
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'payment_reconciliation')).toHaveLength(2)
  })
})
