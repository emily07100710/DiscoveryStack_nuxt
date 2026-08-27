import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { buildManagedSitePreview, createMockManagedSiteDeploymentAdapter } from '../../../../../../managed-sites/live-connectors/deployment-orchestrator'
import { managedSiteLiveDeploymentAdapter } from '../../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['executionMode', 'idempotencyKey'])
  const executionMode = String(body.executionMode) as 'mocked' | 'live'
  if (!['mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Preview build execution mode is invalid.' })
  const adapter = executionMode === 'mocked' ? createMockManagedSiteDeploymentAdapter() : await managedSiteLiveDeploymentAdapter(ownerUserId, repository)
  return buildManagedSitePreview(ownerUserId, { releaseId, executionMode, idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
})
