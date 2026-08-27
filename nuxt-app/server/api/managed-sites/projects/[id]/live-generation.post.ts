import { getRouterParam, readBody, setResponseHeader } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parsePathId } from '../../../../managed-sites/normalization'
import { generateManagedSiteCandidate } from '../../../../managed-sites/live-connectors/generation-service'
import { createBailianQwenManagedSiteGenerationAdapter } from '../../../../managed-sites/live-connectors/adapters'
import { createS3ManagedSiteArtifactVault } from '../../../../managed-sites/live-connectors/s3-vault'
import { getManagedSiteLiveConnectorRepository } from '../../../../managed-sites/live-connectors/repository'

const ALLOWED_FIELDS = new Set(['sourceVersionId', 'executionMode', 'idempotencyKey'])

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !ALLOWED_FIELDS.has(key)) || !['dry_run', 'live'].includes(String(body.executionMode))) throw createError({ statusCode: 422, statusMessage: 'Managed-site generation request is invalid.' })
  const repository = getManagedSiteLiveConnectorRepository()
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'website_generator')
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  const executionMode = body.executionMode as 'dry_run' | 'live'
  const dependencies = executionMode === 'live' ? {
    repository,
    adapter: createBailianQwenManagedSiteGenerationAdapter({ endpoint: String(transport.endpointOrigin || ''), model: typeof transport.model === 'string' ? transport.model : undefined, providerKey: configuration?.providerKey }),
    vault: createS3ManagedSiteArtifactVault(),
  } : { repository }
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  return generateManagedSiteCandidate(ownerUserId, { projectId, sourceVersionId: Number(body.sourceVersionId), templateIntent: 'astro', executionMode, idempotencyKey: String(body.idempotencyKey || '') }, dependencies)
})
