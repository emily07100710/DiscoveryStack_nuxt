import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStripeCheckoutSessionAdapter, createStripePaymentWebhookAdapter, stripeAmountScale } from '../server/managed-sites/live-connectors/stripe-adapters'
import type { ManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/types'

const savedProviderOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
const savedCheckoutOrigins = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
const now = new Date('2026-09-05T00:00:00.000Z')
const credential = 'stripe-amount-scale-test-secret'

beforeEach(() => {
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://api.stripe.com'
  process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = 'https://checkout.stripe.com'
})

afterEach(() => {
  if (savedProviderOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = savedProviderOrigins
  if (savedCheckoutOrigins === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS
  else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_CHECKOUT_ORIGINS = savedCheckoutOrigins
})

type CheckoutInput = Parameters<ManagedSiteCheckoutSessionAdapter['createSession']>[0]

const checkoutInput: CheckoutInput = {
  ownerUserId: 7,
  projectId: 11,
  releaseId: 13,
  previewId: 17,
  approvalFingerprint: 'a'.repeat(64),
  draftOrderId: 19,
  quoteId: 23,
  amountMinor: 24100,
  currency: 'TWD',
  planKey: 'site_geo_autopost',
  cadenceDays: 7,
  domainOption: 'existing',
  lineSnapshot: [
    { lineKey: 'build-simple_commerce', quantity: 1, unitAmountMinor: 18000, lineAmountMinor: 18000 },
    { lineKey: 'monthly-plan-site_geo_autopost', quantity: 1, unitAmountMinor: 6100, lineAmountMinor: 6100 },
  ],
  taxStatus: 'not_calculated',
  snapshotFingerprint: 'b'.repeat(64),
  checkoutReceiptFingerprint: 'c'.repeat(64),
  configurationFingerprint: 'd'.repeat(64),
  verificationReceiptFingerprint: 'e'.repeat(64),
  capabilityIdentity: 'stripe-balance:test',
  idempotencyKey: 'stripe-amount-scale-001',
  timeoutMs: 5000,
}

function checkoutAdapter(amountTotal: number, capture: { body?: URLSearchParams } = {}) {
  return createStripeCheckoutSessionAdapter({
    endpointOrigin: 'https://api.stripe.com',
    checkoutOrigin: 'https://checkout.stripe.com',
    returnOrigin: 'https://merchant.example.com',
    credentialReference: 'vault:stripe-amount-scale-test',
    resolveCredential: async () => ({ ok: true, value: credential }),
    fetchImpl: async (_url, init) => {
      const body = new URLSearchParams(String(init?.body || ''))
      capture.body = body
      const metadata = Object.fromEntries([...body.entries()].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice('metadata['.length, -1), value]))
      return new Response(JSON.stringify({ id: 'cs_amount_scale_001', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_amount_scale_001', amount_total: amountTotal, currency: 'twd', metadata }))
    },
  })
}

function signedCheckoutEvent(amountTotal: number, eventId: string) {
  const payload = { id: eventId, object: 'event', type: 'checkout.session.completed', created: Math.floor(now.getTime() / 1000), data: { object: { id: 'cs_amount_scale_webhook_001', object: 'checkout.session', payment_status: 'paid', amount_total: amountTotal, currency: 'twd' } } }
  const rawBody = Buffer.from(JSON.stringify(payload))
  const timestamp = Math.floor(now.getTime() / 1000)
  const signature = createHmac('sha256', credential).update(`${timestamp}.`).update(rawBody).digest('hex')
  return { rawBody, signatureHeader: `t=${timestamp},v1=${signature}`, credentialReference: 'vault:stripe-amount-scale-test', resolveCredential: async () => ({ ok: true as const, value: credential }) }
}

describe('managed-site Stripe amount scaling', () => {
  it('uses Stripe special-case scaling only for the documented currencies', () => {
    expect(stripeAmountScale('usd')).toBe(1)
    expect(stripeAmountScale('twd')).toBe(100)
  })

  it('scales TWD line amounts while preserving monthly recurrence and accepts the scaled total echo', async () => {
    const capture: { body?: URLSearchParams } = {}
    const receipt = await checkoutAdapter(2410000, capture).createSession(checkoutInput)

    expect(capture.body?.get('line_items[0][price_data][unit_amount]')).toBe('1800000')
    expect(capture.body?.get('line_items[1][price_data][recurring][interval]')).toBe('month')
    expect(receipt.amountMinor).toBe(24100)
  })

  it('rejects an unscaled TWD create-session amount echo with the existing mismatch error', async () => {
    await expect(checkoutAdapter(24100).createSession(checkoutInput)).rejects.toMatchObject({ statusCode: 409, statusMessage: 'Stripe response does not match the exact managed-site checkout snapshot.' })
  })

  it('converts a scaled TWD checkout webhook and rejects a non-divisible amount', async () => {
    const adapter = createStripePaymentWebhookAdapter({ clock: () => now })
    await expect(adapter.verifyRawWebhook(signedCheckoutEvent(2410000, 'evt_amount_scale_valid_001'))).resolves.toMatchObject({ amountMinor: 24100, currency: 'TWD' })
    await expect(adapter.verifyRawWebhook(signedCheckoutEvent(2410050, 'evt_amount_scale_invalid_001'))).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Stripe webhook signature or payload is invalid.' })
  })
})
