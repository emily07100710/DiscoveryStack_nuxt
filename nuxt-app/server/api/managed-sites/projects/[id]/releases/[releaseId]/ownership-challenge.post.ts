import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { createExistingSiteOwnershipChallenge, createMockExistingSiteOwnershipAdapter } from '../../../../../../managed-sites/live-connectors/deployment-orchestrator'
import { managedSiteLiveOwnershipAdapter } from '../../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, ownershipAdapter } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['executionMode', 'idempotencyKey'])
  const executionMode = String(body.executionMode) as 'mocked' | 'live'; if (!['mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Ownership challenge execution mode is invalid.' })
  const adapter = ownershipAdapter || (executionMode === 'mocked' ? createMockExistingSiteOwnershipAdapter() : await managedSiteLiveOwnershipAdapter(ownerUserId, repository))
  return createExistingSiteOwnershipChallenge(ownerUserId, { releaseId, executionMode, idempotencyKey: String(body.idempotencyKey || '') }, repository, () => new Date(), adapter)
})
