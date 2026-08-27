import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createExistingSiteOwnershipChallenge, createExistingSiteRelease, createMockExistingSiteOwnershipAdapter, createMockManagedSiteDeploymentAdapter, deployManagedSiteProduction, rollbackManagedSiteRelease, verifyExistingSiteOwnership } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createManagedSiteDomainPurchaseIntent, createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter, executeManagedSiteDnsTls, managedSiteDomainConfirmationFingerprint, quoteManagedSiteDomain } from '../server/managed-sites/live-connectors/domain-connectors'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { configureManagedSiteProvider, getManagedSiteProviderReadiness, managedSiteProviderAuthorityMetadata, resolveManagedSiteProviderAuthority } from '../server/managed-sites/live-connectors/provider-registry'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const webhookSecret = 'provider-authority-test-webhook-secret'

async function paidLine(domain: string) {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: domain })
  const payload = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: `payment-${domain}`, eventType: 'checkout_succeeded' })
  const raw = Buffer.from(JSON.stringify(payload))
  await processManagedSiteRawPaymentWebhook({ rawBody: raw, signatureHeader: createHmac('sha256', webhookSecret).update(raw).digest('hex'), credentialReference: 'vault:authority-webhook', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { connectorRepository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, jointTransaction: line.jointTransaction, credentialResolver: async reference => reference === 'vault:authority-webhook' ? { ok: true as const, value: webhookSecret } : { ok: false as const, reason: 'missing_reference' as const }, clock: () => managedSiteFixedNow })
  expect(line.live.state.releases.find(row => row.id === line.release.release.id)?.status).toBe('payment_verified')
  return line
}

async function rotateMock(line: Awaited<ReturnType<typeof paidLine>>, capability: 'domain_registration' | 'dns_tls' | 'deployment', providerKey: string, suffix: string) {
  return configureManagedSiteProvider(1, { capability, providerKey, readinessStatus: 'mock', credentialReference: `vault:${suffix}`, transportConfiguration: {}, idempotencyKey: `rotate-${capability}-${suffix}` }, line.live.repository, () => managedSiteFixedNow)
}

async function quoteAndPurchase(line: Awaited<ReturnType<typeof paidLine>>, prefix: string) {
  const quoted = await quoteManagedSiteDomain(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, requestedDomain: line.release.release.canonicalDomain, executionMode: 'mocked', idempotencyKey: `${prefix}-quote` }, createMockManagedSiteDomainAdapter({ now: () => managedSiteFixedNow }), { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow })
  const payment = line.live.state.receipts.find(row => row.releaseId === line.release.release.id && row.receiptType === 'release_payment_bound')!
  const confirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId: 1, projectId: line.prePurchase.project.id, releaseId: line.release.release.id, commerceSnapshotFingerprint: line.prePurchase.commerceSnapshotFingerprint, quoteReceiptFingerprint: quoted.receiptFingerprint!, draftOrderId: line.order.order.id, paymentReceiptFingerprint: payment.receiptFingerprint })
  const purchased = await createManagedSiteDomainPurchaseIntent(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, draftOrderId: line.order.order.id, quoteReceiptFingerprint: quoted.receiptFingerprint!, paymentReceiptFingerprint: payment.receiptFingerprint, ownerConfirmationFingerprint: confirmation, executionMode: 'mocked', idempotencyKey: `${prefix}-purchase` }, createMockManagedSiteDomainAdapter({ now: () => managedSiteFixedNow }), { repository: line.live.repository, clock: () => managedSiteFixedNow })
  return { quoted, payment, confirmation, purchased }
}

