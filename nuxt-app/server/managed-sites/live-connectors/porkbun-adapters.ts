import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { readBoundedManagedSiteResponse } from './hmac-broker-transport'
import { assertAllowedManagedSiteProviderOrigin } from './provider-verifiers'
import type { ManagedSiteCredentialResolver, ManagedSiteDomainAdapter } from './types'

const PORKBUN_API_PATH = '/api/json/v3'
const MAX_RESPONSE_BYTES = 64 * 1024
const PORKBUN_QUOTE_TTL_MS = 5 * 60_000
const MAX_IDEMPOTENT_PURCHASES = 1_024

type PorkbunCredentials = { apiKey: string; secretApiKey: string }
type PorkbunAdapterOptions = {
  endpointOrigin: string
  providerKey: string
  credentialReference: string
  resolveCredential: ManagedSiteCredentialResolver
  providerAuthorityFingerprint?: string
  fetchImpl?: typeof fetch
  clock?: () => Date
}
type CachedPurchase = { requestFingerprint: string; receipt: Awaited<ReturnType<ManagedSiteDomainAdapter['createPurchaseIntent']>> }

function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function responseMismatch(message = 'Porkbun response does not match the managed-site domain request.'): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unresolvedCredential(): never { throw createError({ statusCode: 503, statusMessage: 'Porkbun credential reference is unresolved.' }) }

/** Classifies only the Porkbun API-key prefix; it never retains or returns credential material. */
export function porkbunEnvironment(apiKey: string): 'sandbox' | 'production' { return apiKey.startsWith('pk1_sb_') ? 'sandbox' : 'production' }

function parsePorkbunCredentials(value: string): PorkbunCredentials {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { unresolvedCredential() }
  if (!plain(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'apiKey') || !Object.hasOwn(parsed, 'secretApiKey') || typeof parsed.apiKey !== 'string' || parsed.apiKey.length < 1 || parsed.apiKey.length > 512 || typeof parsed.secretApiKey !== 'string' || parsed.secretApiKey.length < 1 || parsed.secretApiKey.length > 512) unresolvedCredential()
  return { apiKey: parsed.apiKey, secretApiKey: parsed.secretApiKey }
}

async function credentials(options: PorkbunAdapterOptions): Promise<PorkbunCredentials> {
  const resolved = await options.resolveCredential(options.credentialReference)
  if (!resolved.ok) unresolvedCredential()
  return parsePorkbunCredentials(resolved.value)
}

function dollarsToMinor(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/u.test(value)) responseMismatch('Porkbun domain price is invalid.')
  const [whole, fraction = ''] = value.split('.')
  const amountMinor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2))
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) responseMismatch('Porkbun domain price is invalid.')
  return amountMinor
}

function domainPath(domain: string): string {
  if (typeof domain !== 'string' || domain.length < 1 || domain.length > 253 || !/^[a-z0-9.-]+$/u.test(domain)) throw createError({ statusCode: 422, statusMessage: 'Porkbun canonical domain is invalid.' })
  return encodeURIComponent(domain)
}

function purchaseRequestFingerprint(input: Parameters<ManagedSiteDomainAdapter['createPurchaseIntent']>[0]): string {
  return stableFingerprint({ ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, draftOrderId: input.draftOrderId, commerceSnapshotFingerprint: input.commerceSnapshotFingerprint, quote: input.quote, providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, ownerConfirmationFingerprint: input.ownerConfirmationFingerprint, paymentReceiptFingerprint: input.paymentReceiptFingerprint, idempotencyKey: input.idempotencyKey })
}

