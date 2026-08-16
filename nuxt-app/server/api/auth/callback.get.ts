import { getDatabase } from '../../database'
import { users } from '../../database/schema'
import { setOwnerSession } from '../../utils/auth'
import { exchangeOAuthCode, type OAuthProviderError } from '../../utils/oauth'

type CallbackStage = 'exchange' | 'token' | 'identity' | 'database' | 'session'
type SessionFailureKind = 'owner_mismatch' | 'configuration' | 'jwt_session' | 'unknown'
const OAUTH_NITRO_RELEASE = 'nitro-oauth-20260816-r12'

function errorStatusCode(error: unknown) {
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : 500
  return statusCode >= 400 && statusCode < 600 ? statusCode : 500
}

function classifySessionFailure(error: unknown): SessionFailureKind {
  const statusCode = errorStatusCode(error)
  if (statusCode === 403) return 'owner_mismatch'
  if (statusCode === 503) return 'configuration'
  if (statusCode === 500) return 'jwt_session'
  return 'unknown'
}

function callbackStatusCode(error: unknown, stage: CallbackStage, providerError: OAuthProviderError | null) {
  // Cloudflare turns an origin 502 into a generic Host Error page, which hides
  // our safe callback diagnostics. A provider failure is an unsuccessful
  // authorization response, not an application crash, so return a controlled
  // client-visible response without exposing provider details.
  if ((stage === 'token' || stage === 'identity') && providerError) return 400
  return errorStatusCode(error)
}

function callbackFailureMessage(stage: CallbackStage) {
  if (stage === 'token' || stage === 'identity') return 'The sign-in provider is temporarily unavailable.'
  if (stage === 'database') return 'Private administration is temporarily unavailable.'
  if (stage === 'session') return 'Private sign-in could not be completed.'
  return 'Private sign-in could not be completed.'
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const code = typeof query.code === 'string' ? query.code : ''
  const state = typeof query.state === 'string' ? query.state : ''
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'X-DiscoveryStack-OAuth-Release', OAUTH_NITRO_RELEASE)
  if (!code || !state) {
    setResponseStatus(event, 400)
    return { error: 'Private sign-in could not be completed.' }
  }
  let stage: CallbackStage = 'exchange'
  const providerFailure: { value: OAuthProviderError | null } = { value: null }
  try {
    const user = await exchangeOAuthCode(
      event,
      code,
      state,
      (nextStage) => { stage = nextStage },
      (failure) => { providerFailure.value = failure },
    )
    stage = 'database'
    const database = getDatabase()
    if (!database) throw createError({ statusCode: 503, statusMessage: 'Private administration is temporarily unavailable.' })
    await database.insert(users).values({
      openId: user.openId!, name: user.name || null, email: user.email || null, loginMethod: user.loginMethod || user.platform || null,
      role: 'user', lastSignedIn: new Date(),
    }).onDuplicateKeyUpdate({ set: { name: user.name || null, email: user.email || null, loginMethod: user.loginMethod || user.platform || null, lastSignedIn: new Date() } })
    stage = 'session'
    await setOwnerSession(event, { openId: user.openId!, name: user.name })
    setHeader(event, 'X-DiscoveryStack-OAuth-Callback', 'complete')
    return sendRedirect(event, '/audit-lab', 302)
  } catch (error: unknown) {
    setHeader(event, 'X-DiscoveryStack-OAuth-Callback', stage)
    const sessionFailure = stage === 'session' ? classifySessionFailure(error) : null
    const sessionStatus = stage === 'session' ? errorStatusCode(error) : null
    if (providerFailure.value) {
      setHeader(event, 'X-DiscoveryStack-OAuth-Provider-Error', providerFailure.value.kind)
      if (providerFailure.value.status !== null) setHeader(event, 'X-DiscoveryStack-OAuth-Provider-Status', String(providerFailure.value.status))
      if (providerFailure.value.reason) setHeader(event, 'X-DiscoveryStack-OAuth-Provider-Reason', providerFailure.value.reason)
    }
    if (sessionFailure && sessionStatus !== null) {
      setHeader(event, 'X-DiscoveryStack-OAuth-Session-Error', sessionFailure)
      setHeader(event, 'X-DiscoveryStack-OAuth-Session-Status', String(sessionStatus))
    }
    const statusCode = callbackStatusCode(error, stage, providerFailure.value)
    const errorName = error instanceof Error ? error.name : typeof error
    console.error(`[DiscoveryStack OAuth] callback failed at stage=${stage}; status=${statusCode}; session=${sessionFailure || 'none'}; error=${errorName}`)
    setResponseStatus(event, statusCode)
    if (providerFailure.value) {
      return {
        error: callbackFailureMessage(stage),
        providerError: providerFailure.value.kind,
        providerStatus: providerFailure.value.status,
        providerReason: providerFailure.value.reason,
      }
    }
    if (sessionFailure && sessionStatus !== null) {
      return { error: callbackFailureMessage(stage), sessionError: sessionFailure, sessionStatus }
    }
    return { error: callbackFailureMessage(stage) }
  }
})
