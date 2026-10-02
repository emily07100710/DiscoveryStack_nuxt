import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { advancePaidManagedSiteFunnel, funnelFulfilmentKey, type FunnelFulfilmentDependencies } from '../server/managed-sites/funnel/fulfilment-advancer'
import { createMockRawBodyPaymentWebhookAdapter } from '../server/managed-sites/live-connectors/adapters'
import { createMockManagedSiteDeploymentAdapter, deployManagedSiteProduction } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createManagedSiteDomainPurchaseIntent, createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter, executeManagedSiteDnsTls, managedSiteDomainConfirmationFingerprint, quoteManagedSiteDomain } from '../server/managed-sites/live-connectors/domain-connectors'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { managedSiteCommerceSnapshotFingerprint } from '../server/managed-sites/prepurchase-service'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createFunnelSessionMemoryRepository } from './fixtures/managed-site/funnel-session-repository'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteExactPaymentWebhookPayload, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

const secret = 'funnel-fulfilment-test-webhook'

async function fixture() {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'fulfilment.acme.taipei' })
  let now = new Date(managedSiteFixedNow)
  async function payment(eventType = 'checkout_succeeded') {
    const event = await managedSiteExactPaymentWebhookPayload(line, { providerEventId: `fulfilment-${eventType}`, eventType })
    const rawBody = Buffer.from(JSON.stringify(event))
    return processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader: createHmac('sha256', secret).update(rawBody).digest('hex'), credentialReference: 'vault:fulfilment-webhook', executionMode: 'mocked' }, createMockRawBodyPaymentWebhookAdapter('mock-payment'), { jointTransaction: line.jointTransaction, credentialResolver: async () => ({ ok: true, value: secret }), clock: () => now })
  }
  await payment()
  const release = line.live.state.releases[0]!
  const domainAdapter = createMockManagedSiteDomainAdapter({ now: () => now })
  const quoted = await quoteManagedSiteDomain(1, { projectId: release.projectId, releaseId: release.id, requestedDomain: release.canonicalDomain, executionMode: 'mocked', idempotencyKey: 'fulfilment-domain-quote' }, domainAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => now })
  const bound = line.live.state.receipts.find(row => row.receiptType === 'release_payment_bound')!
  const ownerConfirmationFingerprint = managedSiteDomainConfirmationFingerprint({ ownerUserId: 1, projectId: release.projectId, releaseId: release.id, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint!, quoteReceiptFingerprint: quoted.receiptFingerprint!, draftOrderId: release.draftOrderId!, paymentReceiptFingerprint: bound.receiptFingerprint })
  await createManagedSiteDomainPurchaseIntent(1, { projectId: release.projectId, releaseId: release.id, draftOrderId: release.draftOrderId!, quoteReceiptFingerprint: quoted.receiptFingerprint!, paymentReceiptFingerprint: bound.receiptFingerprint, ownerConfirmationFingerprint, executionMode: 'mocked', idempotencyKey: 'fulfilment-existing-domain-purchase' }, domainAdapter, { repository: line.live.repository, managedRepository: line.managed.repository, clock: () => now })
  const session = { id: 7, ownerUserId: 1, projectId: release.projectId, releaseId: release.id, draftOrderId: release.draftOrderId, quoteId: release.quoteId, previewId: release.previewId }
  const funnel = createFunnelSessionMemoryRepository({ fulfilmentCandidates: () => [session] })
  const deploymentBase = createMockManagedSiteDeploymentAdapter({ now: () => now })
  const deploy = vi.fn(deploymentBase.deployProduction)
  const dns = vi.fn(createMockManagedSiteDnsTlsAdapter().configureAndVerify)
  const dependencies: FunnelFulfilmentDependencies = {
    funnelRepository: funnel.repository, repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository,
    productionTransaction: line.productionTransaction, deploymentAdapter: async () => ({ ...deploymentBase, deployProduction: deploy }), dnsTlsAdapter: async () => ({ configureAndVerify: dns }), executionMode: 'mocked', clock: () => now,
  }
  return { line, release, session, funnel, dependencies, deploy, dns, payment, now: () => now, advanceClock: (ms: number) => { now = new Date(now.getTime() + ms) } }
}