async function postPorkbun(options: PorkbunAdapterOptions, origin: string, path: string, body: Record<string, unknown>, timeoutMs: number, idempotencyKey?: string): Promise<{ raw: string; value: Record<string, unknown> }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1_000), 30_000))
  let response: Response
  try {
    response = await (options.fetchImpl || fetch)(`${origin}${PORKBUN_API_PATH}${path}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}) }, body: JSON.stringify(body) })
  } catch {
    throw createError({ statusCode: 503, statusMessage: controller.signal.aborted ? 'Porkbun request timed out.' : 'Porkbun transport failed.' })
  } finally { clearTimeout(timer) }
  if (!response.ok) throw createError({ statusCode: response.status === 409 ? 409 : 503, statusMessage: 'Porkbun rejected the domain request.' })
  const raw = await readBoundedManagedSiteResponse(response, MAX_RESPONSE_BYTES)
  let value: unknown
  try { value = JSON.parse(raw) } catch { responseMismatch('Porkbun response is malformed.') }
  if (!plain(value)) responseMismatch('Porkbun response must be a plain JSON object.')
  return { raw, value }
}

/** Direct Porkbun registrar adapter. Credentials are resolved only at call time and never enter receipts or errors. */
export function createPorkbunDomainAdapter(options: PorkbunAdapterOptions): ManagedSiteDomainAdapter {
  if (options.providerKey !== 'porkbun') throw createError({ statusCode: 503, statusMessage: 'Unsupported domain provider adapter.' })
  const origin = assertAllowedManagedSiteProviderOrigin(options.endpointOrigin)
  const completedPurchases = new Map<string, CachedPurchase>()
  const clock = options.clock || (() => new Date())
  return {
    async quote(input) {
      if (options.providerAuthorityFingerprint && options.providerAuthorityFingerprint !== input.providerAuthority.authorityFingerprint) responseMismatch()
      const credential = await credentials(options)
      const { raw, value } = await postPorkbun(options, origin, `/domain/checkDomain/${domainPath(input.canonicalDomain)}`, { apikey: credential.apiKey, secretapikey: credential.secretApiKey }, input.timeoutMs)
      if (value.status !== 'SUCCESS' || value.avail !== 'yes') responseMismatch(value.status === 'SUCCESS' ? 'Porkbun reports the domain is unavailable.' : 'Porkbun availability response is invalid.')
      const amountMinor = dollarsToMinor(value.price)
      const responseHash = createHash('sha256').update(raw).digest('hex')
      return { providerKey: 'porkbun', quoteId: `porkbun-quote:${stableFingerprint({ canonicalDomain: input.canonicalDomain, requestFingerprint: input.requestFingerprint, responseHash }).slice(0, 48)}`, canonicalDomain: input.canonicalDomain, amountMinor, currency: 'USD', expiresAt: new Date(clock().getTime() + PORKBUN_QUOTE_TTL_MS).toISOString(), providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: `porkbun-domain-check:${stableFingerprint({ path: '/domain/checkDomain', canonicalDomain: input.canonicalDomain, responseHash })}` }
    },
    async createPurchaseIntent(input) {
      if (options.providerAuthorityFingerprint && options.providerAuthorityFingerprint !== input.providerAuthority.authorityFingerprint) responseMismatch()
      const requestFingerprint = purchaseRequestFingerprint(input)
      const cached = completedPurchases.get(input.idempotencyKey)
      if (cached) {
        if (cached.requestFingerprint !== requestFingerprint) throw createError({ statusCode: 409, statusMessage: 'Porkbun purchase idempotency key collides with another request.' })
        return cached.receipt
      }
      const credential = await credentials(options)
      const { raw, value } = await postPorkbun(options, origin, `/domain/create/${domainPath(input.quote.canonicalDomain)}`, { apikey: credential.apiKey, secretapikey: credential.secretApiKey, years: 1 }, input.timeoutMs, input.idempotencyKey)
      if (value.status !== 'SUCCESS') responseMismatch('Porkbun registration response is invalid.')
      const confirmedRegistrationId = typeof value.id === 'string' && /^[1-9]\d{0,31}$/u.test(value.id) ? value.id : Number.isSafeInteger(value.id) && Number(value.id) > 0 ? String(value.id) : null
      const responseHash = createHash('sha256').update(raw).digest('hex')
      const providerEventId = confirmedRegistrationId || `porkbun-purchase:${stableFingerprint({ idempotencyKey: input.idempotencyKey, responseHash }).slice(0, 48)}`
      const receipt = { providerKey: 'porkbun', providerEventId, providerReference: confirmedRegistrationId || providerEventId, canonicalDomain: input.quote.canonicalDomain, status: confirmedRegistrationId ? 'registered' as const : 'purchase_intent_created' as const, providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: `porkbun-domain-create:${stableFingerprint({ canonicalDomain: input.quote.canonicalDomain, idempotencyKey: input.idempotencyKey, responseHash })}` }
      completedPurchases.set(input.idempotencyKey, { requestFingerprint, receipt })
      if (completedPurchases.size > MAX_IDEMPOTENT_PURCHASES) completedPurchases.delete(completedPurchases.keys().next().value as string)
      return receipt
    },
  }
}
