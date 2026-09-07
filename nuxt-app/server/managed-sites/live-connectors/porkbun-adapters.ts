import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { readBoundedManagedSiteResponse } from './hmac-broker-transport'
import { assertAllowedManagedSiteProviderOrigin } from './provider-verifiers'
import type { ManagedSiteCredentialResolver, ManagedSiteDomainAdapter, ManagedSiteDomainQuote, ManagedSiteProviderAuthoritySnapshot } from './types'

const PORKBUN_API_PATH = '/api/json/v3'
const MAX_RESPONSE_BYTES = 64 * 1024
const PORKBUN_QUOTE_TTL_MS = 5 * 60_000
const MAX_IDEMPOTENT_PURCHASES = 1_024

type PorkbunCredentials = { apiKey: string; secretApiKey: string }
export type PorkbunRegistrantContact = { firstName: string; lastName: string; organization: string; address1: string; city: string; state: string; postalCode: string; country: string; phoneCountryCode: string; phone: string; email: string }
export type PorkbunAdapterOptions = {
  endpointOrigin: string
  providerKey: string
  credentialReference: string
  resolveCredential: ManagedSiteCredentialResolver
  providerAuthorityFingerprint?: string
  fetchImpl?: typeof fetch
  clock?: () => Date
  beforeMutation?: () => Promise<void>
}
type CachedPurchase = { requestFingerprint: string; receipt: Awaited<ReturnType<ManagedSiteDomainAdapter['createPurchaseIntent']>> }

function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function responseMismatch(message = 'Porkbun response does not match the managed-site domain request.'): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unresolvedCredential(): never { throw createError({ statusCode: 503, statusMessage: 'Porkbun credential reference is unresolved.' }) }

export function parsePorkbunRegistrantContact(input: unknown): PorkbunRegistrantContact {
  const fields = ['firstName', 'lastName', 'organization', 'address1', 'city', 'state', 'postalCode', 'country', 'phoneCountryCode', 'phone', 'email'] as const
  if (!plain(input) || Object.keys(input).some(key => !(fields as readonly string[]).includes(key) || typeof input[key] !== 'string')) throw createError({ statusCode: 422, statusMessage: '網域登記人資料格式不正確。' })
  const output = Object.fromEntries(fields.map(key => [key, typeof input[key] === 'string' ? input[key].trim().normalize('NFC') : ''])) as PorkbunRegistrantContact
  for (const key of fields) if (output[key].length > (key === 'address1' || key === 'email' ? 200 : 100) || /[\u0000-\u001f\u007f]/u.test(output[key]) || !['lastName', 'organization', 'state'].includes(key) && !output[key]) throw createError({ statusCode: 422, statusMessage: '請填寫完整的網域登記人姓名、地址、電話與 Email。' })
  output.country = output.country.toUpperCase(); output.email = output.email.toLowerCase()
  if (!/^[A-Z]{2}$/u.test(output.country) || !/^[1-9]\d{0,3}$/u.test(output.phoneCountryCode) || !/^\d{4,18}$/u.test(output.phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(output.email)) throw createError({ statusCode: 422, statusMessage: '網域登記人的國家代碼、電話或 Email 不正確。' })
  return output
}

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
  return stableFingerprint({ ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, draftOrderId: input.draftOrderId, commerceSnapshotFingerprint: input.commerceSnapshotFingerprint, quote: input.quote, providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, ownerConfirmationFingerprint: input.ownerConfirmationFingerprint, ...(input.purchaseAuthority ? { purchaseAuthority: input.purchaseAuthority } : {}), paymentReceiptFingerprint: input.paymentReceiptFingerprint, idempotencyKey: input.idempotencyKey })
}

