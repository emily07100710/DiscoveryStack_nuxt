import { timingSafeEqual } from 'node:crypto'

/**
 * Temporary password-only owner login for the free hosting deploy.
 *
 * The shipped owner login uses an external OAuth identity provider that is not
 * available on this deployment. This route is an opt-in fallback: it is inert
 * unless OWNER_SIMPLE_LOGIN_PASSWORD is set on the server. It grants the same
 * admin session the rest of the private app already enforces, so it must stay
 * behind the same session secret and admin-in-database checks.
 *
 * The password is a runtime secret, so it is read from process.env directly
 * (never baked into the serialized runtimeConfig) — mirroring server/utils/auth.ts.
 */
export const OWNER_SIMPLE_LOGIN_PATH = '/owner-login'
const DEFAULT_OWNER_OPEN_ID = 'owner-simple-login'

export function configuredSimpleLoginPassword() {
  return process.env.OWNER_SIMPLE_LOGIN_PASSWORD || ''
}

export function resolveSimpleLoginOpenId() {
  return process.env.OWNER_OPEN_ID || DEFAULT_OWNER_OPEN_ID
}

export function simpleLoginPasswordMatches(submitted: string, expected: string) {
  if (!expected) return false
  const submittedBytes = Buffer.from(String(submitted), 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  // Keep the comparison time independent of whether the lengths match.
  if (submittedBytes.length !== expectedBytes.length) {
    timingSafeEqual(expectedBytes, expectedBytes)
    return false
  }
  return timingSafeEqual(submittedBytes, expectedBytes)
}

const RATE_LIMIT = 8
const RATE_WINDOW_MS = 15 * 60 * 1_000
const attempts = new Map<string, { count: number, startedAt: number }>()

/** Throttle password guesses per client. Call on every submit; reset on success. */
export function enforceSimpleLoginRateLimit(fingerprint: string) {
  const now = Date.now()
  const bucket = attempts.get(fingerprint)
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    attempts.set(fingerprint, { count: 1, startedAt: now })
    return
  }
  if (bucket.count >= RATE_LIMIT) throw createError({ statusCode: 429, statusMessage: 'Too many sign-in attempts. Please wait a few minutes and try again.' })
  bucket.count += 1
}

export function clearSimpleLoginRateLimit(fingerprint: string) {
  attempts.delete(fingerprint)
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => (
  ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
))

/** Minimal, self-contained sign-in page. No external assets; safe to serve noindex/no-store. */
export function renderOwnerLoginPage(options: { message?: string } = {}) {
  const alert = options.message
    ? `<p class="alert" role="alert">${escapeHtml(options.message)}</p>`
    : ''
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Owner 登入 · DiscoveryStack</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Noto Sans TC", sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  .card { width: 100%; max-width: 360px; background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 28px; box-shadow: 0 20px 50px rgba(0,0,0,.35); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #94a3b8; line-height: 1.5; }
  label { display: block; font-size: 13px; margin: 0 0 6px; color: #cbd5e1; }
  input { width: 100%; padding: 12px 14px; font-size: 16px; border-radius: 10px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; }
  input:focus { outline: 2px solid #38bdf8; border-color: #38bdf8; }
  button { width: 100%; margin-top: 16px; padding: 12px 14px; font-size: 15px; font-weight: 600; border: none; border-radius: 10px; background: #38bdf8; color: #082f49; cursor: pointer; }
  button:hover { background: #7dd3fc; }
  .alert { margin: 0 0 16px; padding: 10px 12px; font-size: 13px; border-radius: 8px; background: #7f1d1d; color: #fee2e2; }
</style>
</head>
<body>
  <main class="card">
    <h1>Owner 登入</h1>
    <p class="sub">私有稽核實驗室。輸入密碼即可進入。</p>
    ${alert}
    <form method="post" action="${OWNER_SIMPLE_LOGIN_PATH}" autocomplete="off">
      <label for="password">密碼</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">登入</button>
    </form>
  </main>
</body>
</html>`
}