describe('durable paid funnel fulfilment advancement', () => {
  it('advances existing paid/domain authority through DNS and production without browser, new generation, or another charge', async () => {
    const f = await fixture()
    const lock = vi.spyOn(f.line.ordering.repository, 'findDraftOrderByIdForUpdate')
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ scanned: 1, advanced: 1, failed: 0 })
    expect(f.line.live.state.releases[0]).toMatchObject({ status: 'live_verified', activeDeploymentReceiptFingerprint: expect.any(String) })
    expect(f.line.managed.state.projects[0]!.status).toBe('active')
    expect(lock).toHaveBeenCalledWith(f.release.draftOrderId)
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    expect(f.deploy).toHaveBeenCalledTimes(1)
    expect(f.dns).toHaveBeenCalledTimes(1)
    expect(f.line.live.state.candidates).toHaveLength(1)
    expect(f.line.live.state.receipts.filter(row => row.receiptType === 'checkout_session_created')).toHaveLength(1)
    expect(f.line.live.state.receipts.filter(row => row.receiptType === 'production_deployment_verified')).toHaveLength(1)
  })

  it.each(['missing_domain', 'foreign_domain', 'owner_mismatch', 'unpaid', 'snapshot_changed', 'suspended', 'effective_dispute'] as const)('does not call DNS or production with %s authority', async reason => {
    const f = await fixture()
    if (reason === 'missing_domain') f.line.live.state.domainClaims.length = 0
    if (reason === 'foreign_domain') f.line.live.state.domainClaims[0]!.ownerUserId = 2
    if (reason === 'owner_mismatch') f.session.ownerUserId = 2
    if (reason === 'unpaid') f.line.ordering.state.orders[0]!.status = 'payment_pending'
    if (reason === 'snapshot_changed') f.line.ordering.state.quotes[0]!.totalMinor++
    if (reason === 'suspended') f.line.managed.state.projects[0]!.status = 'suspended'
    if (reason === 'effective_dispute') {
      const bound = f.line.live.state.receipts.find(row => row.receiptType === 'release_payment_bound')!
      f.line.live.state.receipts.push({ ...bound, id: 9001, receiptType: 'payment_disputed', metadata: { effective: true } })
    }
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0 })
    expect(f.deploy).not.toHaveBeenCalled()
    expect(f.dns).not.toHaveBeenCalled()
  })

  it('skips one suspended project before adapter acquisition while advancing a second paid project in the same run', async () => {
    const f = await fixture(); const offset = 10_000; const firstProject = f.line.managed.state.projects[0]!; const firstOrder = f.line.ordering.state.orders[0]!; const firstQuote = f.line.ordering.state.quotes.find(row => row.id === firstOrder.quoteId)!; const firstRelease = f.line.live.state.releases[0]!; const firstCandidate = f.line.live.state.candidates[0]!
    const project = { ...structuredClone(firstProject), id: firstProject.id + offset, status: 'payment_pending' as const }; f.line.managed.state.projects.push(project as any)
    const quote = { ...structuredClone(firstQuote), id: firstQuote.id + offset, projectId: project.id }; f.line.ordering.state.quotes.push(quote as any)
    const lines = f.line.ordering.state.lines.filter(row => row.quoteId === firstQuote.id).map(row => ({ ...structuredClone(row), id: row.id + offset, quoteId: quote.id })); f.line.ordering.state.lines.push(...lines as any)
    const order = { ...structuredClone(firstOrder), id: firstOrder.id + offset, projectId: project.id, quoteId: quote.id }; f.line.ordering.state.orders.push(order as any)
    f.line.ordering.state.paymentEvents.push(...f.line.ordering.state.paymentEvents.filter(row => row.draftOrderId === firstOrder.id).map(row => ({ ...structuredClone(row), id: row.id + offset, draftOrderId: order.id } as any)))
    const commerceSnapshotFingerprint = managedSiteCommerceSnapshotFingerprint({ previewId: order.previewId, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
    const candidate = { ...structuredClone(firstCandidate), id: firstCandidate.id + offset, projectId: project.id }; f.line.live.state.candidates.push(candidate as any)
    const release = { ...structuredClone(firstRelease), id: firstRelease.id + offset, projectId: project.id, generationCandidateId: candidate.id, quoteId: quote.id, draftOrderId: order.id, canonicalDomain: 'fulfilment-second.acme.taipei', commerceSnapshotFingerprint, idempotencyKey: 'fulfilment-second-release' }; f.line.live.state.releases.push(release as any)
    const clonedReceipts = f.line.live.state.receipts.filter(row => row.releaseId === firstRelease.id).map(row => ({ ...structuredClone(row), id: row.id + offset, projectId: project.id, draftOrderId: order.id, releaseId: release.id, canonicalDomain: release.canonicalDomain, metadata: { ...(row.metadata as Record<string, unknown>), commerceSnapshotFingerprint } })); const domainReceipt = clonedReceipts.find(row => row.receiptType === 'domain_registered')!; domainReceipt.receiptFingerprint = stableFingerprint({ previous: domainReceipt.receiptFingerprint, projectId: project.id, releaseId: release.id }); f.line.live.state.receipts.push(...clonedReceipts as any)
    const claim = f.line.live.state.domainClaims[0]!; f.line.live.state.domainClaims.push({ ...structuredClone(claim), id: claim.id + offset, canonicalDomain: release.canonicalDomain, activeCanonicalDomainKey: release.canonicalDomain, projectId: project.id, releaseId: release.id, authorityReceiptFingerprint: domainReceipt.receiptFingerprint, idempotencyKey: 'fulfilment-second-domain' } as any)
    const subscription = f.line.managed.state.subscriptions[0]; if (subscription) f.line.managed.state.subscriptions.push({ ...structuredClone(subscription), id: subscription.id + offset, projectId: project.id, idempotencyKey: 'fulfilment-second-subscription' } as any)
    const secondSession = { ...f.session, id: f.session.id + offset, projectId: project.id, releaseId: release.id, draftOrderId: order.id, quoteId: quote.id }; const funnel = createFunnelSessionMemoryRepository({ fulfilmentCandidates: () => [f.session, secondSession] }); firstProject.status = 'suspended'
    expect(await f.line.live.repository.findDomainClaim(release.canonicalDomain)).toMatchObject({ status: 'verified', ownerUserId: 1, projectId: project.id, releaseId: release.id, authorityReceiptFingerprint: expect.any(String) })
    const deploymentBase = createMockManagedSiteDeploymentAdapter({ now: f.now }); const deploy = vi.fn(deploymentBase.deployProduction); const dns = vi.fn(createMockManagedSiteDnsTlsAdapter().configureAndVerify); const deploymentFactory = vi.fn(async () => ({ ...deploymentBase, deployProduction: deploy })); const dnsFactory = vi.fn(async () => ({ configureAndVerify: dns }))
    const result = await advancePaidManagedSiteFunnel({}, { ...f.dependencies, funnelRepository: funnel.repository, deploymentAdapter: deploymentFactory, dnsTlsAdapter: dnsFactory })
    expect(dnsFactory).toHaveBeenCalledTimes(1); expect(dns).toHaveBeenCalledTimes(1); expect(deploymentFactory).toHaveBeenCalledTimes(1); expect(deploy).toHaveBeenCalledTimes(1); expect(result).toEqual({ scanned: 2, advanced: 1, waiting: 0, failed: 1, nextAfterId: 0 }); expect(firstProject.status).toBe('suspended'); expect(project.status).toBe('active')
  })

  it('retries a pending DNS observation only after eligibility with one stable key', async () => {
    const f = await fixture()
    let ready = false
    f.dns.mockImplementation(async input => {
      const result = await createMockManagedSiteDnsTlsAdapter({ result: ready ? {} : { dnsStatus: 'propagation_pending', tlsStatus: 'pending' } }).configureAndVerify(input)
      return { ...result, providerEventId: `${result.providerEventId}-${ready ? 'ready' : 'pending'}` }
    })
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, waiting: 1 })
    ready = true
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    expect(f.dns).toHaveBeenCalledTimes(1)
    expect(f.deploy).not.toHaveBeenCalled()
    f.advanceClock(5 * 60_000 + 1)
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 1 })
    expect(f.dns.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([funnelFulfilmentKey(7, f.release.id, 'dns_tls'), funnelFulfilmentKey(7, f.release.id, 'dns_tls')])
  })

  it('observes normal DNS propagation beyond three retries and succeeds hours later', async () => {
    const f = await fixture()
    let ready = false
    f.dns.mockImplementation(async input => {
      const result = await createMockManagedSiteDnsTlsAdapter({ result: ready ? {} : { dnsStatus: 'propagation_pending', tlsStatus: 'pending' } }).configureAndVerify(input)
      return { ...result, providerEventId: `${result.providerEventId}-${ready ? 'ready' : 'pending'}` }
    })
    for (let i = 0; i < 6; i++) {
      expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ waiting: 1, failed: 0 })
      f.advanceClock(60 * 60_000)
    }
    expect(f.line.live.state.attempts.find(row => row.operation === 'dns_tls_configure_verify')).toMatchObject({ status: 'retry_wait', attemptNumber: 0 })
    expect(f.deploy).not.toHaveBeenCalled()
    ready = true
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 1 })
    expect(f.dns).toHaveBeenCalledTimes(7)
    expect(f.line.live.state.attempts.filter(row => row.operation === 'dns_tls_configure_verify')).toHaveLength(1)
  })

  it('persists an actionable block after the bounded 48-hour DNS propagation window', async () => {
    const f = await fixture()
    f.dns.mockImplementation(createMockManagedSiteDnsTlsAdapter({ result: { dnsStatus: 'propagation_pending', tlsStatus: 'pending' } }).configureAndVerify)
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    f.advanceClock(48 * 60 * 60_000 + 1)
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, failed: 1 })
    expect(f.line.live.state.releases[0]).toMatchObject({ status: 'blocked', blockedReasonCode: 'DNS_PROPAGATION_TIMEOUT', nextSafeAction: 'review_domain_connection' })
    expect(f.line.live.state.attempts.find(row => row.operation === 'dns_tls_configure_verify')).toMatchObject({ status: 'blocked', errorCode: 'DNS_PROPAGATION_TIMEOUT' })
    expect(f.dns).toHaveBeenCalledTimes(1)
    expect(f.deploy).not.toHaveBeenCalled()
  })

  it('persists an actionable DNS failure after three actual transport failures', async () => {
    const f = await fixture()
    f.dns.mockRejectedValue(new Error('DNS broker temporarily unavailable'))
    for (let i = 0; i < 3; i++) {
      expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ failed: 1, advanced: 0 })
      f.advanceClock(30_001)
    }
    expect(f.line.live.state.releases[0]).toMatchObject({ status: 'blocked', blockedReasonCode: 'DNS_TLS_FAILED', nextSafeAction: 'review_domain_connection' })
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    expect(f.dns).toHaveBeenCalledTimes(3)
    expect(f.deploy).not.toHaveBeenCalled()
  })

  it('uses the existing production retry lease and never recreates the charge or generation', async () => {
    const f = await fixture()
    f.deploy.mockRejectedValueOnce(new Error('temporary production timeout'))
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, failed: 1 })
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, waiting: 1 })
    expect(f.deploy).toHaveBeenCalledTimes(1)
    f.advanceClock(5 * 60_000 + 1)
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 1 })
    expect(f.deploy).toHaveBeenCalledTimes(2)
    expect(f.line.live.state.attempts.filter(row => row.operation === 'production_deploy')).toHaveLength(1)
    expect(f.line.live.state.candidates).toHaveLength(1)
    expect(f.line.live.state.receipts.filter(row => row.receiptType === 'checkout_session_created')).toHaveLength(1)
  })

  it.each(['payment_refunded', 'payment_disputed'])('does not accept production when %s arrives during transport', async eventType => {
    const f = await fixture()
    const base = createMockManagedSiteDeploymentAdapter({ now: f.now })
    f.deploy.mockImplementation(async input => { await f.payment(eventType); return base.deployProduction(input) })
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, failed: 1 })
    expect(f.deploy).toHaveBeenCalledTimes(1)
    expect(f.line.live.state.releases[0]!.status).toBe('blocked')
    expect(f.line.managed.state.projects[0]!.status).toBe('suspended')
    expect(f.line.live.state.receipts.filter(row => row.receiptType === 'production_deployment_verified')).toHaveLength(0)
  })

  it('allows only one production transport when two scheduled pages overlap', async () => {
    const f = await fixture()
    await executeManagedSiteDnsTls(1, { projectId: f.release.projectId, releaseId: f.release.id, executionMode: 'mocked', idempotencyKey: 'pre-existing-dns' }, createMockManagedSiteDnsTlsAdapter(), { repository: f.line.live.repository, managedRepository: f.line.managed.repository, clock: f.now })
    let unblock!: () => void
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const base = createMockManagedSiteDeploymentAdapter({ now: f.now })
    f.deploy.mockImplementation(async input => { await gate; return base.deployProduction(input) })
    const first = advancePaidManagedSiteFunnel({}, f.dependencies)
    const second = advancePaidManagedSiteFunnel({}, f.dependencies)
    unblock()
    const results = await Promise.all([first, second])
    expect(results.reduce((sum, result) => sum + result.advanced, 0)).toBe(1)
    expect(f.deploy).toHaveBeenCalledTimes(1)
  })

  it('recovers only the expired exact production attempt after a worker crash', async () => {
    const f = await fixture()
    f.deploy.mockRejectedValueOnce(new Error('worker lost'))
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    const attempt = f.line.live.state.attempts.find(row => row.operation === 'production_deploy')!
    Object.assign(attempt, { status: 'processing', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(f.now().getTime() + 45_000), retryEligibleAt: null })
    f.line.live.state.releases[0]!.status = 'deployment_pending'
    await advancePaidManagedSiteFunnel({}, f.dependencies)
    expect(f.deploy).toHaveBeenCalledTimes(1)
    f.advanceClock(45_001)
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 1 })
    expect(f.deploy).toHaveBeenCalledTimes(2)
    expect(f.line.live.state.attempts.filter(row => row.operation === 'production_deploy')).toHaveLength(1)
  })

  it.each(['deployment', 'dns_tls'] as const)('blocks production on %s provider drift', async capability => {
    const f = await fixture()
    await executeManagedSiteDnsTls(1, { projectId: f.release.projectId, releaseId: f.release.id, executionMode: 'mocked', idempotencyKey: 'pre-existing-dns' }, createMockManagedSiteDnsTlsAdapter(), { repository: f.line.live.repository, managedRepository: f.line.managed.repository, clock: f.now })
    await configureManagedSiteProvider(1, { capability, providerKey: capability === 'deployment' ? 'mock-deployment' : 'mock-dns-tls', readinessStatus: 'mock', credentialReference: 'vault:rotated-fulfilment', transportConfiguration: {}, idempotencyKey: `rotate-fulfilment-${capability}` }, f.line.live.repository, f.now)
    expect(await advancePaidManagedSiteFunnel({}, f.dependencies)).toMatchObject({ advanced: 0, failed: 1 })
    expect(f.deploy).not.toHaveBeenCalled()
  })

  it('returns a bounded keyset cursor and wraps only after the last page', async () => {
    const f = await fixture()
    const candidates = [f.session, { ...f.session, id: 9 }, { ...f.session, id: 11 }]
    f.dependencies.funnelRepository = createFunnelSessionMemoryRepository({ fulfilmentCandidates: () => candidates }).repository
    f.line.live.state.domainClaims.length = 0
    expect(await advancePaidManagedSiteFunnel({ limit: 2 }, f.dependencies)).toMatchObject({ scanned: 2, nextAfterId: 9 })
    expect(await advancePaidManagedSiteFunnel({ limit: 2, afterId: 9 }, f.dependencies)).toMatchObject({ scanned: 1, nextAfterId: 0 })
  })

  it('also protects the owner production service from stale paid status', async () => {
    const f = await fixture()
    await executeManagedSiteDnsTls(1, { projectId: f.release.projectId, releaseId: f.release.id, executionMode: 'mocked', idempotencyKey: 'pre-existing-dns' }, createMockManagedSiteDnsTlsAdapter(), { repository: f.line.live.repository, managedRepository: f.line.managed.repository, clock: f.now })
    f.line.ordering.state.orders[0]!.status = 'refunded'
    await expect(deployManagedSiteProduction(1, { releaseId: f.release.id, executionMode: 'mocked', idempotencyKey: 'owner-stale-paid-production' }, { ...createMockManagedSiteDeploymentAdapter(), deployProduction: f.deploy }, { repository: f.line.live.repository, orderingRepository: f.line.ordering.repository, managedRepository: f.line.managed.repository, productionTransaction: f.line.productionTransaction, clock: f.now })).rejects.toMatchObject({ statusCode: 409 })
    expect(f.deploy).not.toHaveBeenCalled()
  })
})
