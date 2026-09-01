import type { H3Event } from 'h3'
import { getDatabase } from '../database'
import { users } from '../database/schema'
import { setOwnerSession } from '../utils/auth'
import { requestFingerprint } from '../utils/lead'
import {
  clearSimpleLoginRateLimit,
  configuredSimpleLoginPassword,
  enforceSimpleLoginRateLimit,
  renderOwnerLoginPage,
  resolveSimpleLoginOpenId,
  simpleLoginPasswordMatches,
} from '../utils/ownerSimpleLogin'

function htmlResponse(event: H3Event, status: number, message?: string) {
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  setResponseStatus(event, status)
  return renderOwnerLoginPage(message ? { message } : {})
}

export default defineEventHandler(async (event) => {
  const expected = configuredSimpleLoginPassword()
  if (!expected) return htmlResponse(event, 503, 'Owner 登入尚未設定。請在伺服器設定 OWNER_SIMPLE_LOGIN_PASSWORD 後再試。')

  enforceSimpleLoginRateLimit(requestFingerprint(event))

  const body = await readBody(event).catch(() => null)
  const rawPassword = body && typeof body === 'object' ? (body as Record<string, unknown>).password : undefined
  const submitted = typeof rawPassword === 'string' ? rawPassword : ''

  if (!simpleLoginPasswordMatches(submitted, expected)) {
    return htmlResponse(event, 401, '密碼不正確，請再試一次。')
  }

  const database = getDatabase()
  if (!database) return htmlResponse(event, 503, '資料庫尚未設定，暫時無法登入。')

  const openId = resolveSimpleLoginOpenId()
  const now = new Date()
  // Ensure the owner row exists AND carries admin authority before minting the
  // session, because getOwnerSession re-checks role='admin' in the database on
  // every request. Promote an existing row rather than only inserting.
  await database.insert(users)
    .values({ openId, name: 'Owner', role: 'admin', lastSignedIn: now })
    .onDuplicateKeyUpdate({ set: { role: 'admin', lastSignedIn: now } })

  await setOwnerSession(event, { openId, name: 'Owner' })
  clearSimpleLoginRateLimit(requestFingerprint(event))

  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  return sendRedirect(event, '/audit-lab', 302)
})
