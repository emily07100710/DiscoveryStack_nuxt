import { getRouterParam, readBody, setResponseHeaders } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parsePathId } from '../../../../managed-sites/normalization'
import { generateManagedSiteCandidate } from '../../../../managed-sites/live-connectors/generation-service'
import { createS3ManagedSiteArtifactVault } from '../../../../managed-sites/live-connectors/s3-vault'
import { getManagedSiteLiveConnectorRepository } from '../../../../managed-sites/live-connectors/repository'
import { managedSiteLiveGenerationAdapter } from '../../../../managed-sites/live-connectors/runtime-adapters'

const ALLOWED_FIELDS = new Set(['sourceVersionId', 'executionMode', 'idempotencyKey'])

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBody(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !ALLOWED_FIELDS.has(key)) || !['dry_run', 'live'].includes(String(body.executionMode))) throw createError({ statusCode: 422, statusMessage: 'Managed-site generation request is invalid.' })
  const repository = getManagedSiteLiveConnectorRepository()
  const executionMode = body.executionMode as 'dry_run' | 'live'
  const dependencies = executionMode === 'live' ? {
    repository,
    adapter: await managedSiteLiveGenerationAdapter(ownerUserId, repository),
    vault: createS3ManagedSiteArtifactVault(),
  } : { repository }
  setResponseHeaders(event, { 'cache-control': 'private, no-store, max-age=0', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' })
  return generateManagedSiteCandidate(ownerUserId, { projectId, sourceVersionId: Number(body.sourceVersionId), templateIntent: 'astro', executionMode, idempotencyKey: String(body.idempotencyKey || '') }, dependencies)
})
