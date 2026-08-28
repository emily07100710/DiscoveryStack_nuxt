import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote } from '../../../server/managed-sites/ordering-service'
import { claimManagedSiteCheckout } from '../../../server/managed-sites/checkout-claim-service'
import { convertClaimedManagedSitePrePurchase } from '../../../server/managed-sites/prepurchase-service'
import { configureManagedSiteProvider } from '../../../server/managed-sites/live-connectors/provider-registry'
import { createMemoryManagedSiteArtifactVault, createMockManagedSiteGenerationAdapter } from '../../../server/managed-sites/live-connectors/adapters'
import { generateManagedSiteCandidate } from '../../../server/managed-sites/live-connectors/generation-service'
import { approveManagedSitePreview, buildManagedSitePreview, createGeneratedManagedSiteRelease, createMockManagedSiteDeploymentAdapter } from '../../../server/managed-sites/live-connectors/deployment-orchestrator'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../../../server/managed-sites/live-connectors/checkout-session'
import { createManagedSiteMemoryRepository } from './repository'
import { createOrderingMemoryRepository } from './ordering-repository'
import { createLiveConnectorMemoryRepository } from './live-connectors-repository'

/** Stable for one test process while remaining inside real TTL windows on any run date. */
export const managedSiteFixedNow = new Date()

export async function managedSiteExactPaymentWebhookPayload(line: Awaited<ReturnType<typeof createAuthoritativeManagedSiteReleaseFixture>>, input: { providerEventId: string; eventType: string; providerReference?: string; exactResponseIdentity?: string }) {
  const configuration = await line.live.repository.findProviderConfiguration(line.ownerUserId, 'payment')
  const checkoutReceipt = line.live.state.receipts.find(row => row.receiptType === 'checkout_session_created' && row.releaseId === line.release.release.id)
  if (!configuration?.verificationReceiptFingerprint || !checkoutReceipt) throw new Error('fixture payment configuration or checkout authority is missing')
  return {
    providerKey: configuration.providerKey,
    providerEventId: input.providerEventId,
    providerReference: input.providerReference || 'payment-ref-001',
    eventType: input.eventType,
    draftOrderId: line.order.order.id,
    amountMinor: line.quote.quote.totalMinor,
    currency: line.quote.quote.currency,
    configurationFingerprint: configuration.configurationFingerprint,
    verificationReceiptFingerprint: configuration.verificationReceiptFingerprint,
    checkoutReceiptFingerprint: checkoutReceipt.receiptFingerprint,
    occurredAt: managedSiteFixedNow.toISOString(),
    exactResponseIdentity: input.exactResponseIdentity || `payment-response:${input.providerEventId}`,
  }
}

