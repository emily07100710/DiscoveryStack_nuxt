import { createError } from 'h3'

export const WEEKLY_LIFF_VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify'
const MAX_RESPONSE_BYTES = 12 * 1024
const invalid = (): never => { throw createError({ statusCode: 401, statusMessage: 'LINE_IDENTITY_INVALID' }) }
const unavailable = (): never => { throw createError({ statusCode: 503, statusMessage: 'LINE_IDENTITY_UNAVAILABLE' }) }
export type VerifiedWeeklyLiffIdentity = { lineUserId: string; channelId: string; expiresAtSeconds: number }
export type WeeklyLiffIdentityDependencies = { channelId: string; fetchImpl?: typeof fetch; now?: Date; timeoutMs?: number }

/** Only the fixed LINE server verifies the token; no JWT decode or browser identity is authoritative. */
export async function verifyWeeklyLiffIdentity(idToken: unknown, deps: WeeklyLiffIdentityDependencies): Promise<VerifiedWeeklyLiffIdentity> {
  if (!/^[0-9]{8,15}$/.test(deps.channelId)) return unavailable()
  if (typeof idToken !== 'string' || idToken.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) return invalid()
  const controller = new AbortController()
  const timeout = Number.isSafeInteger(deps.timeoutMs) ? Math.max(100, Math.min(deps.timeoutMs!, 10_000)) : 5000
  const timer = setTimeout(() => controller.abort(), timeout)
  timer.unref?.()
  const deadline = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(createError({ statusCode: 503, statusMessage: 'LINE_IDENTITY_UNAVAILABLE' })), { once: true }))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await Promise.race([(deps.fetchImpl || fetch)(WEEKLY_LIFF_VERIFY_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ id_token: idToken, client_id: deps.channelId }).toString(),
    }), deadline])
    if (response.status !== 200 || response.redirected) {
      if (response.body) void response.body.cancel().catch(() => undefined)
      if (response.status >= 500 || response.status === 429) return unavailable()
      return invalid()
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) { if (response.body) void response.body.cancel().catch(() => undefined); return invalid() }
    const advertised = response.headers.get('content-length')
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
      if (response.body) void response.body.cancel().catch(() => undefined)
      return invalid()
    }
    if (!response.body) return invalid()
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const next = await Promise.race([reader.read(), deadline])
      if (controller.signal.aborted) return unavailable()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) return invalid()
      chunks.push(next.value)
    }
    let payload: unknown
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size))) } catch { return invalid() }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid()
    const row = payload as Record<string, unknown>
    const nowSeconds = Math.floor((deps.now || new Date()).getTime() / 1000)
    if (row.iss !== 'https://access.line.me' || row.aud !== deps.channelId || typeof row.sub !== 'string' || !/^U[a-f0-9]{32}$/.test(row.sub)
      || typeof row.exp !== 'number' || !Number.isSafeInteger(row.exp) || typeof row.iat !== 'number' || !Number.isSafeInteger(row.iat)
      || row.iat <= 0 || row.iat > nowSeconds || row.exp <= nowSeconds || row.exp <= row.iat || row.exp - row.iat > 3600 || nowSeconds - row.iat >= 3600) return invalid()
    // Do not project name, picture, email, nonce, raw token or raw provider response.
    return { lineUserId: row.sub, channelId: deps.channelId, expiresAtSeconds: row.exp }
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'statusCode' in cause && [401, 503].includes(Number(cause.statusCode))) throw cause
    return unavailable()
  } finally {
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
    clearTimeout(timer)
  }
}