describe('managed-site exact provider authority lineage', () => {
  it('rejects domain purchase after same-provider configuration rotation before calling the adapter', async () => {
    const line = await paidLine('authority-domain.acme.taipei')
    let quoteCalls = 0; const quoteBase = createMockManagedSiteDomainAdapter({ now: () => managedSiteFixedNow }); const quoteAdapter = { ...quoteBase, quote: async (input: any) => { quoteCalls++; return quoteBase.quote(input) } }
    const quoteInput = { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, requestedDomain: line.release.release.canonicalDomain, executionMode: 'mocked' as const, idempotencyKey: 'authority-domain-quote' }
    const quoted = await quoteManagedSiteDomain(1, quoteInput, quoteAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow })
    expect((await quoteManagedSiteDomain(1, quoteInput, quoteAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow })).replayed).toBe(true); expect(quoteCalls).toBe(1)
    const payment = line.live.state.receipts.find(row => row.releaseId === line.release.release.id && row.receiptType === 'release_payment_bound')!
    const confirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId: 1, projectId: line.prePurchase.project.id, releaseId: line.release.release.id, commerceSnapshotFingerprint: line.prePurchase.commerceSnapshotFingerprint, quoteReceiptFingerprint: quoted.receiptFingerprint!, draftOrderId: line.order.order.id, paymentReceiptFingerprint: payment.receiptFingerprint })
    const before = await resolveManagedSiteProviderAuthority(1, 'domain_registration', 'mocked', line.live.repository)
    await rotateMock(line, 'domain_registration', 'mock-domain', 'domain-rotated-account')
    const after = await resolveManagedSiteProviderAuthority(1, 'domain_registration', 'mocked', line.live.repository)
    expect(after.providerKey).toBe(before.providerKey); expect(after.configurationFingerprint).not.toBe(before.configurationFingerprint); expect(after.capabilityIdentity).not.toBe(before.capabilityIdentity)
    await expect(quoteManagedSiteDomain(1, quoteInput, quoteAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 }); expect(quoteCalls).toBe(1)
    let calls = 0
    const adapter = { ...createMockManagedSiteDomainAdapter(), createPurchaseIntent: async (input: any) => { calls++; return createMockManagedSiteDomainAdapter().createPurchaseIntent(input) } }
    await expect(createManagedSiteDomainPurchaseIntent(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, draftOrderId: line.order.order.id, quoteReceiptFingerprint: quoted.receiptFingerprint!, paymentReceiptFingerprint: payment.receiptFingerprint, ownerConfirmationFingerprint: confirmation, executionMode: 'mocked', idempotencyKey: 'authority-domain-purchase' }, adapter, { repository: line.live.repository, clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 })
    expect(calls).toBe(0)
  })

  it('rejects production deploy when deployment authority changed after preview', async () => {
    const line = await paidLine('authority-deploy.acme.taipei'); await quoteAndPurchase(line, 'authority-deploy')
    await executeManagedSiteDnsTls(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'authority-deploy-dns' }, createMockManagedSiteDnsTlsAdapter(), { repository: line.live.repository, clock: () => managedSiteFixedNow })
    await rotateMock(line, 'deployment', 'mock-deployment', 'deployment-rotated-workspace')
    let calls = 0; const base = createMockManagedSiteDeploymentAdapter(); const adapter = { ...base, deployProduction: async (input: any) => { calls++; return base.deployProduction(input) } }
    await expect(deployManagedSiteProduction(1, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'authority-deploy-production' }, adapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 })
    expect(calls).toBe(0)
  })

  it('rejects DNS retry, ownership verify, and rollback after configuration drift', async () => {
    const line = await paidLine('authority-retry.acme.taipei'); await quoteAndPurchase(line, 'authority-retry')
    let dnsCalls = 0; const pending = createMockManagedSiteDnsTlsAdapter({ result: { dnsStatus: 'propagation_pending', tlsStatus: 'pending' } }); const dns = { configureAndVerify: async (input: any) => { dnsCalls++; return pending.configureAndVerify(input) } }
    await executeManagedSiteDnsTls(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'authority-dns-retry' }, dns, { repository: line.live.repository, clock: () => managedSiteFixedNow })
    await rotateMock(line, 'dns_tls', 'mock-dns-tls', 'dns-rotated-zone')
    await expect(executeManagedSiteDnsTls(1, { projectId: line.prePurchase.project.id, releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'authority-dns-retry' }, dns, { repository: line.live.repository, clock: () => new Date(managedSiteFixedNow.getTime() + 6 * 60_000) })).rejects.toMatchObject({ statusCode: 409 })
    expect(dnsCalls).toBe(1)

    const existing = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'authority-existing.acme.taipei', buildPreview: false, createCheckout: false })
    const existingRelease = await createExistingSiteRelease(1, { projectId: existing.prePurchase.project.id, canonicalDomain: 'authority-existing.acme.taipei', targetKey: 'existing-authority', idempotencyKey: 'existing-authority-release' }, { repository: existing.live.repository, managedRepository: existing.managed.repository })
    const ownership = createMockExistingSiteOwnershipAdapter(); const challenge = await createExistingSiteOwnershipChallenge(1, { releaseId: existingRelease.release.id, executionMode: 'mocked', idempotencyKey: 'existing-authority-challenge' }, existing.live.repository, () => managedSiteFixedNow, ownership)
    await configureManagedSiteProvider(1, { capability: 'dns_tls', providerKey: 'mock-dns-tls', readinessStatus: 'mock', credentialReference: 'vault:ownership-rotated-account', transportConfiguration: {}, idempotencyKey: 'ownership-rotate' }, existing.live.repository, () => managedSiteFixedNow)
    let ownershipCalls = 0; const ownershipAdapter = { ...ownership, verify: async (input: any) => { ownershipCalls++; return ownership.verify(input) } }
    await expect(verifyExistingSiteOwnership(1, { releaseId: existingRelease.release.id, challengeReceiptFingerprint: challenge.receipt.receiptFingerprint, executionMode: 'mocked', idempotencyKey: 'existing-authority-verify' }, ownershipAdapter, { repository: existing.live.repository, clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 })
    expect(ownershipCalls).toBe(0)

    const rollbackLine = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'authority-rollback.acme.taipei', buildPreview: false, createCheckout: false })
    const authority = await resolveManagedSiteProviderAuthority(1, 'deployment', 'mocked', rollbackLine.live.repository)
    const priorFingerprint = stableFingerprint({ prior: 'authority-rollback' })
    const prior = await rollbackLine.live.repository.insertRelease({ ownerUserId: 1, projectId: rollbackLine.prePurchase.project.id, generationCandidateId: rollbackLine.generation.candidate!.id, versionId: rollbackLine.prePurchase.version.id, previewId: null, quoteId: null, draftOrderId: null, commerceSnapshotFingerprint: null, releaseKind: 'generated_site', targetKey: 'authority-rollback-prior', canonicalDomain: 'authority-rollback.acme.taipei', contentHash: stableFingerprint({ release: 'prior' }), status: 'live_verified', previewUrl: null, providerPreviewId: null, approvalFingerprint: stableFingerprint({ approval: 'prior' }), approvedAt: managedSiteFixedNow, activeDeploymentReceiptFingerprint: priorFingerprint, rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'retain', projectionFingerprint: stableFingerprint({ projection: 'prior' }), idempotencyKey: 'authority-rollback-prior-release' } as any)
    await rollbackLine.live.repository.insertReceipt({ ownerUserId: 1, projectId: prior.projectId, draftOrderId: null, releaseId: prior.id, attemptId: null, capability: 'deployment', providerKey: authority.providerKey, providerEventId: 'authority-rollback-prior-event', receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: 'authority-rollback-prior-deploy', exactResponseIdentity: 'authority-rollback-prior-response', requestFingerprint: stableFingerprint({ prior: true }), contentHash: prior.contentHash, canonicalDomain: prior.canonicalDomain, metadata: { ...managedSiteProviderAuthorityMetadata(authority) }, receiptFingerprint: priorFingerprint, verifiedAt: managedSiteFixedNow } as any)
    const current = await rollbackLine.live.repository.insertRelease({ ...prior, id: undefined, targetKey: 'authority-rollback-current', contentHash: stableFingerprint({ release: 'current' }), activeDeploymentReceiptFingerprint: stableFingerprint({ current: true }), projectionFingerprint: stableFingerprint({ projection: 'current' }), idempotencyKey: 'authority-rollback-current-release' } as any)
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'mock-deployment', readinessStatus: 'mock', credentialReference: 'vault:rollback-rotated-workspace', transportConfiguration: {}, idempotencyKey: 'rollback-rotate' }, rollbackLine.live.repository, () => managedSiteFixedNow)
    let rollbackCalls = 0; const rollbackBase = createMockManagedSiteDeploymentAdapter(); const rollbackAdapter = { ...rollbackBase, rollback: async (input: any) => { rollbackCalls++; return rollbackBase.rollback(input) } }
    await expect(rollbackManagedSiteRelease(1, { fromReleaseId: current.id, toReleaseId: prior.id, executionMode: 'mocked', idempotencyKey: 'authority-rollback-operation' }, rollbackAdapter, { repository: rollbackLine.live.repository, clock: () => managedSiteFixedNow })).rejects.toMatchObject({ statusCode: 409 })
    expect(rollbackCalls).toBe(0)
  })

  it('never promotes incomplete readiness or mock authority into live mutation authority', async () => {
    const live = createLiveConnectorMemoryRepository()
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: 'vault:incomplete-deployment', transportConfiguration: { endpointOrigin: 'https://deployment.example.com' }, idempotencyKey: 'incomplete-readiness' }, live.repository, () => managedSiteFixedNow)
    const configuration = await live.repository.findProviderConfiguration(1, 'deployment')
    await live.repository.updateProviderConfiguration(1, configuration!.id, { readinessStatus: 'verified', verificationReceiptFingerprint: null, capabilityIdentity: null, verifiedAt: managedSiteFixedNow })
    const readiness = await getManagedSiteProviderReadiness(1, live.repository, async () => ({ ok: true as const, value: 'server-only' }))
    const item = readiness.capabilities.find(row => row.capability === 'deployment')!
    expect(item).toMatchObject({ verified: false, liveMutationAllowed: false }); expect(item.missing).toEqual(expect.arrayContaining(['verification_receipt_fingerprint', 'capability_identity']))

    const mocked = createLiveConnectorMemoryRepository()
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'mock-deployment', readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: 'mock-not-live' }, mocked.repository, () => managedSiteFixedNow)
    await expect(resolveManagedSiteProviderAuthority(1, 'deployment', 'live', mocked.repository, async () => ({ ok: true as const, value: 'server-only' }))).rejects.toMatchObject({ statusCode: 503 })
  })
})