async function postPorkbun(options: PorkbunAdapterOptions, origin: string, path: string, body: Record<string, unknown>, timeoutMs: number, idempotencyKey?: string, method: 'GET' | 'POST' = 'POST'): Promise<{ raw: string; value: Record<string, unknown> }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1), 30_000))
  try {
    const response = await (options.fetchImpl || fetch)(`${origin}${PORKBUN_API_PATH}${path}`, { method, redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', ...(method === 'GET' ? { 'X-API-Key': String(body.apikey), 'X-Secret-API-Key': String(body.secretapikey) } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw createError({ statusCode: response.status === 409 || response.status === 429 ? response.status : 503, statusMessage: 'Porkbun rejected the domain request.' })
    const raw = await readBoundedManagedSiteResponse(response, MAX_RESPONSE_BYTES)
    let value: unknown
    try { value = JSON.parse(raw) } catch { responseMismatch('Porkbun response is malformed.') }
    if (!plain(value)) responseMismatch('Porkbun response must be a plain JSON object.')
    return { raw, value }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({ statusCode: 503, statusMessage: controller.signal.aborted ? 'Porkbun request timed out.' : 'Porkbun transport failed.' })
  } finally { clearTimeout(timer) }
}

function registrationBlocked(code: 'DOMAIN_UNAVAILABLE' | 'DOMAIN_PREMIUM' | 'DOMAIN_UNSUPPORTED', message: string): never {
  throw createError({ statusCode: 409, statusMessage: message, data: { code } })
}

export async function quotePorkbunRegistration(options: PorkbunAdapterOptions, input: { canonicalDomain: string; providerAuthority: ManagedSiteProviderAuthoritySnapshot; requestFingerprint: string; timeoutMs: number; requireAutomaticEligibility?: boolean }): Promise<ManagedSiteDomainQuote> {
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs, 1), 30_000)
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw createError({ statusCode: 503, statusMessage: 'Porkbun quote timed out.' }); return ms }
  if (options.providerKey !== 'porkbun' || options.providerAuthorityFingerprint && options.providerAuthorityFingerprint !== input.providerAuthority.authorityFingerprint) responseMismatch()
  const origin = assertAllowedManagedSiteProviderOrigin(options.endpointOrigin)
  const credential = await credentials(options)
  const expectedIdentity = `porkbun:${porkbunEnvironment(credential.apiKey)}`
  if (input.providerAuthority.capabilityIdentity !== expectedIdentity) responseMismatch('Porkbun credential environment changed after verification.')
  const auth = { apikey: credential.apiKey, secretapikey: credential.secretApiKey }
  if (input.requireAutomaticEligibility) {
    const tld = input.canonicalDomain.slice(input.canonicalDomain.indexOf('.') + 1)
    const requirements = (await postPorkbun(options, origin, `/domain/getRegistrationRequirements/${domainPath(tld)}`, auth, remaining())).value
    if (requirements.status !== 'SUCCESS' || requirements.tld !== tld) responseMismatch('Porkbun registration requirements response is invalid.')
    if (requirements.apiRegisterable !== true || requirements.requiresValidatedAddress !== false || requirements.registryRequirements !== null || requirements.registrationDurationYears !== 1) registrationBlocked('DOMAIN_UNSUPPORTED', '此網域結尾需要額外登記驗證，暫不支援自動註冊，請選擇其他結尾。')
  }
  const { raw, value } = await postPorkbun(options, origin, `/domain/checkDomain/${domainPath(input.canonicalDomain)}`, auth, remaining())
  if (value.status !== 'SUCCESS' || !plain(value.response) || expectedIdentity === 'porkbun:production' && value.sandbox === true) responseMismatch('Porkbun availability response is invalid.')
  const result = value.response
  if (result.avail === 'no') registrationBlocked('DOMAIN_UNAVAILABLE', '這個網域已被註冊，請選擇其他名稱。')
  if (result.avail !== 'yes' || !['yes', 'no'].includes(String(result.premium)) || !Number.isSafeInteger(result.minDuration) || Number(result.minDuration) < 1 || Number(result.minDuration) > 10) responseMismatch('Porkbun availability response is invalid.')
  if (result.premium === 'yes') registrationBlocked('DOMAIN_PREMIUM', '此網域屬於特殊價格網域，暫不支援自動註冊。')
  if (input.requireAutomaticEligibility && result.minDuration !== 1) registrationBlocked('DOMAIN_UNSUPPORTED', '此網域不支援一年期自動註冊。')
  const amountMinor = dollarsToMinor(result.price) * Number(result.minDuration)
  if (!Number.isSafeInteger(amountMinor)) responseMismatch('Porkbun registration total is invalid.')
  const responseHash = createHash('sha256').update(raw).digest('hex')
  return { providerKey: 'porkbun', quoteId: `porkbun-quote:${stableFingerprint({ canonicalDomain: input.canonicalDomain, requestFingerprint: input.requestFingerprint, responseHash }).slice(0, 48)}`, canonicalDomain: input.canonicalDomain, amountMinor, currency: 'USD', expiresAt: new Date((options.clock || (() => new Date()))().getTime() + PORKBUN_QUOTE_TTL_MS).toISOString(), providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: `porkbun-domain-check:${stableFingerprint({ path: '/domain/checkDomain', canonicalDomain: input.canonicalDomain, responseHash })}` }
}

