import { getDatabase } from '../../database'
import { users } from '../../database/schema'
import { setOwnerSession } from '../../utils/auth'
import { exchangeOAuthCode, type OAuthProviderErrorKind } from '../../utils/oauth'

type CallbackStage = 'exchange' | 'token' | 'identity' | 'database' | 'session'
const OAUTH_NITRO_RELEASE = 'nitro-oauth-20260816-r5'

function callbackStatusCode(error: unknown, stage: CallbackStage, providerError: OAuthProviderErrorKind | null) {
  // Cloudflare turns an origin 502 into a generic Host Error page, which hides
  // our safe callback diagnostics. A provider failure is an unsuccessful
  // authorization response, not an application crash, so return a controlled
  // client-visible response without exposing provider details.
  if ((stage === 'token' || stage === 'identity') && providerError) return 400
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : 500
  return statusCode >= 400 && statusCode < 600 ? statusCode : 500
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
  let providerError: OAuthProviderErrorKind | null = null
  try {
    const user = await exchangeOAuthCode(
      event,
      code,
      state,
      (nextStage) => { stage = nextStage },
      (kind) => { providerError = kind },
    )
    stage = 'database'
    const database = getDatabase()
    if (!database) throw createError({ statusCode: 503, statusMessage: 'Private administration is temporarily unavailable.' })
    const config = useRuntimeConfig(event)
    setHeader(event, 'X-DiscoveryStack-OAuth-Owner', user.openId === config.ownerOpenId ? 'match' : 'mismatch')
    await database.insert(users).values({
      openId: user.openId!, name: user.name || null, email: user.email || null, loginMethod: user.loginMethod || user.platform || null,
      role: user.openId === config.ownerOpenId ? 'admin' : 'user', lastSignedIn: new Date(),
    }).onDuplicateKeyUpdate({ set: { name: user.name || null, email: user.email || null, loginMethod: user.loginMethod || user.platform || null, lastSignedIn: new Date() } })
    stage = 'session'
    await setOwnerSession(event, { openId: user.openId!, name: user.name })
    setHeader(event, 'X-DiscoveryStack-OAuth-Callback', 'complete')
    return sendRedirect(event, '/audit-lab', 302)
  } catch (error: unknown) {
    setHeader(event, 'X-DiscoveryStack-OAuth-Callback', stage)
    if (providerError) setHeader(event, 'X-DiscoveryStack-OAuth-Provider-Error', providerError)
    const statusCode = callbackStatusCode(error, stage, providerError)
    const errorName = error instanceof Error ? error.name : typeof error
    console.error(`[DiscoveryStack OAuth] callback failed at stage=${stage}; error=${errorName}`)
    setResponseStatus(event, statusCode)
    return { error: callbackFailureMessage(stage) }
  }
})
