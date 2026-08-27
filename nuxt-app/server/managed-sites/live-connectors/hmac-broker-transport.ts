import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { assertAllowedManagedSiteProviderOrigin } from './provider-verifiers'
import type { ManagedSiteCredentialResolver } from './types'

export const MANAGED_SITE_BROKER_PATHS = [
  '/v1/managed-sites/verify',
  '/v1/managed-sites/checkout-sessions',
  '/v1/managed-sites/domain/quote',
  '/v1/managed-sites/domain/purchase',
  '/v1/managed-sites/dns-tls/apply',
  '/v1/managed-sites/ownership/challenge',
  '/v1/managed-sites/ownership/verify',
] as const
export type ManagedSiteBrokerPath = typeof MANAGED_SITE_BROKER_PATHS[number]

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60_000

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function hmac(key: string, value: string): string { return createHmac('sha256', key).update(value).digest('hex') }

export function managedSiteBrokerSignature(input: { method: 'POST'; path: ManagedSiteBrokerPath; timestamp: string; nonce: string; bodyHash: string; requestNonce?: string }, credential: string): string {
  return hmac(credential, [input.method, input.path, input.timestamp, input.nonce, input.requestNonce || '-', input.bodyHash].join('\n'))
}

export async function readBoundedManagedSiteResponse(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const announced = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(announced) && announced > maxBytes) throw createError({ statusCode: 409, statusMessage: 'Provider response is oversized.' })
  if (!response.body) return ''
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) { await reader.cancel(); throw createError({ statusCode: 409, statusMessage: 'Provider response is oversized.' }) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function strictJson(raw: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw createError({ statusCode: 409, statusMessage: 'Provider response is malformed.' }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw createError({ statusCode: 409, statusMessage: 'Provider response is malformed.' })
  return parsed as Record<string, unknown>
}

export type ManagedSiteHmacBrokerTransport = {
  post(path: ManagedSiteBrokerPath, payload: Record<string, unknown>, options?: { timeoutMs?: number; idempotencyKey?: string }): Promise<{ body: Record<string, unknown>; bodyHash: string; providerRequestId: string; observedAt: string; exactResponseIdentity: string }>
}

export function createManagedSiteHmacBrokerTransport(options: { endpointOrigin: string; providerKey: string; credentialReference: string; resolveCredential: ManagedSiteCredentialResolver; fetchImpl?: typeof fetch; clock?: () => Date; nonceFactory?: () => string }): ManagedSiteHmacBrokerTransport {
  const origin = assertAllowedManagedSiteProviderOrigin(options.endpointOrigin)
  const fetchImpl = options.fetchImpl || fetch
  const clock = options.clock || (() => new Date())
  const nonceFactory = options.nonceFactory || (() => randomBytes(18).toString('hex'))
  return {
    async post(path, payload, callOptions = {}) {
      if (!(MANAGED_SITE_BROKER_PATHS as readonly string[]).includes(path)) throw createError({ statusCode: 503, statusMessage: 'Provider broker path is not allowlisted.' })
      const credential = await options.resolveCredential(options.credentialReference)
      if (!credential.ok) throw createError({ statusCode: 503, statusMessage: 'Provider credential reference is unresolved.' })
      const body = JSON.stringify(payload)
      if (Buffer.byteLength(body, 'utf8') > 128 * 1024) throw createError({ statusCode: 422, statusMessage: 'Provider request is oversized.' })
      const bodyHash = sha256(body); const timestamp = clock().toISOString(); const nonce = nonceFactory()
      const signature = managedSiteBrokerSignature({ method: 'POST', path, timestamp, nonce, bodyHash }, credential.value)
      const controller = new AbortController(); const timeoutMs = Math.min(Math.max(callOptions.timeoutMs || 12_000, 1_000), 30_000); const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(`${origin}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-discoverystack-provider-key': options.providerKey, 'x-discoverystack-timestamp': timestamp, 'x-discoverystack-nonce': nonce, 'x-discoverystack-body-sha256': bodyHash, 'x-discoverystack-signature': signature, ...(callOptions.idempotencyKey ? { 'idempotency-key': callOptions.idempotencyKey } : {}) }, body })
      } catch { throw createError({ statusCode: 503, statusMessage: controller.signal.aborted ? 'Provider broker request timed out.' : 'Provider broker transport failed.' }) } finally { clearTimeout(timer) }
      if (!response.ok) throw createError({ statusCode: response.status === 409 ? 409 : 503, statusMessage: 'Provider broker rejected the request.' })
      const responseRaw = await readBoundedManagedSiteResponse(response); const responseBodyHash = sha256(responseRaw)
      const responseTimestamp = response.headers.get('x-discoverystack-timestamp') || ''
      const responseNonce = response.headers.get('x-discoverystack-nonce') || ''
      const providerRequestId = response.headers.get('x-provider-request-id') || ''
      const responseSignature = response.headers.get('x-discoverystack-signature') || ''
      if (!Number.isFinite(Date.parse(responseTimestamp)) || Math.abs(clock().getTime() - Date.parse(responseTimestamp)) > MAX_CLOCK_SKEW_MS || !/^[A-Za-z0-9._:-]{8,160}$/u.test(responseNonce) || !/^[A-Za-z0-9._:-]{3,160}$/u.test(providerRequestId) || !/^[a-f0-9]{64}$/u.test(responseSignature)) throw createError({ statusCode: 409, statusMessage: 'Provider broker response identity is incomplete.' })
      const expected = managedSiteBrokerSignature({ method: 'POST', path, timestamp: responseTimestamp, nonce: responseNonce, requestNonce: nonce, bodyHash: responseBodyHash }, credential.value)
      const suppliedBytes = Buffer.from(responseSignature, 'hex'); const expectedBytes = Buffer.from(expected, 'hex')
      if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) throw createError({ statusCode: 409, statusMessage: 'Provider broker response signature is invalid.' })
      return { body: strictJson(responseRaw), bodyHash: responseBodyHash, providerRequestId, observedAt: responseTimestamp, exactResponseIdentity: `hmac-response:${stableFingerprint({ providerKey: options.providerKey, path, providerRequestId, responseNonce, responseBodyHash })}` }
    },
  }
}

export function assertExactManagedSiteProviderObject(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw createError({ statusCode: 409, statusMessage: 'Provider response contains unsupported fields.' })
}