/** Direct Porkbun registrar adapter. Credentials are resolved only at call time and never enter receipts or errors. */
export function createPorkbunDomainAdapter(options: PorkbunAdapterOptions): ManagedSiteDomainAdapter {
  if (options.providerKey !== 'porkbun') throw createError({ statusCode: 503, statusMessage: 'Unsupported domain provider adapter.' })
  const origin = assertAllowedManagedSiteProviderOrigin(options.endpointOrigin)
  const completedPurchases = new Map<string, CachedPurchase>()
  const clock = options.clock || (() => new Date())
  return {
    async quote(input) {
      return quotePorkbunRegistration(options, input)
    },
    async createPurchaseIntent(input) {
      // The governed attempt lease is 25 seconds. Spend at most the caller's
      // 15-second provider budget across all calls, leaving time for receipts.
      const deadline = Date.now() + Math.min(Math.max(input.timeoutMs, 1), 15_000)
      const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw createError({ statusCode: 503, statusMessage: 'Porkbun registration reached its bounded provider budget.' }); return ms }
      if (options.providerAuthorityFingerprint && options.providerAuthorityFingerprint !== input.providerAuthority.authorityFingerprint) responseMismatch()
      const requestFingerprint = purchaseRequestFingerprint(input)
      const cached = completedPurchases.get(input.idempotencyKey)
      if (cached) {
        if (cached.requestFingerprint !== requestFingerprint) throw createError({ statusCode: 409, statusMessage: 'Porkbun purchase idempotency key collides with another request.' })
        return cached.receipt
      }
      const credential = await credentials(options)
      if (input.providerAuthority.capabilityIdentity !== `porkbun:${porkbunEnvironment(credential.apiKey)}`) responseMismatch('Porkbun credential environment changed after verification.')
      const delegated = input.purchaseAuthority
      const registrant = delegated ? parsePorkbunRegistrantContact(delegated.registrant) : null
      if (delegated && (delegated.kind !== 'customer_domain_delegation_v1' || !/^[a-f0-9]{64}$/u.test(delegated.fingerprint) || porkbunEnvironment(credential.apiKey) !== 'production' || input.providerAuthority.capabilityIdentity !== 'porkbun:production' || !input.beforeMutation || !input.onRegistrationCreated)) responseMismatch('Customer domain delegation requires verified production registration authority.')
      if (!delegated && !/^[a-f0-9]{64}$/u.test(input.ownerConfirmationFingerprint)) responseMismatch('Porkbun registration requires explicit purchase authority.')
      if (input.quote.currency !== 'USD' || !Number.isSafeInteger(input.quote.amountMinor) || input.quote.amountMinor < 1 || input.quote.providerKey !== 'porkbun' || input.quote.providerAuthorityFingerprint !== input.providerAuthority.authorityFingerprint) responseMismatch('Porkbun purchase quote is invalid.')
      const auth = { apikey: credential.apiKey, secretapikey: credential.secretApiKey }
      const path = domainPath(input.quote.canonicalDomain)
      let receipt = input.registrationReceipt
      if (receipt && (receipt.providerKey !== 'porkbun' || receipt.canonicalDomain !== input.quote.canonicalDomain || receipt.providerAuthorityFingerprint !== input.providerAuthority.authorityFingerprint || !/^[1-9]\d{0,31}$/u.test(receipt.providerReference) || receipt.providerEventId !== receipt.providerReference)) responseMismatch('Porkbun recorded registration does not match the requested domain.')
      if (input.reconcileOnly || receipt) {
        const owned = (await postPorkbun(options, origin, `/domain/get/${path}`, auth, remaining(), undefined, 'GET')).value
        if (owned.status !== 'SUCCESS' || !plain(owned.domain) || owned.domain.domain !== input.quote.canonicalDomain || owned.domain.status !== 'ACTIVE' || owned.domain.notLocal !== 0 || owned.domain.apiAccess !== 1) responseMismatch('Porkbun registration outcome is not confirmed for this account.')
      } else {
        if (!Number.isFinite(Date.parse(input.quote.expiresAt)) || Date.parse(input.quote.expiresAt) <= clock().getTime()) responseMismatch('Porkbun purchase quote expired before registration.')
        await (input.beforeMutation || options.beforeMutation)?.()
        const { raw, value } = await postPorkbun(options, origin, `/domain/create/${path}`, { ...auth, cost: input.quote.amountMinor, agreeToTerms: 'yes', whoisPrivacy: 'yes' }, remaining(), input.idempotencyKey)
        const orderId = typeof value.orderId === 'string' && /^[1-9]\d{0,31}$/u.test(value.orderId) ? value.orderId : Number.isSafeInteger(value.orderId) && Number(value.orderId) > 0 ? String(value.orderId) : null
        if (value.status !== 'SUCCESS' || value.dryRun === true || value.domain !== input.quote.canonicalDomain || value.cost !== input.quote.amountMinor || !orderId) responseMismatch('Porkbun registration response is invalid or does not match the approved domain and cost.')
        receipt = { providerKey: 'porkbun', providerEventId: orderId, providerReference: orderId, canonicalDomain: input.quote.canonicalDomain, status: 'purchase_intent_created', providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: `porkbun-domain-create:${stableFingerprint({ canonicalDomain: input.quote.canonicalDomain, idempotencyKey: input.idempotencyKey, responseHash: createHash('sha256').update(raw).digest('hex') })}` }
        await input.onRegistrationCreated?.(receipt)
      }
      if (registrant) {
        let contacts = await postPorkbun(options, origin, `/domain/getContacts/${path}`, auth, remaining())
        const matches = () => { try { const actual = plain(contacts.value.contacts) && plain(contacts.value.contacts.registrant) ? contacts.value.contacts.registrant : null; return contacts.value.status === 'SUCCESS' && actual && stableFingerprint(parsePorkbunRegistrantContact(Object.fromEntries(Object.keys(registrant).map(key => [key, actual[key]])))) === stableFingerprint(registrant) } catch { return false } }
        if (!matches()) {
          if (!receipt) responseMismatch('Porkbun registration outcome is unknown; unrelated registrant contacts will not be overwritten.')
          await input.beforeMutation!()
          const changed = await postPorkbun(options, origin, `/domain/updateContacts/${path}`, { ...auth, contacts: { registrant } }, remaining(), `${input.idempotencyKey}:registrant`)
          if (changed.value.status !== 'SUCCESS' || changed.value.dryRun === true) responseMismatch('Porkbun registrant update was not confirmed.')
          contacts = await postPorkbun(options, origin, `/domain/getContacts/${path}`, auth, remaining())
          if (!matches()) responseMismatch('Porkbun registrant readback does not match the delegated customer.')
        }
        const responseHash = createHash('sha256').update(contacts.raw).digest('hex')
        receipt = { providerKey: 'porkbun', providerEventId: receipt?.providerEventId || `porkbun-reconcile:${stableFingerprint({ canonicalDomain: input.quote.canonicalDomain, responseHash })}`, providerReference: receipt?.providerReference || `domain:${input.quote.canonicalDomain}`, canonicalDomain: input.quote.canonicalDomain, status: 'registered', providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint, exactResponseIdentity: `porkbun-customer-registrant:${stableFingerprint({ registrationIdentity: receipt?.exactResponseIdentity || null, canonicalDomain: input.quote.canonicalDomain, responseHash, registrantFingerprint: stableFingerprint(registrant) })}` }
      }
      if (!receipt) responseMismatch('Porkbun registration outcome has no verified external identity.')
      receipt = { ...receipt, status: 'registered' }
      completedPurchases.set(input.idempotencyKey, { requestFingerprint, receipt })
      if (completedPurchases.size > MAX_IDEMPOTENT_PURCHASES) completedPurchases.delete(completedPurchases.keys().next().value as string)
      return receipt
    },
  }
}

