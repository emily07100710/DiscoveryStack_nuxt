import { SignJWT, jwtVerify } from 'jose'
import type { H3Event } from 'h3'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { users } from '../database/schema'

const SESSION_COOKIE = '__Host-discoverystack-session'
const SESSION_DURATION_SECONDS = 60 * 60 * 8

type AdminSession = { openId: string, name: string, role: 'admin' }

function authConfig(event: H3Event) {
  const config = useRuntimeConfig(event)
  // Nitro serializes runtimeConfig during build. Hosting secrets are injected only
  // into the running container, so the server-only environment fallback keeps the
  // session boundary available without ever exposing either value to the client.
  const sessionSecret = (typeof config.sessionSecret === 'string' ? config.sessionSecret : '') || process.env.NUXT_SESSION_SECRET || process.env.JWT_SECRET || ''
  if (!sessionSecret) {
    throw createError({ statusCode: 503, statusMessage: 'Private administration is not configured.' })
  }
  return { secret: new TextEncoder().encode(sessionSecret) }
}

async function isAdminOpenId(openId: string) {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Private administration is not configured.' })
  const [user] = await database.select({ role: users.role }).from(users).where(eq(users.openId, openId)).limit(1)
  return user?.role === 'admin'
}

export async function setOwnerSession(event: H3Event, user: { openId: string, name?: string | null }) {
  const { secret } = authConfig(event)
  if (!await isAdminOpenId(user.openId)) throw createError({ statusCode: 403, statusMessage: 'This account is not permitted to access private administration.' })
  const token = await new SignJWT({ openId: user.openId, name: user.name || '', role: 'admin' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(secret)
  setCookie(event, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_DURATION_SECONDS })
}

export async function getOwnerSession(event: H3Event): Promise<AdminSession | null> {
  const token = getCookie(event, SESSION_COOKIE)
  if (!token) return null
  try {
    const { secret } = authConfig(event)
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    if (typeof payload.openId !== 'string' || payload.role !== 'admin' || typeof payload.name !== 'string' || !await isAdminOpenId(payload.openId)) return null
    return { openId: payload.openId, name: payload.name, role: 'admin' }
  } catch {
    return null
  }
}

export async function requireOwner(event: H3Event) {
  const session = await getOwnerSession(event)
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Private administration requires an owner session.' })
  return session
}

export function clearOwnerSession(event: H3Event) {
  deleteCookie(event, SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
}
