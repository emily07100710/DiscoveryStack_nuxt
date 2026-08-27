import { managedSiteOwnerContext, strictManagedSiteBody } from '../../../managed-sites/live-connectors/http'
import { convertClaimedManagedSitePrePurchase } from '../../../managed-sites/prepurchase-service'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, orderingRepository, managedRepository } = await managedSiteOwnerContext(event)
  const body = await strictManagedSiteBody(event, ['previewId', 'quoteId', 'leadIntentId', 'draftOrderId', 'idempotencyKey'])
  const result = await convertClaimedManagedSitePrePurchase(ownerUserId, { previewId: Number(body.previewId), quoteId: Number(body.quoteId), leadIntentId: Number(body.leadIntentId), draftOrderId: Number(body.draftOrderId), idempotencyKey: String(body.idempotencyKey || '') }, orderingRepository && managedRepository ? { ordering: orderingRepository, managed: managedRepository, live: repository } : undefined)
  return { projectId: result.project.id, sourceVersionId: result.version.id, previewId: result.binding.previewId, quoteId: result.binding.quoteId, draftOrderId: result.binding.draftOrderId, commerceSnapshotFingerprint: result.binding.commerceSnapshotFingerprint, projectStatus: result.project.status, versionStatus: result.version.lifecycleStatus, subscriptionActivated: false, paymentVerified: false, replayed: result.replayed }
})
