import { describe, expect, it } from 'vitest'
import { createManagedSiteProject } from '../server/managed-sites/service'
import { createManagedSiteIntegrationIntent, createShopifyIntegrationIntent, getCanonicalGeoReuseContract, getManagedSiteModuleWorkspace, linkManagedSiteContentOperations, runManagedSiteAssistant } from '../server/managed-sites/modules-service'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createIntegrationMemoryRepository } from './fixtures/managed-site/modules-repository'
import { ContentOperationsFixture } from './fixtures/content-operations/repository'

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const, principal: 'owner@example.test' }

async function makeProject() {
  const managed = createManagedSiteMemoryRepository()
  const project = await createManagedSiteProject(1, actor, { canonicalClientIdentity: 'modules-client', canonicalWebsiteIdentity: 'https://modules.example.test', siteType: 'simple_commerce', idempotencyKey: 'modules-project-1' }, managed.repository)
  return { managed, project }
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
    const linked = await linkManagedSiteContentOperations(1, line.project.project.id, { displayName: 'Modules Site', canonicalSiteOrigin: 'https://modules.example.test', framework: 'astro', publicationTransport: 'first_party_git', timeZone: 'Asia/Taipei', defaultCadenceDays: 7, defaultPublishLocalTime: '09:00', monthlyBudgetUnits: 100, idempotencyKey: 'content-link-1' }, line.managed.repository, content.repository)
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
    const blocked = await runManagedSiteAssistant(1, { projectId: line.project.project.id, question: '如何預約？' }, undefined, line.managed.repository)
    expect(blocked.status).toBe('blocked')
    expect(blocked.answer).toBeNull()
    expect(blocked.externalCalls).toBe(false)
    const answered = await runManagedSiteAssistant(1, { projectId: line.project.project.id, question: '如何預約？', contextKeys: ['booking-page'] }, { async answer(input) { return { status: 'answered', answer: `依據 ${input.contextKeys[0]}，請透過預約頁提交需求。`, citations: ['booking-page'], providerConfigured: true, externalCalls: false, limitation: null } } }, line.managed.repository)
    expect(answered.status).toBe('answered')
    expect(answered.citations).toEqual(['booking-page'])
    await expect(runManagedSiteAssistant(1, { projectId: line.project.project.id, question: 'unsafe' }, { async answer() { return { status: 'answered', answer: '<script>alert(1)</script>', citations: [], providerConfigured: true, externalCalls: false, limitation: null } } }, line.managed.repository)).rejects.toMatchObject({ statusCode: 422 })
  })
})
