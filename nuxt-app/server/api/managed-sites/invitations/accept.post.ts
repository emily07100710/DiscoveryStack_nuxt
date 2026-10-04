import { createError, readBody, setHeader } from 'h3'
import { setManagedSiteSessionCookie } from '../../../managed-sites/auth'
import { assertSameOriginManagedSiteMutation } from '../../../managed-sites/live-connectors/http'
import { acceptManagedSiteInvitation } from '../../../managed-sites/service'
import { requestFingerprint } from '../../../utils/lead'
import { enforceManagedSiteAccessRateLimit } from '../../../utils/managedSiteAccessPage'

/**
 * Unauthenticated by design — the bearer token in the body IS the credential — so it
 * is the one managed-site route where an outsider can guess. It carries the same
 * same-origin requirement as every other managed-site mutation, plus a per-client
 * limit so the single-use token space cannot be swept.
 */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  assertSameOriginManagedSiteMutation(event)
  enforceManagedSiteAccessRateLimit(`api-accept:${requestFingerprint(event)}`)

  const body = await readBody(event).catch(() => null)
  const token = body && typeof body === 'object' && typeof (body as Record<string, unknown>).token === 'string'
    ? String((body as Record<string, unknown>).token)
    : ''
  if (!token) throw createError({ statusCode: 422, statusMessage: 'Managed site invitation token is required.' })
  const result = await acceptManagedSiteInvitation(token)
  setManagedSiteSessionCookie(event, result.sessionToken)
  return { accepted: true, project: result.project }
})
