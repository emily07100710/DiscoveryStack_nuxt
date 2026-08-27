import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { createMockExistingSiteOwnershipAdapter, verifyExistingSiteOwnership } from '../../../../../../managed-sites/live-connectors/deployment-orchestrator'
import { unsupportedManagedSiteVendorAdapter } from '../../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['executionMode', 'idempotencyKey'])
  const executionMode = String(body.executionMode) as 'mocked' | 'live'; if (!['mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Ownership verification execution mode is invalid.' })
  const adapter = executionMode === 'mocked' ? createMockExistingSiteOwnershipAdapter() : unsupportedManagedSiteVendorAdapter('existing_site_ownership')
  const challenge = (await repository.listReceipts(ownerUserId, projectId)).find(item => item.releaseId === releaseId && item.receiptType === 'existing_site_challenge_created' && item.receiptStatus === 'verified')
  if (!challenge) throw createError({ statusCode: 409, statusMessage: 'No exact pending ownership challenge receipt is available.' })
  return verifyExistingSiteOwnership(ownerUserId, { releaseId, challengeReceiptFingerprint: challenge.receiptFingerprint, executionMode, idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
})
