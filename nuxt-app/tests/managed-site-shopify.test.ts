import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createManagedSitePreview, createManagedSiteQuote, createManagedSiteDraftOrder, createManagedSiteLeadIntent } from '../server/managed-sites/ordering-service'
import { processManagedSitePaymentAndConversion } from '../server/managed-sites/conversion-service'
import { createShopifyIntegrationIntent } from '../server/managed-sites/modules-service'
import { canonicalizeShopifyOAuthQuery, completeShopifyAuthorization, createShopifyOAuthCallbackVerifier, handleShopifyWebhook, normalizeShopifyShopDomain, readShopifyCatalog, revokeShopifyIntegration, startShopifyAuthorization, validateShopifyStorefrontUrl } from '../server/managed-sites/shopify-service'
import type { PaymentEventVerifier } from '../server/managed-sites/ordering-types'
import type { ShopifyOAuthExchangeAdapter, ShopifyReadOnlyAdminAdapter, ShopifyWebhookVerifier } from '../server/managed-sites/shopify-types'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createInjectedManagedSiteCheckoutAuthorityResolver, createOrderingMemoryRepository } from './fixtures/managed-site/ordering-repository'
import { createIntegrationMemoryRepository, createShopifyMemoryRepository } from './fixtures/managed-site/modules-repository'

const mockPaymentVerifier: PaymentEventVerifier = { verify: async () => true }
const SHOPIFY_TEST_SECRET = 'shopify-test-shared-secret'
const CALLBACK_REDIRECT_URI = 'https://discovery.acme.taipei/api/managed-sites/shopify/callback'

function signedCallback(start: { state: string }, options: { shopDomain?: string; timestamp?: string; code?: string; extra?: string; hmac?: string } = {}) {
  const shopDomain = options.shopDomain || 'merchant.myshopify.com'
  const timestamp = options.timestamp || String(Math.floor(new Date('2026-08-27T00:01:00.000Z').getTime() / 1000))
  const code = options.code || 'mock-code'
  const unsignedQuery = `shop=${encodeURIComponent(shopDomain)}&timestamp=${encodeURIComponent(timestamp)}&code=${encodeURIComponent(code)}&extra=${encodeURIComponent(options.extra || 'hello world')}&state=${encodeURIComponent(start.state)}`
  const hmac = options.hmac || createHmac('sha256', SHOPIFY_TEST_SECRET).update(canonicalizeShopifyOAuthQuery(unsignedQuery), 'utf8').digest('hex')
  return { state: start.state, code, hmac, shopDomain, timestamp, redirectUri: CALLBACK_REDIRECT_URI, rawQuery: `${unsignedQuery}&hmac=${hmac}`, stateCookie: start.state }
}

