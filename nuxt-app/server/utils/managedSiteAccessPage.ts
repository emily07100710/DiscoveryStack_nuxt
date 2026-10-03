import { createError } from 'h3'
import { MANAGED_SITE_REACCESS_PATH } from '../managed-sites/types'

/**
 * Server-rendered pages for customer self-serve re-access.
 *
 * These live in server/routes/ rather than pages/ for three reasons: the flow must
 * work with cookies disabled until the moment a session is minted, it must never
 * pull the private app's client bundle in front of an unauthenticated visitor, and
 * a magic link must survive an email scanner prefetching it — which it does because
 * GET only renders a confirmation, and only the POST consumes the token.
 */

/** Re-exported so the pages and their route handlers share one spelling of the path. */
export const MANAGED_SITE_ACCESS_PATH = MANAGED_SITE_REACCESS_PATH
export const MANAGED_SITE_PORTAL_PATH = '/customer/managed-sites'

const RATE_LIMIT = 6
const RATE_WINDOW_MS = 15 * 60 * 1_000
/** Bounded so a flood of distinct clients cannot grow this map without limit. */
const RATE_LIMIT_MAX_BUCKETS = 10_000
const attempts = new Map<string, { count: number, startedAt: number }>()

function evictExpired(now: number) {
  for (const [key, bucket] of attempts) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) attempts.delete(key)
  }
}

/** Throttle unauthenticated re-access traffic per client. Complements the ledger-backed per-address limit. */
export function enforceManagedSiteAccessRateLimit(fingerprint: string, now = Date.now()) {
  const bucket = attempts.get(fingerprint)
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    if (attempts.size >= RATE_LIMIT_MAX_BUCKETS) {
      evictExpired(now)
      // Map iterates in insertion order, so this drops the oldest surviving bucket.
      if (attempts.size >= RATE_LIMIT_MAX_BUCKETS) {
        const oldest = attempts.keys().next()
        if (!oldest.done) attempts.delete(oldest.value)
      }
    }
    attempts.set(fingerprint, { count: 1, startedAt: now })
    return
  }
  if (bucket.count >= RATE_LIMIT) throw createError({ statusCode: 429, statusMessage: '嘗試次數太多了，請等幾分鐘再試一次。' })
  bucket.count += 1
}

export function clearManagedSiteAccessRateLimit(fingerprint: string) {
  attempts.delete(fingerprint)
}

/** Test-only reset so limiter state never leaks between test files. */
export function resetManagedSiteAccessRateLimitForTests() {
  if (process.env.NODE_ENV !== 'test') throw createError({ statusCode: 403, statusMessage: 'Managed-site access limiter reset is test-only.' })
  attempts.clear()
}

const escapeHtml = (value: string) => String(value).replace(/[&<>"']/g, ch => (
  ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
))

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  .card { width: 100%; max-width: 420px; background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,.35); }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { margin: 0 0 16px; font-size: 14px; color: #cbd5e1; line-height: 1.6; }
  p.sub { color: #94a3b8; font-size: 13px; }
  label { display: block; font-size: 13px; margin: 0 0 6px; color: #cbd5e1; }
  input { width: 100%; padding: 12px 14px; font-size: 16px; border-radius: 10px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; }
  input:focus { outline: 2px solid #38bdf8; border-color: #38bdf8; }
  button { width: 100%; margin-top: 16px; padding: 12px 14px; font-size: 15px; font-weight: 600; border: none; border-radius: 10px; background: #38bdf8; color: #082f49; cursor: pointer; }
  button:hover { background: #7dd3fc; }
  .alert { margin: 0 0 16px; padding: 10px 12px; font-size: 13px; border-radius: 8px; background: #7f1d1d; color: #fee2e2; }
  .notice { margin: 0 0 16px; padding: 10px 12px; font-size: 13px; border-radius: 8px; background: #164e63; color: #cffafe; }
  .back { display: inline-block; margin-top: 18px; font-size: 13px; color: #7dd3fc; }
`

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="origin">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
  <main class="card">
${body}
  </main>
</body>
</html>`
}

function banner(message: string | undefined, kind: 'alert' | 'notice') {
  return message ? `    <p class="${kind}" role="${kind === 'alert' ? 'alert' : 'status'}">${escapeHtml(message)}</p>\n` : ''
}

/** Step 1: ask for the address. Shown to anyone; reveals nothing about who has an account. */
export function renderManagedSiteAccessRequestPage(options: { message?: string, notice?: string, email?: string } = {}) {
  return page('重新進入網站後台 · DiscoveryStack', `    <h1>重新進入您的網站後台</h1>
    <p class="sub">輸入您當初開站時使用的 Email，我們會寄一個一次性連結給您。</p>
${banner(options.message, 'alert')}${banner(options.notice, 'notice')}    <form method="post" action="${MANAGED_SITE_ACCESS_PATH}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" autofocus required maxlength="320" value="${escapeHtml(options.email || '')}">
      <button type="submit">寄出連結</button>
    </form>`)
}

/**
 * Step 2: the same acknowledgement for every address, so this page cannot be used to
 * find out which email addresses are customers.
 */
export function renderManagedSiteAccessAcknowledgementPage() {
  return page('連結已寄出 · DiscoveryStack', `    <h1>信寄出去了</h1>
    <p>如果這個 Email 有網站管理權限，您會收到一封含有登入連結的信。連結 30 分鐘內有效，只能用一次。</p>
    <p class="sub">沒收到的話，先看看垃圾信件匣，或確認輸入的 Email 跟當初開站時用的是同一個。</p>
    <a class="back" href="${MANAGED_SITE_ACCESS_PATH}">換一個 Email 再試一次</a>`)
}

/**
 * Step 3: confirmation. The link is NOT consumed here — mail scanners and link
 * previewers issue GET requests, and a single-use token must survive them.
 */
export function renderManagedSiteAccessConfirmPage(token: string) {
  return page('確認進入網站後台 · DiscoveryStack', `    <h1>確認進入您的網站後台</h1>
    <p>按下按鈕就會進入您的網站管理頁面。這個連結用過一次之後就會失效。</p>
    <form method="post" action="${MANAGED_SITE_ACCESS_PATH}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit">進入網站後台</button>
    </form>
    <a class="back" href="${MANAGED_SITE_ACCESS_PATH}">連結失效了？重新寄一次</a>`)
}

/** Step 3 failure: expired, already used, or never valid — all indistinguishable on purpose. */
export function renderManagedSiteAccessExpiredPage(message = '這個連結已經失效或已經用過了。') {
  return page('連結已失效 · DiscoveryStack', `    <h1>連結不能用了</h1>
${banner(message, 'alert')}    <p>重新輸入 Email，我們再寄一個新的連結給您。</p>
    <form method="post" action="${MANAGED_SITE_ACCESS_PATH}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" inputmode="email" autocomplete="email" autofocus required maxlength="320">
      <button type="submit">重新寄出連結</button>
    </form>`)
}
