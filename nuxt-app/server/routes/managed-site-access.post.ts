import { readBody, sendRedirect, setResponseStatus } from 'h3'
import { setManagedSiteSessionCookie } from '../managed-sites/auth'
import { assertSameOriginManagedSiteMutation } from '../managed-sites/live-connectors/http'
import { requestManagedSiteReaccess } from '../managed-sites/reaccess-service'
import { acceptManagedSiteInvitation } from '../managed-sites/service'
import { requestFingerprint } from '../utils/lead'
import {
  MANAGED_SITE_PORTAL_PATH,
  enforceManagedSiteAccessRateLimit,
  renderManagedSiteAccessAcknowledgementPage,
  renderManagedSiteAccessExpiredPage,
  renderManagedSiteAccessRequestPage,
} from '../utils/managedSiteAccessPage'
import { managedSiteAccessPageHeaders } from './managed-site-access.get'

/**
 * The only step that consumes a re-access token, and the only step that issues one.
 *
 * Both branches answer identically for every email address: the acknowledgement page
 * never depends on whether that address holds access, so this endpoint cannot be
 * used to enumerate customers.
 */
export default defineEventHandler(async (event) => {
  managedSiteAccessPageHeaders(event)
  assertSameOriginManagedSiteMutation(event)

  const body = await readBody(event).catch(() => null)
  const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const token = typeof fields.token === 'string' ? fields.token : ''
  const email = typeof fields.email === 'string' ? fields.email : ''

  if (token) {
    if (!withinClientRateLimit(event, 'confirm')) {
      setResponseStatus(event, 429)
      return renderManagedSiteAccessExpiredPage('嘗試次數太多了，請等幾分鐘再試一次。')
    }
    let session: Awaited<ReturnType<typeof acceptManagedSiteInvitation>>
    try {
      session = await acceptManagedSiteInvitation(token)
    } catch {
      // Expired, already used, revoked and never-valid are deliberately the same answer.
      setResponseStatus(event, 400)
      return renderManagedSiteAccessExpiredPage()
    }
    setManagedSiteSessionCookie(event, session.sessionToken)
    return sendRedirect(event, MANAGED_SITE_PORTAL_PATH, 302)
  }

  if (!withinClientRateLimit(event, 'request')) {
    setResponseStatus(event, 429)
    return renderManagedSiteAccessRequestPage({ message: '嘗試次數太多了，請等幾分鐘再試一次。' })
  }
  if (!email) {
    setResponseStatus(event, 422)
    return renderManagedSiteAccessRequestPage({ message: '請輸入 Email。' })
  }
  // The result is intentionally discarded: its diagnostics are owner-facing only.
  await requestManagedSiteReaccess(email)
  return renderManagedSiteAccessAcknowledgementPage()
})

/** Separate namespaces so link confirmations and send requests cannot exhaust each other. */
function withinClientRateLimit(event: Parameters<typeof requestFingerprint>[0], namespace: 'confirm' | 'request'): boolean {
  try {
    enforceManagedSiteAccessRateLimit(`${namespace}:${requestFingerprint(event)}`)
    return true
  } catch {
    return false
  }
}
