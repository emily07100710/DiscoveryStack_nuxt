import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../server/managed-sites/live-connectors/checkout-session'
import { buildManagedSitePreview, createMockManagedSiteDeploymentAdapter, deployManagedSiteProduction, rollbackManagedSiteRelease } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createManagedSiteDomainPurchaseIntent, createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter, executeManagedSiteDnsTls, managedSiteDomainConfirmationFingerprint, quoteManagedSiteDomain } from '../server/managed-sites/live-connectors/domain-connectors'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

function failOneLocalCommit<T extends { transaction: any }>(repository: T): T {
  let fail = true
  return new Proxy(repository, { get(target, key, receiver) { if (key !== 'transaction') return Reflect.get(target, key, receiver); return async (work: any) => target.transaction(async (transaction: any) => { const result = await work(transaction); if (fail) { fail = false; throw new Error('synthetic local commit fault after provider success') } return result }) } })
}

describe('managed-site external-success/local-commit recovery sagas', () => {
  it('reuses checkout provider idempotency after local commit failure and converges to one receipt', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ createCheckout: false }); let now = new Date(managedSiteFixedNow); let externalCreations = 0; const cache = new Map<string, any>(); const base = createMockManagedSiteCheckoutSessionAdapter()
    const adapter = { createSession: async (input: any) => { if (cache.has(input.idempotencyKey)) return cache.get(input.idempotencyKey); externalCreations++; const value = await base.createSession(input); cache.set(input.idempotencyKey, value); return value } }
    const repository = failOneLocalCommit(line.live.repository)
    await expect(createManagedSiteCheckoutSession(1, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-local-commit-retry' }, adapter, { connectorRepository: repository, orderingRepository: line.ordering.repository, clock: () => now })).rejects.toThrow('synthetic local commit fault')
    expect(line.live.state.receipts.filter(row => row.receiptType === 'checkout_session_created')).toHaveLength(0); expect(line.live.state.attempts.find(row => row.operation === 'checkout_session_create')?.status).toBe('retry_wait')
    now = new Date(now.getTime() + 31_000)
    const retried = await createManagedSiteCheckoutSession(1, { releaseId: line.release.release.id, draftOrderId: line.order.order.id, executionMode: 'mocked', idempotencyKey: 'checkout-local-commit-retry' }, adapter, { connectorRepository: repository, orderingRepository: line.ordering.repository, clock: () => now })
    expect(retried.receipt.receiptType).toBe('checkout_session_created'); expect(externalCreations).toBe(1); expect(line.live.state.receipts.filter(row => row.receiptType === 'checkout_session_created')).toHaveLength(1)
  })

  it('reuses preview deployment idempotency after local receipt/gate/CAS rollback', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ buildPreview: false, createCheckout: false }); let now = new Date(managedSiteFixedNow); let externalCreations = 0; const cache = new Map<string, any>(); const base = createMockManagedSiteDeploymentAdapter({ now: () => now })
    const adapter = { ...base, buildPreview: async (input: any) => { const key = input.requestFingerprint; if (cache.has(key)) return cache.get(key); externalCreations++; const value = await base.buildPreview(input); cache.set(key, value); return value } }
    const repository = failOneLocalCommit(line.live.repository)
    await expect(buildManagedSitePreview(1, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'preview-local-commit-retry' }, adapter, { repository, clock: () => now })).rejects.toThrow('synthetic local commit fault')
    expect(line.live.state.receipts.filter(row => row.receiptType === 'preview_build_verified')).toHaveLength(0); expect(line.live.state.gates).toHaveLength(0)
    now = new Date(now.getTime() + 5 * 60_000 + 1_000)
    const retried = await buildManagedSitePreview(1, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'preview-local-commit-retry' }, adapter, { repository, clock: () => now })
    expect(retried.release.status).toBe('preview_ready'); expect(externalCreations).toBe(1); expect(line.live.state.receipts.filter(row => row.receiptType === 'preview_build_verified')).toHaveLength(1); expect(line.live.state.gates).toHaveLength(6)
  })

  it('reconciles domain purchase, DNS/TLS, and production deploy with the same provider idempotency after local faults', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); let now = new Date(managedSiteFixedNow); const credential = 'runtime-only-saga-payment-key'
    const event = { providerKey: 'mock-payment', providerEventId: 'saga-payment-success-001', providerReference: 'saga-payment-ref-001', eventType: 'checkout_succeeded', draftOrderId: line.order.order.id, amountMinor: line.quote.quote.totalMinor, currency: line.quote.quote.currency, occurredAt: now.toISOString(), exactResponseIdentity: 'payment-response:saga-001' }
    const rawBody = Buffer.from(JSON.stringify(event)); const signatureHeader = createHmac('sha256', credential).update(rawBody).digest('hex')
    await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:saga-payment', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true, value: credential }), clock: () => now })
    const quoteAdapter = createMockManagedSiteDomainAdapter({ now: () => now }); const quoted = await quoteManagedSiteDomain(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, requestedDomain: line.release.release.canonicalDomain, executionMode: 'mocked', idempotencyKey: 'saga-domain-quote' }, quoteAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => now })
    const bound = line.live.state.receipts.find(row => row.receiptType === 'release_payment_bound')!; const confirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId: 1, projectId: line.prePurchase.project.id, releaseId: line.release.release.id, commerceSnapshotFingerprint: line.prePurchase.commerceSnapshotFingerprint, quoteReceiptFingerprint: quoted.receiptFingerprint!, draftOrderId: line.order.order.id, paymentReceiptFingerprint: bound.receiptFingerprint })
    let domainCreations = 0; const domainCache = new Map<string, any>(); const domainAdapter = { ...quoteAdapter, createPurchaseIntent: async (input: any) => { if (domainCache.has(input.idempotencyKey)) return domainCache.get(input.idempotencyKey); domainCreations++; const value = await quoteAdapter.createPurchaseIntent(input); domainCache.set(input.idempotencyKey, value); return value } }; const domainRepository = failOneLocalCommit(line.live.repository)
    const domainInput = { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, draftOrderId: line.order.order.id, quoteReceiptFingerprint: quoted.receiptFingerprint!, paymentReceiptFingerprint: bound.receiptFingerprint, ownerConfirmationFingerprint: confirmation, executionMode: 'mocked' as const, idempotencyKey: 'saga-domain-purchase' }
    await expect(createManagedSiteDomainPurchaseIntent(1, domainInput, domainAdapter, { repository: domainRepository, clock: () => now })).rejects.toThrow('synthetic local commit fault'); now = new Date(now.getTime() + 31_000); await createManagedSiteDomainPurchaseIntent(1, domainInput, domainAdapter, { repository: domainRepository, clock: () => now }); expect(domainCreations).toBe(1)
    let dnsCreations = 0; const dnsCache = new Map<string, any>(); const dnsBase = createMockManagedSiteDnsTlsAdapter(); const dnsAdapter = { configureAndVerify: async (input: any) => { if (dnsCache.has(input.idempotencyKey)) return dnsCache.get(input.idempotencyKey); dnsCreations++; const value = await dnsBase.configureAndVerify(input); dnsCache.set(input.idempotencyKey, value); return value } }; const dnsRepository = failOneLocalCommit(line.live.repository); const dnsInput = { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'mocked' as const, idempotencyKey: 'saga-dns-tls' }
    await expect(executeManagedSiteDnsTls(1, dnsInput, dnsAdapter, { repository: dnsRepository, clock: () => now })).rejects.toThrow('synthetic local commit fault'); now = new Date(now.getTime() + 31_000); await executeManagedSiteDnsTls(1, dnsInput, dnsAdapter, { repository: dnsRepository, clock: () => now }); expect(dnsCreations).toBe(1)
    let deployCreations = 0; const deployCache = new Map<string, any>(); const deployBase = createMockManagedSiteDeploymentAdapter({ now: () => now }); const deployAdapter = { ...deployBase, deployProduction: async (input: any) => { if (deployCache.has(input.requestFingerprint)) return deployCache.get(input.requestFingerprint); deployCreations++; const value = await deployBase.deployProduction(input); deployCache.set(input.requestFingerprint, value); return value } }; const deployRepository = failOneLocalCommit(line.live.repository); const deployInput = { releaseId: line.release.release.id, executionMode: 'mocked' as const, idempotencyKey: 'saga-production-deploy' }
    await expect(deployManagedSiteProduction(1, deployInput, deployAdapter, { repository: deployRepository, managedRepository: line.managed.repository, clock: () => now })).rejects.toThrow('synthetic local commit fault'); now = new Date(now.getTime() + 5 * 60_000 + 1_000); const deployed = await deployManagedSiteProduction(1, deployInput, deployAdapter, { repository: deployRepository, managedRepository: line.managed.repository, clock: () => now }); expect(deployed.release.status).toBe('live_verified'); expect(deployCreations).toBe(1)
  })

  it('reconciles rollback with the same provider idempotency after a local commit fault', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'rollback-saga.acme.taipei', buildPreview: false, createCheckout: false })
    let now = new Date(managedSiteFixedNow)
    const priorReceiptFingerprint = stableFingerprint({ receipt: 'rollback-saga-prior' })
    const prior = await line.live.repository.insertRelease({ ownerUserId: 1, projectId: line.prePurchase.project.id, generationCandidateId: line.generation.candidate!.id, versionId: line.prePurchase.version.id, previewId: null, quoteId: null, draftOrderId: null, commerceSnapshotFingerprint: null, releaseKind: 'generated_site', targetKey: 'rollback-saga-prior', canonicalDomain: 'rollback-saga.acme.taipei', contentHash: stableFingerprint({ release: 'rollback-saga-prior' }), status: 'live_verified', previewUrl: 'https://prior.preview.discoverystack.dev', providerPreviewId: 'rollback-saga-prior-preview', approvalFingerprint: stableFingerprint({ approval: 'rollback-saga-prior' }), approvedAt: now, activeDeploymentReceiptFingerprint: priorReceiptFingerprint, rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'retain_verified_release', projectionFingerprint: stableFingerprint({ projection: 'rollback-saga-prior' }), idempotencyKey: 'rollback-saga-prior-release' } as any)
    await line.live.repository.insertReceipt({ ownerUserId: 1, projectId: line.prePurchase.project.id, draftOrderId: null, releaseId: prior.id, attemptId: null, capability: 'deployment', providerKey: 'mock-deployment', providerEventId: 'rollback-saga-prior-event', receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: 'rollback-saga-prior-deployment', exactResponseIdentity: 'rollback-saga-prior-response', requestFingerprint: stableFingerprint({ rollbackSagaPrior: true }), contentHash: prior.contentHash, canonicalDomain: prior.canonicalDomain, metadata: { deploymentUrl: `https://${prior.canonicalDomain}` }, receiptFingerprint: priorReceiptFingerprint, verifiedAt: now } as any)
    const current = await line.live.repository.insertRelease({ ownerUserId: 1, projectId: line.prePurchase.project.id, generationCandidateId: line.generation.candidate!.id, versionId: line.prePurchase.version.id, releaseKind: 'generated_site', targetKey: 'rollback-saga-current', canonicalDomain: prior.canonicalDomain, contentHash: stableFingerprint({ release: 'rollback-saga-current' }), status: 'live_verified', previewUrl: 'https://current.preview.discoverystack.dev', providerPreviewId: 'rollback-saga-current-preview', approvalFingerprint: stableFingerprint({ approval: 'rollback-saga-current' }), approvedAt: now, activeDeploymentReceiptFingerprint: stableFingerprint({ receipt: 'rollback-saga-current' }), rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'rollback_available', projectionFingerprint: stableFingerprint({ projection: 'rollback-saga-current' }), idempotencyKey: 'rollback-saga-current-release' } as any)
    let externalCreations = 0
    const cache = new Map<string, any>()
    const base = createMockManagedSiteDeploymentAdapter({ now: () => now })
    const adapter = { ...base, rollback: async (input: any) => { if (cache.has(input.requestFingerprint)) return cache.get(input.requestFingerprint); externalCreations++; const value = await base.rollback(input); cache.set(input.requestFingerprint, value); return value } }
    const repository = failOneLocalCommit(line.live.repository)
    const input = { fromReleaseId: current.id, toReleaseId: prior.id, executionMode: 'mocked' as const, idempotencyKey: 'rollback-saga-operation' }
    await expect(rollbackManagedSiteRelease(1, input, adapter, { repository, clock: () => now })).rejects.toThrow('synthetic local commit fault')
    expect(line.live.state.receipts.filter(row => row.receiptType === 'rollback_deployment_verified')).toHaveLength(0)
    expect(line.live.state.releases.find(row => row.id === current.id)).toMatchObject({ status: 'retry_wait', blockedReasonCode: 'ROLLBACK_FAILED' })
    now = new Date(now.getTime() + 5 * 60_000 + 1_000)
    const retried = await rollbackManagedSiteRelease(1, input, adapter, { repository, clock: () => now })
    expect(retried.release.status).toBe('live_verified')
    expect(line.live.state.releases.find(row => row.id === current.id)?.status).toBe('rolled_back')
    expect(externalCreations).toBe(1)
    expect(line.live.state.receipts.filter(row => row.receiptType === 'rollback_deployment_verified')).toHaveLength(1)
  })
})
