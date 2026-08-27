import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { processManagedSitePaymentAndConversion, type ConversionRepositories } from '../conversion-service'
import { getPreviewRepository } from '../ordering-repository'
import { getManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { managedSiteCommerceSnapshotFingerprint } from '../prepurchase-service'
import type { PreviewRepository } from '../ordering-types'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import type {
  ManagedSiteConnectorExecutionMode,
  ManagedSiteCredentialResolver,
  ManagedSiteLiveConnectorRepository,
  ManagedSitePaymentWebhookAdapter,
  ManagedSiteVerifiedPaymentWebhook,
} from './types'

const MAX_WEBHOOK_BYTES = 1_000_000

function forbidden(message: string): never { throw createError({ statusCode: 403, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }

function validateVerifiedEvent(event: ManagedSiteVerifiedPaymentWebhook, clock: () => Date): ManagedSiteVerifiedPaymentWebhook {
  if (!isOpaqueReference(event.providerKey, 96) || !isOpaqueReference(event.providerEventId, 160) || !isOpaqueReference(event.providerReference, 160) || !isOpaqueReference(event.exactResponseIdentity, 256)) invalid('Verified payment webhook identity is invalid.')
  if (!['checkout_succeeded', 'checkout_failed', 'checkout_cancelled', 'payment_refunded'].includes(event.eventType)) invalid('Verified payment webhook lifecycle event is invalid.')
  if (!Number.isSafeInteger(event.draftOrderId) || event.draftOrderId < 1 || !Number.isSafeInteger(event.amountMinor) || event.amountMinor < 0 || !/^[A-Z]{3}$/u.test(event.currency) || !/^[a-f0-9]{64}$/u.test(event.canonicalPayloadHash)) invalid('Verified payment webhook commercial identity is invalid.')
  const occurredAt = new Date(event.occurredAt)
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > clock().getTime() + 5 * 60_000) invalid('Verified payment webhook timestamp is invalid.')
  return event
}

function receiptIdentity(event: ManagedSiteVerifiedPaymentWebhook, ownerUserId: number, projectId: number | null) {
  return stableFingerprint({ ownerUserId, projectId, providerKey: event.providerKey, providerEventId: event.providerEventId, providerReference: event.providerReference, eventType: event.eventType, draftOrderId: event.draftOrderId, amountMinor: event.amountMinor, currency: event.currency, occurredAt: event.occurredAt, exactResponseIdentity: event.exactResponseIdentity, canonicalPayloadHash: event.canonicalPayloadHash })
}

async function reconcileRefundedRelease(ownerUserId: number, releaseId: number, repository: ManagedSiteLiveConnectorRepository): Promise<void> {
  const current = await repository.findRelease(ownerUserId, releaseId)
  if (!current || current.status === 'blocked' && current.blockedReasonCode === 'PAYMENT_REFUNDED') return
  const updated = await repository.transitionRelease(ownerUserId, current.id, current.status, current.projectionFingerprint, { status: 'blocked', blockedReasonCode: 'PAYMENT_REFUNDED', nextSafeAction: 'review_refund_and_live_site_suspension', projectionFingerprint: stableFingerprint({ previous: current.projectionFingerprint, authority: 'verified_payment_refund' }) })
  if (!updated) conflict('Release changed concurrently while applying verified refund authority.')
}

export async function processManagedSiteRawPaymentWebhook(
  input: {
    rawBody: Uint8Array
    signatureHeader: string
    credentialReference: string
    executionMode: Exclude<ManagedSiteConnectorExecutionMode, 'dry_run'>
  },
  adapter: ManagedSitePaymentWebhookAdapter,
  dependencies: {
    connectorRepository?: ManagedSiteLiveConnectorRepository
    orderingRepository?: PreviewRepository
    managedRepository?: ManagedSiteRepository
    credentialResolver?: ManagedSiteCredentialResolver
    clock?: () => Date
  } = {},
) {
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength < 2 || input.rawBody.byteLength > MAX_WEBHOOK_BYTES) invalid('Payment webhook raw body is invalid or oversized.')
  if (typeof input.signatureHeader !== 'string' || input.signatureHeader.length < 1 || input.signatureHeader.length > 1024) forbidden('Payment webhook signature is missing or invalid.')
  if (!isOpaqueReference(input.credentialReference, 160)) forbidden('Payment webhook credential reference is invalid.')
  if (input.executionMode === 'mocked' && process.env.NODE_ENV !== 'test') forbidden('Mocked payment webhooks are restricted to tests.')
  const credentialResolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())

  // Signature verification intentionally occurs before any repository is obtained or queried.
  const rawVerified = await adapter.verifyRawWebhook({ rawBody: input.rawBody, signatureHeader: input.signatureHeader, credentialReference: input.credentialReference, resolveCredential: credentialResolver })
  if (!rawVerified) forbidden('Payment webhook signature verification failed.')
  const event = validateVerifiedEvent(rawVerified, clock)

  const connectorRepository = dependencies.connectorRepository || getManagedSiteLiveConnectorRepository()
  const orderingRepository = dependencies.orderingRepository || getPreviewRepository()
  const managedRepository = dependencies.managedRepository || getManagedSiteRepository()
  const order = await orderingRepository.findDraftOrderById(event.draftOrderId)
  if (!order || !order.ownerUserId) throw createError({ statusCode: 404, statusMessage: 'Payment webhook order lineage was not found or owner-claimed.' })
  const providerConfiguration = await connectorRepository.findProviderConfiguration(order.ownerUserId, 'payment')
  if (input.executionMode === 'live') {
    const verified = await requireVerifiedManagedSiteProvider(order.ownerUserId, 'payment', connectorRepository, credentialResolver)
    if (verified.providerKey !== event.providerKey) conflict('Payment webhook provider does not match the verified owner configuration.')
  } else if (!providerConfiguration || !['mock', 'verified'].includes(providerConfiguration.readinessStatus) || providerConfiguration.providerKey !== event.providerKey) {
    conflict('Mock payment webhook does not match an explicit test provider configuration.')
  }
  const quote = await orderingRepository.findQuoteById(order.quoteId)
  if (!quote || quote.ownerUserId !== order.ownerUserId || quote.totalMinor !== event.amountMinor || quote.currency !== event.currency) conflict('Payment webhook amount, currency, quote, or owner lineage does not match the server-derived order snapshot.')
  const lines = await orderingRepository.listQuoteLines(quote.id)
  const commerceSnapshotFingerprint = managedSiteCommerceSnapshotFingerprint({ previewId: order.previewId, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
  const commercialReceipts = await connectorRepository.listReceiptsByDraftOrder(order.ownerUserId, order.id)
  const checkout = commercialReceipts.find(receipt => receipt.receiptType === 'checkout_session_created' && receipt.receiptStatus === 'verified' && receipt.releaseId && (receipt.metadata as any)?.snapshotFingerprint === commerceSnapshotFingerprint)
  const release = checkout?.releaseId ? await connectorRepository.findRelease(order.ownerUserId, checkout.releaseId) : null
  const refundedProjection = release?.status === 'blocked' && release.blockedReasonCode === 'PAYMENT_REFUNDED'
  if (!order.projectId || !checkout || !release || !(['checkout_pending', 'payment_verified'].includes(release.status) || refundedProjection) || release.projectId !== order.projectId || release.previewId !== order.previewId || release.quoteId !== quote.id || release.draftOrderId !== order.id || release.commerceSnapshotFingerprint !== commerceSnapshotFingerprint) conflict('Payment webhook is not bound to an exact approved release checkout snapshot.')
  const provisionalFingerprint = receiptIdentity(event, order.ownerUserId, order.projectId)
  const existing = await connectorRepository.findReceiptByProviderEvent(event.providerKey, event.providerEventId)
  if (existing) {
    if (existing.receiptFingerprint !== provisionalFingerprint && (existing.metadata as any)?.eventIdentityFingerprint !== provisionalFingerprint) conflict('Payment provider event was replayed with a different payload or order identity.')
    if (existing.receiptType === 'payment_refunded' && existing.receiptStatus === 'verified' && (existing.metadata as any)?.effective === true && existing.releaseId) await reconcileRefundedRelease(order.ownerUserId, existing.releaseId, connectorRepository)
    return { event: existing, replayed: true, effective: existing.receiptStatus === 'verified' }
  }

  let projectId = order.projectId
  let effective = true
  let receiptStatus: 'verified' | 'ignored_out_of_order' = 'verified'
  if (event.eventType === 'checkout_succeeded') {
    const previousSucceeded = commercialReceipts.some(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified') || order.status === 'payment_verified' || release.status === 'payment_verified'
    const previouslyCancelled = commercialReceipts.some(receipt => receipt.receiptType === 'checkout_cancelled' && receipt.receiptStatus === 'verified') || order.status === 'cancelled'
    if (previousSucceeded || previouslyCancelled) { receiptStatus = 'ignored_out_of_order'; effective = false }
    else {
      const conversionRepositories: ConversionRepositories = { ordering: orderingRepository, managed: managedRepository }
      const result = await processManagedSitePaymentAndConversion({ providerKey: event.providerKey, eventId: event.providerEventId, providerReference: event.providerReference, eventType: 'payment_succeeded', draftOrderId: event.draftOrderId, amountMinor: event.amountMinor, currency: event.currency, canonicalPayloadHash: event.canonicalPayloadHash, idempotencyKey: stableFingerprint({ event: event.providerEventId, order: event.draftOrderId }) }, { verify: async request => request.providerKey === event.providerKey && request.eventId === event.providerEventId && request.providerReference === event.providerReference && request.draftOrderId === event.draftOrderId && request.amountMinor === event.amountMinor && request.currency === event.currency && request.canonicalPayloadHash === event.canonicalPayloadHash }, conversionRepositories)
      projectId = result.project.id
    }
  } else {
    const previous = await connectorRepository.listReceiptsByDraftOrder(order.ownerUserId, order.id)
    const succeeded = previous.some(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified') || order.status === 'payment_verified'
    const refunded = previous.some(receipt => receipt.receiptType === 'payment_refunded' && receipt.receiptStatus === 'verified')
    if (((event.eventType === 'checkout_failed' || event.eventType === 'checkout_cancelled') && succeeded) || (event.eventType === 'payment_refunded' && (!succeeded || refunded))) {
      receiptStatus = 'ignored_out_of_order'
      effective = false
    } else if (event.eventType === 'checkout_cancelled') {
      await orderingRepository.updateDraftOrder(order.id, { status: 'cancelled', updatedAt: clock() } as any)
    } else if (event.eventType === 'payment_refunded' && projectId) {
      await managedRepository.updateSubscription(order.ownerUserId, projectId, { status: 'suspended' } as any)
      await managedRepository.updateProject(order.ownerUserId, projectId, { status: 'suspended' } as any)
    }
  }
  const finalFingerprint = receiptIdentity(event, order.ownerUserId, projectId)
  const attemptFingerprint = stableFingerprint({ operation: 'payment_webhook_transition', finalFingerprint })
  const attempt = await connectorRepository.insertAttempt({ ownerUserId: order.ownerUserId, projectId, draftOrderId: order.id, releaseId: null, capability: 'payment', operation: 'payment_webhook_transition', executionMode: input.executionMode, status: 'succeeded', attemptNumber: 1, maxAttempts: 1, timeoutMs: 10_000, requestFingerprint: attemptFingerprint, idempotencyKey: stableFingerprint({ providerKey: event.providerKey, providerEventId: event.providerEventId }), leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: event.exactResponseIdentity, errorCode: null, errorSummary: null } as any)
  const receipt = await connectorRepository.insertReceipt({ ownerUserId: order.ownerUserId, projectId, draftOrderId: order.id, releaseId: release.id, attemptId: attempt.id, capability: 'payment', providerKey: event.providerKey, providerEventId: event.providerEventId, receiptType: event.eventType, receiptStatus, externalReference: event.providerReference, exactResponseIdentity: event.exactResponseIdentity, requestFingerprint: attemptFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { occurredAt: event.occurredAt, previewId: order.previewId, quoteId: quote.id, draftOrderId: order.id, commerceSnapshotFingerprint, checkoutReceiptFingerprint: checkout.receiptFingerprint, amountMinor: event.amountMinor, currency: event.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, lineSnapshotFingerprint: (checkout.metadata as any)?.lineSnapshotFingerprint, canonicalPayloadHash: event.canonicalPayloadHash, eventIdentityFingerprint: finalFingerprint, effective }, receiptFingerprint: finalFingerprint, verifiedAt: clock() } as any)
  if (event.eventType === 'payment_refunded' && receiptStatus === 'verified' && effective) await reconcileRefundedRelease(order.ownerUserId, release.id, connectorRepository)
  return { event: receipt, replayed: false, effective, projectId }
}
