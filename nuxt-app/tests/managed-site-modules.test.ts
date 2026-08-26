import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent } from '../server/managed-sites/ordering-service'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import { createManagedSiteIntegrationIntent, createShopifyIntegrationIntent, getCanonicalGeoReuseContract, getManagedSiteModuleWorkspace, linkManagedSiteContentOperations, runManagedSiteAssistant } from '../server/managed-sites/modules-service'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createIntegrationMemoryRepository } from './fixtures/managed-site/modules-repository'
import { createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { ContentOperationsFixture, HASH } from './fixtures/content-operations/repository'

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const, principal: 'owner@acme.taipei' }
const mockPaymentVerifier: PaymentEventVerifier = { verify: async () => true }

async function makeProject() {
  const managed = createManagedSiteMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const selectedModules = ['managed_content_admin', 'bounded_ai_assistant', 'shopify_commerce', 'line_assisted_integration', 'google_booking_assisted_integration', 'geo_content_subscription', 'geo_measurement_dashboard', 'pwa_reference_only'] as any
  const preview = await createManagedSitePreview(1, { draftIdentity: 'modules-preview-001', brandName: 'Modules Client', audience: 'Taiwan customers', brief: 'A paid modular managed site.', businessGoals: ['sell_online', 'increase_inquiries'], siteType: 'simple_commerce', selectedModules, styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'business', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'modules-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Modules Owner', email: 'owner@acme.taipei', company: 'Modules Client', website: 'https://modules-client.acme.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'modules-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'modules-order-001' }, ordering.repository)
  const conversion = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'modules-payment-001', providerReference: 'modules-payment-ref-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'e'.repeat(64), idempotencyKey: 'modules-conversion-001' }, mockPaymentVerifier, { ordering: ordering.repository, managed: managed.repository })
  return { managed, ordering, project: { project: conversion.project } }
}

async function seedValidDeliveredContent(content: ContentOperationsFixture) {
  content.evidenceApprovalAt = new Date().toISOString()
  const calendar = await content.addCalendar(1, '2026-08-27', 1)
  const entry = content.entries[0]!
  const deliverable = content.bundles.get('1:11')!.deliverables[0]!
  const job = { id: 701, ownerUserId: 1, briefId: 702, productionPlanId: 11, productionDeliverableId: deliverable.id, strategyRecommendationId: 1, evidenceSnapshotHash: HASH, status: 'delivered' }
  const draft = { id: 703, ownerUserId: 1, jobId: job.id, version: 1, title: '預約服務說明', body: '這是可供客戶查詢的已發布內容。', contentHash: HASH, evidenceRefs: [{ locator: 'https://evidence.routing.discoverystack.dev/section-1' }], safetyStatus: 'passed' }
  const riskGate = { id: 704, ownerUserId: 1, draftId: draft.id, status: 'passed', evidenceSnapshotHash: HASH }
  content.persistGeneratedLineage(entry.id, { deliverable: deliverable as any, job, draft, riskGate })
  const review = content.recordOwnerReview(entry.id, { ownerUserId: 1, jobId: job.id, draftId: draft.id, decision: 'approved_for_delivery', evidenceSnapshotHash: HASH })
  Object.assign(job, { status: 'delivered' })
  Object.assign(entry, { status: 'delivered', contentHash: HASH, draftId: draft.id, jobId: job.id, publicationSlug: 'booking-service', publicationPath: '/booking-service', publicationIdentityFingerprint: HASH })
  const run = { id: 705, ownerUserId: 1, clientId: calendar.clientId, calendarId: calendar.id, entryId: entry.id, stage: 'publication', state: 'succeeded', attemptNumber: 1, idempotencyKey: 'assistant-publication-run', inputFingerprint: HASH, outputFingerprint: HASH, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, errorCode: null, errorSummary: null, startedAt: calendar.createdAt, completedAt: calendar.updatedAt, createdAt: calendar.createdAt, updatedAt: calendar.updatedAt }
  const attempt = { id: 706, ownerUserId: 1, clientId: calendar.clientId, entryId: entry.id, runId: run.id, targetId: 1, status: 'delivered', attemptNumber: 1, idempotencyKey: 'assistant-publication-attempt', inputFingerprint: HASH, contentHash: HASH, evidenceSnapshotHash: HASH, receiptFingerprint: 'b'.repeat(64), receiptLedger: [{ status: 'delivered', contentHash: HASH, evidenceSnapshotHash: HASH }], createdAt: calendar.createdAt, startedAt: calendar.createdAt, completedAt: calendar.updatedAt }
  content.runs.push(run as any)
  content.attempts.push(attempt as any)
  return { calendar, entry, job, draft, riskGate, review, run, attempt }
}

