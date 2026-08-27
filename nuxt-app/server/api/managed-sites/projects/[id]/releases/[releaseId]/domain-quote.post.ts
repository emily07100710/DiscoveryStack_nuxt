import { managedSiteOwnerContext, managedSitePathId, requireManagedSiteReleaseScope, strictManagedSiteBody } from '../../../../../../managed-sites/live-connectors/http'
import { createMockManagedSiteDomainAdapter, quoteManagedSiteDomain } from '../../../../../../managed-sites/live-connectors/domain-connectors'
import { unsupportedManagedSiteVendorAdapter } from '../../../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id'); const releaseId = managedSitePathId(event, 'releaseId', 'Managed-site release id')
  const release = await requireManagedSiteReleaseScope(ownerUserId, projectId, releaseId, repository)
  const body = await strictManagedSiteBody(event, ['requestedDomain', 'executionMode', 'idempotencyKey'])
  const executionMode = String(body.executionMode) as 'dry_run' | 'mocked' | 'live'; if (!['dry_run', 'mocked', 'live'].includes(executionMode)) throw createError({ statusCode: 422, statusMessage: 'Domain quote execution mode is invalid.' })
  const adapter = executionMode === 'mocked' ? createMockManagedSiteDomainAdapter() : executionMode === 'live' ? unsupportedManagedSiteVendorAdapter('domain_registration') : undefined
  return quoteManagedSiteDomain(ownerUserId, { projectId, releaseId, requestedDomain: String(body.requestedDomain || release.canonicalDomain), executionMode, idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
})
