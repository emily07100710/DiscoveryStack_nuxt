import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { createManagedSiteDomainPurchaseIntent, createMockManagedSiteDomainAdapter, managedSiteDomainConfirmationFingerprint } from '../../../../../../managed-sites/live-connectors/domain-connectors'
import { managedSiteLiveDomainAdapter } from '../../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, domainAdapter } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  const release = await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['explicitConfirmation', 'executionMode', 'idempotencyKey'])
  if (body.explicitConfirmation !== true || !release.draftOrderId || !release.commerceSnapshotFingerprint) throw createError({ statusCode: 422, statusMessage: 'Explicit owner confirmation and release commerce lineage are required.' })
  const executionMode = String(body.executionMode) as 'mocked' | 'live'; if (!['mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Domain purchase execution mode is invalid.' })
  const receipts = await repository.listReceipts(ownerUserId, projectId)
  const quoteReceiptFingerprint = receipts.find(item => item.releaseId === releaseId && item.receiptType === 'domain_quote_verified' && item.receiptStatus === 'verified')?.receiptFingerprint || ''
  const paymentReceiptFingerprint = receipts.find(item => item.releaseId === releaseId && item.receiptType === 'release_payment_bound' && item.receiptStatus === 'verified')?.receiptFingerprint || ''
  const draftOrderId = release.draftOrderId
  if (!quoteReceiptFingerprint || !paymentReceiptFingerprint) throw createError({ statusCode: 409, statusMessage: 'Exact release domain quote and payment receipts are required.' })
  const confirmation = managedSiteDomainConfirmationFingerprint({ ownerUserId, projectId, releaseId, commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, quoteReceiptFingerprint, draftOrderId, paymentReceiptFingerprint })
  const adapter = domainAdapter || (executionMode === 'mocked' ? createMockManagedSiteDomainAdapter() : await managedSiteLiveDomainAdapter(ownerUserId, repository))
  return createManagedSiteDomainPurchaseIntent(ownerUserId, { projectId, releaseId, draftOrderId, quoteReceiptFingerprint, paymentReceiptFingerprint, ownerConfirmationFingerprint: confirmation, executionMode, idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
})
