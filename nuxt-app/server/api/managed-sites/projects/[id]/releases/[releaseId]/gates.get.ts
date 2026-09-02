import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope } from '../../../../../../managed-sites/live-connectors/http'
import { inspectManagedSitePreviewGates } from '../../../../../../managed-sites/live-connectors/gates'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event, false)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  return inspectManagedSitePreviewGates(ownerUserId, releaseId, repository)
})
