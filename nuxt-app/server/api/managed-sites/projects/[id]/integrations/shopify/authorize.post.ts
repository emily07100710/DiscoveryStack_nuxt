import { readBody, setCookie, setResponseHeader } from 'h3'
import { getShopifyRepository } from '../../../../../../managed-sites/shopify-repository'
import { requireOwner } from '../../../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../../../audit/repository'
import { getIntegrationRepository } from '../../../../../../managed-sites/modules-repository'
import { getManagedSiteRepository } from '../../../../../../managed-sites/repository'
import { parsePathId } from '../../../../../../managed-sites/normalization'
import { startShopifyAuthorization } from '../../../../../../managed-sites/shopify-service'

const SHOPIFY_STATE_COOKIE = '__Host-discoverystack-shopify-state'

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
  const result = await startShopifyAuthorization({ ownerUserId, projectId, integrationId: Number(body.integrationId), shopDomain: body.shopDomain, redirectUri, idempotencyKey: body.idempotencyKey }, { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, getManagedSiteRepository(), () => new Date(), process.env.SHOPIFY_CLIENT_ID || null)
  setCookie(event, SHOPIFY_STATE_COOKIE, result.state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 })
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  return { authorizationUrl: result.authorizationUrl, expiresAt: result.authorization.expiresAt, externalCalls: false, providerConfigured: false, limitation: result.limitation }
})
