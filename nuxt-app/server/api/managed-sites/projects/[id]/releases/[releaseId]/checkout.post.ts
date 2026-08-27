import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { createManagedSiteCheckoutSession, createMockManagedSiteCheckoutSessionAdapter } from '../../../../../../managed-sites/live-connectors/checkout-session'
import { managedSiteLiveCheckoutAdapter } from '../../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, orderingRepository, checkoutAdapter } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  const release = await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['executionMode', 'idempotencyKey'])
  const executionMode = String(body.executionMode) as 'mocked' | 'live'; if (!['mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Checkout execution mode is invalid.' })
  const adapter = checkoutAdapter || (executionMode === 'mocked' ? createMockManagedSiteCheckoutSessionAdapter() : await managedSiteLiveCheckoutAdapter(ownerUserId, repository))
  if (!release.draftOrderId) throw createError({ statusCode: 409, statusMessage: 'Release has no exact draft-order lineage.' })
  return createManagedSiteCheckoutSession(ownerUserId, { releaseId, draftOrderId: release.draftOrderId, executionMode, idempotencyKey: String(body.idempotencyKey || '') }, adapter, { connectorRepository: repository, orderingRepository })
})
