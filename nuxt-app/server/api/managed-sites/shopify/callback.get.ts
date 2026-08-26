import { deleteCookie, getCookie, getQuery } from 'h3'
import { completeShopifyAuthorization } from '../../../managed-sites/shopify-service'

function queryString(value: unknown, label: string): string {
  const candidate = Array.isArray(value) ? value.length === 1 ? value[0] : null : value
  if (typeof candidate !== 'string' || !candidate.trim()) throw createError({ statusCode: 400, statusMessage: `Shopify OAuth ${label} is missing or ambiguous.` })
  return candidate
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const codeVerifier = getCookie(event, '__Host-discoverystack-shopify-pkce')
  if (!codeVerifier) throw createError({ statusCode: 400, statusMessage: 'Shopify OAuth PKCE verifier is missing.' })
  const config = useRuntimeConfig(event)
  const configuredOrigin = typeof config.discoveryStackOauthAllowedOrigin === 'string' ? config.discoveryStackOauthAllowedOrigin : ''
  let allowedOrigin = ''
  try { allowedOrigin = new URL(configuredOrigin).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Shopify callback origin is not configured.' }) }
  if (!allowedOrigin.startsWith('https://')) throw createError({ statusCode: 503, statusMessage: 'Shopify callback origin must use HTTPS.' })
  const redirectUri = `${allowedOrigin}/api/managed-sites/shopify/callback`
  const result = await completeShopifyAuthorization({ state: queryString(query.state, 'state'), code: queryString(query.code, 'code'), nonce: queryString(query.nonce, 'nonce'), codeVerifier, shopDomain: queryString(query.shop, 'shop'), redirectUri })
  deleteCookie(event, '__Host-discoverystack-shopify-pkce', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  return result
})
