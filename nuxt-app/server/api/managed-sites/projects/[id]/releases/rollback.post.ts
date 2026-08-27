import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../managed-sites/live-connectors/http'
import { createMockManagedSiteDeploymentAdapter, rollbackManagedSiteRelease } from '../../../../../managed-sites/live-connectors/deployment-orchestrator'
import { managedSiteLiveDeploymentAdapter } from '../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, deploymentAdapter } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id')
  const body = await strictManagedSiteBody(event, ['fromReleaseId', 'toReleaseId', 'executionMode', 'idempotencyKey'])
  const fromReleaseId = Number(body.fromReleaseId); const toReleaseId = Number(body.toReleaseId)
  await Promise.all([requireManagedSiteReleaseScope(ownerUserId, projectId, fromReleaseId, repository), requireManagedSiteReleaseScope(ownerUserId, projectId, toReleaseId, repository)])
  const executionMode = String(body.executionMode) as 'mocked' | 'live'; if (!['mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Rollback execution mode is invalid.' })
  const adapter = deploymentAdapter || (executionMode === 'mocked' ? createMockManagedSiteDeploymentAdapter() : await managedSiteLiveDeploymentAdapter(ownerUserId, repository))
  return rollbackManagedSiteRelease(ownerUserId, { fromReleaseId, toReleaseId, executionMode, idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
})
