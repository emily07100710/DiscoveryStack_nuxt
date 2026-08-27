import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent } from '../server/managed-sites/ordering-service'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createHmacRawBodyPaymentWebhookAdapter, createMemoryManagedSiteArtifactVault, createMockManagedSiteGenerationAdapter } from '../server/managed-sites/live-connectors/adapters'
import { processManagedSiteRawPaymentWebhook } from '../server/managed-sites/live-connectors/payment-webhook'
import { generateManagedSiteCandidate } from '../server/managed-sites/live-connectors/generation-service'
import { approveManagedSitePreview, bindManagedSiteReleasePayment, buildManagedSitePreview, createGeneratedManagedSiteRelease, createMockManagedSiteDeploymentAdapter, deployManagedSiteProduction, activateManagedSiteGeoOperations } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createMockManagedSiteDnsTlsAdapter, createMockManagedSiteDomainAdapter, createManagedSiteDomainPurchaseIntent, executeManagedSiteDnsTls, managedSiteDomainConfirmationFingerprint, quoteManagedSiteDomain } from '../server/managed-sites/live-connectors/domain-connectors'

const ownerUserId = 1
const fixedNow = new Date('2026-08-27T00:00:00.000Z')

async function configureMocks(repository: ReturnType<typeof createLiveConnectorMemoryRepository>['repository']) {
  const keys = { website_generator: 'mock-generator', payment: 'mock-payment', domain_registration: 'mock-domain', dns_tls: 'mock-dns-tls', deployment: 'mock-deployment' } as const
  for (const [capability, providerKey] of Object.entries(keys)) await configureManagedSiteProvider(ownerUserId, { capability: capability as keyof typeof keys, providerKey, readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: `configure-${capability}` }, repository)
}

async function createCheckoutLineage(ordering: ReturnType<typeof createOrderingMemoryRepository>, website = 'https://new-live.acme.taipei') {
  const preview = await createManagedSitePreview(ownerUserId, { draftIdentity: 'live-connectors-new-site', brandName: 'Live Connector Client', audience: 'Taiwan service buyers', brief: 'A governed evidence-safe managed website.', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [] }, ordering.repository, () => fixedNow)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'live-quote-001' }, ordering.repository, () => fixedNow)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Managed Owner', email: 'owner@live-connectors.invalid', company: 'Live Connector Client', website, privacyConsent: true, recontactConsent: false, idempotencyKey: 'live-lead-001' }, ordering.repository, () => fixedNow)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'live-order-001' }, ordering.repository, () => fixedNow)
  return { preview, quote, lead, order }
}

