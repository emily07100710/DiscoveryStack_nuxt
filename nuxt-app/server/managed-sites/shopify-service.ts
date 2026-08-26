import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { normalizePublicHttpsOrigin } from '../content-operations/normalization'
import { assertPaidManagedSiteModuleEntitlement } from './module-authority'
import { getIntegrationRepository } from './modules-repository'
import { getManagedSiteRepository } from './repository'
import { getShopifyRepository } from './shopify-repository'
import { SHOPIFY_OAUTH_TTL_MS, SHOPIFY_WEBHOOK_MAX_BYTES, type ShopifyAuthorizationStartInput, type ShopifyOAuthExchangeAdapter, type ShopifyReadOnlyAdminAdapter, type ShopifyRepository, type ShopifyServiceRepositories, type ShopifyWebhookVerifier, type ShopifyWebhookVerificationRequest } from './shopify-types'
import type { ManagedSiteIntegration } from '../database/schema'
import type { IntegrationRepository } from './modules-types'
import type { ManagedSiteRepository } from './types'

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(`${label} is invalid.`)
  return value.trim()
}

function hashValue(value: string): string { return stableFingerprint({ value }) }
function payloadHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function normalizeShopifyShopDomain(value: unknown): string {
  const candidate = boundedString(value, 'Shopify shop domain', 253).toLowerCase().replace(/\.$/, '')
  if (candidate.includes('://') || candidate.includes('/') || candidate.includes('@') || candidate.includes(':') || candidate.includes('..')) invalid('Shopify shop domain must be a hostname without protocol, path, port, credentials, or wildcard.')
  const origin = normalizePublicHttpsOrigin(`https://${candidate}`)
  const hostname = new URL(origin).hostname.toLowerCase()
  if (hostname === 'shopify.com' || hostname === 'admin.shopify.com' || hostname.endsWith('.admin.shopify.com')) invalid('Shopify shop domain must identify a merchant shop, not a Shopify control-plane host.')
  return hostname
}

