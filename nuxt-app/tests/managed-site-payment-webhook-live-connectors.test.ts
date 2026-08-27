import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent } from '../server/managed-sites/ordering-service'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { createHmacRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'

const now = new Date('2026-08-27T00:00:00.000Z')

async function lineage() {
  const managed = createManagedSiteMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const live = createLiveConnectorMemoryRepository()
  await configureManagedSiteProvider(1, { capability: 'payment', providerKey: 'mock-payment', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'payment-mock-config' }, live.repository)
  const preview = await createManagedSitePreview(1, { draftIdentity: `payment-${randomBytes(4).toString('hex')}`, brandName: 'Webhook Client', audience: 'Webhook buyers', brief: 'Verified payment webhook lifecycle.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription'], styleReferences: [] }, ordering.repository, () => now)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'payment-quote-001' }, ordering.repository, () => now)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Webhook Owner', email: 'webhook-owner@managed.invalid', company: 'Webhook Client', website: 'https://webhook-client.acme.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'payment-lead-001' }, ordering.repository, () => now)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'payment-order-001' }, ordering.repository, () => now)
  const runtimeCredential = randomBytes(32).toString('hex')
  const send = async (event: Record<string, unknown>, bodyOverride?: Buffer) => {
    const rawBody = bodyOverride || Buffer.from(JSON.stringify(event))
    const signatureHeader = createHmac('sha256', runtimeCredential).update(rawBody).digest('hex')
    return processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-webhook-runtime', executionMode: 'mocked' }, createHmacRawBodyPaymentWebhookAdapter('mock-payment'), { connectorRepository: live.repository, orderingRepository: ordering.repository, managedRepository: managed.repository, credentialResolver: async reference => reference === 'vault:payment-webhook-runtime' ? { ok: true, value: runtimeCredential } : { ok: false, reason: 'missing_reference' }, clock: () => now })
  }
  const event = (providerEventId: string, eventType: string) => ({ providerKey: 'mock-payment', providerEventId, providerReference: 'payment-ref-001', eventType, draftOrderId: order.order.id, amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, occurredAt: now.toISOString(), exactResponseIdentity: `payment-response:${providerEventId}` })
  return { managed, ordering, live, quote, order, runtimeCredential, send, event }
}

describe('managed-site raw-body payment lifecycle', () => {
  it('verifies the raw signature before any database or repository access', async () => {
    const adapter = { verifyRawWebhook: vi.fn().mockResolvedValue(null) }
    const repositoryMethod = vi.fn(() => { throw new Error('must not query repository') })
    const dependencies: any = { connectorRepository: { findProviderConfiguration: repositoryMethod }, orderingRepository: { findDraftOrderById: repositoryMethod }, managedRepository: {}, credentialResolver: async () => ({ ok: false, reason: 'missing_reference' }) }
    await expect(processManagedSiteRawPaymentWebhook({ rawBody: Buffer.from('{}'), signatureHeader: 'invalid-signature', credentialReference: 'vault:payment-runtime', executionMode: 'mocked' }, adapter, dependencies)).rejects.toMatchObject({ statusCode: 403 })
    expect(adapter.verifyRawWebhook).toHaveBeenCalledTimes(1)
    expect(repositoryMethod).not.toHaveBeenCalled()
  })

  it('rejects tamper, replays exact events, detects collisions, and applies out-of-order/refund rules', async () => {
    const line = await lineage()
    const success = line.event('success-001', 'checkout_succeeded')
    const signedSuccess = Buffer.from(JSON.stringify(success))
    const tampered = Buffer.from(JSON.stringify({ ...success, amountMinor: line.quote.quote.totalMinor + 1 }))
    const signatureForOriginal = createHmac('sha256', line.runtimeCredential).update(signedSuccess).digest('hex')
    await expect(processManagedSiteRawPaymentWebhook({ rawBody: tampered, signatureHeader: signatureForOriginal, credentialReference: 'vault:payment-webhook-runtime', executionMode: 'mocked' }, createHmacRawBodyPaymentWebhookAdapter('mock-payment'), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, credentialResolver: async () => ({ ok: true, value: line.runtimeCredential }), clock: () => now })).rejects.toMatchObject({ statusCode: 403 })
    expect(line.live.state.receipts).toHaveLength(0)

    const earlyRefund = await line.send(line.event('refund-early-001', 'payment_refunded'))
    expect(earlyRefund.effective).toBe(false)
    expect(earlyRefund.event.receiptStatus).toBe('ignored_out_of_order')
    const paid = await line.send(success)
    expect(paid.effective).toBe(true)
    const paidReplay = await line.send(success)
    expect(paidReplay.replayed).toBe(true)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'checkout_succeeded')).toHaveLength(1)

    await expect(line.send({ ...success, eventType: 'checkout_cancelled' })).rejects.toMatchObject({ statusCode: 409 })
    const lateFailure = await line.send(line.event('failure-late-001', 'checkout_failed'))
    expect(lateFailure.event.receiptStatus).toBe('ignored_out_of_order')
    const refund = await line.send(line.event('refund-001', 'payment_refunded'))
    expect(refund.effective).toBe(true)
    const project = await line.managed.repository.findProject(1, paid.projectId!)
    const subscription = await line.managed.repository.findSubscription(1, paid.projectId!)
    expect(project?.status).toBe('suspended')
    expect(subscription?.status).toBe('suspended')
    const secondRefund = await line.send(line.event('refund-002', 'payment_refunded'))
    expect(secondRefund.event.receiptStatus).toBe('ignored_out_of_order')
    expect(JSON.stringify(line.live.state)).not.toContain(line.runtimeCredential)
    expect(JSON.stringify(line.live.state)).not.toContain(Buffer.from(JSON.stringify(success)).toString('utf8'))
  })

  it('creates checkout only from the exact server-derived quote and rejects adapter amount collisions', async () => {
    const line = await lineage()
    const created = await createManagedSiteCheckoutSession(1, { draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-session-001' }, createMockManagedSiteCheckoutSessionAdapter(), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, clock: () => now })
    expect(created.checkout).toMatchObject({ amountMinor: line.quote.quote.totalMinor, currency: line.quote.quote.currency, taxStatus: 'not_calculated' })
    expect(created.receipt.metadata).toMatchObject({ amountMinor: line.quote.quote.totalMinor, currency: line.quote.quote.currency })
    const badAdapter = { createSession: async (input: any) => ({ ...(await createMockManagedSiteCheckoutSessionAdapter().createSession(input)), amountMinor: input.amountMinor + 1 }) }
    await expect(createManagedSiteCheckoutSession(1, { draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-session-collision' }, badAdapter, { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, clock: () => now })).rejects.toMatchObject({ statusCode: 409 })
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'checkout_session_created')).toHaveLength(1)
  })
})
