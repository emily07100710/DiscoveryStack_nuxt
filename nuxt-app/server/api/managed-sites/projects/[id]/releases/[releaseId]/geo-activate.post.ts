import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { activateManagedSiteGeoOperations } from '../../../../../../managed-sites/live-connectors/deployment-orchestrator'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['timeZone', 'cadenceDays', 'monthlyBudgetUnits', 'idempotencyKey'])
  return activateManagedSiteGeoOperations(ownerUserId, { releaseId, timeZone: String(body.timeZone || ''), cadenceDays: Number(body.cadenceDays) as 3 | 7 | 15 | 30, monthlyBudgetUnits: Number(body.monthlyBudgetUnits), idempotencyKey: String(body.idempotencyKey || '') }, { repository })
})