function normalizeRedirectUri(value: unknown): string {
  const candidate = boundedString(value, 'Shopify redirect URI', 2048)
  let url: URL
  try { url = new URL(candidate) } catch { invalid('Shopify redirect URI is invalid.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/managed-sites\/shopify\/callback$/u.test(url.pathname) || (url.port && url.port !== '443')) invalid('Shopify redirect URI must be the HTTPS callback path without credentials, query, fragment, or non-standard port.')
  const origin = normalizePublicHttpsOrigin(`${url.protocol}//${url.host}`)
  return `${origin}${url.pathname}`
}

function oauthCodeVerifier(): string { return randomBytes(32).toString('base64url') }
function pkceChallenge(verifier: string): string { return createHash('sha256').update(verifier, 'utf8').digest('base64url') }

export const FAIL_CLOSED_SHOPIFY_OAUTH_ADAPTER: ShopifyOAuthExchangeAdapter = {
  async exchange() { return { status: 'blocked', shopDomain: null, credentialReference: null, providerConfigured: false, externalCalls: false, limitation: 'Shopify credential exchange is disabled until a customer-authorized provider adapter is injected.' } },
}

export const FAIL_CLOSED_SHOPIFY_WEBHOOK_VERIFIER: ShopifyWebhookVerifier = {
  async verify() { return false },
}

export const FAIL_CLOSED_SHOPIFY_ADMIN_ADAPTER: ShopifyReadOnlyAdminAdapter = {
  async readCatalog() { return { status: 'blocked', products: [], collections: [], externalCalls: false, limitation: 'Shopify Admin read-only sync is disabled until a customer-authorized provider adapter is injected.' } },
}

function integrationShopDomain(integration: ManagedSiteIntegration): string {
  const config = integration.redactedConfig && typeof integration.redactedConfig === 'object' && !Array.isArray(integration.redactedConfig) ? integration.redactedConfig as Record<string, unknown> : {}
  return normalizeShopifyShopDomain(config.shopDomain)
}

function ensureIntegration(ownerUserId: number, projectId: number, integrationId: number, integrations: IntegrationRepository): Promise<ManagedSiteIntegration> {
  return integrations.findById(integrationId).then(integration => {
    if (!integration || integration.ownerUserId !== ownerUserId || integration.projectId !== projectId || integration.moduleKey !== 'shopify_commerce') notFound('Shopify integration was not found.')
    return integration
  })
}

export async function startShopifyAuthorization(input: ShopifyAuthorizationStartInput, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date(), shopifyClientId: string | null = null) {
  const authority = await assertPaidManagedSiteModuleEntitlement(input.ownerUserId, input.projectId, 'shopify_commerce', managedRepository)
  const integration = await ensureIntegration(input.ownerUserId, input.projectId, input.integrationId, repositories.integrations)
  const shopDomain = normalizeShopifyShopDomain(input.shopDomain)
  if (integrationShopDomain(integration) !== shopDomain) conflict('Shopify authorization shop identity does not match the integration intent.')
  const redirectUri = normalizeRedirectUri(input.redirectUri)
  const idempotencyKey = boundedString(input.idempotencyKey, 'Shopify authorization idempotency key', 128)
  const createdAt = clock()
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) invalid('Shopify authorization clock is invalid.')
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = oauthCodeVerifier()
  const authorization = await repositories.shopify.transaction(transaction => transaction.insertAuthorization({ ownerUserId: input.ownerUserId, projectId: input.projectId, integrationId: integration.id, stateHash: hashValue(state), nonceHash: hashValue(nonce), codeVerifierHash: hashValue(verifier), shopDomain, redirectUri, status: 'pending', expiresAt: new Date(createdAt.getTime() + SHOPIFY_OAUTH_TTL_MS), consumedAt: null } as any))
  const scopes = Array.isArray(integration.requiredScopes) ? integration.requiredScopes.filter((scope): scope is string => typeof scope === 'string') : []
  const authorizationUrl = shopifyClientId ? `https://${shopDomain}/admin/oauth/authorize?client_id=${encodeURIComponent(shopifyClientId)}&scope=${encodeURIComponent(scopes.join(','))}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}&code_challenge=${encodeURIComponent(pkceChallenge(verifier))}&code_challenge_method=S256` : null
  return { authorization, state, nonce, codeVerifier: verifier, codeChallenge: pkceChallenge(verifier), authorizationUrl, providerConfigured: false, externalCalls: false, projectId: authority.project.id, limitation: shopifyClientId ? 'Authorization URL is a customer navigation intent; no Shopify request was executed.' : 'Shopify client configuration is missing; customer authorization URL is withheld.' }
}

export async function completeShopifyAuthorization(input: { state: string; code: string; nonce: string; codeVerifier: string; shopDomain: string; redirectUri?: string }, adapter: ShopifyOAuthExchangeAdapter = FAIL_CLOSED_SHOPIFY_OAUTH_ADAPTER, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const state = boundedString(input.state, 'Shopify OAuth state', 256)
  const code = boundedString(input.code, 'Shopify OAuth code', 2048)
  const nonce = boundedString(input.nonce, 'Shopify OAuth nonce', 256)
  const codeVerifier = boundedString(input.codeVerifier, 'Shopify OAuth code verifier', 256)
  const requestedShopDomain = normalizeShopifyShopDomain(input.shopDomain)
  const pending = await repositories.shopify.findAuthorizationByStateHash(hashValue(state))
  if (!pending || pending.status !== 'pending' || pending.expiresAt.getTime() <= clock().getTime()) conflict('Shopify OAuth state is expired, revoked, or already consumed.')
  if (pending.shopDomain !== requestedShopDomain || (input.redirectUri !== undefined && normalizeRedirectUri(input.redirectUri) !== pending.redirectUri) || !constantTimeEqual(pending.nonceHash, hashValue(nonce)) || !constantTimeEqual(pending.codeVerifierHash, hashValue(codeVerifier))) conflict('Shopify OAuth state, nonce, PKCE verifier, redirect URI, or shop identity does not match.')
  const claimed = await repositories.shopify.transaction(transaction => transaction.claimAuthorization(hashValue(state), clock()))
  if (!claimed) conflict('Shopify OAuth state was already consumed or is no longer valid.')
  const integration = await ensureIntegration(pending.ownerUserId, pending.projectId, pending.integrationId, repositories.integrations)
  if (integration.status !== 'awaiting_authorization') conflict('Shopify integration is not awaiting authorization.')
  await assertPaidManagedSiteModuleEntitlement(pending.ownerUserId, pending.projectId, 'shopify_commerce', managedRepository)
  const result = await adapter.exchange({ code, codeVerifier, redirectUri: pending.redirectUri, shopDomain: pending.shopDomain, nonce })
  if (result.externalCalls !== false || result.providerConfigured !== false || result.status !== 'authorized' || !result.credentialReference || result.credentialReference.length > 256 || !/^vault:[A-Za-z0-9._:-]+$/u.test(result.credentialReference)) {
    await repositories.integrations.update(integration.id, { status: 'blocked', externalReference: null, updatedAt: clock() } as any)
    return { status: 'blocked' as const, integration: await repositories.integrations.findById(integration.id), shopDomain: pending.shopDomain, providerConfigured: false, externalCalls: false, limitation: result.limitation || 'Shopify authorization did not produce an accepted opaque credential reference.' }
  }
  if (result.shopDomain !== pending.shopDomain) conflict('Shopify OAuth provider response belongs to a different shop.')
  const updated = await repositories.integrations.update(integration.id, { status: 'mock_verified', externalReference: result.credentialReference, redactedConfig: { shopDomain: pending.shopDomain, storefrontMode: 'storefront_api', checkoutMode: 'shopify_hosted', adminMode: 'admin_graphql_api' }, updatedAt: clock() } as any)
  return { status: 'authorized' as const, integration: updated, shopDomain: pending.shopDomain, providerConfigured: false, externalCalls: false, limitation: 'Authorization was accepted only as an injected mock contract; no production Shopify token or API call was persisted.' }
}

export function validateShopifyStorefrontUrl(shopDomainInput: unknown, candidate: unknown, kind: 'product' | 'collection' | 'cart' | 'checkout'): string {
  const shopDomain = normalizeShopifyShopDomain(shopDomainInput)
  const value = boundedString(candidate, 'Shopify Storefront URL', 2048)
  let url: URL
  try { url = new URL(value) } catch { invalid('Shopify Storefront URL is invalid.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || url.hostname.toLowerCase() !== shopDomain) invalid('Shopify Storefront URL must remain on the normalized merchant shop origin without credentials, query, fragment, or non-standard port.')
  const path = url.pathname.replace(/\/$/u, '')
  const valid = kind === 'product' ? /^\/products\/[a-z0-9][a-z0-9-]*$/u.test(path) : kind === 'collection' ? /^\/collections(?:\/[a-z0-9][a-z0-9-]*)?$/u.test(path) : kind === 'cart' ? path === '/cart' : /^\/(?:checkouts?|account\/login)$/u.test(path)
  if (!valid) invalid('Shopify Storefront URL path does not match the requested contract.')
  return `https://${shopDomain}${path || '/'}`
}

export async function readShopifyCatalog(ownerUserId: number, projectId: number, integrationId: number, adapter: ShopifyReadOnlyAdminAdapter = FAIL_CLOSED_SHOPIFY_ADMIN_ADAPTER, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository()) {
  await assertPaidManagedSiteModuleEntitlement(ownerUserId, projectId, 'shopify_commerce', managedRepository)
  const integration = await ensureIntegration(ownerUserId, projectId, integrationId, repositories.integrations)
  if (!['active', 'mock_verified'].includes(integration.status) || !integration.externalReference || !/^vault:[A-Za-z0-9._:-]+$/u.test(integration.externalReference)) conflict('Shopify Admin read-only sync requires an accepted opaque credential reference.')
  const shopDomain = integrationShopDomain(integration)
  const result = await adapter.readCatalog({ shopDomain, credentialReference: integration.externalReference })
  if (result.externalCalls !== false || result.status !== 'read' || !Array.isArray(result.products) || !Array.isArray(result.collections) || result.products.length > 1000 || result.collections.length > 1000) conflict('Shopify Admin read-only sync returned an unsafe or incomplete result.')
  return { status: 'read' as const, shopDomain, products: result.products, collections: result.collections, writes: false, externalCalls: false, providerConfigured: false, limitation: 'Read-only catalog data came from an injected mock contract; no Shopify write, order, payment, or checkout mutation was executed.' }
}

export async function handleShopifyWebhook(ownerUserId: number, projectId: number, integrationId: number, request: ShopifyWebhookVerificationRequest, verifier: ShopifyWebhookVerifier = FAIL_CLOSED_SHOPIFY_WEBHOOK_VERIFIER, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  await assertPaidManagedSiteModuleEntitlement(ownerUserId, projectId, 'shopify_commerce', managedRepository)
  const integration = await ensureIntegration(ownerUserId, projectId, integrationId, repositories.integrations)
  if (!['active', 'mock_verified'].includes(integration.status)) conflict('Shopify webhook integration is not active.')
  const shopDomain = normalizeShopifyShopDomain(request.shopDomain)
  if (integrationShopDomain(integration) !== shopDomain) conflict('Shopify webhook shop identity does not match the integration.')
  const webhookId = boundedString(request.webhookId, 'Shopify webhook id', 160)
  const topic = boundedString(request.topic, 'Shopify webhook topic', 160)
  const rawBody = boundedString(request.rawBody, 'Shopify webhook body', SHOPIFY_WEBHOOK_MAX_BYTES)
  const signature = boundedString(request.signature, 'Shopify webhook signature', 512)
  const verified = await verifier.verify({ shopDomain, webhookId, topic, rawBody, signature })
  if (verified !== true) conflict('Shopify webhook signature was not verified by the server-owned verifier.')
  const hash = payloadHash(rawBody)
  const signatureHash = hashValue(signature)
  const fingerprint = stableFingerprint({ ownerUserId, projectId, integrationId, shopDomain, webhookId, topic, payloadHash: hash })
  const existingEvent = await repositories.shopify.findWebhookByIntegrationEvent(integrationId, webhookId)
  if (existingEvent) {
    if (existingEvent.payloadHash !== hash || existingEvent.topic !== topic || existingEvent.shopDomain !== shopDomain || existingEvent.signatureHash !== signatureHash) conflict('Shopify webhook id collided with a different payload or shop identity.')
    return { status: 'replayed' as const, replayed: true, webhook: existingEvent, integration, externalCalls: false, writes: false, limitation: 'Verified Shopify webhook was already recorded; no duplicate downstream action was executed.' }
  }
  const collision = await repositories.shopify.findWebhookByFingerprint(ownerUserId, fingerprint)
  if (collision) return { status: 'replayed' as const, replayed: true, webhook: collision, integration, externalCalls: false, writes: false, limitation: 'Verified Shopify webhook fingerprint was already recorded.' }
  const webhook = await repositories.shopify.transaction(transaction => transaction.insertWebhook({ ownerUserId, projectId, integrationId, shopDomain, webhookId, topic, payloadHash: hash, signatureHash, status: 'accepted', eventFingerprint: fingerprint } as any))
  const updatedIntegration = topic === 'app/uninstalled' ? await repositories.integrations.update(integration.id, { status: 'revoked', externalReference: null, updatedAt: clock() } as any) : integration
  return { status: 'accepted' as const, replayed: false, webhook, integration: updatedIntegration, externalCalls: false, writes: topic === 'app/uninstalled', limitation: topic === 'app/uninstalled' ? 'Uninstall webhook revoked the integration reference only; no Shopify API call was made.' : 'Verified webhook was recorded as an intent-only event; no Shopify write was executed.' }
}

export async function revokeShopifyIntegration(ownerUserId: number, projectId: number, integrationId: number, integrations: IntegrationRepository = getIntegrationRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository()) {
  await assertPaidManagedSiteModuleEntitlement(ownerUserId, projectId, 'shopify_commerce', managedRepository)
  const integration = await ensureIntegration(ownerUserId, projectId, integrationId, integrations)
  const updated = await integrations.update(integration.id, { status: 'revoked', externalReference: null, updatedAt: new Date() } as any)
  return { integration: updated, revoked: true, externalCalls: false, writes: false, limitation: 'Shopify integration was locally revoked; no Shopify API request was executed.' }
}
