import type { H3Event } from 'h3'
import { deleteCookie, getCookie, setCookie } from 'h3'
import { createError } from 'h3'
import { getManagedSiteRepository } from './repository'
import { getManagedSiteCustomerSession } from './service'
import { roleAllows, MANAGED_SITE_REACCESS_PATH, MANAGED_SITE_SESSION_COOKIE, MANAGED_SITE_SESSION_TTL_MS, type ManagedSiteRepository, type ManagedSiteRole } from './types'

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

/**
 * A customer session lasts 8 hours, so this 401 is an ordinary daily event, not an
 * error condition. It carries the recovery path so the caller can send the customer
 * somewhere useful instead of a dead end. The body stays identical for a missing and
 * an expired session: the difference is not the customer's to act on, and telling
 * an unauthenticated caller which cookies name real sessions helps nobody but a
 * guesser.
 */
function managedSiteCustomerUnauthenticated() {
  return createError({
    statusCode: 401,
    statusMessage: 'Managed site customer access requires a valid invitation session.',
    data: { reaccessPath: MANAGED_SITE_REACCESS_PATH },
  })
}

/** `repository` is an injection seam for tests; production always resolves the real one. */
export async function requireManagedSiteCustomer(event: H3Event, repository?: ManagedSiteRepository) {
  const token = getManagedSiteSessionToken(event)
  if (!token) throw managedSiteCustomerUnauthenticated()
  const access = await getManagedSiteCustomerSession(token, repository ?? getManagedSiteRepository())
  if (!access) {
    // The cookie outlived the session row, so drop it: without this the browser
    // keeps replaying a token that can never succeed again.
    clearManagedSiteSessionCookie(event)
    throw managedSiteCustomerUnauthenticated()
  }
  return { token, ...access }
}

export function requireManagedSiteCustomerPermission<T extends { membership: { role: ManagedSiteRole } }>(access: T, permission: string): T {
  if (!roleAllows(access.membership.role, permission)) throw createError({ statusCode: 403, statusMessage: 'This customer role cannot perform this managed-site action.' })
  return access
}
