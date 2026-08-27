import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { bindManagedSiteReleasePayment } from '../../../../../../managed-sites/live-connectors/deployment-orchestrator'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['idempotencyKey'])
  const receipt = (await repository.listReceipts(ownerUserId, projectId)).find(item => item.releaseId === releaseId && item.receiptType === 'checkout_succeeded' && item.receiptStatus === 'verified')
  if (!receipt) throw createError({ statusCode: 409, statusMessage: 'No exact verified release payment receipt is available.' })
  return bindManagedSiteReleasePayment(ownerUserId, { releaseId, paymentReceiptFingerprint: receipt.receiptFingerprint, idempotencyKey: String(body.idempotencyKey || '') }, repository)
})
