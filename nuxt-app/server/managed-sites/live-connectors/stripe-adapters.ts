import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { assertManagedSiteCheckoutOrigin } from './canonical'
import { readBoundedManagedSiteResponse } from './hmac-broker-transport'
import { assertAllowedManagedSiteProviderOrigin } from './provider-verifiers'
import type { ManagedSiteCheckoutSessionAdapter, ManagedSiteCredentialResolver, ManagedSitePaymentEventType, ManagedSitePaymentWebhookAdapter, ManagedSiteSignatureVerifiedPaymentWebhook } from './types'

export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300
const STRIPE_CHECKOUT_PATH = '/v1/checkout/sessions'
const STRIPE_METADATA_KEYS = [
  'ds_draft_order_id',
  'ds_release_id',
  'ds_owner_user_id',
  'ds_configuration_fingerprint',
  'ds_verification_receipt_fingerprint',
  'ds_checkout_receipt_fingerprint',
  'ds_snapshot_fingerprint',
] as const

type StripeMetadataKey = typeof STRIPE_METADATA_KEYS[number]
type StripeMetadata = Record<StripeMetadataKey, string>
type StripeCheckoutOptions = {
  endpointOrigin: string
  checkoutOrigin: string
  returnOrigin: string
  credentialReference: string
  resolveCredential: ManagedSiteCredentialResolver
  fetchImpl?: typeof fetch
}

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function mismatch(message = 'Stripe response does not match the exact managed-site checkout snapshot.'): never { throw createError({ statusCode: 409, statusMessage: message }) }
function invalidWebhook(): never { throw createError({ statusCode: 400, statusMessage: 'Stripe webhook signature or payload is invalid.' }) }
export type StripeWebhookIgnoredReason = 'unsupported_event_type' | 'unbindable_provider_reference'
export class StripeWebhookIgnoredError extends Error {
  constructor(readonly ignored: StripeWebhookIgnoredReason) { super(`Stripe webhook ignored: ${ignored}`); this.name = 'StripeWebhookIgnoredError' }
}
export function stripeWebhookIgnoredReason(error: unknown): StripeWebhookIgnoredReason | null { return error instanceof StripeWebhookIgnoredError ? error.ignored : null }
function ignoredWebhook(reason: StripeWebhookIgnoredReason): never { throw new StripeWebhookIgnoredError(reason) }

function exactStripeCheckoutOrigin(value: string): string {
  let origin: string
  try { origin = assertManagedSiteCheckoutOrigin(value) } catch { throw createError({ statusCode: 503, statusMessage: 'Verified Stripe checkout origin must be https://checkout.stripe.com.' }) }
  if (origin !== 'https://checkout.stripe.com') throw createError({ statusCode: 503, statusMessage: 'Verified Stripe checkout origin must be https://checkout.stripe.com.' })
  return origin
}

function exactStripeReturnOrigin(value: string): string {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw createError({ statusCode: 503, statusMessage: 'Verified Stripe return origin is not configured as an exact HTTPS origin.' }) }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw createError({ statusCode: 503, statusMessage: 'Verified Stripe return origin is not configured as an exact HTTPS origin.' })
  return parsed.origin
}

function metadataFor(input: Parameters<ManagedSiteCheckoutSessionAdapter['createSession']>[0]): StripeMetadata {
  return {
    ds_draft_order_id: String(input.draftOrderId),
    ds_release_id: String(input.releaseId),
    ds_owner_user_id: String(input.ownerUserId),
    ds_configuration_fingerprint: input.configurationFingerprint,
    ds_verification_receipt_fingerprint: input.verificationReceiptFingerprint,
    ds_checkout_receipt_fingerprint: input.checkoutReceiptFingerprint,
    ds_snapshot_fingerprint: input.snapshotFingerprint,
  }
}

function appendMetadata(body: URLSearchParams, prefix: string, metadata: StripeMetadata): void {
  for (const key of STRIPE_METADATA_KEYS) body.append(`${prefix}[${key}]`, metadata[key])
}

function exactMetadata(value: unknown): StripeMetadata {
  if (!plain(value) || STRIPE_METADATA_KEYS.some(key => !Object.hasOwn(value, key))) invalidWebhook()
  for (const key of STRIPE_METADATA_KEYS) if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 500) invalidWebhook()
  return value as StripeMetadata
}

