import { describe, expect, it } from 'vitest'
import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote, createManagedSiteCheckoutAuthorityResolver } from '../server/managed-sites/ordering-service'
import { claimManagedSiteCheckout } from '../server/managed-sites/checkout-claim-service'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'

const mockPaymentVerifier: PaymentEventVerifier = { verify: async () => true }

async function makeClaimLineage() {
  const ordering = createOrderingMemoryRepository()
  const managed = createManagedSiteMemoryRepository()
  const preview = await createManagedSitePreview(null, { draftIdentity: 'checkout-claim-preview-001', brandName: 'Claim Client', audience: 'Taiwan customers', brief: 'A governed preview.', businessGoals: ['sell_online'], siteType: 'simple_commerce', selectedModules: ['managed_content_admin', 'shopify_commerce', 'geo_content_subscription'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'existing', idempotencyKey: 'checkout-claim-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Claim Client', email: 'same-owner@example.com', company: 'Claim Client', website: null, privacyConsent: true, recontactConsent: false, idempotencyKey: 'checkout-claim-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'checkout-claim-order-001' }, ordering.repository)
  const input = { previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id }
  return { ordering, managed, preview, quote, lead, order, input }
}

function paymentInput(draftOrderId: number, amountMinor: number, currency: string) {
  return { draftOrderId, providerKey: 'mock-payment', eventId: 'checkout-claim-payment-001', providerReference: 'checkout-claim-reference-001', eventType: 'payment_succeeded' as const, amountMinor, currency, canonicalPayloadHash: 'a'.repeat(64), idempotencyKey: 'checkout-claim-payment-idempotency-001' }
}

describe('managed site checkout claim authority', () => {
  it('never derives authority from a lead email, including case variants, and fails closed before claim', async () => {
    const line = await makeClaimLineage()
    const resolver = createManagedSiteCheckoutAuthorityResolver()
    const input = {
      preview: { ...line.ordering.state.previews[0]!, ownerUserId: null },
      quote: { ...line.ordering.state.quotes[0]!, ownerUserId: null },
      leadIntent: { ...line.ordering.state.leadIntents[0]!, ownerUserId: null },
      draftOrder: { ...line.ordering.state.orders[0]!, ownerUserId: null },
      subscriptionIntent: { ...line.ordering.state.subscriptionIntents[0]!, ownerUserId: null },
    }
    expect(await resolver.resolve(input)).toBeNull()
    await expect(processManagedSitePaymentAndConversion(paymentInput(line.order.order.id, line.quote.quote.totalMinor, line.quote.quote.currency), mockPaymentVerifier, { ordering: line.ordering.repository, managed: line.managed.repository })).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.projects).toHaveLength(0)
  })

  it('claims the exact anonymous lineage for the signed-in owner and permits default payment conversion only after claim', async () => {
    const line = await makeClaimLineage()
    await expect(processManagedSitePaymentAndConversion(paymentInput(line.order.order.id, line.quote.quote.totalMinor, line.quote.quote.currency), mockPaymentVerifier, { ordering: line.ordering.repository, managed: line.managed.repository })).rejects.toMatchObject({ statusCode: 409 })
    expect(line.managed.state.projects).toHaveLength(0)

    const claimed = await claimManagedSiteCheckout(1, line.input, line.ordering.repository, () => new Date('2026-08-27T00:00:00.000Z'))
    expect(claimed).toMatchObject({ ownerUserId: 1, previewId: line.preview.preview.id, quoteId: line.quote.quote.quoteId, leadIntentId: line.lead.leadIntent.id, draftOrderId: line.order.order.id, replayed: false })
    expect(line.ordering.state.previews[0]?.ownerUserId).toBe(1)
    expect(line.ordering.state.quotes[0]?.ownerUserId).toBe(1)
    expect(line.ordering.state.leadIntents[0]?.ownerUserId).toBe(1)
    expect(line.ordering.state.orders[0]?.ownerUserId).toBe(1)
    expect(line.ordering.state.subscriptionIntents[0]?.ownerUserId).toBe(1)

    const converted = await processManagedSitePaymentAndConversion(paymentInput(line.order.order.id, line.quote.quote.totalMinor, line.quote.quote.currency), mockPaymentVerifier, { ordering: line.ordering.repository, managed: line.managed.repository })
    expect(converted.project.ownerUserId).toBe(1)
    expect(line.managed.state.projects).toHaveLength(1)
  })

  it('rejects malformed, wrong-token, wrong-lineage, and cross-owner claims without overwriting the bound lineage', async () => {
    const line = await makeClaimLineage()
    await expect(claimManagedSiteCheckout(1, { ...line.input, previewAccessToken: 'too-short' }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 422 })
    await expect(claimManagedSiteCheckout(1, { ...line.input, previewAccessToken: 'x'.repeat(64) }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 404 })
    await expect(claimManagedSiteCheckout(1, { ...line.input, quoteId: line.quote.quote.quoteId + 999 }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(claimManagedSiteCheckout(1, { ...line.input, leadIntentId: line.lead.leadIntent.id + 999 }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    await expect(claimManagedSiteCheckout(1, { ...line.input, draftOrderId: line.order.order.id + 999 }, line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    await claimManagedSiteCheckout(1, line.input, line.ordering.repository)
    await expect(claimManagedSiteCheckout(2, line.input, line.ordering.repository)).rejects.toMatchObject({ statusCode: 409 })
    expect(line.ordering.state.previews[0]?.ownerUserId).toBe(1)
    expect(line.ordering.state.quotes[0]?.ownerUserId).toBe(1)
    expect(line.ordering.state.orders[0]?.ownerUserId).toBe(1)
  })

  it('serializes concurrent claims so same-owner replay succeeds while a different owner cannot also succeed', async () => {
    const line = await makeClaimLineage()
    const [first, second, foreign] = await Promise.allSettled([
      claimManagedSiteCheckout(1, line.input, line.ordering.repository),
      claimManagedSiteCheckout(1, line.input, line.ordering.repository),
      claimManagedSiteCheckout(2, line.input, line.ordering.repository),
    ])
    const fulfilled = [first, second, foreign].filter(result => result.status === 'fulfilled')
    const rejected = [first, second, foreign].filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } })
    expect(fulfilled.map(result => result.status === 'fulfilled' ? result.value.replayed : null).sort()).toEqual([false, true])
    expect(new Set([line.ordering.state.previews[0]?.ownerUserId, line.ordering.state.quotes[0]?.ownerUserId, line.ordering.state.orders[0]?.ownerUserId])).toEqual(new Set([1]))
  })
})
