import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow as now } from './fixtures/managed-site/live-connectors-application'

async function webhookLineage() {
  const line = await createAuthoritativeManagedSiteReleaseFixture()
  const runtimeCredential = randomBytes(32).toString('hex')
  const event = (providerEventId: string, eventType: string) => managedSiteExactPaymentWebhookPayload(line, { providerEventId, eventType })
  const send = async (payload: Record<string, unknown>, bodyOverride?: Buffer) => {
    const rawBody = bodyOverride || Buffer.from(JSON.stringify(payload)); const signatureHeader = createHmac('sha256', runtimeCredential).update(rawBody).digest('hex')
    return processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-webhook-runtime', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async reference => reference === 'vault:payment-webhook-runtime' ? { ok: true, value: runtimeCredential } : { ok: false, reason: 'missing_reference' }, clock: () => now })
  }
  return { ...line, runtimeCredential, event, send }
}

describe('managed-site raw-body payment lifecycle', () => {
  it('verifies raw signature before any repository access', async () => {
    const adapter = { verifyRawWebhook: vi.fn().mockResolvedValue(null) }
    const repositoryMethod = vi.fn(() => { throw new Error('must not query repository') })
    await expect(processManagedSiteRawPaymentWebhook({ rawBody: Buffer.from('{}'), signatureHeader: 'invalid-signature', credentialReference: 'vault:payment-runtime', executionMode: 'mocked' }, adapter, { connectorRepository: { findProviderConfiguration: repositoryMethod } as any, orderingRepository: { findDraftOrderById: repositoryMethod } as any, managedRepository: {} as any, credentialResolver: async () => ({ ok: false, reason: 'missing_reference' }) })).rejects.toMatchObject({ statusCode: 403 })
    expect(adapter.verifyRawWebhook).toHaveBeenCalledTimes(1); expect(repositoryMethod).not.toHaveBeenCalled()
  })

  it('rejects tamper, replays exact events, and ignores duplicate/out-of-order lifecycle mutations', async () => {
    const line = await webhookLineage(); const success = await line.event('success-001', 'checkout_succeeded')
    const signedSuccess = Buffer.from(JSON.stringify(success)); const tampered = Buffer.from(JSON.stringify({ ...success, amountMinor: line.quote.quote.totalMinor + 1 })); const signature = createHmac('sha256', line.runtimeCredential).update(signedSuccess).digest('hex')
    await expect(processManagedSiteRawPaymentWebhook({ rawBody: tampered, signatureHeader: signature, credentialReference: 'vault:payment-webhook-runtime', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true, value: line.runtimeCredential }), clock: () => now })).rejects.toMatchObject({ statusCode: 403 })
    expect(line.live.state.receipts.filter(item => item.receiptType === 'checkout_succeeded')).toHaveLength(0)
    const earlyRefund = await line.send(await line.event('refund-early-001', 'payment_refunded')); expect(earlyRefund.effective).toBe(false); expect(earlyRefund.event.metadata).toMatchObject({ effective: false })
    const paid = await line.send(success); expect(paid.effective).toBe(true); expect(paid.event.metadata).toMatchObject({ settledAs: 'refunded', settledByProviderEventId: 'refund-early-001', settledByReceiptFingerprint: earlyRefund.event.receiptFingerprint })
    expect(line.ordering.state.orders.find(item => item.id === line.order.order.id)?.status).toBe('refunded')
    expect(line.live.state.releases.find(item => item.id === line.release.release.id)).toMatchObject({ status: 'blocked', blockedReasonCode: 'PAYMENT_REFUNDED', nextSafeAction: 'review_refund_and_live_site_suspension' })
    expect(line.managed.state.projects.find(item => item.id === line.prePurchase.project.id)?.status).toBe('suspended')
    expect(line.managed.state.subscriptions.find(item => item.projectId === line.prePurchase.project.id)?.status).toBe('suspended')
    expect(line.live.state.receipts.filter(item => item.receiptType === 'provisioning_armed')).toHaveLength(0)
    expect(line.live.state.receipts.filter(item => item.receiptType === 'release_payment_bound')).toHaveLength(0)
    const settledRefunds = line.live.state.receipts.filter(item => item.receiptType === 'payment_refunded' && item.receiptStatus === 'verified' && (item.metadata as any)?.effective === true)
    expect(settledRefunds).toHaveLength(1); expect(settledRefunds[0]?.metadata).toMatchObject({ settledFromProviderEventId: 'refund-early-001' })
    const replay = await line.send(success); expect(replay.replayed).toBe(true)
    const duplicateSuccess = await line.send(await line.event('success-duplicate-002', 'checkout_succeeded')); expect(duplicateSuccess.effective).toBe(false); expect(duplicateSuccess.event.receiptStatus).toBe('ignored_out_of_order')
    await expect(line.send({ ...success, eventType: 'checkout_cancelled' })).rejects.toMatchObject({ statusCode: 409 })
    const lateFailure = await line.send(await line.event('failure-late-001', 'checkout_failed')); expect(lateFailure.event.receiptStatus).toBe('ignored_out_of_order')
    const refunded = await line.send(await line.event('refund-effective-001', 'payment_refunded')); expect(refunded.effective).toBe(false); expect(refunded.event.receiptStatus).toBe('ignored_out_of_order')
    expect((await line.send(await line.event('refund-effective-001', 'payment_refunded'))).replayed).toBe(true)
    const duplicateRefund = await line.send(await line.event('refund-duplicate-002', 'payment_refunded')); expect(duplicateRefund.effective).toBe(false); expect(duplicateRefund.event.receiptStatus).toBe('ignored_out_of_order')
    expect(JSON.stringify(line.live.state)).not.toContain(line.runtimeCredential)
  })

  it('creates checkout only after exact release approval and rejects adapter commercial collision', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    const created = await createManagedSiteCheckoutSession(1, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-session-001' }, createMockManagedSiteCheckoutSessionAdapter(), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, clock: () => now })
    expect(created.checkout).toMatchObject({ amountMinor: line.quote.quote.totalMinor, currency: line.quote.quote.currency, taxStatus: 'not_calculated' })
    const second = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false, canonicalDomain: 'collision.acme.taipei' })
    const badAdapter = { createSession: async (input: any) => ({ ...(await createMockManagedSiteCheckoutSessionAdapter().createSession(input)), amountMinor: input.amountMinor + 1 }) }
    await expect(createManagedSiteCheckoutSession(1, { releaseId: second.release.release.id, draftOrderId: second.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-session-collision' }, badAdapter, { connectorRepository: second.live.repository, orderingRepository: second.ordering.repository, clock: () => now })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('accepts an exact cancellation and ignores a later out-of-order success without activating payment', async () => {
    const line = await webhookLineage()
    const cancelled = await line.send(await line.event('cancel-effective-001', 'checkout_cancelled'))
    expect(cancelled.effective).toBe(true)
    expect(line.ordering.state.orders.find(item => item.id === line.order.order.id)?.status).toBe('cancelled')
    const lateSuccess = await line.send(await line.event('success-after-cancel-001', 'checkout_succeeded'))
    expect(lateSuccess.effective).toBe(false)
    expect(lateSuccess.event.receiptStatus).toBe('ignored_out_of_order')
    expect(line.managed.state.subscriptions).toHaveLength(0)
  })

  it('prefers an ignored dispute over refund and otherwise settles the newest terminal receipt', async () => {
    const disputed = await webhookLineage()
    const earlyDispute = { ...(await disputed.event('dispute-early-001', 'payment_disputed')), occurredAt: new Date(now.getTime() - 2_000).toISOString() }
    const laterRefund = { ...(await disputed.event('refund-later-001', 'payment_refunded')), occurredAt: new Date(now.getTime() - 1_000).toISOString() }
    expect((await disputed.send(earlyDispute)).effective).toBe(false); expect((await disputed.send(laterRefund)).effective).toBe(false)
    const disputePaid = await disputed.send(await disputed.event('success-dispute-precedence-001', 'checkout_succeeded'))
    expect(disputePaid.event.metadata).toMatchObject({ settledAs: 'disputed', settledByProviderEventId: 'dispute-early-001' })
    expect(disputed.ordering.state.orders.find(item => item.id === disputed.order.order.id)?.status).toBe('disputed')

    const refunded = await webhookLineage()
    const olderRefund = { ...(await refunded.event('refund-older-001', 'payment_refunded')), occurredAt: new Date(now.getTime() - 2_000).toISOString() }
    const newerRefund = { ...(await refunded.event('refund-newer-001', 'payment_refunded')), occurredAt: new Date(now.getTime() - 1_000).toISOString() }
    expect((await refunded.send(olderRefund)).effective).toBe(false); expect((await refunded.send(newerRefund)).effective).toBe(false)
    const refundPaid = await refunded.send(await refunded.event('success-newest-refund-001', 'checkout_succeeded'))
    expect(refundPaid.event.metadata).toMatchObject({ settledAs: 'refunded', settledByProviderEventId: 'refund-newer-001' })
    expect(refunded.ordering.state.orders.find(item => item.id === refunded.order.order.id)?.status).toBe('refunded')
  })

  it('rejects signed stale configuration and checkout authority lineage with zero joint-transaction writes', async () => {
    for (const patch of [
      { configurationFingerprint: 'f'.repeat(64) },
      { verificationReceiptFingerprint: 'e'.repeat(64) },
      { checkoutReceiptFingerprint: 'd'.repeat(64) },
    ]) {
      const line = await webhookLineage(); const payload = { ...(await line.event(`lineage-${Object.keys(patch)[0]}`, 'checkout_succeeded')), ...patch }
      await expect(line.send(payload)).rejects.toMatchObject({ statusCode: 409 })
      expect(line.live.state.paymentWebhookInbox).toHaveLength(0); expect(line.ordering.state.paymentEvents).toHaveLength(0); expect(line.managed.state.subscriptions).toHaveLength(0)
    }
    const stale = await webhookLineage(); const payload = await stale.event('lineage-stale-current-config', 'checkout_succeeded')
    stale.live.state.configurations.find(row => row.capability === 'payment')!.configurationFingerprint = 'c'.repeat(64)
    await expect(stale.send(payload)).rejects.toMatchObject({ statusCode: 409 })
    expect(stale.live.state.paymentWebhookInbox).toHaveLength(0); expect(stale.ordering.state.paymentEvents).toHaveLength(0); expect(stale.managed.state.subscriptions).toHaveLength(0)
  })
})
