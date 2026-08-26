import type { H3Event } from 'h3'
import { deleteCookie, getCookie, setCookie } from 'h3'
import { createError } from 'h3'
import { getManagedSiteCustomerSession } from './service'
import { roleAllows, MANAGED_SITE_SESSION_COOKIE, MANAGED_SITE_SESSION_TTL_MS, type ManagedSiteRole } from './types'

export function getManagedSiteSessionToken(event: H3Event): string | null {
  const token = getCookie(event, MANAGED_SITE_SESSION_COOKIE)
  return token || null
}

export function setManagedSiteSessionCookie(event: H3Event, token: string) {
  setCookie(event, MANAGED_SITE_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(MANAGED_SITE_SESSION_TTL_MS / 1000),
  })
}

export function clearManagedSiteSessionCookie(event: H3Event) {
  deleteCookie(event, MANAGED_SITE_SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
}

export async function requireManagedSiteCustomer(event: H3Event) {
  const token = getManagedSiteSessionToken(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Managed site customer access requires a valid invitation session.' })
  const access = await getManagedSiteCustomerSession(token)
  if (!access) throw createError({ statusCode: 401, statusMessage: 'Managed site customer access requires a valid invitation session.' })
  return { token, ...access }
}

export function requireManagedSiteCustomerPermission<T extends { membership: { role: ManagedSiteRole } }>(access: T, permission: string): T {
  if (!roleAllows(access.membership.role, permission)) throw createError({ statusCode: 403, statusMessage: 'This customer role cannot perform this managed-site action.' })
  return access
}