async function makeProject() {
  const managed = createManagedSiteMemoryRepository()
  const ordering = createOrderingMemoryRepository()
  const integrations = createIntegrationMemoryRepository()
  const shopify = createShopifyMemoryRepository()
  const preview = await createManagedSitePreview(1, { draftIdentity: 'shopify-contract-preview-001', brandName: 'Shopify Contract Client', audience: 'Taiwan shoppers', brief: 'A governed commerce website.', businessGoals: ['sell_online'], siteType: 'simple_commerce', selectedModules: ['managed_content_admin', 'shopify_commerce', 'geo_content_subscription'], styleReferences: [] }, ordering.repository)
  const quote = await createManagedSiteQuote({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, planKey: 'business', cadenceDays: 7, domainOption: 'new', idempotencyKey: 'shopify-contract-quote-001' }, ordering.repository)
  const lead = await createManagedSiteLeadIntent({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, name: 'Shopify Owner', email: 'shopify-owner@acme.taipei', company: 'Shopify Contract Client', website: 'https://shopify-contract.acme.taipei', privacyConsent: true, recontactConsent: false, idempotencyKey: 'shopify-contract-lead-001' }, ordering.repository)
  const order = await createManagedSiteDraftOrder({ previewId: preview.preview.id, previewAccessToken: preview.accessToken!, quoteId: quote.quote.quoteId, leadIntentId: lead.leadIntent.id, idempotencyKey: 'shopify-contract-order-001' }, ordering.repository)
  const conversion = await processManagedSitePaymentAndConversion({ draftOrderId: order.order.id, providerKey: 'mock-payment', eventId: 'shopify-contract-payment-001', providerReference: 'shopify-contract-payment-ref-001', eventType: 'payment_succeeded', amountMinor: quote.quote.totalMinor, currency: quote.quote.currency, canonicalPayloadHash: 'f'.repeat(64), idempotencyKey: 'shopify-contract-conversion-001' }, mockPaymentVerifier, { ordering: ordering.repository, managed: managed.repository }, createInjectedManagedSiteCheckoutAuthorityResolver(1))
  const integration = await createShopifyIntegrationIntent(1, { projectId: conversion.project.id, moduleKey: 'shopify_commerce', redactedConfig: { shopDomain: 'merchant.myshopify.com', storefrontToken: 'must-not-persist', adminApiKey: 'must-not-persist' }, idempotencyKey: 'shopify-contract-intent-001' }, integrations.repository, managed.repository)
  return { managed, ordering, integrations, shopify, project: conversion.project, integration: integration.integration }
}