function bindableMetadata(value: unknown): StripeMetadata | null {
  if (!plain(value)) return null
  const present = STRIPE_METADATA_KEYS.filter(key => Object.hasOwn(value, key))
  for (const key of present) if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 500) invalidWebhook()
  if (present.length !== STRIPE_METADATA_KEYS.length) return null
  return exactMetadata(value)
}

function assertEchoedMetadata(value: unknown, expected: StripeMetadata): void {
  if (!plain(value) || Object.keys(value).length !== STRIPE_METADATA_KEYS.length || Object.keys(value).some(key => !(STRIPE_METADATA_KEYS as readonly string[]).includes(key))) mismatch('Stripe checkout metadata echo is incomplete or contains unsupported fields.')
  for (const key of STRIPE_METADATA_KEYS) if (value[key] !== expected[key]) mismatch('Stripe checkout metadata echo does not match the exact server-derived snapshot.')
}

/**
 * A positive cadenceDays is the server contract for a recurring plan. It maps
 * directly to Stripe's daily interval_count; zero is the one-time payment rule.
 */
export function stripeCheckoutMode(cadenceDays: number): 'subscription' | 'payment' {
  if (!Number.isSafeInteger(cadenceDays) || cadenceDays < 0 || cadenceDays > 1095) throw createError({ statusCode: 422, statusMessage: 'Stripe checkout cadence is invalid.' })
  return cadenceDays > 0 ? 'subscription' : 'payment'
}

