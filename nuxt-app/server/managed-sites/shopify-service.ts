import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../seo-geo-core/repository'
import { normalizePublicHttpsOrigin } from '../content-operations/normalization'
import { assertPaidManagedSiteModuleEntitlement } from './module-authority'
import { getIntegrationRepository } from './modules-repository'
import { getManagedSiteRepository } from './repository'
import { getShopifyRepository } from './shopify-repository'
import { SHOPIFY_OAUTH_TTL_MS, SHOPIFY_WEBHOOK_MAX_BYTES, type ShopifyAuthorizationStartInput, type ShopifyOAuthCallbackVerifier, type ShopifyOAuthExchangeAdapter, type ShopifyOAuthCallbackVerificationInput, type ShopifyReadOnlyAdminAdapter, type ShopifyServiceRepositories, type ShopifyWebhookEventInput, type ShopifyWebhookVerifier, type ShopifyWebhookVerificationRequest } from './shopify-types'
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
function rawWebhookBody(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > SHOPIFY_WEBHOOK_MAX_BYTES) invalid('Shopify webhook body is invalid.')
  return value
}
function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function decodeQueryComponent(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/gu, ' ')) } catch { invalid('Shopify OAuth callback query is malformed.') }
}

type ShopifyOAuthQueryPair = { key: string; value: string }

function parseShopifyOAuthQuery(rawQuery: string): ShopifyOAuthQueryPair[] {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery
  if (query.length > 8192) invalid('Shopify OAuth callback query is too large.')
  return query ? query.split('&').filter(Boolean).map(part => {
    const separator = part.indexOf('=')
    const rawKey = separator < 0 ? part : part.slice(0, separator)
    const rawValue = separator < 0 ? '' : part.slice(separator + 1)
    return { key: decodeQueryComponent(rawKey), value: decodeQueryComponent(rawValue) }
  }) : []
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactShopifyOAuthQueryValue(pairs: ShopifyOAuthQueryPair[], key: string): string {
  const matches = pairs.filter(pair => pair.key === key)
  if (matches.length !== 1 || !matches[0]!.value) invalid(`Shopify OAuth ${key} is missing or ambiguous.`)
  return matches[0]!.value
}

/** Shopify signs the decoded callback query with hmac excluded and parameters sorted. */
export function canonicalizeShopifyOAuthQuery(rawQuery: string): string {
  return parseShopifyOAuthQuery(rawQuery)
    .filter(pair => pair.key !== 'hmac')
    .sort((left, right) => codeUnitCompare(left.key, right.key) || codeUnitCompare(left.value, right.value))
    .map(pair => `${pair.key}=${pair.value}`)
    .join('&')
}

function callbackHmac(secret: string, canonicalQuery: string): string {
  return createHmac('sha256', secret).update(canonicalQuery, 'utf8').digest('hex')
}

export function normalizeShopifyShopDomain(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 253 || value !== value.trim()) invalid('Shopify shop domain must be one lowercase merchant label under myshopify.com.')
  const candidate = value
  const merchantLabel = candidate.split('.')[0] || ''
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(candidate) || merchantLabel.endsWith('-') || candidate.split('.').length !== 3) invalid('Shopify shop domain must be one lowercase merchant label under myshopify.com.')
  return candidate
}

