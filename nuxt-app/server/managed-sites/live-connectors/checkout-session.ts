import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { isOpaqueReference } from '../../first-party-publishing/normalization'
import { getPreviewRepository } from '../ordering-repository'
import type { PreviewRepository } from '../ordering-types'
import { getManagedSiteLiveConnectorRepository } from './repository'
import { requireVerifiedManagedSiteProvider, resolveManagedSiteCredential } from './provider-registry'
import { managedSiteCommerceSnapshotFingerprint } from '../prepurchase-service'
import type { ManagedSiteCheckoutSessionAdapter, ManagedSiteCheckoutSessionReceipt, ManagedSiteCredentialResolver, ManagedSiteLiveConnectorRepository } from './types'
import { assertManagedSiteCheckoutUrl, compareCodeUnits } from './canonical'

const CHECKOUT_TIMEOUT_MS = 15_000

function invalid(message: string): never { throw createError({ statusCode: 422, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }
function unavailable(message: string): never { throw createError({ statusCode: 503, statusMessage: message }) }

export async function createManagedSiteCheckoutSession(ownerUserId: number, input: { releaseId: number; draftOrderId: number; executionMode: 'mocked' | 'live'; idempotencyKey: string }, adapter: ManagedSiteCheckoutSessionAdapter, dependencies: { connectorRepository?: ManagedSiteLiveConnectorRepository; orderingRepository?: PreviewRepository; credentialResolver?: ManagedSiteCredentialResolver; clock?: () => Date } = {}) {
  if (![input.releaseId, input.draftOrderId].every(value => Number.isSafeInteger(value) && value > 0) || !isOpaqueReference(input.idempotencyKey, 128)) invalid('Checkout session request identity is invalid.')
  if (input.executionMode === 'mocked' && process.env.NODE_ENV !== 'test') unavailable('Mock checkout sessions are restricted to tests.')
  const repository = dependencies.connectorRepository || getManagedSiteLiveConnectorRepository()
  const ordering = dependencies.orderingRepository || getPreviewRepository()
  const resolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const clock = dependencies.clock || (() => new Date())
  const order = await ordering.findDraftOrderById(input.draftOrderId)
  if (!order || order.ownerUserId !== ownerUserId) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped draft order was not found.' })
  if (order.status !== 'payment_pending') conflict('Checkout session requires a payment-pending server-owned order.')
  const quote = await ordering.findQuoteById(order.quoteId)
  const lines = quote ? await ordering.listQuoteLines(quote.id) : []
  if (!quote || quote.ownerUserId !== ownerUserId || quote.previewId !== order.previewId || quote.status !== 'quoted' || quote.expiresAt.getTime() <= clock().getTime() || !lines.length) conflict('Checkout session quote lineage is incomplete, expired, or no longer payable.')
  const lineSnapshot = lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor })).sort((left, right) => compareCodeUnits(left.lineKey, right.lineKey))
  if (lineSnapshot.reduce((sum, line) => sum + line.lineAmountMinor, 0) !== quote.totalMinor || lineSnapshot.some(line => line.quantity * line.unitAmountMinor !== line.lineAmountMinor)) conflict('Server-derived checkout line snapshot does not equal the canonical quote total.')
  const release = await repository.findRelease(ownerUserId, input.releaseId)
  const binding = order.projectId ? await repository.findPrePurchaseBinding(ownerUserId, order.projectId) : null
  if (!release || !['approved', 'checkout_pending'].includes(release.status) || release.projectId !== order.projectId || release.previewId !== order.previewId || release.quoteId !== quote.id || release.draftOrderId !== order.id || !release.approvalFingerprint || !binding || binding.projectId !== release.projectId || binding.sourceVersionId !== release.versionId) conflict('Checkout requires one exact owner-approved release and pre-purchase commercial lineage.')
  const commerceSnapshotFingerprint = managedSiteCommerceSnapshotFingerprint({ previewId: order.previewId, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
  if (binding.commerceSnapshotFingerprint !== commerceSnapshotFingerprint || release.commerceSnapshotFingerprint !== commerceSnapshotFingerprint) conflict('Checkout commercial snapshot changed after pre-purchase release creation.')
  const configuration = input.executionMode === 'live' ? await requireVerifiedManagedSiteProvider(ownerUserId, 'payment', repository, resolver) : await repository.findProviderConfiguration(ownerUserId, 'payment')
  if (!configuration || input.executionMode === 'mocked' && !['mock', 'verified'].includes(configuration.readinessStatus)) unavailable('Payment provider is not configured for this execution mode.')
  if (!configuration.verificationReceiptFingerprint || !configuration.capabilityIdentity) unavailable('Payment provider configuration lacks exact verified capability lineage.')
  const configuredCheckoutOrigin = configuration.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) && typeof (configuration.transportConfiguration as any).checkoutOrigin === 'string' ? String((configuration.transportConfiguration as any).checkoutOrigin) : null
  const checkoutOrigin = (configuration.providerKey === 'stripe' || input.executionMode === 'live') && configuredCheckoutOrigin || 'https://checkout.acme-payments.com'
  const snapshot = { draftOrderId: order.id, quoteId: quote.id, amountMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, lineSnapshot, taxStatus: quote.taxStatus }
  const snapshotFingerprint = commerceSnapshotFingerprint
  const requestFingerprint = stableFingerprint({ ownerUserId, releaseId: release.id, approvalFingerprint: release.approvalFingerprint, providerKey: configuration.providerKey, configurationFingerprint: configuration.configurationFingerprint, verificationReceiptFingerprint: configuration.verificationReceiptFingerprint, capabilityIdentity: configuration.capabilityIdentity, snapshotFingerprint })
  // This authority fingerprint is fixed before any provider call so vendors can
  // echo it through signed metadata without making the receipt identity circular.
  const checkoutReceiptFingerprint = stableFingerprint({ schemaVersion: 'managed-site-checkout-receipt-authority-v1', ownerUserId, projectId: release.projectId, releaseId: release.id, draftOrderId: order.id, requestFingerprint, idempotencyKey: input.idempotencyKey })
  let attempt = await repository.findAttemptByIdempotency(ownerUserId, input.idempotencyKey)
  if (attempt && attempt.requestFingerprint !== requestFingerprint) conflict('Checkout session idempotency key collides with another commercial snapshot.')
  if (attempt?.status === 'succeeded') {
    const existing = (await repository.listReceipts(ownerUserId, release.projectId)).find(receipt => receipt.attemptId === attempt!.id && receipt.receiptType === 'checkout_session_created')
    if (existing && release.status === 'checkout_pending') return { receipt: existing, checkout: { url: (existing.metadata as any).checkoutUrl, providerReference: existing.externalReference, amountMinor: quote.totalMinor, currency: quote.currency, taxStatus: quote.taxStatus }, replayed: true }
    conflict('Checkout receipt exists without the exact checkout-pending release projection.')
  }
  if (release.status !== 'approved') conflict('A new checkout session requires the exact approved release projection.')
  if (!attempt) attempt = await repository.insertAttempt({ ownerUserId, projectId: order.projectId, draftOrderId: order.id, releaseId: release.id, capability: 'payment', operation: 'checkout_session_create', executionMode: input.executionMode, status: 'queued', attemptNumber: 0, maxAttempts: 3, timeoutMs: CHECKOUT_TIMEOUT_MS, requestFingerprint, idempotencyKey: input.idempotencyKey, leaseOwner: null, leaseExpiresAt: null, retryEligibleAt: null, exactResponseIdentity: null, errorCode: null, errorSummary: null } as any)
  const leaseOwner = `checkout-${randomBytes(10).toString('hex')}`
  const leased = await repository.acquireAttemptLease(ownerUserId, attempt.id, leaseOwner, clock(), 25_000)
  if (!leased) conflict('Checkout session is already leased, terminal, or waiting for retry.')
  try {
    const result = await adapter.createSession({ ownerUserId, projectId: release.projectId, releaseId: release.id, previewId: release.previewId!, approvalFingerprint: release.approvalFingerprint, ...snapshot, snapshotFingerprint, checkoutReceiptFingerprint, configurationFingerprint: configuration.configurationFingerprint, verificationReceiptFingerprint: configuration.verificationReceiptFingerprint, capabilityIdentity: configuration.capabilityIdentity, idempotencyKey: input.idempotencyKey, timeoutMs: CHECKOUT_TIMEOUT_MS })
    if (result.providerKey !== configuration.providerKey || result.draftOrderId !== order.id || result.amountMinor !== quote.totalMinor || result.currency !== quote.currency || result.snapshotFingerprint !== snapshotFingerprint || result.configurationFingerprint !== configuration.configurationFingerprint || result.verificationReceiptFingerprint !== configuration.verificationReceiptFingerprint || result.capabilityIdentity !== configuration.capabilityIdentity || !isOpaqueReference(result.providerEventId, 160) || !isOpaqueReference(result.providerReference, 160) || !isOpaqueReference(result.exactResponseIdentity, 256)) conflict('Checkout provider receipt does not match the exact server-derived commercial and configuration snapshot.')
    const checkoutUrl = assertManagedSiteCheckoutUrl(result.checkoutUrl, checkoutOrigin, result.providerKey === 'stripe' ? { allowFragment: true } : undefined)
    // Preserve the legacy internal_hmac_v1 receipt identity byte-for-byte. Only
    // Stripe needs the pre-call authority value that it echoes through metadata.
    const receiptFingerprint = result.providerKey === 'stripe' ? checkoutReceiptFingerprint : stableFingerprint({ ownerUserId, requestFingerprint, result: { ...result, checkoutUrl } })
    const { receipt } = await repository.transaction(async transaction => {
      const receipt = await transaction.insertReceipt({ ownerUserId, projectId: order.projectId, draftOrderId: order.id, releaseId: release.id, attemptId: leased.id, capability: 'payment', providerKey: result.providerKey, providerEventId: result.providerEventId, receiptType: 'checkout_session_created', receiptStatus: 'verified', externalReference: result.providerReference, exactResponseIdentity: result.exactResponseIdentity, requestFingerprint, contentHash: release.contentHash, canonicalDomain: release.canonicalDomain, metadata: { checkoutUrl, snapshotFingerprint, checkoutReceiptFingerprint: receiptFingerprint, previewId: release.previewId, quoteId: release.quoteId, draftOrderId: release.draftOrderId, amountMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, lineSnapshotFingerprint: stableFingerprint(lines.map(line => line.lineFingerprint).sort()), taxStatus: quote.taxStatus, configurationFingerprint: configuration.configurationFingerprint, verificationReceiptFingerprint: configuration.verificationReceiptFingerprint, capabilityIdentity: configuration.capabilityIdentity }, receiptFingerprint, verifiedAt: clock() } as any)
      const transitioned = await transaction.transitionRelease(ownerUserId, release.id, 'approved', release.projectionFingerprint, { status: 'checkout_pending', blockedReasonCode: null, nextSafeAction: 'wait_for_verified_payment_webhook', projectionFingerprint: stableFingerprint({ previous: release.projectionFingerprint, checkoutReceiptFingerprint: receipt.receiptFingerprint }) })
      if (!transitioned) conflict('Release changed concurrently before checkout session authority committed.')
      const completed = await transaction.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'succeeded', attemptNumber: leased.attemptNumber + 1, exactResponseIdentity: result.exactResponseIdentity, errorCode: null, errorSummary: null })
      if (!completed) conflict('Checkout attempt lease changed before local receipt commit.')
      return { receipt }
    })
    return { receipt, checkout: { url: checkoutUrl, providerReference: result.providerReference, amountMinor: quote.totalMinor, currency: quote.currency, taxStatus: quote.taxStatus }, replayed: false }
  } catch (error) {
    await repository.releaseAttemptLease(ownerUserId, leased.id, leaseOwner, { status: 'retry_wait', attemptNumber: leased.attemptNumber + 1, retryEligibleAt: new Date(clock().getTime() + 30_000), errorCode: 'CHECKOUT_RECONCILE_REQUIRED', errorSummary: 'Provider result was not locally committed; retry will reuse the exact idempotency key.' }).catch(() => null)
    throw error
  }
}

export function createMockManagedSiteCheckoutSessionAdapter(providerKey = 'mock-payment'): ManagedSiteCheckoutSessionAdapter {
  return { async createSession(input): Promise<ManagedSiteCheckoutSessionReceipt> { return { providerKey, providerEventId: `checkout-${stableFingerprint(input).slice(0, 24)}`, providerReference: `checkout-ref-${input.draftOrderId}`, checkoutUrl: `https://checkout.acme-payments.com/session/${stableFingerprint(input).slice(0, 24)}`, draftOrderId: input.draftOrderId, amountMinor: input.amountMinor, currency: input.currency, snapshotFingerprint: input.snapshotFingerprint, configurationFingerprint: input.configurationFingerprint, verificationReceiptFingerprint: input.verificationReceiptFingerprint, capabilityIdentity: input.capabilityIdentity, exactResponseIdentity: `checkout-response:${stableFingerprint(input).slice(0, 32)}` } } }
}
