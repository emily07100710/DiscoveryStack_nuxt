import { expect, it } from 'vitest'
import { createManagedSiteDraftOrder, createManagedSiteLeadIntent, createManagedSitePreview, createManagedSiteQuote } from '../server/managed-sites/ordering-service'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import { createManagedSiteDomainIntent, createManagedSiteProvisioningPlan, executeManagedSiteProvisioningPlan } from '../server/managed-sites/provisioning-service'
import { createShopifyIntegrationIntent, linkManagedSiteContentOperations, runManagedSiteAssistant } from '../server/managed-sites/modules-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'
import { createIntegrationMemoryRepository } from './fixtures/managed-site/modules-repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const mockedPaymentVerifier: PaymentEventVerifier = { verify: async () => true }

it('runs the managed platform path end to end with server-owned payment conversion and injected provider boundaries', async () => {
  const ordering = createOrderingMemoryRepository()
  const managed = createManagedSiteMemoryRepository()
  const provisioning = createProvisioningMemoryRepository()
  const integrations = createIntegrationMemoryRepository()
  const content = new ContentOperationsFixture()
  const preview = await createManagedSitePreview(1, { draftIdentity: 'e2e-preview-1', brandName: 'Acme Studio', audience: '台灣服務企業客戶', brief: '用清楚的答案、專業證據與持續內容帶來更多諮詢。', businessGoals: ['increase_inquiries', 'improve_search_ai_understanding'], siteType: 'brand_blog', selectedModules: ['managed_content_admin', 'bounded_ai_assistant', 'geo_content_subscription', 'geo_measurement_dashboard', 'shopify_commerce'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'business', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'e2e-quote-1' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Acme Owner', email: 'owner@acme.taipei', company: 'Acme Studio', privacyConsent: true, recontactConsent: true, idempotencyKey: 'e2e-lead-1' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'e2e-order-1' }, ordering.repository)
  const conversion = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'e2e-payment-event-1', providerReference: 'mock-provider-ref-1', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'b'.repeat(64), idempotencyKey: 'e2e-conversion-1' }, mockedPaymentVerifier, { ordering: ordering.repository, managed: managed.repository })
  expect(conversion.order.status).toBe('payment_verified')
  expect(conversion.project.status).toBe('active')
  expect(conversion.version.lifecycleStatus).toBe('active')
  expect(conversion.subscription.status).toBe('active')
  expect(conversion.order.projectId).toBe(conversion.project.id)
  const replayConversion = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'e2e-payment-event-1', providerReference: 'mock-provider-ref-1', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'b'.repeat(64), idempotencyKey: 'e2e-conversion-1' }, mockedPaymentVerifier, { ordering: ordering.repository, managed: managed.repository })
  expect(replayConversion.paymentReplayed).toBe(true)
  expect(replayConversion.conversionReplayed).toBe(true)

  const domain = await createManagedSiteDomainIntent(1, { projectId: conversion.project.id, draftOrderId: order.order.id, mode: 'new_registration', requestedDomain: 'acme-demo.taipei', providerKey: 'registrar-neutral', idempotencyKey: 'e2e-domain-1' }, provisioning.repository, managed.repository)
  const plan = await createManagedSiteProvisioningPlan(1, { projectId: conversion.project.id, versionId: conversion.version.id, domainIntentId: domain.intent.id, platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: 'e2e-plan-1' }, provisioning.repository, managed.repository)
  const provisioningResult = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', undefined, provisioning.repository, managed.repository)
  expect(provisioningResult.plan?.status).toBe('draft')
  expect(provisioningResult.externalCalls).toBe(false)
  expect(provisioningResult.plan?.deployedUrl).toBeNull()

  const shopify = await createShopifyIntegrationIntent(1, { projectId: conversion.project.id, moduleKey: 'shopify_commerce', redactedConfig: { shopDomain: 'acme.myshopify.com' }, idempotencyKey: 'e2e-shopify-1' }, integrations.repository, managed.repository)
  expect(shopify.shopify.claims.shopCreated).toBe(false)
  const linked = await linkManagedSiteContentOperations(1, conversion.project.id, { displayName: 'Acme Studio', canonicalSiteOrigin: 'https://managed-site.acme.taipei', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'e2e-content-link-1' }, managed.repository, content.repository)
  expect(linked.notDuplicated).toBe(true)
  const assistant = await runManagedSiteAssistant(1, { projectId: conversion.project.id, question: '這個網站何時可以上線？' }, undefined, managed.repository, content.repository)
  expect(assistant.status).toBe('needs_authorization')
  expect(assistant.externalCalls).toBe(false)
})