export function createStripeCheckoutSessionAdapter(options: StripeCheckoutOptions): ManagedSiteCheckoutSessionAdapter {
  const endpointOrigin = assertAllowedManagedSiteProviderOrigin(options.endpointOrigin)
  exactStripeCheckoutOrigin(options.checkoutOrigin)
  const returnOrigin = exactStripeReturnOrigin(options.returnOrigin)
  const fetchImpl = options.fetchImpl || fetch
  return {
    async createSession(input) {
      const mode = stripeCheckoutMode(input.cadenceDays)
      const maxLines = mode === 'subscription' ? 20 : 100
      if (!input.lineSnapshot.length || input.lineSnapshot.length > maxLines) throw createError({ statusCode: 422, statusMessage: 'Stripe checkout line count is invalid for the selected mode.' })
      let total = 0
      for (const line of input.lineSnapshot) {
        if (typeof line.lineKey !== 'string' || line.lineKey.length < 1 || line.lineKey.length > 120 || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || !Number.isSafeInteger(line.unitAmountMinor) || line.unitAmountMinor < 0 || !Number.isSafeInteger(line.lineAmountMinor) || line.lineAmountMinor !== line.quantity * line.unitAmountMinor) mismatch('Stripe checkout line snapshot is invalid or internally inconsistent.')
        total += line.lineAmountMinor
        if (!Number.isSafeInteger(total)) mismatch('Stripe checkout line total exceeds the supported integer range.')
      }
      if (total !== input.amountMinor) mismatch('Stripe checkout line total does not match the canonical order amount.')
      if (!/^[A-Z]{3}$/u.test(input.currency)) throw createError({ statusCode: 422, statusMessage: 'Stripe checkout currency is invalid.' })

      const metadata = metadataFor(input)
      const body = new URLSearchParams()
      body.append('mode', mode)
      body.append('currency', input.currency.toLowerCase())
      body.append('success_url', `${returnOrigin}/managed-sites/checkout/success`)
      body.append('cancel_url', `${returnOrigin}/managed-sites/checkout/cancel`)
      appendMetadata(body, 'metadata', metadata)
      appendMetadata(body, mode === 'subscription' ? 'subscription_data[metadata]' : 'payment_intent_data[metadata]', metadata)
      input.lineSnapshot.forEach((line, index) => {
        body.append(`line_items[${index}][quantity]`, String(line.quantity))
        body.append(`line_items[${index}][price_data][currency]`, input.currency.toLowerCase())
        body.append(`line_items[${index}][price_data][unit_amount]`, String(line.unitAmountMinor))
        body.append(`line_items[${index}][price_data][product_data][name]`, line.lineKey)
        if (mode === 'subscription') {
          body.append(`line_items[${index}][price_data][recurring][interval]`, 'day')
          body.append(`line_items[${index}][price_data][recurring][interval_count]`, String(input.cadenceDays))
        }
      })

      const credential = await options.resolveCredential(options.credentialReference)
      if (!credential.ok) throw createError({ statusCode: 503, statusMessage: 'Stripe credential reference is unresolved.' })
      const controller = new AbortController(); const timeoutMs = Math.min(Math.max(input.timeoutMs, 1_000), 30_000); const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(`${endpointOrigin}${STRIPE_CHECKOUT_PATH}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${credential.value}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': input.idempotencyKey }, body: body.toString() })
      } catch { throw createError({ statusCode: 503, statusMessage: controller.signal.aborted ? 'Stripe checkout request timed out.' : 'Stripe checkout transport failed.' }) } finally { clearTimeout(timer) }
      if (!response.ok) throw createError({ statusCode: response.status === 409 ? 409 : 503, statusMessage: 'Stripe rejected the checkout request.' })
      const raw = await readBoundedManagedSiteResponse(response)
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { mismatch('Stripe checkout response is malformed.') }
      if (!plain(parsed)) mismatch('Stripe checkout response must be a plain JSON object.')
      if (parsed.object !== 'checkout_session' || typeof parsed.id !== 'string' || !/^cs_[A-Za-z0-9_]{3,156}$/u.test(parsed.id) || typeof parsed.url !== 'string' || !Number.isSafeInteger(parsed.amount_total) || parsed.amount_total !== input.amountMinor || typeof parsed.currency !== 'string' || parsed.currency.toUpperCase() !== input.currency) mismatch()
      assertEchoedMetadata(parsed.metadata, metadata)
      const responseBodyHash = sha256(raw)
      return { providerKey: 'stripe', providerEventId: parsed.id, providerReference: parsed.id, checkoutUrl: parsed.url, draftOrderId: input.draftOrderId, amountMinor: input.amountMinor, currency: input.currency, snapshotFingerprint: input.snapshotFingerprint, configurationFingerprint: input.configurationFingerprint, verificationReceiptFingerprint: input.verificationReceiptFingerprint, capabilityIdentity: input.capabilityIdentity, exactResponseIdentity: `stripe-response:${stableFingerprint({ providerKey: 'stripe', path: STRIPE_CHECKOUT_PATH, sessionId: parsed.id, responseBodyHash })}` }
    },
  }
}

function signatureParts(header: string): { timestamp: number; signatures: Buffer[] } {
  if (typeof header !== 'string' || header.length < 1 || header.length > 1024) invalidWebhook()
  let timestamp: number | null = null
  const signatures: Buffer[] = []
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim(); const separator = part.indexOf('=')
    if (separator < 1 || separator === part.length - 1) invalidWebhook()
    const key = part.slice(0, separator); const value = part.slice(separator + 1)
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,16}$/u.test(value)) invalidWebhook()
      timestamp = Number(value)
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) invalidWebhook()
    } else if (key === 'v1') {
      if (!/^[a-f0-9]{64}$/iu.test(value)) invalidWebhook()
      signatures.push(Buffer.from(value, 'hex'))
    } else if (key === 'v0') {
      if (!/^[a-f0-9]+$/iu.test(value)) invalidWebhook()
    } else invalidWebhook()
  }
  if (timestamp === null || !signatures.length) invalidWebhook()
  return { timestamp, signatures }
}

function positiveIntegerMetadata(value: string): number {
  if (!/^[1-9]\d{0,14}$/u.test(value)) invalidWebhook()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) invalidWebhook()
  return parsed
}

function fingerprintMetadata(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) invalidWebhook()
  return value
}

function stripeObjectId(value: unknown, prefix: 'cs' | 'pi' | 'ch' | 'in' | 'sub'): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_]{3,156}$`, 'u').test(value)) invalidWebhook()
  return value
}

function stripeEvent(value: unknown, rawBody: Uint8Array): ManagedSiteSignatureVerifiedPaymentWebhook {
  if (!plain(value) || value.object !== 'event' || typeof value.id !== 'string' || !/^evt_[A-Za-z0-9_]{3,156}$/u.test(value.id) || typeof value.type !== 'string' || !Number.isSafeInteger(value.created) || Number(value.created) < 1 || !plain(value.data) || !plain(value.data.object)) invalidWebhook()
  const object = value.data.object
  let eventType: ManagedSitePaymentEventType
  let expectedObject: string
  let amountField: string
  if (value.type === 'checkout.session.completed') {
    eventType = object.payment_status === 'paid' ? 'checkout_succeeded' : 'checkout_failed'; expectedObject = 'checkout_session'; amountField = 'amount_total'
  } else if (value.type === 'payment_intent.succeeded') {
    eventType = 'checkout_succeeded'; expectedObject = 'payment_intent'; amountField = 'amount_received'
  } else if (value.type === 'charge.refunded') {
    eventType = 'payment_refunded'; expectedObject = 'charge'; amountField = 'amount_refunded'
  } else if (value.type === 'charge.dispute.created') {
    eventType = 'payment_disputed'; expectedObject = object.object === 'dispute' ? 'dispute' : 'charge'; amountField = 'amount'
  } else ignoredWebhook('unsupported_event_type')
  if (object.object !== expectedObject || typeof object.id !== 'string' || !Number.isSafeInteger(object[amountField]) || Number(object[amountField]) < 0 || typeof object.currency !== 'string' || !/^[a-z]{3}$/u.test(object.currency)) invalidWebhook()
  const metadata = bindableMetadata(object.metadata)
  const providerReference = expectedObject === 'dispute' ? object.charge : object.id
  if (typeof providerReference !== 'string' || !/^(?:cs|pi|ch)_[A-Za-z0-9_]{3,156}$/u.test(providerReference)) invalidWebhook()
  const stripeCheckoutSessionId = stripeObjectId(expectedObject === 'checkout_session' ? object.id : object.checkout_session, 'cs')
  const stripePaymentIntentId = stripeObjectId(expectedObject === 'payment_intent' ? object.id : object.payment_intent, 'pi')
  const stripeChargeId = stripeObjectId(expectedObject === 'charge' ? object.id : expectedObject === 'dispute' ? object.charge : object.latest_charge, 'ch')
  const stripeInvoiceId = stripeObjectId(object.invoice, 'in')
  const stripeSubscriptionId = stripeObjectId(object.subscription, 'sub')
  const verified = {
    providerKey: 'stripe', providerEventId: value.id, providerReference, eventType,
    amountMinor: Number(object[amountField]), currency: object.currency.toUpperCase(), occurredAt: new Date(Number(value.created) * 1000).toISOString(),
    exactResponseIdentity: `stripe-event:${stableFingerprint({ providerKey: 'stripe', providerEventId: value.id })}`,
    canonicalPayloadHash: sha256(rawBody),
    ...(stripeCheckoutSessionId ? { stripeCheckoutSessionId } : {}),
    ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
    ...(stripeChargeId ? { stripeChargeId } : {}),
    ...(stripeInvoiceId ? { stripeInvoiceId } : {}),
    ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
  }
  if (!metadata) return verified
  return {
    ...verified,
    draftOrderId: positiveIntegerMetadata(metadata.ds_draft_order_id),
    ownerUserId: positiveIntegerMetadata(metadata.ds_owner_user_id),
    releaseId: positiveIntegerMetadata(metadata.ds_release_id),
    configurationFingerprint: fingerprintMetadata(metadata.ds_configuration_fingerprint),
    verificationReceiptFingerprint: fingerprintMetadata(metadata.ds_verification_receipt_fingerprint),
    checkoutReceiptFingerprint: fingerprintMetadata(metadata.ds_checkout_receipt_fingerprint),
    snapshotFingerprint: fingerprintMetadata(metadata.ds_snapshot_fingerprint),
  }
}

export function createStripePaymentWebhookAdapter(options: { clock?: () => Date } = {}): ManagedSitePaymentWebhookAdapter {
  const clock = options.clock || (() => new Date())
  return {
    async verifyRawWebhook(input) {
      const { timestamp, signatures } = signatureParts(input.signatureHeader)
      if (Math.abs(Math.floor(clock().getTime() / 1000) - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) invalidWebhook()
      const credential = await input.resolveCredential(input.credentialReference)
      if (!credential.ok) invalidWebhook()
      const expected = createHmac('sha256', credential.value).update(String(timestamp)).update('.').update(input.rawBody).digest()
      if (!signatures.some(signature => signature.length === expected.length && timingSafeEqual(signature, expected))) invalidWebhook()
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.from(input.rawBody).toString('utf8')) } catch { invalidWebhook() }
      return stripeEvent(parsed, input.rawBody)
    },
  }
}