function normalizeRedirectUri(value: unknown): string {
  const candidate = boundedString(value, 'Shopify redirect URI', 2048)
  let url: URL
  try { url = new URL(candidate) } catch { invalid('Shopify redirect URI is invalid.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/managed-sites\/shopify\/callback$/u.test(url.pathname) || (url.port && url.port !== '443')) invalid('Shopify redirect URI must be the HTTPS callback path without credentials, query, fragment, or non-standard port.')
  const origin = normalizePublicHttpsOrigin(`${url.protocol}//${url.host}`)
  return `${origin}${url.pathname}`
}

export const FAIL_CLOSED_SHOPIFY_OAUTH_ADAPTER: ShopifyOAuthExchangeAdapter = {
  async exchange() { return { status: 'blocked', shopDomain: null, credentialReference: null, providerConfigured: false, externalCalls: false, limitation: 'Shopify credential exchange is disabled until a customer-authorized provider adapter is injected.' } },
}

export const FAIL_CLOSED_SHOPIFY_OAUTH_CALLBACK_VERIFIER: ShopifyOAuthCallbackVerifier = {
  async verify() { return false },
}

export function createShopifyOAuthCallbackVerifier(sharedSecret: string | null | undefined): ShopifyOAuthCallbackVerifier {
  if (typeof sharedSecret !== 'string' || !sharedSecret.trim()) return FAIL_CLOSED_SHOPIFY_OAUTH_CALLBACK_VERIFIER
  const secret = sharedSecret.trim()
  return {
    async verify(input: ShopifyOAuthCallbackVerificationInput) {
      if (canonicalizeShopifyOAuthQuery(input.rawQuery) !== input.canonicalQuery) return false
      const expected = callbackHmac(secret, input.canonicalQuery)
      return constantTimeEqual(expected, input.hmac)
    },
  }
}

export const FAIL_CLOSED_SHOPIFY_WEBHOOK_VERIFIER: ShopifyWebhookVerifier = {
  async verify() { return false },
}

export function createShopifyWebhookVerifier(sharedSecret: string | null | undefined): ShopifyWebhookVerifier {
  if (typeof sharedSecret !== 'string' || !sharedSecret.trim()) return FAIL_CLOSED_SHOPIFY_WEBHOOK_VERIFIER
  const secret = sharedSecret.trim()
  return {
    async verify(input: ShopifyWebhookVerificationRequest) {
      if (typeof input.rawBody !== 'string' || typeof input.signature !== 'string' || input.signature.length > 128) return false
      const expected = createHmac('sha256', secret).update(input.rawBody, 'utf8').digest('base64')
      return constantTimeEqual(expected, input.signature)
    },
  }
}

export const FAIL_CLOSED_SHOPIFY_ADMIN_ADAPTER: ShopifyReadOnlyAdminAdapter = {
  async readCatalog() { return { status: 'blocked', products: [], collections: [], externalCalls: false, limitation: 'Shopify Admin read-only sync is disabled until a customer-authorized provider adapter is injected.' } },
}

async function verifyShopifyWebhookSignature(rawBody: string, signature: string, verifier: ShopifyWebhookVerifier): Promise<void> {
  let verified: unknown
  try {
    verified = await verifier.verify({ rawBody, signature })
  } catch {
    conflict('Shopify webhook signature could not be verified.')
  }
  if (verified !== true) conflict('Shopify webhook signature could not be verified.')
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
  const authorization = await repositories.shopify.transaction(transaction => transaction.insertAuthorization({ ownerUserId: input.ownerUserId, projectId: input.projectId, integrationId: integration.id, stateHash: hashValue(state), nonceHash: null, codeVerifierHash: null, shopDomain, redirectUri, status: 'pending', expiresAt: new Date(createdAt.getTime() + SHOPIFY_OAUTH_TTL_MS), consumedAt: null }))
  const scopes = Array.isArray(integration.requiredScopes) ? integration.requiredScopes.filter((scope): scope is string => typeof scope === 'string') : []
  let authorizationUrl: string | null = null
  if (typeof shopifyClientId === 'string' && shopifyClientId.trim()) {
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`)
    url.searchParams.set('client_id', shopifyClientId.trim())
    url.searchParams.set('scope', scopes.join(','))
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    authorizationUrl = url.toString()
  }
  return { authorization, state, authorizationUrl, providerConfigured: false, externalCalls: false, projectId: authority.project.id, limitation: authorizationUrl ? 'Authorization URL is a customer navigation intent; no Shopify request was executed.' : 'Shopify client configuration is missing; customer authorization URL is withheld.' }
}

export async function completeShopifyAuthorization(input: { rawQuery: string; redirectUri: string; stateCookie?: string }, adapter: ShopifyOAuthExchangeAdapter = FAIL_CLOSED_SHOPIFY_OAUTH_ADAPTER, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date(), callbackVerifier: ShopifyOAuthCallbackVerifier = FAIL_CLOSED_SHOPIFY_OAUTH_CALLBACK_VERIFIER) {
  const pairs = parseShopifyOAuthQuery(input.rawQuery)
  const hmac = exactShopifyOAuthQueryValue(pairs, 'hmac')
  if (!/^[a-f0-9]{64}$/iu.test(hmac)) invalid('Shopify OAuth HMAC is invalid.')
  const canonicalQuery = canonicalizeShopifyOAuthQuery(input.rawQuery)
  let verified: unknown
  try {
    verified = await callbackVerifier.verify({ rawQuery: input.rawQuery, canonicalQuery, hmac })
  } catch {
    conflict('Shopify OAuth callback signature could not be verified.')
  }
  if (verified !== true) conflict('Shopify OAuth callback signature could not be verified.')

  const state = boundedString(exactShopifyOAuthQueryValue(pairs, 'state'), 'Shopify OAuth state', 256)
  const code = boundedString(exactShopifyOAuthQueryValue(pairs, 'code'), 'Shopify OAuth code', 2048)
  const requestedShopDomain = normalizeShopifyShopDomain(exactShopifyOAuthQueryValue(pairs, 'shop'))
  const timestampText = boundedString(exactShopifyOAuthQueryValue(pairs, 'timestamp'), 'Shopify OAuth timestamp', 32)
  if (!/^\d{10,12}$/u.test(timestampText)) invalid('Shopify OAuth timestamp is invalid.')
  const timestamp = Number(timestampText)
  const now = clock()
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isSafeInteger(timestamp) || Math.abs(now.getTime() - timestamp * 1000) > SHOPIFY_OAUTH_TTL_MS) conflict('Shopify OAuth callback timestamp is outside the allowed window.')
  if (typeof input.stateCookie !== 'string' || !constantTimeEqual(state, boundedString(input.stateCookie, 'Shopify OAuth state cookie', 256))) conflict('Shopify OAuth browser state does not match the callback state.')
  const redirectUri = normalizeRedirectUri(input.redirectUri)
  const pending = await repositories.shopify.findAuthorizationByStateHash(hashValue(state))
  if (!pending || pending.status !== 'pending' || pending.expiresAt.getTime() <= now.getTime()) conflict('Shopify OAuth state is expired, revoked, or already consumed.')
  if (pending.shopDomain !== requestedShopDomain || pending.redirectUri !== redirectUri) conflict('Shopify OAuth redirect URI or shop identity does not match the authorization state.')
  const integration = await ensureIntegration(pending.ownerUserId, pending.projectId, pending.integrationId, repositories.integrations)
  if (integration.status !== 'awaiting_authorization') conflict('Shopify integration is not awaiting authorization.')
  await assertPaidManagedSiteModuleEntitlement(pending.ownerUserId, pending.projectId, 'shopify_commerce', managedRepository)
  const claimed = await repositories.shopify.transaction(transaction => transaction.claimAuthorization(hashValue(state), now))
  if (!claimed) conflict('Shopify OAuth state was already consumed or is no longer valid.')
  let result: Awaited<ReturnType<ShopifyOAuthExchangeAdapter['exchange']>>
  try {
    result = await adapter.exchange({ code, redirectUri: pending.redirectUri, shopDomain: pending.shopDomain })
  } catch {
    await repositories.integrations.update(integration.id, { status: 'blocked', externalReference: null, updatedAt: clock() } as any)
    return { status: 'blocked' as const, integration: await repositories.integrations.findById(integration.id), shopDomain: pending.shopDomain, providerConfigured: false, externalCalls: false, limitation: 'Shopify credential exchange failed closed; no credential was persisted.' }
  }
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

async function processVerifiedShopifyWebhook(ownerUserId: number, projectId: number, integrationId: number, request: ShopifyWebhookEventInput, repositories: ShopifyServiceRepositories, managedRepository: ManagedSiteRepository, clock: () => Date = () => new Date(), knownIntegration?: ManagedSiteIntegration) {
  await assertPaidManagedSiteModuleEntitlement(ownerUserId, projectId, 'shopify_commerce', managedRepository)
  const integration = knownIntegration || await ensureIntegration(ownerUserId, projectId, integrationId, repositories.integrations)
  if (!['active', 'mock_verified'].includes(integration.status)) conflict('Shopify webhook integration is not active.')
  const shopDomain = normalizeShopifyShopDomain(request.shopDomain)
  if (integrationShopDomain(integration) !== shopDomain) conflict('Shopify webhook shop identity does not match the integration.')
  const webhookId = boundedString(request.webhookId, 'Shopify webhook id', 160)
  const topic = boundedString(request.topic, 'Shopify webhook topic', 160)
  const rawBody = rawWebhookBody(request.rawBody)
  const signature = boundedString(request.signature, 'Shopify webhook signature', 512)
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

export async function handleShopifyWebhook(ownerUserId: number, projectId: number, integrationId: number, request: ShopifyWebhookEventInput, verifier: ShopifyWebhookVerifier = FAIL_CLOSED_SHOPIFY_WEBHOOK_VERIFIER, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const rawBody = rawWebhookBody(request.rawBody)
  const signature = boundedString(request.signature, 'Shopify webhook signature', 512)
  await verifyShopifyWebhookSignature(rawBody, signature, verifier)
  return processVerifiedShopifyWebhook(ownerUserId, projectId, integrationId, { ...request, rawBody, signature }, repositories, managedRepository, clock)
}

export async function handleShopifyWebhookIngress(request: ShopifyWebhookEventInput, verifier: ShopifyWebhookVerifier = FAIL_CLOSED_SHOPIFY_WEBHOOK_VERIFIER, repositories: ShopifyServiceRepositories = { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, managedRepository: ManagedSiteRepository = getManagedSiteRepository(), clock: () => Date = () => new Date()) {
  const rawBody = rawWebhookBody(request.rawBody)
  const signature = boundedString(request.signature, 'Shopify webhook signature', 512)
  await verifyShopifyWebhookSignature(rawBody, signature, verifier)
  const shopDomain = normalizeShopifyShopDomain(request.shopDomain)
  const integration = await repositories.integrations.findByShopDomain(shopDomain)
  if (!integration) notFound('Shopify webhook integration was not found.')
  return processVerifiedShopifyWebhook(integration.ownerUserId, integration.projectId, integration.id, { ...request, shopDomain, rawBody, signature }, repositories, managedRepository, clock, integration)
}

export async function revokeShopifyIntegration(ownerUserId: number, projectId: number, integrationId: number, integrations: IntegrationRepository = getIntegrationRepository(), managedRepository: ManagedSiteRepository = getManagedSiteRepository()) {
  await assertPaidManagedSiteModuleEntitlement(ownerUserId, projectId, 'shopify_commerce', managedRepository)
  const integration = await ensureIntegration(ownerUserId, projectId, integrationId, integrations)
  const updated = await integrations.update(integration.id, { status: 'revoked', externalReference: null, updatedAt: new Date() } as any)
  return { integration: updated, revoked: true, externalCalls: false, writes: false, limitation: 'Shopify integration was locally revoked; no Shopify API request was executed.' }
}
