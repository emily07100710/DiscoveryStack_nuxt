import { describe, expect, it } from 'vitest'
import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote, recordVerifiedMockedPaymentEvent } from '../server/managed-sites/ordering-service'
import { createManagedSiteDomainIntent, createManagedSiteProvisioningPlan, executeManagedSiteProvisioningPlan } from '../server/managed-sites/provisioning-service'
import { createManagedSiteProject, createManagedSiteVersion } from '../server/managed-sites/service'
import { createShopifyIntegrationIntent, linkManagedSiteContentOperations, runManagedSiteAssistant } from '../server/managed-sites/modules-service'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'
import { createIntegrationMemoryRepository } from './fixtures/managed-site/modules-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const, principal: 'owner@example.test' }

it('runs the managed platform path end to end with only injected mocks and explicit owner confirmation boundaries', async () => {
  const ordering = createOrderingMemoryRepository()
  const managed = createManagedSiteMemoryRepository()
  const provisioning = createProvisioningMemoryRepository()
  const integrations = createIntegrationMemoryRepository()
  const content = new ContentOperationsFixture()
  const preview = await createManagedSitePreview(null, { draftIdentity: 'e2e-preview-1', brandName: 'Acme Studio', audience: '台灣服務企業客戶', brief: '用清楚的答案、專業證據與持續內容帶來更多諮詢。', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'geo_content_subscription', 'geo_measurement_dashboard'], styleReferences: [{ url: 'https://example.com/reference', selectedPreferences: ['color', 'homepage_structure'] }] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'business', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'e2e-quote-1' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Acme Owner', email: 'e2e@example.test', company: 'Acme Studio', privacyConsent: true, recontactConsent: true, idempotencyKey: 'e2e-lead-1' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'e2e-order-1' }, ordering.repository)
  const payment = await recordVerifiedMockedPaymentEvent({ draftOrderId: order.order.id, eventId: 'e2e-payment-event-1', providerReference: 'mock-provider-ref-1', eventType: 'payment_succeeded', verified: true, idempotencyKey: 'e2e-payment-1' }, ordering.repository)
  expect(payment.order.status).toBe('payment_verified')

  const project = await createManagedSiteProject(1, actor, { canonicalClientIdentity: 'Acme Studio', canonicalWebsiteIdentity: 'https://preview-1.discoverystack.example', siteType: 'brand_blog', idempotencyKey: 'e2e-project-1' }, managed.repository)
  const version = await createManagedSiteVersion(1, project.project.id, actor, { siteSpecSnapshot: preview.spec, designTokenSnapshot: preview.spec.designTokens, selectedModuleSnapshot: preview.spec.selectedModules, contentFingerprint: stableFingerprint(preview.spec), createdByAuthority: 'verified_payment_owner_confirmation', lifecycleStatus: 'preview' }, managed.repository)
  expect(version.version?.lifecycleStatus).toBe('preview')

  const domain = await createManagedSiteDomainIntent(1, { projectId: project.project.id, draftOrderId: order.order.id, mode: 'new_registration', requestedDomain: 'acme.example.com', providerKey: 'registrar-neutral', idempotencyKey: 'e2e-domain-1' }, provisioning.repository, managed.repository)
  const plan = await createManagedSiteProvisioningPlan(1, { projectId: project.project.id, versionId: version.version!.id, domainIntentId: domain.intent.id, platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: 'e2e-plan-1' }, provisioning.repository, managed.repository)
  const provisioningResult = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', undefined, provisioning.repository, managed.repository)
  expect(provisioningResult.plan?.status).toBe('blocked')
  expect(provisioningResult.externalCalls).toBe(false)
  expect(provisioningResult.plan?.deployedUrl).toBeNull()

  const shopify = await createShopifyIntegrationIntent(1, { projectId: project.project.id, moduleKey: 'shopify_commerce', redactedConfig: { shopDomain: 'acme.myshopify.com' }, idempotencyKey: 'e2e-shopify-1' }, integrations.repository, managed.repository)
  expect(shopify.shopify.claims.shopCreated).toBe(false)
  const linked = await linkManagedSiteContentOperations(1, project.project.id, { displayName: 'Acme Studio', canonicalSiteOrigin: 'https://preview-1.discoverystack.example', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'e2e-content-link-1' }, managed.repository, content.repository)
  expect(linked.notDuplicated).toBe(true)
  const assistant = await runManagedSiteAssistant(1, { projectId: project.project.id, question: '這個網站何時可以上線？' }, undefined, managed.repository)
  expect(assistant.status).toBe('blocked')
  expect(assistant.externalCalls).toBe(false)
})