describe('managed site Shopify contract', () => {
  it('creates hashed single-use OAuth state and verifies the official authorization-code callback contract', async () => {
    const line = await makeProject()
    const start = await startShopifyAuthorization({ ownerUserId: 1, projectId: line.project.id, integrationId: line.integration.id, shopDomain: 'merchant.myshopify.com', redirectUri: CALLBACK_REDIRECT_URI, idempotencyKey: 'shopify-oauth-start-001' }, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:00:00.000Z'), 'shopify-client-id')
    const authorizationUrl = new URL(start.authorizationUrl!)
    expect([...authorizationUrl.searchParams.keys()].sort()).toEqual(['client_id', 'redirect_uri', 'scope', 'state'])
    expect(authorizationUrl.searchParams.get('state')).toBe(start.state)
    expect(line.shopify.state.authorizations[0]?.stateHash).not.toBe(start.state)
    expect(line.shopify.state.authorizations[0]?.nonceHash).toBeNull()
    expect(line.shopify.state.authorizations[0]?.codeVerifierHash).toBeNull()
    const adapter: ShopifyOAuthExchangeAdapter = { exchange: async input => ({ status: 'authorized', shopDomain: input.shopDomain, credentialReference: 'vault:shopify-credential-001', providerConfigured: false, externalCalls: false, limitation: 'Injected mock only.' }) }
    const invalidVerifier = { verify: async () => false }
    await expect(completeShopifyAuthorization(signedCallback(start, { shopDomain: 'other.myshopify.com' }), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), invalidVerifier)).rejects.toMatchObject({ statusCode: 409 })
    expect(line.shopify.state.authorizations[0]?.status).toBe('pending')
    const completed = await completeShopifyAuthorization(signedCallback(start), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))
    expect(completed.status).toBe('authorized')
    expect(completed.integration?.status).toBe('mock_verified')
    expect(completed.integration?.externalReference).toBe('vault:shopify-credential-001')
    expect(line.shopify.state.authorizations[0]?.status).toBe('consumed')
    await expect(completeShopifyAuthorization(signedCallback(start), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:02:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('does not consume pending state on invalid HMAC, verifier throw/reject, cookie, timestamp, redirect, or shop mismatch', async () => {
    const line = await makeProject()
    const start = await startShopifyAuthorization({ ownerUserId: 1, projectId: line.project.id, integrationId: line.integration.id, shopDomain: 'merchant.myshopify.com', redirectUri: CALLBACK_REDIRECT_URI, idempotencyKey: 'shopify-adversarial-start-001' }, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:00:00.000Z'), 'shopify-client-id')
    const adapterCalls: string[] = []
    const adapter: ShopifyOAuthExchangeAdapter = { exchange: async input => { adapterCalls.push(input.code); return { status: 'authorized', shopDomain: input.shopDomain, credentialReference: 'vault:shopify-adversarial-001', providerConfigured: false, externalCalls: false, limitation: 'Injected mock only.' } } }
    const rejectVerifier = { verify: async () => false }
    const badHmac = signedCallback(start, { hmac: '0'.repeat(64) })
    await expect(completeShopifyAuthorization(badHmac, adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
    expect(line.shopify.state.authorizations[0]?.status).toBe('pending')
    const tampered = signedCallback(start)
    tampered.rawQuery = tampered.rawQuery.replace('hello%20world', 'tampered')
    await expect(completeShopifyAuthorization(tampered, adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
    expect(line.shopify.state.authorizations[0]?.status).toBe('pending')
    await expect(completeShopifyAuthorization(signedCallback(start), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), rejectVerifier)).rejects.toMatchObject({ statusCode: 409 })
    expect(line.shopify.state.authorizations[0]?.status).toBe('pending')
    await expect(completeShopifyAuthorization(signedCallback(start), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), { verify: async () => { throw new Error('synthetic verifier failure') } })).rejects.toMatchObject({ statusCode: 409 })
    expect(line.shopify.state.authorizations[0]?.status).toBe('pending')
    await expect(completeShopifyAuthorization({ ...signedCallback(start), stateCookie: 'different-state' }, adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
    await expect(completeShopifyAuthorization({ ...signedCallback(start), redirectUri: 'https://different.acme.taipei/api/managed-sites/shopify/callback' }, adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
    await expect(completeShopifyAuthorization(signedCallback(start, { timestamp: String(Math.floor(new Date('2026-08-27T00:30:00.000Z').getTime() / 1000)) }), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:30:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
    await expect(completeShopifyAuthorization(signedCallback(start, { shopDomain: 'other.myshopify.com' }), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))).rejects.toMatchObject({ statusCode: 409 })
    expect(line.shopify.state.authorizations[0]?.status).toBe('pending')
    expect(adapterCalls).toHaveLength(0)
  })

  it('rejects unsafe shop identity and validates Storefront product, collection, cart, and checkout URLs', () => {
    expect(normalizeShopifyShopDomain('Merchant.myshopify.com.')).toBe('merchant.myshopify.com')
    expect(() => normalizeShopifyShopDomain('https://merchant.myshopify.com')).toThrow()
    expect(() => normalizeShopifyShopDomain('admin.shopify.com')).toThrow()
    expect(validateShopifyStorefrontUrl('merchant.myshopify.com', 'https://merchant.myshopify.com/products/red-shirt', 'product')).toBe('https://merchant.myshopify.com/products/red-shirt')
    expect(validateShopifyStorefrontUrl('merchant.myshopify.com', 'https://merchant.myshopify.com/collections/sale', 'collection')).toBe('https://merchant.myshopify.com/collections/sale')
    expect(validateShopifyStorefrontUrl('merchant.myshopify.com', 'https://merchant.myshopify.com/cart', 'cart')).toBe('https://merchant.myshopify.com/cart')
    expect(validateShopifyStorefrontUrl('merchant.myshopify.com', 'https://merchant.myshopify.com/checkout', 'checkout')).toBe('https://merchant.myshopify.com/checkout')
    expect(() => validateShopifyStorefrontUrl('merchant.myshopify.com', 'https://other.myshopify.com/cart', 'cart')).toThrow()
    expect(() => validateShopifyStorefrontUrl('merchant.myshopify.com', 'javascript:alert(1)', 'checkout')).toThrow()
  })

  it('keeps Admin sync read-only and only accepts bounded injected catalog data', async () => {
    const line = await makeProject()
    const start = await startShopifyAuthorization({ ownerUserId: 1, projectId: line.project.id, integrationId: line.integration.id, shopDomain: 'merchant.myshopify.com', redirectUri: CALLBACK_REDIRECT_URI, idempotencyKey: 'shopify-admin-start-001' }, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:00:00.000Z'), null)
    const adapter: ShopifyOAuthExchangeAdapter = { exchange: async input => ({ status: 'authorized', shopDomain: input.shopDomain, credentialReference: 'vault:shopify-admin-001', providerConfigured: false, externalCalls: false, limitation: 'Injected mock only.' }) }
    await completeShopifyAuthorization(signedCallback(start), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))
    const admin: ShopifyReadOnlyAdminAdapter = { readCatalog: async input => ({ status: 'read', products: [{ handle: 'red-shirt' }], collections: [{ handle: 'sale' }], externalCalls: false, limitation: `mock ${input.shopDomain}` }) }
    const result = await readShopifyCatalog(1, line.project.id, line.integration.id, admin, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository)
    expect(result.products).toHaveLength(1)
    expect(result.collections).toHaveLength(1)
    expect(result.writes).toBe(false)
    expect(result.externalCalls).toBe(false)
  })

  it('verifies webhook through injected verifier, replays exact events, rejects collisions, and revokes on uninstall', async () => {
    const line = await makeProject()
    const start = await startShopifyAuthorization({ ownerUserId: 1, projectId: line.project.id, integrationId: line.integration.id, shopDomain: 'merchant.myshopify.com', redirectUri: CALLBACK_REDIRECT_URI, idempotencyKey: 'shopify-webhook-start-001' }, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:00:00.000Z'))
    const adapter: ShopifyOAuthExchangeAdapter = { exchange: async input => ({ status: 'authorized', shopDomain: input.shopDomain, credentialReference: 'vault:shopify-webhook-001', providerConfigured: false, externalCalls: false, limitation: 'Injected mock only.' }) }
    await completeShopifyAuthorization(signedCallback(start), adapter, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository, () => new Date('2026-08-27T00:01:00.000Z'), createShopifyOAuthCallbackVerifier(SHOPIFY_TEST_SECRET))
    const verifier: ShopifyWebhookVerifier = { verify: async input => input.signature === 'mock-valid-signature' }
    const request = { shopDomain: 'merchant.myshopify.com', webhookId: 'webhook-001', topic: 'products/update', rawBody: '{"id":1}', signature: 'mock-valid-signature' }
    const accepted = await handleShopifyWebhook(1, line.project.id, line.integration.id, request, verifier, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository)
    expect(accepted.status).toBe('accepted')
    const replayed = await handleShopifyWebhook(1, line.project.id, line.integration.id, request, verifier, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository)
    expect(replayed.replayed).toBe(true)
    await expect(handleShopifyWebhook(1, line.project.id, line.integration.id, { ...request, rawBody: '{"id":2}' }, verifier, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository)).rejects.toMatchObject({ statusCode: 409 })
    const uninstalled = await handleShopifyWebhook(1, line.project.id, line.integration.id, { shopDomain: request.shopDomain, webhookId: 'webhook-uninstall-001', topic: 'app/uninstalled', rawBody: '{}', signature: 'mock-valid-signature' }, verifier, { integrations: line.integrations.repository, shopify: line.shopify.repository }, line.managed.repository)
    expect(uninstalled.integration?.status).toBe('revoked')
    expect(uninstalled.integration?.externalReference).toBeNull()
  })

  it('locally revokes an integration without external calls or raw credentials', async () => {
    const line = await makeProject()
    const revoked = await revokeShopifyIntegration(1, line.project.id, line.integration.id, line.integrations.repository, line.managed.repository)
    expect(revoked.revoked).toBe(true)
    expect(revoked.externalCalls).toBe(false)
    expect(revoked.integration?.externalReference).toBeNull()
  })
})

