import { createError } from 'h3'
import { getDatabase } from '../../database'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { processManagedSitePaymentAndConversion } from '../conversion-service'
import { makeOrderingRepository } from '../ordering-repository'
import { makeManagedSiteRepository } from '../repository'
import type { ManagedSiteRepository } from '../types'
import { managedSiteCommerceSnapshotFingerprint } from '../prepurchase-service'
import type { PreviewRepository } from '../ordering-types'
import { makeManagedSiteLiveConnectorRepository } from './repository'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import type { ManagedSiteConnectorExecutionMode, ManagedSiteCredentialResolver, ManagedSiteLiveConnectorRepository, ManagedSitePaymentWebhookAdapter, ManagedSiteVerifiedPaymentWebhook } from './types'

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

function eventIdentity(event: ManagedSiteVerifiedPaymentWebhook) { return stableFingerprint({ providerKey: event.providerKey, providerEventId: event.providerEventId, providerReference: event.providerReference, eventType: event.eventType, draftOrderId: event.draftOrderId, amountMinor: event.amountMinor, currency: event.currency, occurredAt: event.occurredAt, exactResponseIdentity: event.exactResponseIdentity, canonicalPayloadHash: event.canonicalPayloadHash }) }

export type ManagedSiteJointRepositories = { connector: ManagedSiteLiveConnectorRepository; ordering: PreviewRepository; managed: ManagedSiteRepository }
export type ManagedSiteJointTransaction = <T>(work: (repositories: ManagedSiteJointRepositories) => Promise<T>) => Promise<T>
export type ManagedSitePaymentWebhookFaultPoint = 'after_inbox_claim' | 'after_payment_authority' | 'after_project_update' | 'after_subscription_insert' | 'before_receipt_insert' | 'after_receipt_insert' | 'before_release_cas'

function nonNestedOrdering(repository: PreviewRepository): PreviewRepository { return { ...repository, transaction: async work => work(repository) } }
function productionJointTransaction(): ManagedSiteJointTransaction {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Managed-site joint transaction storage is unavailable.' })
  return work => database.transaction((transaction: any) => work({ connector: makeManagedSiteLiveConnectorRepository(transaction), ordering: makeOrderingRepository(transaction), managed: makeManagedSiteRepository(transaction) })) as Promise<any>
}
function jointBoundary(dependencies: { connectorRepository?: ManagedSiteLiveConnectorRepository; orderingRepository?: PreviewRepository; managedRepository?: ManagedSiteRepository; jointTransaction?: ManagedSiteJointTransaction }): ManagedSiteJointTransaction {
  if (dependencies.jointTransaction) return dependencies.jointTransaction
  if (dependencies.connectorRepository || dependencies.orderingRepository || dependencies.managedRepository) throw createError({ statusCode: 503, statusMessage: 'Injected webhook repositories require one genuine joint transaction boundary.' })
  return productionJointTransaction()
}

