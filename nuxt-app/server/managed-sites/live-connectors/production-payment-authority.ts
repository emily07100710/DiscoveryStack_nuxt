import { createError } from 'h3'
import type { ManagedSiteReleaseProjection } from '../../database/schema'
import type { PreviewRepository } from '../ordering-types'
import { managedSiteCommerceSnapshotFingerprint } from '../prepurchase-service'
import type { ManagedSiteRepository } from '../types'
import type { ManagedSiteLiveConnectorRepository } from './types'

function conflict(): never {
  throw createError({ statusCode: 409, statusMessage: 'Production requires current exact verified payment without refund, dispute, or suspended project authority.' })
}

/** Rechecked before transport and within the production commit transaction. */
export async function assertManagedSiteProductionPayment(ownerUserId: number, release: ManagedSiteReleaseProjection, repository: ManagedSiteLiveConnectorRepository, ordering: PreviewRepository, managed: ManagedSiteRepository): Promise<void> {
  if (release.ownerUserId !== ownerUserId || !release.draftOrderId || !release.quoteId || !release.previewId || !release.commerceSnapshotFingerprint) conflict()
  const [order, quote, project, receipts] = await Promise.all([
    ordering.findDraftOrderById(release.draftOrderId), ordering.findQuoteById(release.quoteId),
    managed.findProject(ownerUserId, release.projectId), repository.listReceiptsByDraftOrder(ownerUserId, release.draftOrderId),
  ])
  if (!project || project.ownerUserId !== ownerUserId || project.status === 'suspended' || !order || !quote || order.status !== 'payment_verified' || order.ownerUserId !== ownerUserId || order.projectId !== release.projectId || order.previewId !== release.previewId || order.quoteId !== release.quoteId || quote.status !== 'locked' || quote.ownerUserId !== ownerUserId || quote.projectId !== release.projectId || quote.previewId !== release.previewId) conflict()
  if (receipts.some(receipt => receipt.receiptStatus === 'verified' && ['payment_refunded', 'payment_disputed'].includes(receipt.receiptType) && (receipt.metadata as any)?.effective === true)) conflict()
  const bound = receipts.find(receipt => receipt.releaseId === release.id && receipt.projectId === release.projectId && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === 'release_payment_bound' && receipt.receiptStatus === 'verified')
  const paymentFingerprint = (bound?.metadata as any)?.paymentReceiptFingerprint || (bound?.metadata as any)?.checkoutReceiptFingerprint
  const payment = receipts.find(receipt => receipt.receiptFingerprint === paymentFingerprint && receipt.releaseId === release.id && receipt.projectId === release.projectId && receipt.contentHash === release.contentHash && receipt.canonicalDomain === release.canonicalDomain && receipt.receiptType === 'checkout_succeeded' && receipt.receiptStatus === 'verified')
  if (!payment || (payment.metadata as any)?.effective !== true) conflict()
  const lines = await ordering.listQuoteLines(quote.id)
  const snapshot = managedSiteCommerceSnapshotFingerprint({ previewId: release.previewId, quoteId: quote.id, draftOrderId: order.id, quoteVersion: quote.quoteVersion, totalMinor: quote.totalMinor, currency: quote.currency, planKey: quote.planKey, cadenceDays: quote.cadenceDays, domainOption: quote.domainOption, taxStatus: quote.taxStatus, lines: lines.map(line => ({ lineKey: line.lineKey, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor, lineAmountMinor: line.lineAmountMinor, lineFingerprint: line.lineFingerprint })) })
  const metadata = payment.metadata as Record<string, unknown>
  if (snapshot !== release.commerceSnapshotFingerprint || metadata.commerceSnapshotFingerprint !== snapshot || metadata.amountMinor !== quote.totalMinor || metadata.currency !== quote.currency) conflict()
}
