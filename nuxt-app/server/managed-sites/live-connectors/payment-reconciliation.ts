import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { readBoundedManagedSiteResponse } from './hmac-broker-transport'
import { processManagedSiteVerifiedPaymentWebhook, type ManagedSiteJointTransaction } from './payment-webhook'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import { assertAllowedManagedSiteProviderOrigin } from './provider-verifiers'
import { getManagedSiteLiveConnectorRepository } from './repository'
import type { ManagedSiteCredentialResolver, ManagedSiteLiveConnectorRepository, ManagedSitePaymentEventType, ManagedSiteVerifiedPaymentWebhook } from './types'

const STRIPE_READ_TIMEOUT_MS = 10_000
const STRIPE_READ_MAX_BYTES = 64 * 1024

type ReconciliationDependencies = {
  repository?: ManagedSiteLiveConnectorRepository
  orderingRepository?: PreviewRepository
  jointTransaction?: ManagedSiteJointTransaction
  credentialResolver?: ManagedSiteCredentialResolver
  fetchImpl?: typeof fetch
  clock?: () => Date
}

function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unavailable(message: string): never { throw createError({ statusCode: 503, statusMessage: message }) }
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function stripeId(value: unknown, prefix: 'cs' | 'pi' | 'ch' | 'in' | 'sub'): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9_]{3,156}$`, 'u').test(value)) conflict('Stripe reconciliation returned a malformed object identity.')
  return value
}

async function stripeGet(origin: string, path: string, credential: string, fetchImpl: typeof fetch): Promise<{ value: Record<string, unknown>; responseHash: string }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), STRIPE_READ_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(`${origin}${path}`, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${credential}` } })
  } catch { throw createError({ statusCode: 503, statusMessage: controller.signal.aborted ? 'Stripe reconciliation timed out.' : 'Stripe reconciliation transport failed.' }) } finally { clearTimeout(timer) }
  if (!response.ok) unavailable('Stripe reconciliation read was rejected.')
  const raw = await readBoundedManagedSiteResponse(response, STRIPE_READ_MAX_BYTES)
  let value: unknown
  try { value = JSON.parse(raw) } catch { conflict('Stripe reconciliation response is malformed.') }
  if (!plain(value)) conflict('Stripe reconciliation response is malformed.')
  return { value, responseHash: stableFingerprint(raw) }
}