export async function processManagedSiteRawPaymentWebhook(
  input: { rawBody: Uint8Array; signatureHeader: string; credentialReference: string; executionMode: Exclude<ManagedSiteConnectorExecutionMode, 'dry_run'> },
  adapter: ManagedSitePaymentWebhookAdapter,
  dependencies: { connectorRepository?: ManagedSiteLiveConnectorRepository; orderingRepository?: PreviewRepository; managedRepository?: ManagedSiteRepository; jointTransaction?: ManagedSiteJointTransaction; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date; faultInjector?: (point: ManagedSitePaymentWebhookFaultPoint) => void | Promise<void> } = {},
) {
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength < 2 || input.rawBody.byteLength > MAX_WEBHOOK_BYTES) invalid('Payment webhook raw body is invalid or oversized.')
  if (typeof input.signatureHeader !== 'string' || input.signatureHeader.length < 1 || input.signatureHeader.length > 1024) forbidden('Payment webhook signature is missing or invalid.')
  if (!isOpaqueReference(input.credentialReference, 160)) forbidden('Payment webhook credential reference is invalid.')
  if (input.executionMode === 'mocked' && process.env.NODE_ENV !== 'test') forbidden('Mocked payment webhooks are restricted to tests.')
  const credentialResolver = dependencies.credentialResolver || resolveManagedSiteCredential; const clock = dependencies.clock || (() => new Date())
  // Raw signature verification is deliberately first: no repository or DB handle exists before it succeeds.
  const rawVerified = await adapter.verifyRawWebhook({ rawBody: input.rawBody, signatureHeader: input.signatureHeader, credentialReference: input.credentialReference, resolveCredential: credentialResolver })
  if (!rawVerified) forbidden('Payment webhook signature verification failed.')
  const event = validateVerifiedEvent(rawVerified, clock); const fingerprint = eventIdentity(event); const transact = jointBoundary(dependencies)

  return transact(async repositories => {
    const existingInbox = await repositories.connector.findPaymentWebhookInbox(event.providerKey, event.providerEventId)
    if (existingInbox && existingInbox.eventFingerprint !== fingerprint) conflict('Payment webhook provider event collided with a different signed payload.')
    if (existingInbox && ['succeeded', 'ignored'].includes(existingInbox.processingStatus)) {
      const receipt = await repositories.connector.findReceiptByProviderEvent(event.providerKey, event.providerEventId)
      if (!receipt) conflict('Completed payment webhook inbox lacks its append-only receipt.')
      return { event: receipt, replayed: true, effective: receipt.receiptStatus === 'verified', projectId: receipt.projectId }
    }
    const processingFingerprint = stableFingerprint({ fingerprint, status: 'processing' })
    const inbox = existingInbox || await repositories.connector.insertPaymentWebhookInbox({ ownerUserId: null, projectId: null, releaseId: null, draftOrderId: event.draftOrderId, providerKey: event.providerKey, providerEventId: event.providerEventId, eventType: event.eventType, canonicalPayloadHash: event.canonicalPayloadHash, exactResponseIdentity: event.exactResponseIdentity, eventFingerprint: fingerprint, processingStatus: 'processing', processingFingerprint, completedAt: null } as any)
    await dependencies.faultInjector?.('after_inbox_claim')
    const order = await repositories.ordering.findDraftOrderById(event.draftOrderId)
    if (!order?.ownerUserId || !order.projectId) throw createError({ statusCode: 404, statusMessage: 'Payment webhook order lineage was not found or owner-claimed.' })
    const ownerUserId = order.ownerUserId
    const configuration = input.executionMode === 'live' ? await requireVerifiedManagedSiteProvider(ownerUserId, 'payment', repositories.connector, credentialResolver) : await repositories.connector.findProviderConfiguration(ownerUserId, 'payment')
    if (!configuration || configuration.providerKey !== event.providerKey || input.executionMode === 'mocked' && !['mock', 'verified'].includes(configuration.readinessStatus)) conflict('Payment webhook does not match the explicit owner provider configuration.')
    const quote = await repositories.ordering.findQuoteById(order.quoteId); const lines = quote ? await repositories.ordering.listQuoteLines(quote.id) : []
    if (!quote || quote.ownerUserId !== ownerUserId || quote.totalMinor !== event.amountMinor || quote.currency !== event.currency || !lines.length) conflict('Payment webhook commercial identity does not match the server-derived quote.')
    const commerceSnapshotFingerprint = managedSiteCommerceSnapshotFingerprint({ previewId: order.previewId, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
    const receipts = await repositories.connector.listReceiptsByDraftOrder(ownerUserId, order.id)
    const checkout = receipts.find(receipt => receipt.receiptType === 'checkout_session_created' && receipt.receiptStatus === 'verified' && receipt.releaseId && (receipt.metadata as any)?.snapshotFingerprint === commerceSnapshotFingerprint)
    const release = checkout?.releaseId ? await repositories.connector.findRelease(ownerUserId, checkout.releaseId) : null
    if (!checkout || !release || release.projectId !== order.projectId || release.previewId !== order.previewId || release.quoteId !== quote.id || release.draftOrderId !== order.id || release.commerceSnapshotFingerprint !== commerceSnapshotFingerprint) conflict('Payment webhook is not bound to the exact approved release checkout snapshot.')

    const previousSuccess = receipts.some(receipt => receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified') || order.status === 'payment_verified'
    const previousRefund = receipts.some(receipt => receipt.receiptType === 'payment_refunded' && receipt.receiptStatus === 'verified' && (receipt.metadata as any)?.effective === true)
    const previousCancel = receipts.some(receipt => receipt.receiptType === 'checkout_cancelled' && receipt.receiptStatus === 'verified') || order.status === 'cancelled'
    let effective = true; let receiptStatus: 'verified' | 'ignored_out_of_order' = 'verified'; const projectId = order.projectId
    if (event.eventType === 'checkout_succeeded') {
      if (previousSuccess || previousCancel) { effective = false; receiptStatus = 'ignored_out_of_order' }
      else {
        const ordering = nonNestedOrdering(repositories.ordering)
        await processManagedSitePaymentAndConversion({ providerKey: event.providerKey, eventId: event.providerEventId, providerReference: event.providerReference, eventType: 'payment_succeeded', draftOrderId: event.draftOrderId, amountMinor: event.amountMinor, currency: event.currency, canonicalPayloadHash: event.canonicalPayloadHash, idempotencyKey: stableFingerprint({ event: event.providerEventId, order: event.draftOrderId }) }, { verify: async request => request.providerKey === event.providerKey && request.eventId === event.providerEventId && request.providerReference === event.providerReference && request.draftOrderId === event.draftOrderId && request.amountMinor === event.amountMinor && request.currency === event.currency && request.canonicalPayloadHash === event.canonicalPayloadHash }, { ordering, managed: repositories.managed }, undefined, clock)
        await dependencies.faultInjector?.('after_payment_authority'); await dependencies.faultInjector?.('after_project_update'); await dependencies.faultInjector?.('after_subscription_insert')
      }
    } else if ((event.eventType === 'checkout_failed' || event.eventType === 'checkout_cancelled') && previousSuccess || event.eventType === 'payment_refunded' && (!previousSuccess || previousRefund)) { effective = false; receiptStatus = 'ignored_out_of_order' }
    else if (event.eventType === 'checkout_cancelled') await repositories.ordering.updateDraftOrder(order.id, { status: 'cancelled', updatedAt: clock() } as any)
    else if (event.eventType === 'payment_refunded') { await repositories.managed.updateSubscription(ownerUserId, projectId, { status: 'suspended' } as any); await repositories.managed.updateProject(ownerUserId, projectId, { status: 'suspended' } as any) }

    const attemptFingerprint = stableFingerprint({ operation: 'payment_webhook_transition', fingerprint, projectId, effective })
    const attempt = await repositories.connector.insertAttempt({ ownerUserId, projectId, draftOrderId: order.id, releaseId: release.id, capability: 'payment', operation: 'payment_webhook_transition', executionMode: input.executionMode, status: 'succeeded', attemptNumber: 1, maxAttempts: 1, timeoutMs: 10_000, requestFingerprint: attemptFingerprint, idempotencyKey: stableFingerprint({ providerKey: event.providerKey, providerEventId: event.providerEventId }), leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: event.exactResponseIdentity, errorCode: null, errorSummary: null } as any)
    await dependencies.faultInjector?.('before_receipt_insert')
    const finalFingerprint = stableFingerprint({ fingerprint, ownerUserId, projectId, releaseId: release.id })
    const receipt = await repositories.connector.insertReceipt({ ownerUserId, projectId, draftOrderId: order.id, releaseId: release.id, attemptId: attempt.id, capability: 'payment', providerKey: event.providerKey, providerEventId: event.providerEventId, receiptType: event.eventType, receiptStatus, externalReference: event.providerReference, exactResponseIdentity: event.exactResponseIdentity, requestFingerprint: attemptFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { occurredAt: event.occurredAt, previewId: order.previewId, quoteId: quote.id, draftOrderId: order.id, commerceSnapshotFingerprint, checkoutReceiptFingerprint: checkout.receiptFingerprint, amountMinor: event.amountMinor, currency: event.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, canonicalPayloadHash: event.canonicalPayloadHash, eventIdentityFingerprint: fingerprint, effective }, receiptFingerprint: finalFingerprint, verifiedAt: clock() } as any)
    await dependencies.faultInjector?.('after_receipt_insert')
    if (event.eventType === 'checkout_succeeded' && effective) {
      await dependencies.faultInjector?.('before_release_cas')
      const boundFingerprint = stableFingerprint({ releaseId: release.id, paymentReceiptFingerprint: receipt.receiptFingerprint, commerceSnapshotFingerprint })
      await repositories.connector.insertReceipt({ ownerUserId, projectId, draftOrderId: order.id, releaseId: release.id, attemptId: attempt.id, capability: 'payment', providerKey: event.providerKey, providerEventId: `release-bind-${event.providerEventId}`.slice(0, 160), receiptType: 'release_payment_bound', receiptStatus: 'verified', externalReference: event.providerReference, exactResponseIdentity: event.exactResponseIdentity, requestFingerprint: boundFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { paymentReceiptFingerprint: receipt.receiptFingerprint, previewId: release.previewId, quoteId: release.quoteId, draftOrderId: release.draftOrderId, commerceSnapshotFingerprint }, receiptFingerprint: boundFingerprint, verifiedAt: clock() } as any)
      const transitioned = await repositories.connector.transitionRelease(ownerUserId, release.id, 'checkout_pending', release.projectionFingerprint, { status: 'payment_verified', blockedReasonCode: null, nextSafeAction: release.releaseKind === 'generated_site' ? 'quote_domain' : 'create_ownership_challenge', projectionFingerprint: stableFingerprint({ previous: release.projectionFingerprint, boundFingerprint }) })
      if (!transitioned) conflict('Release changed concurrently before payment binding acceptance.')
    } else if (event.eventType === 'payment_refunded' && effective) {
      const transitioned = await repositories.connector.transitionRelease(ownerUserId, release.id, release.status, release.projectionFingerprint, { status: 'blocked', blockedReasonCode: 'PAYMENT_REFUNDED', nextSafeAction: 'review_refund_and_live_site_suspension', projectionFingerprint: stableFingerprint({ previous: release.projectionFingerprint, receiptFingerprint: receipt.receiptFingerprint }) })
      if (!transitioned) conflict('Release changed concurrently while applying verified refund authority.')
    }
    const completed = await repositories.connector.transitionPaymentWebhookInbox(inbox.id, 'processing', inbox.processingFingerprint, { ownerUserId, projectId, releaseId: release.id, processingStatus: effective ? 'succeeded' : 'ignored', processingFingerprint: stableFingerprint({ previous: inbox.processingFingerprint, receiptFingerprint: receipt.receiptFingerprint }), completedAt: clock() })
    if (!completed) conflict('Payment webhook inbox changed concurrently before completion.')
    return { event: receipt, replayed: false, effective, projectId }
  })
}
