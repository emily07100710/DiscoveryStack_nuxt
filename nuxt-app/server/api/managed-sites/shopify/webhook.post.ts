import { getHeader, readRawBody } from 'h3'
import { getIntegrationRepository } from '../../../managed-sites/modules-repository'
import { getManagedSiteRepository } from '../../../managed-sites/repository'
import { getShopifyRepository } from '../../../managed-sites/shopify-repository'
import { createShopifyWebhookVerifier, handleShopifyWebhookIngress } from '../../../managed-sites/shopify-service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  const rawBody = await readRawBody(event)
  if (typeof rawBody !== 'string') throw createError({ statusCode: 400, statusMessage: 'Shopify webhook body is missing.' })
  const config = useRuntimeConfig(event)
  const configuredSecret = typeof config.shopifyApiSecret === 'string' ? config.shopifyApiSecret : process.env.SHOPIFY_API_SECRET || null
  const verifier = createShopifyWebhookVerifier(configuredSecret)
  return handleShopifyWebhookIngress({
    shopDomain: getHeader(event, 'x-shopify-shop-domain') || '',
    webhookId: getHeader(event, 'x-shopify-webhook-id') || '',
    topic: getHeader(event, 'x-shopify-topic') || '',
    rawBody,
    signature: getHeader(event, 'x-shopify-hmac-sha256') || '',
  }, verifier, { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, getManagedSiteRepository())
})
