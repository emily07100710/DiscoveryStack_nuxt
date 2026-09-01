import { createHash, timingSafeEqual } from 'node:crypto'
import { managedSiteBrokerSignature, type ManagedSiteBrokerPath } from '../hmac-broker-transport'

const MAX_BODY_BYTES = 128 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60_000
const NONCE = /^[A-Za-z0-9._:-]{8,160}$/u
const HMAC_PATHS = new Set(['/v1/managed-sites/verify', '/v1/managed-sites/ownership/challenge', '/v1/managed-sites/ownership/verify'])

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const sameHex = (left: string, right: string): boolean => {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export type ManagedSiteHmacServerContext = { path: ManagedSiteBrokerPath; body: Record<string, unknown>; requestNonce: string; providerEventId: string; observedAt: string }

export function createManagedSiteHmacServer(options: { credential: string; clock: () => Date; nonceFactory: () => string; maxReplayEntries?: number }) {
  // Best-effort single-process replay protection; durable multi-instance replay authority remains upstream.
  const replay = new Map<string, number>(); const maxReplayEntries = Math.min(Math.max(options.maxReplayEntries || 2_048, 32), 10_000)
  const response = (path: ManagedSiteBrokerPath, requestNonce: string, status: number, body: Record<string, unknown>, providerEventId?: string, observedAt?: string) => {
    const raw = JSON.stringify(body); const timestamp = observedAt || options.clock().toISOString(); const nonce = `response-${options.nonceFactory()}`.slice(0, 160)
    const signature = managedSiteBrokerSignature({ method: 'POST', path, timestamp, nonce, requestNonce, bodyHash: sha256(raw) }, options.credential)
    return new Response(raw, { status, headers: { 'content-type': 'application/json', 'x-discoverystack-timestamp': timestamp, 'x-discoverystack-nonce': nonce, 'x-discoverystack-signature': signature, 'x-provider-request-id': providerEventId || `broker-error-${options.nonceFactory()}`.slice(0, 160) } })
  }
  return {
    async handle(pathname: string, headers: Headers, raw: string, handler: (context: ManagedSiteHmacServerContext) => Promise<Record<string, unknown>>): Promise<Response> {
      const path = pathname as ManagedSiteBrokerPath; const requestNonce = headers.get('x-discoverystack-nonce') || '-'
      const reject = (status: number, statusMessage: string) => response(path, requestNonce, status, { statusCode: status, statusMessage })
      if (!HMAC_PATHS.has(pathname)) return reject(401, 'Internal HMAC broker path is not allowlisted.')
      if (!/^application\/json(?:\s*;|$)/iu.test(headers.get('content-type') || '')) return reject(401, 'Internal HMAC broker requires JSON content.')
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return reject(401, 'Internal HMAC broker request is oversized.')
      const timestamp = headers.get('x-discoverystack-timestamp') || ''; const parsedTimestamp = Date.parse(timestamp)
      const bodyHash = headers.get('x-discoverystack-body-sha256') || ''; const signature = headers.get('x-discoverystack-signature') || ''
      if (headers.get('x-discoverystack-provider-key') !== 'internal-dns-tls-broker-hmac-v1' || !NONCE.test(requestNonce) || !Number.isFinite(parsedTimestamp) || Math.abs(options.clock().getTime() - parsedTimestamp) > MAX_CLOCK_SKEW_MS || !sameHex(bodyHash, sha256(raw))) return reject(401, 'Internal HMAC broker request identity is invalid.')
      const expected = managedSiteBrokerSignature({ method: 'POST', path, timestamp, nonce: requestNonce, bodyHash }, options.credential)
      if (!sameHex(signature, expected)) return reject(401, 'Internal HMAC broker signature is invalid.')
      const cutoff = options.clock().getTime() - MAX_CLOCK_SKEW_MS
      for (const [nonce, seenAt] of replay) if (seenAt < cutoff) replay.delete(nonce)
      if (replay.has(requestNonce)) return reject(409, 'Internal HMAC broker request nonce was replayed.')
      replay.set(requestNonce, options.clock().getTime())
      while (replay.size > maxReplayEntries) replay.delete(replay.keys().next().value as string)
      let body: unknown
      try { body = JSON.parse(raw) } catch { return reject(401, 'Internal HMAC broker body is malformed.') }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) return reject(401, 'Internal HMAC broker body is malformed.')
      const providerEventId = `broker-${options.nonceFactory()}`.slice(0, 160); const observedAt = options.clock().toISOString()
      try {
        const result = await handler({ path, body: body as Record<string, unknown>, requestNonce, providerEventId, observedAt })
        return response(path, requestNonce, 200, result, providerEventId, observedAt)
      } catch (error) {
        const candidate = error as { statusCode?: unknown; statusMessage?: unknown; message?: unknown }
        const status = Number.isInteger(candidate?.statusCode) ? Math.min(Math.max(Number(candidate.statusCode), 400), 599) : 503
        const statusMessage = typeof candidate?.statusMessage === 'string' ? candidate.statusMessage : 'Internal HMAC broker operation failed closed.'
        return response(path, requestNonce, status, { statusCode: status, statusMessage })
      }
    },
  }
}
