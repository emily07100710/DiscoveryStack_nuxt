import { SignJWT, jwtVerify } from 'jose'
import type { H3Event } from 'h3'

const SESSION_COOKIE = '__Host-discoverystack-session'
const SESSION_DURATION_SECONDS = 60 * 60 * 8

type AdminSession = { openId: string, name: string, role: 'admin' }

function authConfig(event: H3Event) {
  const config = useRuntimeConfig(event)
  // Nitro serializes runtimeConfig during build. Hosting secrets are injected only
  // into the running container, so the server-only environment fallback keeps the
  // session boundary available without ever exposing either value to the client.
  const sessionSecret = (typeof config.sessionSecret === 'string' ? config.sessionSecret : '') || process.env.NUXT_SESSION_SECRET || process.env.JWT_SECRET || ''
  const ownerOpenId = (typeof config.ownerOpenId === 'string' ? config.ownerOpenId : '') || process.env.NUXT_OWNER_OPEN_ID || process.env.OWNER_OPEN_ID || ''
  if (!sessionSecret || !ownerOpenId) {
    throw createError({ statusCode: 503, statusMessage: 'Private administration is not configured.' })
  }
  return { secret: new TextEncoder().encode(sessionSecret), ownerOpenId }
}

export async function setOwnerSession(event: H3Event, user: { openId: string, name?: string | null }) {
  const { secret, ownerOpenId } = authConfig(event)
  if (user.openId !== ownerOpenId) throw createError({ statusCode: 403, statusMessage: 'This account is not permitted to access private administration.' })
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
    const { secret, ownerOpenId } = authConfig(event)
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    if (payload.openId !== ownerOpenId || payload.role !== 'admin' || typeof payload.name !== 'string') return null
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
