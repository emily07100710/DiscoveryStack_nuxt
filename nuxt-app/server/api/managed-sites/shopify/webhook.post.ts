import { getHeader, readRawBody } from 'h3'
import { getIntegrationRepository } from '../../../managed-sites/modules-repository'
import { getManagedSiteRepository } from '../../../managed-sites/repository'
import { handleShopifyWebhook, normalizeShopifyShopDomain } from '../../../managed-sites/shopify-service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  const shopDomainHeader = getHeader(event, 'x-shopify-shop-domain')
  const shopDomain = normalizeShopifyShopDomain(shopDomainHeader)
  const integrations = getIntegrationRepository()
  const integration = await integrations.findByShopDomain(shopDomain)
  if (!integration) throw createError({ statusCode: 404, statusMessage: 'Shopify webhook integration was not found.' })
  const rawBody = await readRawBody(event)
  if (typeof rawBody !== 'string') throw createError({ statusCode: 400, statusMessage: 'Shopify webhook body is missing.' })
  return handleShopifyWebhook(integration.ownerUserId, integration.projectId, integration.id, { shopDomain, webhookId: getHeader(event, 'x-shopify-webhook-id') || '', topic: getHeader(event, 'x-shopify-topic') || '', rawBody, signature: getHeader(event, 'x-shopify-hmac-sha256') || '' })
})