/** Changes registry delegation only for this newly purchased managed domain and the exact Cloudflare pair. */
export async function updatePorkbunDomainNameservers(input: { canonicalDomain: string; nameservers: string[]; idempotencyKey: string; timeoutMs: number }, options: PorkbunAdapterOptions): Promise<{ verified: boolean; exactResponseIdentity: string }> {
  const deadline = Date.now() + Math.min(Math.max(input.timeoutMs, 1), 30_000)
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw createError({ statusCode: 503, statusMessage: 'Porkbun nameserver verification timed out.' }); return ms }
  const desired = [...new Set(input.nameservers.map(value => value.toLowerCase().replace(/\.$/u, '')))].sort()
  if (options.providerKey !== 'porkbun' || desired.length !== 2 || desired.some(value => !/^[a-z0-9-]+\.ns\.cloudflare\.com$/u.test(value)) || !/^[A-Za-z0-9._:-]{8,128}$/u.test(input.idempotencyKey)) responseMismatch('Porkbun nameserver target is invalid.')
  const origin = assertAllowedManagedSiteProviderOrigin(options.endpointOrigin)
  const credential = await credentials(options)
  if (porkbunEnvironment(credential.apiKey) !== 'production' || !options.beforeMutation) responseMismatch('Production nameserver changes require current verified registration authority.')
  const auth = { apikey: credential.apiKey, secretapikey: credential.secretApiKey }; const path = domainPath(input.canonicalDomain)
  const read = async () => {
    const response = await postPorkbun(options, origin, `/domain/getNs/${path}`, auth, remaining())
    if (response.value.status !== 'SUCCESS' || !Array.isArray(response.value.ns) || !response.value.ns.length || response.value.ns.length > 13 || response.value.ns.some(value => typeof value !== 'string')) responseMismatch('Porkbun nameserver readback is malformed.')
    return { raw: response.raw, nameservers: [...new Set((response.value.ns as string[]).map(value => value.toLowerCase().replace(/\.$/u, '')))].sort() }
  }
  let observed = await read()
  if (stableFingerprint(observed.nameservers) !== stableFingerprint(desired)) {
    if (observed.nameservers.some(value => !/^[a-z0-9.-]+\.porkbun\.com$/u.test(value))) responseMismatch('Unrelated existing nameservers require an explicit separate change authorization.')
    await options.beforeMutation()
    const changed = await postPorkbun(options, origin, `/domain/updateNs/${path}`, { ...auth, ns: desired }, remaining(), input.idempotencyKey)
    if (changed.value.status !== 'SUCCESS' || changed.value.dryRun === true) responseMismatch('Porkbun nameserver update was not confirmed.')
    observed = await read()
  }
  return { verified: stableFingerprint(observed.nameservers) === stableFingerprint(desired), exactResponseIdentity: `porkbun-nameservers:${stableFingerprint({ canonicalDomain: input.canonicalDomain, nameservers: observed.nameservers, responseHash: createHash('sha256').update(observed.raw).digest('hex') })}` }
}
