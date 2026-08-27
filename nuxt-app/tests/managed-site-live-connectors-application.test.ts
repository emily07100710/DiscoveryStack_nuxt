import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { activateManagedSiteGeoOperations, approveManagedSitePreview, bindManagedSiteReleasePayment, deployManagedSiteProduction } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter, createManagedSiteDomainPurchaseIntent, executeManagedSiteDnsTls, managedSiteDomainConfirmationFingerprint, quoteManagedSiteDomain } from '../server/managed-sites/live-connectors/domain-connectors'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

describe('managed-site authoritative mocked application path', () => {
  it('generates and gates preview before checkout/payment, then requires exact domain/deploy receipts before GEO activation', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture()
    expect(line.prePurchase.project.status).toBe('payment_pending')
    expect(line.prePurchase.version.lifecycleStatus).toBe('draft')
    expect(line.managed.state.subscriptions).toHaveLength(0)
    const generationReceipt = line.live.state.receipts.find(receipt => receipt.receiptType === 'generation_candidate_admitted')!
    const previewReceipt = line.live.state.receipts.find(receipt => receipt.receiptType === 'preview_build_verified')!
    const checkoutReceipt = line.live.state.receipts.find(receipt => receipt.receiptType === 'checkout_session_created')!
    expect(generationReceipt.id).toBeLessThan(previewReceipt.id)
    expect(previewReceipt.id).toBeLessThan(checkoutReceipt.id)
    expect(line.live.state.gates.filter(gate => gate.result === 'passed')).toHaveLength(6)
    expect(line.live.state.receipts.some(receipt => receipt.receiptType === 'checkout_succeeded')).toBe(false)

    const webhookCredential = randomBytes(32).toString('hex')
    const event = { providerKey: 'mock-payment', providerEventId: 'payment-success-authoritative-001', providerReference: 'payment-ref-authoritative-001', eventType: 'checkout_succeeded', draftOrderId: line.order.order.id, amountMinor: line.quote.quote.totalMinor, currency: line.quote.quote.currency, occurredAt: managedSiteFixedNow.toISOString(), exactResponseIdentity: 'payment-response:authoritative-001' }
    const rawBody = Buffer.from(JSON.stringify(event)); const signatureHeader = createHmac('sha256', webhookCredential).update(rawBody).digest('hex')
    const payment = await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-webhook-test', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, credentialResolver: async reference => reference === 'vault:payment-webhook-test' ? { ok: true, value: webhookCredential } : { ok: false, reason: 'missing_reference' }, clock: () => managedSiteFixedNow })
    expect(payment.effective).toBe(true)
    expect(line.managed.state.subscriptions).toHaveLength(1)
    const paymentReceipt = payment.event
    const bound = await bindManagedSiteReleasePayment(line.ownerUserId, { releaseId: line.release.release.id, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint, idempotencyKey: 'fixture-payment-bind-001' }, line.live.repository, () => managedSiteFixedNow, line.ordering.repository)
    expect(bound.release.status).toBe('payment_verified')
    expect((await bindManagedSiteReleasePayment(line.ownerUserId, { releaseId: line.release.release.id, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint, idempotencyKey: 'fixture-payment-bind-001' }, line.live.repository, () => managedSiteFixedNow, line.ordering.repository)).replayed).toBe(true)

    const domainAdapter = createMockManagedSiteDomainAdapter({ now: () => managedSiteFixedNow })
    const domainQuote = await quoteManagedSiteDomain(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, requestedDomain: line.release.release.canonicalDomain, executionMode: 'mocked', idempotencyKey: 'fixture-domain-quote-001' }, domainAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow })
    const wrongConfirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId: line.ownerUserId, projectId: line.prePurchase.project.id, releaseId: line.release.release.id, commerceSnapshotFingerprint: line.prePurchase.commerceSnapshotFingerprint, quoteReceiptFingerprint: domainQuote.receiptFingerprint!, draftOrderId: line.order.order.id, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint })
    await expect(createManagedSiteDomainPurchaseIntent(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, draftOrderId: line.order.order.id, quoteReceiptFingerprint: domainQuote.receiptFingerprint!, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint, ownerConfirmationFingerprint: wrongConfirmation, executionMode: 'mocked', idempotencyKey: 'fixture-domain-wrong-payment' }, domainAdapter, { repository: line.live.repository, clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 })
    const confirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId: line.ownerUserId, projectId: line.prePurchase.project.id, releaseId: line.release.release.id, commerceSnapshotFingerprint: line.prePurchase.commerceSnapshotFingerprint, quoteReceiptFingerprint: domainQuote.receiptFingerprint!, draftOrderId: line.order.order.id, paymentReceiptFingerprint: bound.receipt.receiptFingerprint })
    const domain = await createManagedSiteDomainPurchaseIntent(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, draftOrderId: line.order.order.id, quoteReceiptFingerprint: domainQuote.receiptFingerprint!, paymentReceiptFingerprint: bound.receipt.receiptFingerprint, ownerConfirmationFingerprint: confirmation, executionMode: 'mocked', idempotencyKey: 'fixture-domain-purchase-001' }, domainAdapter, { repository: line.live.repository, clock: () => managedSiteFixedNow })
    expect(domain.claim.status).toBe('verified')
    expect((await createManagedSiteDomainPurchaseIntent(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, draftOrderId: line.order.order.id, quoteReceiptFingerprint: domainQuote.receiptFingerprint!, paymentReceiptFingerprint: bound.receipt.receiptFingerprint, ownerConfirmationFingerprint: confirmation, executionMode: 'mocked', idempotencyKey: 'fixture-domain-purchase-001' }, domainAdapter, { repository: line.live.repository, clock: () => managedSiteFixedNow })).replayed).toBe(true)
    const dns = await executeManagedSiteDnsTls(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'fixture-dns-001' }, createMockManagedSiteDnsTlsAdapter(), { repository: line.live.repository, clock: () => managedSiteFixedNow })
    expect(dns.ready).toBe(true)
    expect((await executeManagedSiteDnsTls(line.ownerUserId, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'fixture-dns-001' }, createMockManagedSiteDnsTlsAdapter(), { repository: line.live.repository, clock: () => managedSiteFixedNow })).replayed).toBe(true)
    let deploymentCalls = 0
    const concurrentAdapter = { ...line.deploymentAdapter, deployProduction: async (...args: Parameters<typeof line.deploymentAdapter.deployProduction>) => { deploymentCalls++; return line.deploymentAdapter.deployProduction(...args) } }
    const concurrent = await Promise.allSettled([
      deployManagedSiteProduction(line.ownerUserId, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'fixture-deploy-001' }, concurrentAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow }),
      deployManagedSiteProduction(line.ownerUserId, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'fixture-deploy-duplicate' }, concurrentAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow }),
    ])
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(deploymentCalls).toBe(1)
    expect(line.live.state.releases.find(item => item.id === line.release.release.id)?.status).toBe('live_verified')
    let activationCalls = 0
    const activationDependencies = { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow, activate: (async (owner: number, projectId: number, _input: unknown, repository: any) => { activationCalls++; return { project: await repository.updateProject(owner, projectId, { contentOperationClientId: 501 }), client: { id: 501 }, linked: true, reused: true, notDuplicated: true } }) as any }
    const activated = await activateManagedSiteGeoOperations(line.ownerUserId, { releaseId: line.release.release.id, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 12, idempotencyKey: 'fixture-geo-001' }, activationDependencies)
    expect(activated.release.status).toBe('geo_active')
    expect((await activateManagedSiteGeoOperations(line.ownerUserId, { releaseId: line.release.release.id, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 12, idempotencyKey: 'fixture-geo-001' }, activationDependencies)).replayed).toBe(true)
    expect(activationCalls).toBe(1)
  })

  it('replays the exact owner preview approval without appending duplicate authority', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false })
    const receiptsBefore = line.live.state.receipts.length
    const gatesBefore = line.live.state.gates.length
    const replay = await approveManagedSitePreview(line.ownerUserId, { releaseId: line.release.release.id, idempotencyKey: 'fixture-approval-001' }, line.live.repository, () => managedSiteFixedNow)
    expect(replay.replayed).toBe(true)
    expect(line.live.state.receipts).toHaveLength(receiptsBefore)
    expect(line.live.state.gates).toHaveLength(gatesBefore)
  })
})
