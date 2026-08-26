import { revokeManagedSiteSession } from '../../../managed-sites/service'
import { clearManagedSiteSessionCookie, getManagedSiteSessionToken } from '../../../managed-sites/auth'

export default defineEventHandler(async (event) => {
  const token = getManagedSiteSessionToken(event)
  if (token) await revokeManagedSiteSession(token)
  clearManagedSiteSessionCookie(event)
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  return { signedOut: true }
})
