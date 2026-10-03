import type { H3Event } from 'h3'
import { getQuery, setHeader, setResponseStatus } from 'h3'
import { managedSiteReaccessConfiguration } from '../managed-sites/reaccess-service'
import {
  renderManagedSiteAccessConfirmPage,
  renderManagedSiteAccessExpiredPage,
  renderManagedSiteAccessRequestPage,
} from '../utils/managedSiteAccessPage'

/** Unauthenticated, so it must never be indexed, cached or stored by an intermediary. */
export function managedSiteAccessPageHeaders(event: H3Event) {
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'X-Robots-Tag', 'noindex, nofollow, noarchive')
  // MUST NOT be `no-referrer`. These pages submit their own forms, and a document
  // whose referrer policy is `no-referrer` makes the browser send `Origin: null`
  // on that submit (Fetch, "Append a request Origin header"), which the same-origin
  // guard then rejects with 403 — every customer would be locked out at the button.
  // `origin` keeps the guard working while still stripping the magic-link token from
  // the Referer, so the token never travels beyond the URL it already lives in.
  setHeader(event, 'Referrer-Policy', 'origin')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'X-Frame-Options', 'DENY')
}

export default defineEventHandler((event) => {
  managedSiteAccessPageHeaders(event)

  const raw = getQuery(event).token
  const token = typeof raw === 'string' ? raw : ''
  if (token) {
    // GET renders a confirmation only. Consuming the token here would let an email
    // scanner or link previewer burn a single-use link before the customer clicks.
    if (token.length < 32 || token.length > 256) {
      setResponseStatus(event, 400)
      return renderManagedSiteAccessExpiredPage('這個連結看起來不完整，可能是信件把它截斷了。')
    }
    return renderManagedSiteAccessConfirmPage(token)
  }

  const configuration = managedSiteReaccessConfiguration()
  if (!configuration.ready) {
    // A global configuration fact, identical for every visitor, so it reveals
    // nothing about which addresses hold access.
    setResponseStatus(event, 503)
    return renderManagedSiteAccessRequestPage({ notice: '自助登入信件功能尚未開通，請直接聯絡我們，我們會手動幫您重新開通後台。' })
  }
  return renderManagedSiteAccessRequestPage()
})
