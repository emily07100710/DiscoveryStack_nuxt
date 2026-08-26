import type { ManagedSiteShopifyAuthorization, ManagedSiteShopifyWebhook } from '../database/schema'
import type { IntegrationRepository } from './modules-types'

export type ShopifyAuthorizationStartInput = {
  ownerUserId: number
  projectId: number
  integrationId: number
  shopDomain: string
  redirectUri: string
  idempotencyKey: string
}

export type ShopifyOAuthExchangeResult = {
  status: 'authorized' | 'blocked'
  shopDomain: string | null
  credentialReference: string | null
  providerConfigured: false
  externalCalls: false
  limitation: string
}

/**
 * V1 uses Shopify's standalone authorization-code exchange only. Shopify does
 * not receive or return a DiscoveryStack nonce or PKCE verifier here.
 */
export type ShopifyOAuthExchangeAdapter = {
  exchange(input: { code: string; redirectUri: string; shopDomain: string }): Promise<ShopifyOAuthExchangeResult>
}

export type ShopifyOAuthCallbackVerificationInput = {
  rawQuery: string
  canonicalQuery: string
  hmac: string
  shopDomain: string
  state: string
  timestamp: number
  redirectUri: string
}

export type ShopifyOAuthCallbackVerifier = {
  verify(input: ShopifyOAuthCallbackVerificationInput): Promise<unknown>
}

export type ShopifyAuthorizationInsert = Omit<ManagedSiteShopifyAuthorization, 'id' | 'createdAt' | 'nonceHash' | 'codeVerifierHash'> & {
  /** Legacy columns remain nullable for 0025 compatibility and are never populated in V1. */
  nonceHash?: null
  codeVerifierHash?: null
}

export type ShopifyWebhookVerificationRequest = {
  shopDomain: string
  webhookId: string
  topic: string
  rawBody: string
  signature: string
}

export type ShopifyWebhookVerifier = {
  verify(input: ShopifyWebhookVerificationRequest): Promise<unknown>
}

export type ShopifyReadOnlyAdminAdapter = {
  readCatalog(input: { shopDomain: string; credentialReference: string }): Promise<{ status: 'read' | 'blocked'; products: unknown[]; collections: unknown[]; externalCalls: false; limitation: string }>
}

export type ShopifyRepository = {
  transaction<T>(work: (repository: ShopifyRepository) => Promise<T>): Promise<T>
  findAuthorizationByStateHash(stateHash: string): Promise<ManagedSiteShopifyAuthorization | null>
  insertAuthorization(input: ShopifyAuthorizationInsert): Promise<ManagedSiteShopifyAuthorization>
  claimAuthorization(stateHash: string, consumedAt: Date): Promise<ManagedSiteShopifyAuthorization | null>
  findWebhookByIntegrationEvent(integrationId: number, webhookId: string): Promise<ManagedSiteShopifyWebhook | null>
  findWebhookByFingerprint(ownerUserId: number, eventFingerprint: string): Promise<ManagedSiteShopifyWebhook | null>
  insertWebhook(input: Omit<ManagedSiteShopifyWebhook, 'id' | 'receivedAt'>): Promise<ManagedSiteShopifyWebhook>
}

export type ShopifyServiceRepositories = {
  integrations: IntegrationRepository
  shopify: ShopifyRepository
}

export const SHOPIFY_OAUTH_TTL_MS = 10 * 60 * 1000
export const SHOPIFY_WEBHOOK_MAX_BYTES = 256 * 1024