export async function createAuthoritativeManagedSiteReleaseFixture(options: { ownerUserId?: number; siteType?: 'one_page' | 'brand_blog' | 'simple_commerce'; selectedModules?: any[]; canonicalDomain?: string; buildPreview?: boolean; createCheckout?: boolean } = {}) {
  const ownerUserId = options.ownerUserId || 1
  const managed = createManagedSiteMemoryRepository(); const ordering = createOrderingMemoryRepository(); const live = createLiveConnectorMemoryRepository()
  const providerKeys = { website_generator: 'mock-generator', payment: 'mock-payment', domain_registration: 'mock-domain', dns_tls: 'mock-dns-tls', deployment: 'mock-deployment' } as const
  for (const [capability, providerKey] of Object.entries(providerKeys)) await configureManagedSiteProvider(ownerUserId, { capability: capability as keyof typeof providerKeys, providerKey, readinessStatus: 'mock', credentialReference: null, transportConfiguration: {}, idempotencyKey: `fixture-configure-${capability}` }, live.repository)
  const preview = await createManagedSitePreview(null, { draftIdentity: `authoritative-${options.siteType || 'brand_blog'}`, brandName: 'Authoritative Managed Site', audience: 'Reviewed Taiwan buyers', brief: 'A governed evidence-safe managed website with no outcome claim.', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: options.siteType || 'brand_blog', selectedModules: options.selectedModules || ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [] }, ordering.repository, () => managedSiteFixedNow)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'basic', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'fixture-quote-001' }, ordering.repository, () => managedSiteFixedNow)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Claimed Owner', email: 'not-authority@example.invalid', company: 'Authoritative Managed Site', website: `https://${options.canonicalDomain || 'authoritative.acme.taipei'}`, privacyConsent: true, recontactConsent: false, idempotencyKey: 'fixture-lead-001' }, ordering.repository, () => managedSiteFixedNow)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'fixture-order-001' }, ordering.repository, () => managedSiteFixedNow)
  await claimManagedSiteCheckout(ownerUserId, { previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id }, ordering.repository, () => managedSiteFixedNow)
  const prePurchase = await convertClaimedManagedSitePrePurchase(ownerUserId, { previewId: preview.preview.id, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, draftOrderId: order.order.id, idempotencyKey: 'fixture-prepurchase-001' }, { ordering: ordering.repository, managed: managed.repository, live: live.repository }, () => managedSiteFixedNow)
  const vault = createMemoryManagedSiteArtifactVault()
  const generation = await generateManagedSiteCandidate(ownerUserId, { projectId: prePurchase.project.id, sourceVersionId: prePurchase.version.id, templateIntent: 'astro', executionMode: 'mocked', idempotencyKey: 'fixture-generation-001' }, { adapter: createMockManagedSiteGenerationAdapter(), vault, repository: live.repository, managedRepository: managed.repository, clock: () => managedSiteFixedNow })
  const release = await createGeneratedManagedSiteRelease(ownerUserId, { projectId: prePurchase.project.id, generationCandidateId: generation.candidate!.id, canonicalDomain: options.canonicalDomain || 'authoritative.acme.taipei', targetKey: 'production-primary', idempotencyKey: 'fixture-release-001' }, { repository: live.repository, managedRepository: managed.repository })
  const deploymentAdapter = createMockManagedSiteDeploymentAdapter({ now: () => managedSiteFixedNow })
  if (options.buildPreview !== false) {
    await buildManagedSitePreview(ownerUserId, { releaseId: release.release.id, executionMode: 'mocked', idempotencyKey: 'fixture-preview-001' }, deploymentAdapter, { repository: live.repository, clock: () => managedSiteFixedNow })
    await approveManagedSitePreview(ownerUserId, { releaseId: release.release.id, idempotencyKey: 'fixture-approval-001' }, live.repository, () => managedSiteFixedNow)
  }
  const checkout = options.buildPreview === false || options.createCheckout === false ? null : await createManagedSiteCheckoutSession(ownerUserId, { releaseId: release.release.id, draftOrderId: order.order.id, executionMode: 'mocked', idempotencyKey: 'fixture-checkout-001' }, createMockManagedSiteCheckoutSessionAdapter(), { connectorRepository: live.repository, orderingRepository: ordering.repository, clock: () => managedSiteFixedNow })
  let jointQueue = Promise.resolve()
  const jointTransaction = async <T>(work: (repositories: { connector: typeof live.repository; ordering: typeof ordering.repository; managed: typeof managed.repository }) => Promise<T>): Promise<T> => {
    const previous = jointQueue; let releaseQueue!: () => void; jointQueue = new Promise(resolve => { releaseQueue = resolve }); await previous
    const snapshots = { managed: structuredClone(managed.state), ordering: structuredClone(ordering.state), live: structuredClone(live.state) }
    try { return await work({ connector: live.repository, ordering: ordering.repository, managed: managed.repository }) } catch (error) { Object.assign(managed.state, snapshots.managed); Object.assign(ordering.state, snapshots.ordering); Object.assign(live.state, snapshots.live); throw error } finally { releaseQueue() }
  }
  return { ownerUserId, managed, ordering, live, preview, quote, lead, order, prePurchase, vault, generation, release, deploymentAdapter, checkout, jointTransaction }
}
