import axios from 'axios'
import type { H3Event } from 'h3'

const OAUTH_STATE_COOKIE = '__Host-discoverystack-oauth-state'
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60
const OAUTH_PROVIDER_TIMEOUT_MS = 25_000

type OAuthState = { redirectUri: string, nonce: string }
export type OAuthProviderErrorKind = 'timeout' | 'response' | 'network' | 'unknown'
export type OAuthProviderError = { kind: OAuthProviderErrorKind, status: number | null }

const toBase64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const fromBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8')

function classifyProviderError(error: unknown): OAuthProviderError {
  if (!axios.isAxiosError(error)) return { kind: 'unknown', status: null }
  const status = typeof error.response?.status === 'number' ? error.response.status : null
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return { kind: 'timeout', status }
  if (error.response) return { kind: 'response', status }
  return { kind: 'network', status }
}

export function oauthConfig(event: H3Event) {
  const config = useRuntimeConfig(event)
  const serverUrl = typeof config.oauthServerUrl === 'string' ? config.oauthServerUrl : ''
  const portalUrl = typeof config.oauthPortalUrl === 'string' ? config.oauthPortalUrl : ''
  const appId = typeof config.oauthAppId === 'string' ? config.oauthAppId : ''
  const configuredOrigin = typeof config.discoveryStackOauthAllowedOrigin === 'string' ? config.discoveryStackOauthAllowedOrigin : ''
  if (!serverUrl || !portalUrl || !appId || !configuredOrigin) {
    throw createError({ statusCode: 503, statusMessage: 'Private sign-in is not configured.' })
  }
  let allowedOrigin = ''
  try { allowedOrigin = new URL(configuredOrigin).origin } catch { throw createError({ statusCode: 503, statusMessage: 'Private sign-in origin is not configured correctly.' }) }
  if (!allowedOrigin.startsWith('https://')) throw createError({ statusCode: 503, statusMessage: 'Private sign-in origin must use HTTPS.' })
  return { serverUrl, portalUrl, appId, allowedOrigin }
}

export function beginOAuthLogin(event: H3Event, requestedOrigin: string) {
  const { portalUrl, appId, allowedOrigin } = oauthConfig(event)
  if (requestedOrigin !== allowedOrigin) throw createError({ statusCode: 400, statusMessage: 'This sign-in origin is not allowed.' })
  const redirectUri = `${allowedOrigin}/api/oauth/callback`
  const nonce = crypto.randomUUID()
  const state = toBase64(JSON.stringify({ redirectUri, nonce } satisfies OAuthState))
  // OAuth returns from a different site. Some real browsers/proxies do not return a Lax cookie on this flow,
  // so this short-lived, host-only, HttpOnly state cookie explicitly permits the cross-site callback.
  setCookie(event, OAUTH_STATE_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: OAUTH_STATE_MAX_AGE_SECONDS })
  const authorizationUrl = new URL(portalUrl)
  authorizationUrl.pathname = `${authorizationUrl.pathname.replace(/\/$/, '')}/app-auth`
  authorizationUrl.searchParams.set('appId', appId)
  authorizationUrl.searchParams.set('redirectUri', redirectUri)
  authorizationUrl.searchParams.set('state', state)
  authorizationUrl.searchParams.set('type', 'signIn')
  return authorizationUrl.toString()
}

export function validateOAuthState(event: H3Event, state: string) {
  let parsed: OAuthState
  try { parsed = JSON.parse(fromBase64(state)) as OAuthState } catch { throw createError({ statusCode: 403, statusMessage: 'Invalid sign-in state.' }) }
  const expectedNonce = getCookie(event, OAUTH_STATE_COOKIE)
  // Do not expose nonce or state. The fixed marker distinguishes a missing browser cookie from malformed state.
  setHeader(event, 'X-DiscoveryStack-OAuth-State', expectedNonce ? 'cookie-present' : 'cookie-missing')
  deleteCookie(event, OAUTH_STATE_COOKIE, { httpOnly: true, secure: true, sameSite: 'none', path: '/' })
  const { allowedOrigin } = oauthConfig(event)
  const expectedRedirect = `${allowedOrigin}/api/oauth/callback`
  if (!parsed?.nonce || parsed.nonce !== expectedNonce || parsed.redirectUri !== expectedRedirect) throw createError({ statusCode: 403, statusMessage: 'Invalid sign-in state.' })
  return parsed
}

export async function exchangeOAuthCode(
  event: H3Event,
  code: string,
  state: string,
  onStage?: (stage: 'token' | 'identity') => void,
  onProviderError?: (failure: OAuthProviderError) => void,
) {
  const { serverUrl, appId } = oauthConfig(event)
  const statePayload = validateOAuthState(event, state)
  onStage?.('token')
  let exchange: { accessToken?: string }
  let exchangeStatus: number | null = null
  try {
    const response = await axios.post<{ accessToken?: string }>(`${serverUrl}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, {
      // Match the shipped SDK: it decodes redirectUri from state, then posts redirectUri to the provider.
      clientId: appId, grantType: 'authorization_code', code, redirectUri: statePayload.redirectUri,
    }, {
      timeout: OAUTH_PROVIDER_TIMEOUT_MS,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    })
    exchangeStatus = response.status
    exchange = response.data
  } catch (error) {
    onProviderError?.(classifyProviderError(error))
    throw createError({ statusCode: 502, statusMessage: 'The sign-in provider could not exchange the authorization code.' })
  }
  if (!exchange.accessToken) {
    // A 2xx response with no required token is still a provider contract failure.
    // Record only its HTTP status; never include the response body in diagnostics.
    onProviderError?.({ kind: 'response', status: exchangeStatus })
    throw createError({ statusCode: 502, statusMessage: 'The sign-in provider did not return an access token.' })
  }
  onStage?.('identity')
  let user: { openId?: string, name?: string, email?: string, platform?: string, loginMethod?: string }
  let identityStatus: number | null = null
  try {
    const response = await axios.post<{ openId?: string, name?: string, email?: string, platform?: string, loginMethod?: string }>(`${serverUrl}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, {
      accessToken: exchange.accessToken,
    }, {
      timeout: OAUTH_PROVIDER_TIMEOUT_MS,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    })
    identityStatus = response.status
    user = response.data
  } catch (error) {
    onProviderError?.(classifyProviderError(error))
    throw createError({ statusCode: 502, statusMessage: 'The sign-in provider could not load the account identity.' })
  }
  if (!user.openId) {
    // Preserve the same redaction boundary for a malformed successful identity response.
    onProviderError?.({ kind: 'response', status: identityStatus })
    throw createError({ statusCode: 502, statusMessage: 'The sign-in provider did not return an account identity.' })
  }
  return user
}