export async function reconcileManagedSiteStripePayment(ownerUserId: number, input: { projectId: number; releaseId: number; idempotencyKey: string }, dependencies: ReconciliationDependencies = {}) {
  if (![ownerUserId, input.projectId, input.releaseId].every(value => Number.isSafeInteger(value) && value > 0) || !isOpaqueReference(input.idempotencyKey, 128)) throw createError({ statusCode: 422, statusMessage: 'Stripe reconciliation request identity is invalid.' })
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const ordering = dependencies.orderingRepository || getPreviewRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const fetchImpl = dependencies.fetchImpl || fetch
  const clock = dependencies.clock || (() => new Date())
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  if (!release || release.projectId !== input.projectId || !release.draftOrderId) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped managed-site release was not found.' })
  const order = await ordering.findDraftOrderById(release.draftOrderId)
  const quote = order ? await ordering.findQuoteById(order.quoteId) : null
  if (!order || order.ownerUserId !== ownerUserId || order.projectId !== input.projectId || !quote || quote.ownerUserId !== ownerUserId) conflict('Stripe reconciliation commercial lineage is incomplete.')
  const configuration = await requireVerifiedManagedSiteProvider(ownerUserId, 'payment', repository, resolver)
  const transport = record(configuration.transportConfiguration) ? configuration.transportConfiguration : {}
  if (configuration.providerKey !== 'stripe' || !configuration.credentialReference || typeof transport.endpointOrigin !== 'string' || !configuration.verificationReceiptFingerprint || !configuration.capabilityIdentity) unavailable('Verified Stripe payment provider is not configured.')
  const origin = assertAllowedManagedSiteProviderOrigin(transport.endpointOrigin)
  const credential = await resolver(configuration.credentialReference)
  if (!credential.ok) unavailable('Stripe credential reference is unresolved.')
  const receipts = await repository.listReceiptsByDraftOrder(ownerUserId, order.id)
  const checkout = receipts.find(receipt => receipt.receiptType === 'checkout_session_created' && receipt.receiptStatus === 'verified' && receipt.providerKey === 'stripe' && receipt.releaseId === release.id)
  const checkoutMetadata = checkout && record(checkout.metadata) ? checkout.metadata : {}
  const sessionId = stripeId(checkout?.externalReference, 'cs')
  if (!checkout || !sessionId || checkoutMetadata.configurationFingerprint !== configuration.configurationFingerprint || checkoutMetadata.verificationReceiptFingerprint !== configuration.verificationReceiptFingerprint || checkoutMetadata.snapshotFingerprint !== release.commerceSnapshotFingerprint) conflict('Stripe checkout evidence is missing or no longer matches provider authority.')

  const sessionRead = await stripeGet(origin, `/v1/checkout/sessions/${sessionId}`, credential.value, fetchImpl)
  const session = sessionRead.value
  if (session.object !== 'checkout_session' || session.id !== sessionId || !Number.isSafeInteger(session.created) || Number(session.created) < 1 || !Number.isSafeInteger(session.amount_total) || typeof session.currency !== 'string' || !/^[a-z]{3}$/u.test(session.currency) || typeof session.payment_status !== 'string' || typeof session.status !== 'string') conflict('Stripe checkout reconciliation identity is mismatched.')
  const succeededReceipt = receipts.find(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified' && record(receipt.metadata))
  const succeededMetadata = succeededReceipt && record(succeededReceipt.metadata) ? succeededReceipt.metadata : {}
  const paymentIntentId = stripeId(succeededMetadata.stripePaymentIntentId ?? session.payment_intent, 'pi')
  let paymentIntent: Record<string, unknown> | null = null; let paymentIntentHash: string | null = null; let charge: Record<string, unknown> | null = null; let chargeHash: string | null = null
  if (paymentIntentId) {
    const read = await stripeGet(origin, `/v1/payment_intents/${paymentIntentId}`, credential.value, fetchImpl)
    paymentIntent = read.value; paymentIntentHash = read.responseHash
    if (paymentIntent.object !== 'payment_intent' || paymentIntent.id !== paymentIntentId || !Number.isSafeInteger(paymentIntent.created) || Number(paymentIntent.created) < 1 || typeof paymentIntent.status !== 'string' || typeof paymentIntent.currency !== 'string' || !Number.isSafeInteger(paymentIntent.amount_received)) conflict('Stripe PaymentIntent reconciliation identity is mismatched.')
    const chargeId = stripeId(paymentIntent.latest_charge, 'ch')
    if (chargeId) {
      const chargeRead = await stripeGet(origin, `/v1/charges/${chargeId}`, credential.value, fetchImpl)
      charge = chargeRead.value; chargeHash = chargeRead.responseHash
      if (charge.object !== 'charge' || charge.id !== chargeId || !Number.isSafeInteger(charge.created) || Number(charge.created) < 1 || typeof charge.currency !== 'string' || !Number.isSafeInteger(charge.amount) || !Number.isSafeInteger(charge.amount_refunded) || typeof charge.refunded !== 'boolean' || typeof charge.disputed !== 'boolean') conflict('Stripe Charge reconciliation identity is mismatched.')
    }
  }

  const paid = session.payment_status === 'paid' || paymentIntent?.status === 'succeeded'
  const refundedAmount = charge && Number(charge.amount_refunded) > 0 ? Number(charge.amount_refunded) : 0
  const lifecycle = charge?.disputed === true ? 'disputed' : refundedAmount > 0 || charge?.refunded === true ? 'refunded' : paid ? 'paid' : 'unpaid'
  const chargeId = stripeId(charge?.id, 'ch')
  const invoiceId = stripeId(session.invoice ?? paymentIntent?.invoice, 'in')
  const subscriptionId = stripeId(session.subscription, 'sub')
  const objectId = lifecycle === 'paid' ? paymentIntentId || sessionId : chargeId || paymentIntentId || sessionId
  const providerCreated = lifecycle === 'refunded' || lifecycle === 'disputed' ? Number(charge?.created) : paymentIntent ? Number(paymentIntent.created) : Number(session.created)
  const amountMinor = lifecycle === 'refunded' ? refundedAmount : lifecycle === 'disputed' ? Number(charge?.amount || quote.totalMinor) : Number(session.amount_total)
  const currency = String(charge?.currency || paymentIntent?.currency || session.currency).toUpperCase()
  const reported = {
    lifecycle,
    checkoutSessionId: sessionId,
    checkoutStatus: session.status,
    paymentStatus: session.payment_status,
    paymentIntentId,
    paymentIntentStatus: typeof paymentIntent?.status === 'string' ? paymentIntent.status : null,
    latestChargeId: typeof charge?.id === 'string' ? charge.id : null,
    chargeRefunded: charge?.refunded === true,
    amountRefunded: refundedAmount,
    chargeDisputed: charge?.disputed === true,
    amountMinor,
    currency,
    providerCreated,
  }
  const localLifecycle = receipts.some(receipt => receipt.receiptType === 'payment_disputed' && receipt.receiptStatus === 'verified' && record(receipt.metadata) && receipt.metadata.effective === true) || order.status === 'disputed'
    ? 'disputed'
    : receipts.some(receipt => receipt.receiptType === 'payment_refunded' && receipt.receiptStatus === 'verified' && record(receipt.metadata) && receipt.metadata.effective === true) || order.status === 'refunded'
      ? 'refunded'
      : receipts.some(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified') || order.status === 'payment_verified'
        ? 'paid'
        : 'unpaid'
  const agreesWithLocalState = lifecycle === localLifecycle
  const responseIdentity = stableFingerprint({ sessionHash: sessionRead.responseHash, paymentIntentHash, chargeHash, reported })
  const observationRequestFingerprint = stableFingerprint({ operation: 'stripe_payment_reconcile', ownerUserId, projectId: input.projectId, releaseId: release.id, orderId: order.id, idempotencyKey: input.idempotencyKey })
  const observationProviderEventId = `stripe-reconcile-observation-${stableFingerprint({ ownerUserId, idempotencyKey: input.idempotencyKey }).slice(0, 96)}`.slice(0, 160)
  const observationReceiptFingerprint = stableFingerprint({ observationRequestFingerprint, responseIdentity, reported, agreesWithLocalState })
  const observation = await repository.transaction(async transaction => {
    let attempt = await transaction.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
    if (attempt && attempt.requestFingerprint !== observationRequestFingerprint) conflict('Stripe reconciliation idempotency key collides with another request.')
    if (!attempt) attempt = await transaction.insertAttempt({ ownerUserId, projectId: input.projectId, draftOrderId: order.id, releaseId: release.id, capability: 'payment', operation: 'payment_reconcile', executionMode: 'live', status: 'succeeded', attemptNumber: 1, maxAttempts: 1, timeoutMs: STRIPE_READ_TIMEOUT_MS, requestFingerprint: observationRequestFingerprint, idempotencyKey: input.idempotencyKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: `stripe-reconcile:${responseIdentity}`, errorCode: null, errorSummary: null } as any)
    return transaction.insertReceipt({ ownerUserId, projectId: input.projectId, draftOrderId: order.id, releaseId: release.id, attemptId: attempt.id, capability: 'payment', providerKey: 'stripe', providerEventId: observationProviderEventId, receiptType: 'payment_reconciliation', receiptStatus: 'verified', externalReference: sessionId, exactResponseIdentity: `stripe-reconcile:${responseIdentity}`, requestFingerprint: observationRequestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { reported, localOrderStatus: order.status, localLifecycle, agreesWithLocalState, configurationFingerprint: configuration.configurationFingerprint, verificationReceiptFingerprint: configuration.verificationReceiptFingerprint }, receiptFingerprint: observationReceiptFingerprint, verifiedAt: clock() } as any)
  })

  let transition: Awaited<ReturnType<typeof processManagedSiteVerifiedPaymentWebhook>> | null = null
  if (!agreesWithLocalState && lifecycle !== 'unpaid') {
    const eventType: ManagedSitePaymentEventType = lifecycle === 'paid' ? 'checkout_succeeded' : lifecycle === 'refunded' ? 'payment_refunded' : 'payment_disputed'
    const verifiedEvent: ManagedSiteVerifiedPaymentWebhook = {
      providerKey: 'stripe', providerEventId: `reconcile-${lifecycle}-${objectId}`.slice(0, 160), providerReference: objectId, eventType, draftOrderId: order.id, ownerUserId, releaseId: release.id,
      amountMinor, currency, occurredAt: new Date(providerCreated * 1000).toISOString(), exactResponseIdentity: `stripe-reconcile-event:${responseIdentity}`, canonicalPayloadHash: responseIdentity,
      configurationFingerprint: configuration.configurationFingerprint, verificationReceiptFingerprint: configuration.verificationReceiptFingerprint, checkoutReceiptFingerprint: checkout.receiptFingerprint,
      ...(release.commerceSnapshotFingerprint ? { snapshotFingerprint: release.commerceSnapshotFingerprint } : {}),
      stripeCheckoutSessionId: sessionId,
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      ...(chargeId ? { stripeChargeId: chargeId } : {}),
      ...(invoiceId ? { stripeInvoiceId: invoiceId } : {}),
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    }
    const transitionDependencies = dependencies.jointTransaction ? { jointTransaction: dependencies.jointTransaction, credentialResolver: resolver, clock } : { credentialResolver: resolver, clock }
    transition = await processManagedSiteVerifiedPaymentWebhook({ verifiedEvent, executionMode: 'live' }, transitionDependencies)
    if ((lifecycle === 'refunded' || lifecycle === 'disputed') && localLifecycle === 'unpaid') {
      const paidReference = paymentIntentId || sessionId
      const paidEvent: ManagedSiteVerifiedPaymentWebhook = {
        ...verifiedEvent,
        providerEventId: `reconcile-paid-${paidReference}`.slice(0, 160),
        providerReference: paidReference,
        eventType: 'checkout_succeeded',
        amountMinor: Number(session.amount_total),
        currency: String(paymentIntent?.currency || session.currency).toUpperCase(),
        occurredAt: new Date(Number(paymentIntent?.created ?? session.created) * 1000).toISOString(),
      }
      transition = await processManagedSiteVerifiedPaymentWebhook({ verifiedEvent: paidEvent, executionMode: 'live' }, transitionDependencies)
    }
  }
  return { reported, agreesWithLocalState, evidenceReceiptId: observation.id, transition: transition ? { replayed: transition.replayed, effective: transition.effective } : null }
}