describe('managed site modules and canonical GEO reuse', () => {
  it('creates Shopify as a contract-only OAuth/Storefront/Admin intent without secrets or success claims', async () => {
    const line = await makeProject()
    const integrations = createIntegrationMemoryRepository()
    const result = await createShopifyIntegrationIntent(1, { projectId: line.project.project.id, moduleKey: 'shopify_commerce', redactedConfig: { shopDomain: 'merchant.myshopify.com', storefrontToken: 'should-not-persist', adminApiKey: 'should-not-persist' }, idempotencyKey: 'shopify-intent-1' }, integrations.repository, line.managed.repository)
    expect(result.integration.status).toBe('awaiting_authorization')
    expect(result.integration.requiredScopes).toEqual(['read_products', 'read_inventory', 'read_orders'])
    expect(result.integration.redactedConfig).not.toHaveProperty('storefrontToken')
    expect(result.shopify.oauth.authorizationUrl).toBeNull()
    expect(result.shopify.storefront.checkout).toBe('shopify_hosted_after_authorization')
    expect(result.shopify.claims).toEqual({ shopCreated: false, paymentConfigured: false, checkoutVerified: false })
  })

  it('keeps LINE, booking, payment, and invoice as customer-authorized intents', async () => {
    const line = await makeProject()
    const integrations = createIntegrationMemoryRepository()
    for (const [moduleKey, idempotencyKey] of [['line_assisted_integration', 'line-intent-1'], ['google_booking_assisted_integration', 'booking-intent-1'], ['payment', 'payment-intent-1'], ['invoice', 'invoice-intent-1']] as const) {
      const result = await createManagedSiteIntegrationIntent(1, { projectId: line.project.project.id, moduleKey, idempotencyKey }, integrations.repository, line.managed.repository)
      expect(result.integration.status).toBe('awaiting_authorization')
      expect(result.externalCalls).toBe(false)
      expect(result.providerConfigured).toBe(false)
    }
  })

  it('links the managed site to the existing Content Operations client instead of duplicating the GEO engine', async () => {
    const line = await makeProject()
    const integrations = createIntegrationMemoryRepository()
    const content = new ContentOperationsFixture()
    const linked = await linkManagedSiteContentOperations(1, line.project.project.id, { displayName: 'Modules Site', canonicalSiteOrigin: 'https://modules.acme.taipei', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'content-link-1' }, line.managed.repository, content.repository)
    expect(linked.linked).toBe(true)
    expect(linked.reused).toBe(true)
    expect(linked.notDuplicated).toBe(true)
    expect(content.clients).toHaveLength(1)
    const workspace = await getManagedSiteModuleWorkspace(1, line.project.project.id, integrations.repository, line.managed.repository, content.repository)
    expect(workspace.canonicalContentOperations).toMatchObject({ linked: true, clientId: linked.client.id, reuseOnly: true })
    expect(getCanonicalGeoReuseContract()).toMatchObject({ productionRunner: 'runOwnerContentEntryWorkflow', publicationRunner: 'runContentOperationsExecutionTick', outcomeLearning: 'buildOwnerContentLearningDataset', notDuplicated: true })
  })

  it('reports unconfigured capabilities truthfully and enforces owner isolation', async () => {
    const line = await makeProject()
    const integrations = createIntegrationMemoryRepository()
    const workspace = await getManagedSiteModuleWorkspace(1, line.project.project.id, integrations.repository, line.managed.repository, new ContentOperationsFixture().repository)
    const shopify = workspace.modules.find(module => module.moduleKey === 'shopify_commerce')!
    expect(shopify.status).toBe('requires_authorization')
    expect(shopify.configured).toBe(false)
    expect(shopify.externalCalls).toBe(false)
    expect(workspace.truthfulBoundary.join(' ')).toContain('不交換 token')
    await expect(createManagedSiteIntegrationIntent(2, { projectId: line.project.project.id, moduleKey: 'payment', idempotencyKey: 'cross-owner-module' }, integrations.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('fails closed for the assistant by default and validates an injected bounded answer', async () => {
    const line = await makeProject()
    const content = new ContentOperationsFixture()
    await linkManagedSiteContentOperations(1, line.project.project.id, { displayName: 'Modules Site', canonicalSiteOrigin: 'https://modules.acme.taipei', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'assistant-content-link-1' }, line.managed.repository, content.repository)
    const blocked = await runManagedSiteAssistant(1, { projectId: line.project.project.id, question: '如何預約？' }, undefined, line.managed.repository, content.repository)
    expect(blocked.status).toBe('needs_authorization')
    expect(blocked.answer).toBeNull()
    expect(blocked.externalCalls).toBe(false)
    const valid = await seedValidDeliveredContent(content)
    const answered = await runManagedSiteAssistant(1, { projectId: line.project.project.id, question: '如何預約？' }, { async answer(input) { const knowledge = input.knowledge[0]!; return { status: 'answered', answer: `${knowledge.excerpt} 請透過預約頁提交需求。`, citations: [{ citationId: knowledge.citationId, evidenceHash: knowledge.evidenceHash, contentHash: knowledge.contentHash, sourceLocator: knowledge.sourceLocator }], knowledgeSnapshotHash: input.knowledgeSnapshotHash, providerConfigured: true, externalCalls: false, limitation: null } } }, line.managed.repository, content.repository)
    expect(answered.status).toBe('answered')
    expect(answered.citations[0]?.citationId).toBe(`content-entry:${valid.entry.id}`)
    expect(answered.citations[0]?.sourceLocator).toBe(`content-entry:${valid.entry.id}`)
    await expect(runManagedSiteAssistant(1, { projectId: line.project.project.id, question: 'unsafe' }, { async answer(input) { return { status: 'answered', answer: '<script>alert(1)</script>', citations: [], knowledgeSnapshotHash: input.knowledgeSnapshotHash, providerConfigured: true, externalCalls: false, limitation: null } } }, line.managed.repository, content.repository)).rejects.toMatchObject({ statusCode: 422 })
    await expect(runManagedSiteAssistant(1, { projectId: line.project.project.id, question: 'citation tamper' }, { async answer(input) { const knowledge = input.knowledge[0]!; return { status: 'answered', answer: 'tampered', citations: [{ citationId: knowledge.citationId, evidenceHash: 'f'.repeat(64), contentHash: knowledge.contentHash, sourceLocator: knowledge.sourceLocator }], knowledgeSnapshotHash: input.knowledgeSnapshotHash, providerConfigured: true, externalCalls: false, limitation: null } } }, line.managed.repository, content.repository)).rejects.toMatchObject({ statusCode: 422 })
  })

  it.each(['pending', 'blocked', 'stale_evidence', 'wrong_tenant', 'tampered_content'] as const)('does not expose %s as assistant knowledge', async variant => {
    const line = await makeProject()
    const content = new ContentOperationsFixture()
    await linkManagedSiteContentOperations(1, line.project.project.id, { displayName: 'Eligibility Site', canonicalSiteOrigin: 'https://eligibility.acme.taipei', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: `eligibility-content-${variant}` }, line.managed.repository, content.repository)
    let valid: Awaited<ReturnType<typeof seedValidDeliveredContent>> | null = null
    if (variant === 'wrong_tenant') {
      await content.addCalendar(2, '2026-08-26', 1)
    } else {
      valid = await seedValidDeliveredContent(content)
      if (variant === 'pending') valid.entry.status = 'planned'
      if (variant === 'blocked') valid.entry.status = 'blocked'
      if (variant === 'stale_evidence') content.evidenceApprovalAt = '2025-01-01T00:00:00.000Z'
      if (variant === 'tampered_content') valid.draft.contentHash = 'c'.repeat(64)
    }
    let adapterCalled = false
    const result = await runManagedSiteAssistant(1, { projectId: line.project.project.id, question: '這筆內容可以回答嗎？' }, { async answer() { adapterCalled = true; return { status: 'blocked', answer: null, citations: [], knowledgeSnapshotHash: null, providerConfigured: false, externalCalls: false, limitation: 'should not be called' } } }, line.managed.repository, content.repository)
    expect(result.status).toBe('needs_authorization')
    expect(result.answer).toBeNull()
    expect(adapterCalled).toBe(false)
  })
})