describe('managed-site live connectors mocked application path', () => {
  it('runs generation candidate to preview approval, verified checkout, domain/DNS/TLS/deployment receipts, live, then canonical GEO activation', async () => {
    const live = createLiveConnectorMemoryRepository()
    const managed = createManagedSiteMemoryRepository()
    const ordering = createOrderingMemoryRepository()
    await configureMocks(live.repository)
    const checkout = await createCheckoutLineage(ordering)
    const webhookCredential = randomBytes(32).toString('hex')
    const webhookPayload = { providerKey: 'mock-payment', providerEventId: 'payment-success-001', providerReference: 'payment-ref-001', eventType: 'checkout_succeeded', draftOrderId: checkout.order.order.id, amountMinor: checkout.quote.quote.totalMinor, currency: checkout.quote.quote.currency, occurredAt: fixedNow.toISOString(), exactResponseIdentity: 'payment-response:success-001' }
    const rawBody = Buffer.from(JSON.stringify(webhookPayload))
    const signatureHeader = createHmac('sha256', webhookCredential).update(rawBody).digest('hex')
    const payment = await processManagedSiteRawPaymentWebhook({ rawBody, signatureHeader, credentialReference: 'vault:payment-webhook-test', executionMode: 'mocked' }, createHmacRawBodyPaymentWebhookAdapter('mock-payment'), { connectorRepository: live.repository, orderingRepository: ordering.repository, managedRepository: managed.repository, credentialResolver: async reference => reference === 'vault:payment-webhook-test' ? { ok: true, value: webhookCredential } : { ok: false, reason: 'missing_reference' }, clock: () => fixedNow })
    expect(payment.effective).toBe(true)
    expect(payment.projectId).toBeTypeOf('number')
    const convertedOrder = await ordering.repository.findDraftOrderById(checkout.order.order.id)
    const project = await managed.repository.findProject(ownerUserId, payment.projectId!)
    expect(convertedOrder?.status).toBe('payment_verified')
    expect(project?.activeVersionId).toBeTypeOf('number')

    const vault = createMemoryManagedSiteArtifactVault()
    const generation = await generateManagedSiteCandidate(ownerUserId, { projectId: project!.id, sourceVersionId: project!.activeVersionId!, templateIntent: 'astro', executionMode: 'mocked', idempotencyKey: 'generation-candidate-001' }, { adapter: createMockManagedSiteGenerationAdapter(), vault, credentialResolver: async () => ({ ok: false, reason: 'registry_unavailable' }), repository: live.repository, managedRepository: managed.repository, clock: () => fixedNow })
    expect(generation.candidate?.contentHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(vault.records.size).toBe(1)
    const candidate = generation.candidate!

    const releaseResult = await createGeneratedManagedSiteRelease(ownerUserId, { projectId: project!.id, generationCandidateId: candidate.id, canonicalDomain: 'new-live.acme.taipei', targetKey: 'production-primary', idempotencyKey: 'release-001' }, { repository: live.repository, managedRepository: managed.repository })
    const deploymentAdapter = createMockManagedSiteDeploymentAdapter()
    const preview = await buildManagedSitePreview(ownerUserId, { releaseId: releaseResult.release.id, executionMode: 'mocked', idempotencyKey: 'preview-build-001' }, deploymentAdapter, { repository: live.repository, clock: () => fixedNow })
    expect(preview.release?.status).toBe('preview_ready')
    const approval = await approveManagedSitePreview(ownerUserId, { releaseId: releaseResult.release.id, idempotencyKey: 'preview-approval-001' }, live.repository, () => fixedNow)
    expect(approval.release?.status).toBe('approved')
    const paymentReceipt = live.state.receipts.find(receipt => receipt.receiptType === 'checkout_succeeded')!
    const bound = await bindManagedSiteReleasePayment(ownerUserId, { releaseId: releaseResult.release.id, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint, idempotencyKey: 'release-payment-001' }, live.repository, () => fixedNow)
    expect(bound.release?.status).toBe('payment_verified')

    const quote = await quoteManagedSiteDomain(ownerUserId, { projectId: project!.id, requestedDomain: 'new-live.acme.taipei', executionMode: 'mocked', idempotencyKey: 'domain-quote-001' }, createMockManagedSiteDomainAdapter({ now: () => fixedNow }), { repository: live.repository, managedRepository: managed.repository, clock: () => fixedNow })
    const ownerConfirmationFingerprint = managedSiteDomainConfirmationFingerprint({ ownerUserId, projectId: project!.id, quoteReceiptFingerprint: quote.receiptFingerprint!, draftOrderId: checkout.order.order.id, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint })
    const domain = await createManagedSiteDomainPurchaseIntent(ownerUserId, { projectId: project!.id, draftOrderId: checkout.order.order.id, quoteReceiptFingerprint: quote.receiptFingerprint!, paymentReceiptFingerprint: paymentReceipt.receiptFingerprint, ownerConfirmationFingerprint, executionMode: 'mocked', idempotencyKey: 'domain-purchase-001' }, createMockManagedSiteDomainAdapter({ now: () => fixedNow }), { repository: live.repository, clock: () => fixedNow })
    expect(domain.result.status).toBe('registered')
    const dnsTls = await executeManagedSiteDnsTls(ownerUserId, { projectId: project!.id, releaseId: releaseResult.release.id, executionMode: 'mocked', idempotencyKey: 'dns-tls-001' }, createMockManagedSiteDnsTlsAdapter(), { repository: live.repository, clock: () => fixedNow })
    expect(dnsTls.ready).toBe(true)

    const deployed = await deployManagedSiteProduction(ownerUserId, { releaseId: releaseResult.release.id, executionMode: 'mocked', idempotencyKey: 'deployment-001' }, deploymentAdapter, { repository: live.repository, managedRepository: managed.repository, clock: () => fixedNow })
    expect(deployed.release?.status).toBe('live_verified')
    expect(deployed.receipt.contentHash).toBe(candidate.contentHash)
    expect(deployed.receipt.canonicalDomain).toBe('new-live.acme.taipei')

    const activated = await activateManagedSiteGeoOperations(ownerUserId, { releaseId: releaseResult.release.id, timeZone: 'Asia/Taipei', cadenceDays: 7, monthlyBudgetUnits: 12, idempotencyKey: 'geo-activation-001' }, { repository: live.repository, managedRepository: managed.repository, clock: () => fixedNow, activate: (async (owner: number, projectId: number, _input: unknown, managedRepository: any) => { const updated = await managedRepository.updateProject(owner, projectId, { contentOperationClientId: 501 } as any); return { project: updated, client: { id: 501 }, linked: true, reused: true, notDuplicated: true } }) as any })
    expect(activated.release?.status).toBe('geo_active')
    expect(activated.receipt.metadata).toMatchObject({ reusedCanonicalContentOperations: true, measurementStartsAfterVerifiedLiveSite: true })
    expect(live.state.receipts.some(receipt => receipt.receiptType === 'production_deployment_verified')).toBe(true)
    expect(live.state.receipts.some(receipt => receipt.receiptType === 'geo_subscription_activated')).toBe(true)
  })
})
