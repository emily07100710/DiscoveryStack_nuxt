import { deleteCookie, getCookie, getQuery, setResponseHeader } from 'h3'
import { createShopifyOAuthCallbackVerifier, completeShopifyAuthorization } from '../../../managed-sites/shopify-service'
import { getShopifyRepository } from '../../../managed-sites/shopify-repository'
import { getIntegrationRepository } from '../../../managed-sites/modules-repository'
import { getManagedSiteRepository } from '../../../managed-sites/repository'

const SHOPIFY_STATE_COOKIE = '__Host-discoverystack-shopify-state'

function queryString(value: unknown, label: string): string {
  const candidate = Array.isArray(value) ? value.length === 1 ? value[0] : null : value
  if (typeof candidate !== 'string' || !candidate.trim()) throw createError({ statusCode: 400, statusMessage: `Shopify OAuth ${label} is missing or ambiguous.` })
  return candidate
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const stateCookie = getCookie(event, SHOPIFY_STATE_COOKIE)
  if (!stateCookie) throw createError({ statusCode: 400, statusMessage: 'Shopify OAuth browser state is missing.' })
  const config = useRuntimeConfig(event)
  const configuredOrigin = typeof config.discoveryStackOauthAllowedOrigin === 'string' ? config.discoveryStackOauthAllowedOrigin : ''
  let allowedOrigin = ''
  try { allowedOrigin = new URL(configuredOrigin).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Shopify callback origin is not configured.' }) }
  if (!allowedOrigin.startsWith('https://')) throw createError({ statusCode: 503, statusMessage: 'Shopify callback origin must use HTTPS.' })
  const redirectUri = `${allowedOrigin}/api/managed-sites/shopify/callback`
  const rawRequestUrl = typeof event.node.req.url === 'string' ? event.node.req.url : ''
  const queryStart = rawRequestUrl.indexOf('?')
  const rawQuery = queryStart >= 0 ? rawRequestUrl.slice(queryStart + 1) : ''
  const configuredSecret = typeof config.shopifyApiSecret === 'string' ? config.shopifyApiSecret : process.env.SHOPIFY_API_SECRET || null
  const result = await completeShopifyAuthorization({ state: queryString(query.state, 'state'), code: queryString(query.code, 'code'), hmac: queryString(query.hmac, 'hmac'), shopDomain: queryString(query.shop, 'shop'), timestamp: queryString(query.timestamp, 'timestamp'), redirectUri, rawQuery, stateCookie }, undefined, { integrations: getIntegrationRepository(), shopify: getShopifyRepository() }, getManagedSiteRepository(), () => new Date(), createShopifyOAuthCallbackVerifier(configuredSecret))
  deleteCookie(event, SHOPIFY_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  return result
})
