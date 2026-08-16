import { getDatabase } from '../../database'
import { users } from '../../database/schema'
import { setOwnerSession } from '../../utils/auth'
import { exchangeOAuthCode } from '../../utils/oauth'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const code = typeof query.code === 'string' ? query.code : ''
  const state = typeof query.state === 'string' ? query.state : ''
  if (!code || !state) throw createError({ statusCode: 400, statusMessage: 'Sign-in callback requires code and state.' })
  let stage = 'exchange'
  try {
    const user = await exchangeOAuthCode(event, code, state, (nextStage) => { stage = nextStage })
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
  } catch (error) {
    setHeader(event, 'X-DiscoveryStack-OAuth-Callback', stage)
    throw error
  }
})
