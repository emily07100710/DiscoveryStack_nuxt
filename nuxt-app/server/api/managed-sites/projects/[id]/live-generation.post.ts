import { managedSiteOwnerContext, managedSitePathId, strictManagedSiteBody } from '../../../../managed-sites/live-connectors/http'
import { generateManagedSiteCandidate } from '../../../../managed-sites/live-connectors/generation-service'
import { createS3ManagedSiteArtifactVault } from '../../../../managed-sites/live-connectors/s3-vault'
import { managedSiteLiveGenerationAdapter } from '../../../../managed-sites/live-connectors/runtime-adapters'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, managedRepository, generationAdapter, artifactVault, credentialResolver } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed site project id')
  const body = await strictManagedSiteBody(event, ['sourceVersionId', 'executionMode', 'idempotencyKey'])
  const executionMode = String(body.executionMode) as 'dry_run' | 'mocked' | 'live'
  if (!['dry_run', 'live'].includes(executionMode) && !(process.env.NODE_ENV === 'test' && executionMode === 'mocked')) throw createError({ statusCode: 422, statusMessage: 'Managed-site generation execution mode is invalid.' })
  const dependencies = executionMode === 'live' ? { repository, managedRepository, adapter: generationAdapter || await managedSiteLiveGenerationAdapter(ownerUserId, repository), vault: artifactVault || createS3ManagedSiteArtifactVault(), credentialResolver } : executionMode === 'mocked' ? { repository, managedRepository, adapter: generationAdapter, vault: artifactVault, credentialResolver } : { repository, managedRepository }
  return generateManagedSiteCandidate(ownerUserId, { projectId, sourceVersionId: Number(body.sourceVersionId), templateIntent: 'astro', executionMode, idempotencyKey: String(body.idempotencyKey || '') }, dependencies as any)
})
