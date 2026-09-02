import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { processManagedSiteRawPaymentWebhook, type ManagedSitePaymentWebhookFaultPoint } from '../server/managed-sites/live-connectors/payment-webhook'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { createStripePaymentWebhookAdapter } from '../server/managed-sites/live-connectors/stripe-adapters'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow as now } from './fixtures/managed-site/live-connectors-application'

describe('managed-site payment webhook genuine joint transaction', () => {
  for (const adapterKind of ['hmac', 'stripe'] as const) for (const faultPoint of ['after_inbox_claim', 'after_payment_authority', 'after_project_update', 'after_subscription_insert', 'before_receipt_insert', 'after_receipt_insert', 'before_release_cas'] satisfies ManagedSitePaymentWebhookFaultPoint[]) {
    it(`rolls back every repository and converges on exact replay for ${adapterKind} after ${faultPoint}`, async () => {
      const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: adapterKind === 'hmac' }); const credential = randomBytes(32).toString('hex')
      if (adapterKind === 'stripe') {
        await configureManagedSiteProvider(line.ownerUserId, { capability: 'payment', providerKey: 'stripe', readinessStatus: 'mock', transportConfiguration: {}, idempotencyKey: `joint-stripe-config-${faultPoint}` }, line.live.repository, () => now)
        await createManagedSiteCheckoutSession(line.ownerUserId, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: `joint-stripe-checkout-${faultPoint}` }, createMockManagedSiteCheckoutSessionAdapter('stripe'), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, clock: () => now })
      }
      const configuration = await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment'); const checkout = line.live.state.receipts.find(row => row.receiptType === 'checkout_session_created')!
      const reduced = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: `joint-${faultPoint}`, providerReference: `payment-ref-${faultPoint}`, eventType: 'checkout_succeeded', exactResponseIdentity: `payment-response:${faultPoint}` })
      const payload = adapterKind === 'hmac' ? reduced : { id: `evt_joint_${faultPoint}`, object: 'event', type: 'checkout.session.completed', created: Math.floor(now.getTime() / 1000), data: { object: { id: `cs_joint_${faultPoint}`, object: 'checkout_session', payment_status: 'paid', amount_total: line.quote.quote.totalMinor, currency: line.quote.quote.currency.toLowerCase(), metadata: { ds_draft_order_id: String(line.order.order.id), ds_release_id: String(line.release.release.id), ds_owner_user_id: String(line.ownerUserId), ds_configuration_fingerprint: configuration!.configurationFingerprint, ds_verification_receipt_fingerprint: configuration!.verificationReceiptFingerprint, ds_checkout_receipt_fingerprint: checkout.receiptFingerprint, ds_snapshot_fingerprint: line.prePurchase.commerceSnapshotFingerprint } } } }
      const rawBody = Buffer.from(JSON.stringify(payload)); const timestamp = Math.floor(now.getTime() / 1000)
      const signatureHeader = adapterKind === 'hmac' ? createHmac('sha256', credential).update(rawBody).digest('hex') : `t=${timestamp},v1=${createHmac('sha256', credential).update(`${timestamp}.`).update(rawBody).digest('hex')}`
      const adapter = adapterKind === 'hmac' ? createMockRawBodyPaymentWebhookAdapter('mock-payment') : createStripePaymentWebhookAdapter({ clock: () => now })
      const base = { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true as const, value: credential }), clock: () => now }
      await expect(processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-joint-test', executionMode: 'mocked' }, adapter, { ...base, faultInjector: point => { if (point === faultPoint) throw new Error(`fault:${point}`) } })).rejects.toThrow(`fault:${faultPoint}`)
      expect(line.live.state.paymentWebhookInbox).toHaveLength(0)
      expect(line.ordering.state.paymentEvents).toHaveLength(0)
      expect(line.managed.state.subscriptions).toHaveLength(0)
      expect(line.live.state.receipts.filter(row => ['checkout_succeeded', 'release_payment_bound', 'provisioning_armed'].includes(row.receiptType))).toHaveLength(0)
      const retried = await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-joint-test', executionMode: 'mocked' }, adapter, base)
      expect(retried.effective).toBe(true)
      expect(line.live.state.paymentWebhookInbox).toHaveLength(1)
      expect(line.ordering.state.paymentEvents).toHaveLength(1)
      expect(line.managed.state.subscriptions).toHaveLength(1)
      expect(line.live.state.receipts.filter(row => row.receiptType === 'checkout_succeeded')).toHaveLength(1)
      expect(line.live.state.receipts.filter(row => row.receiptType === 'release_payment_bound')).toHaveLength(1)
      expect(line.live.state.receipts.filter(row => row.receiptType === 'provisioning_armed')).toHaveLength(1)
      expect(line.live.state.releases.find(row => row.id === line.release.release.id)?.status).toBe('payment_verified')
    })
  }
})
