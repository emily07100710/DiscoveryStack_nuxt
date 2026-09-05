import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { claimManagedSiteCheckout } from '../server/managed-sites/checkout-claim-service'
import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote } from '../server/managed-sites/ordering-service'
import { convertClaimedManagedSitePrePurchase } from '../server/managed-sites/prepurchase-service'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { activateManagedSiteGeoOperations, approveManagedSitePreview, bindManagedSiteReleasePayment, deployManagedSiteProduction } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter, createManagedSiteDomainPurchaseIntent, executeManagedSiteDnsTls, managedSiteDomainConfirmationFingerprint, quoteManagedSiteDomain } from '../server/managed-sites/live-connectors/domain-connectors'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'

async function createClaimedPrePurchaseLine() {
  const ownerUserId = 1
  const managed = createManagedSiteMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const live = createLiveConnectorMemoryRepository()
  const preview = await createManagedSitePreview(null, { draftIdentity: 'atomic-prepurchase', brandName: 'Atomic Pre-purchase', audience: 'Taiwan buyers', brief: 'A governed test site.', businessGoals: ['increase_inquiries'], siteType: 'brand_blog', selectedModules: ['managed_content_admin'], styleReferences: [] }, ordering.repository, () => managedSiteFixedNow)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'site_geo', cadenceDays: 7, domainOption: 'new', domainTld: 'com', idempotencyKey: 'atomic-prepurchase-quote' }, ordering.repository, () => managedSiteFixedNow)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Atomic Owner', email: 'atomic@example.invalid', company: 'Atomic Pre-purchase', website: 'https://atomic-prepurchase.example.invalid', privacyConsent: true, recontactConsent: false, idempotencyKey: 'atomic-prepurchase-lead' }, ordering.repository, () => managedSiteFixedNow)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'atomic-prepurchase-order' }, ordering.repository, () => managedSiteFixedNow)
  await claimManagedSiteCheckout(ownerUserId, { previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id }, ordering.repository, () => managedSiteFixedNow)
  return {
    ownerUserId,
    managed,
    ordering,
    live,
    input: { previewId: preview.preview.id, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id, idempotencyKey: 'atomic-prepurchase-conversion' },
  }
}

describe('managed-site authoritative mocked application path', () => {
  it('uses the scoped repositories supplied by a pre-purchase transaction', async () => {
    const line = await createClaimedPrePurchaseLine()
    const calls: string[] = []
    const scoped = {
      ordering: new Proxy(line.ordering.repository, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? (...args: any[]) => { calls.push(`ordering.${String(property)}`); return value.apply(target, args) } : value } }),
      managed: new Proxy(line.managed.repository, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? (...args: any[]) => { calls.push(`managed.${String(property)}`); return value.apply(target, args) } : value } }),
      live: new Proxy(line.live.repository, { get(target, property, receiver) { const value = Reflect.get(target, property, receiver); return typeof value === 'function' ? (...args: any[]) => { calls.push(`live.${String(property)}`); return value.apply(target, args) } : value } }),
    }
    let transactions = 0
    const outer = {
      ordering: { transaction: async () => { throw new Error('outer ordering repository must not be used') } },
      managed: new Proxy({}, { get() { throw new Error('outer managed repository must not be used') } }),
      live: new Proxy({}, { get() { throw new Error('outer live repository must not be used') } }),
      withTransaction: async <T>(work: (repositories: typeof scoped) => Promise<T>) => { transactions++; return work(scoped) },
    }

    await convertClaimedManagedSitePrePurchase(line.ownerUserId, line.input, outer as any, () => managedSiteFixedNow)

    expect(transactions).toBe(1)
    expect(calls.some(call => call.startsWith('ordering.'))).toBe(true)
    expect(calls.some(call => call.startsWith('managed.'))).toBe(true)
    expect(calls.some(call => call.startsWith('live.'))).toBe(true)
  })

  it('rolls back the complete pre-purchase unit when its scoped binding write fails', async () => {
    const line = await createClaimedPrePurchaseLine()
    let rolledBack = false
    const scoped = { ordering: line.ordering.repository, managed: line.managed.repository, live: { ...line.live.repository, async insertPrePurchaseBinding() { throw new Error('binding write failed') } } }
    const outer = {
      ordering: line.ordering.repository,
      managed: line.managed.repository,
      live: line.live.repository,
      withTransaction: async <T>(work: (repositories: typeof scoped) => Promise<T>) => {
        const snapshot = { ordering: structuredClone(line.ordering.state), managed: structuredClone(line.managed.state), live: structuredClone(line.live.state) }
        try {
          return await work(scoped)
        } catch (error) {
          rolledBack = true
          Object.assign(line.ordering.state, snapshot.ordering)
          Object.assign(line.managed.state, snapshot.managed)
          Object.assign(line.live.state, snapshot.live)
          throw error
        }
      },
    }

    await expect(convertClaimedManagedSitePrePurchase(line.ownerUserId, line.input, outer as any, () => managedSiteFixedNow)).rejects.toThrow('binding write failed')

    expect(rolledBack).toBe(true)
    expect(line.managed.state.projects).toHaveLength(0)
    expect(line.managed.state.versions).toHaveLength(0)
    expect(line.live.state.bindings).toHaveLength(0)
    expect(line.ordering.state.orders.find(item => item.id === line.input.draftOrderId)?.projectId).toBeNull()
    expect(line.ordering.state.quotes.find(item => item.id === line.input.quoteId)?.projectId).toBeNull()
    expect(line.ordering.state.subscriptionIntents.find(item => item.quoteId === line.input.quoteId)?.projectId).toBeNull()
  })

  it('reuses the persisted draft version when a create-path retry follows a partial legacy conversion', async () => {
    const line = await createClaimedPrePurchaseLine()
    let rejectBinding = true
    const live = {
      ...line.live.repository,
      async insertPrePurchaseBinding(input: any) {
        if (rejectBinding) {
          rejectBinding = false
          throw new Error('legacy binding write failed')
        }
        return line.live.repository.insertPrePurchaseBinding(input)
      },
    }

    await expect(convertClaimedManagedSitePrePurchase(line.ownerUserId, line.input, { ordering: line.ordering.repository, managed: line.managed.repository, live }, () => managedSiteFixedNow)).rejects.toThrow('legacy binding write failed')
    expect(line.managed.state.projects).toHaveLength(1)
    expect(line.managed.state.versions).toHaveLength(1)
    expect(line.ordering.state.orders.find(item => item.id === line.input.draftOrderId)?.projectId).toBeNull()

    await convertClaimedManagedSitePrePurchase(line.ownerUserId, line.input, { ordering: line.ordering.repository, managed: line.managed.repository, live }, () => managedSiteFixedNow)

    expect(line.managed.state.versions).toHaveLength(1)
  })

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
    const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: 'payment-success-authoritative-001', providerReference: 'payment-ref-authoritative-001', eventType: 'checkout_succeeded', exactResponseIdentity: 'payment-response:authoritative-001' })
    const rawBody = Buffer.from(JSON.stringify(event)); const signatureHeader = createHmac('sha256', webhookCredential).update(rawBody).digest('hex')
    const payment = await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-webhook-test', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async reference => reference === 'vault:payment-webhook-test' ? { ok: true, value: webhookCredential } : { ok: false, reason: 'missing_reference' }, clock: () => managedSiteFixedNow })
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
