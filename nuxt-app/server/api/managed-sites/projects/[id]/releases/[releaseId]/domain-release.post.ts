import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { releaseManagedSiteDomainClaim } from '../../../../../../managed-sites/live-connectors/domain-connectors'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['claimId', 'expectedProjectionFingerprint', 'idempotencyKey'])
  return releaseManagedSiteDomainClaim(ownerUserId, { projectId, releaseId, claimId: Number(body.claimId), expectedProjectionFingerprint: String(body.expectedProjectionFingerprint || ''), idempotencyKey: String(body.idempotencyKey || '') }, repository)
})
