import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook, type ManagedSitePaymentWebhookFaultPoint } from '../server/managed-sites/live-connectors/payment-webhook'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow as now } from './fixtures/managed-site/live-connectors-application'

describe('managed-site payment webhook genuine joint transaction', () => {
  for (const faultPoint of ['after_inbox_claim', 'after_payment_authority', 'after_project_update', 'after_subscription_insert', 'before_receipt_insert', 'after_receipt_insert', 'before_release_cas'] satisfies ManagedSitePaymentWebhookFaultPoint[]) {
    it(`rolls back every repository and converges on exact replay after ${faultPoint}`, async () => {
      const line = await createAuthoritativeManagedSiteReleaseFixture(); const credential = 'runtime-only-joint-transaction-key'
      const payload = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: `joint-${faultPoint}`, providerReference: `payment-ref-${faultPoint}`, eventType: 'checkout_succeeded', exactResponseIdentity: `payment-response:${faultPoint}` })
      const rawBody = Buffer.from(JSON.stringify(payload)); const signatureHeader = createHmac('sha256', credential).update(rawBody).digest('hex')
      const base = { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true as const, value: credential }), clock: () => now }
      await expect(processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-joint-test', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { ...base, faultInjector: point => { if (point === faultPoint) throw new Error(`fault:${point}`) } })).rejects.toThrow(`fault:${faultPoint}`)
      expect(line.live.state.paymentWebhookInbox).toHaveLength(0)
      expect(line.ordering.state.paymentEvents).toHaveLength(0)
      expect(line.managed.state.subscriptions).toHaveLength(0)
      expect(line.live.state.receipts.filter(row => ['checkout_succeeded', 'release_payment_bound'].includes(row.receiptType))).toHaveLength(0)
      const retried = await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-joint-test', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), base)
      expect(retried.effective).toBe(true)
      expect(line.live.state.paymentWebhookInbox).toHaveLength(1)
      expect(line.ordering.state.paymentEvents).toHaveLength(1)
      expect(line.managed.state.subscriptions).toHaveLength(1)
      expect(line.live.state.receipts.filter(row => row.receiptType === 'checkout_succeeded')).toHaveLength(1)
      expect(line.live.state.receipts.filter(row => row.receiptType === 'release_payment_bound')).toHaveLength(1)
      expect(line.live.state.releases.find(row => row.id === line.release.release.id)?.status).toBe('payment_verified')
    })
  }
})
