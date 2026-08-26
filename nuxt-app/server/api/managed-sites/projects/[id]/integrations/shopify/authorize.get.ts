import { setCookie } from 'h3'
import { requireOwner } from '../../../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../../../audit/repository'
import { getIntegrationRepository } from '../../../../../../managed-sites/modules-repository'
import { getManagedSiteRepository } from '../../../../../../managed-sites/repository'
import { parsePathId } from '../../../../../../managed-sites/normalization'
import { startShopifyAuthorization } from '../../../../../../managed-sites/shopify-service'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBody(event) || {}
  const config = useRuntimeConfig(event)
  const configuredOrigin = typeof config.discoveryStackOauthAllowedOrigin === 'string' ? config.discoveryStackOauthAllowedOrigin : ''
  let allowedOrigin = ''
  try { allowedOrigin = new URL(configuredOrigin).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Shopify callback origin is not configured.' }) }
  if (!allowedOrigin.startsWith('https://')) throw createError({ statusCode: 503, statusMessage: 'Shopify callback origin must use HTTPS.' })
  const redirectUri = `${allowedOrigin}/api/managed-sites/shopify/callback`
  const result = await startShopifyAuthorization({ ownerUserId, projectId, integrationId: Number(body.integrationId), shopDomain: body.shopDomain, redirectUri, idempotencyKey: body.idempotencyKey }, { integrations: getIntegrationRepository(), shopify: (await import('../../../../../../managed-sites/shopify-repository')).getShopifyRepository() }, getManagedSiteRepository(), () => new Date(), process.env.SHOPIFY_CLIENT_ID || null)
  setCookie(event, '__Host-discoverystack-shopify-pkce', result.codeVerifier, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 })
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  return { authorizationUrl: result.authorizationUrl, expiresAt: result.authorization.expiresAt, externalCalls: false, providerConfigured: false, limitation: result.limitation }
})
