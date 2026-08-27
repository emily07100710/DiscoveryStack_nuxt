import { getRouterParam, readBody, setResponseHeader } from 'h3'
import { requireOwner } from '../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parsePathId } from '../../../../managed-sites/normalization'
import {
  activateManagedSiteGeoOperations,
  approveManagedSitePreview,
  bindManagedSiteReleasePayment,
  buildManagedSitePreview,
  createExistingSiteRelease,
  createGeneratedManagedSiteRelease,
  deployManagedSiteProduction,
  rollbackManagedSiteRelease,
} from '../../../../managed-sites/live-connectors/deployment-orchestrator'
import { createSignedManagedSiteDeploymentAdapter } from '../../../../managed-sites/live-connectors/deployment-transport'
import { getManagedSiteLiveConnectorRepository } from '../../../../managed-sites/live-connectors/repository'
import { resolveManagedSiteCredential } from '../../../../managed-sites/live-connectors/provider-registry'

const FIELDS: Record<string, Set<string>> = {
  create_generated_release: new Set(['action', 'generationCandidateId', 'canonicalDomain', 'targetKey', 'idempotencyKey']),
  create_existing_release: new Set(['action', 'canonicalDomain', 'targetKey', 'idempotencyKey']),
  build_preview: new Set(['action', 'releaseId', 'idempotencyKey']),
  approve_preview: new Set(['action', 'releaseId', 'idempotencyKey']),
  bind_payment: new Set(['action', 'releaseId', 'paymentReceiptFingerprint', 'idempotencyKey']),
  deploy_production: new Set(['action', 'releaseId', 'idempotencyKey']),
  activate_geo: new Set(['action', 'releaseId', 'timeZone', 'cadenceDays', 'monthlyBudgetUnits', 'idempotencyKey']),
  rollback: new Set(['action', 'fromReleaseId', 'toReleaseId', 'idempotencyKey']),
}

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBody(event)
  const action = body && typeof body === 'object' && !Array.isArray(body) ? String(body.action || '') : ''
  const allowed = FIELDS[action]
  if (!allowed || Object.keys(body).some(key => !allowed.has(key))) throw createError({ statusCode: 422, statusMessage: 'Managed-site orchestration action is invalid.' })
  const repository = getManagedSiteLiveConnectorRepository()
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  if (action === 'create_generated_release') return createGeneratedManagedSiteRelease(ownerUserId, { projectId, generationCandidateId: Number(body.generationCandidateId), canonicalDomain: String(body.canonicalDomain || ''), targetKey: String(body.targetKey || ''), idempotencyKey: String(body.idempotencyKey || '') }, { repository })
  if (action === 'create_existing_release') return createExistingSiteRelease(ownerUserId, { projectId, canonicalDomain: String(body.canonicalDomain || ''), targetKey: String(body.targetKey || ''), idempotencyKey: String(body.idempotencyKey || '') }, { repository })
  if (action === 'rollback') {
    const [from, to] = await Promise.all([repository.findRelease(ownerUserId, Number(body.fromReleaseId)), repository.findRelease(ownerUserId, Number(body.toReleaseId))])
    if (!from || !to || from.projectId !== projectId || to.projectId !== projectId) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped rollback releases were not found in this project.' })
  } else {
    const release = await repository.findRelease(ownerUserId, Number(body.releaseId))
    if (!release || release.projectId !== projectId) throw createError({ statusCode: 404, statusMessage: 'Owner-scoped release was not found in this project.' })
  }
  if (action === 'approve_preview') return approveManagedSitePreview(ownerUserId, { releaseId: Number(body.releaseId), idempotencyKey: String(body.idempotencyKey || '') }, repository)
  if (action === 'bind_payment') return bindManagedSiteReleasePayment(ownerUserId, { releaseId: Number(body.releaseId), paymentReceiptFingerprint: String(body.paymentReceiptFingerprint || ''), idempotencyKey: String(body.idempotencyKey || '') }, repository)
  if (action === 'activate_geo') return activateManagedSiteGeoOperations(ownerUserId, { releaseId: Number(body.releaseId), timeZone: String(body.timeZone || ''), cadenceDays: Number(body.cadenceDays) as 3 | 7 | 15 | 30, monthlyBudgetUnits: Number(body.monthlyBudgetUnits), idempotencyKey: String(body.idempotencyKey || '') }, { repository })
  const configuration = await repository.findProviderConfiguration(ownerUserId, 'deployment')
  const transport = configuration?.transportConfiguration && typeof configuration.transportConfiguration === 'object' && !Array.isArray(configuration.transportConfiguration) ? configuration.transportConfiguration as Record<string, unknown> : {}
  if (!configuration?.credentialReference || typeof transport.endpointOrigin !== 'string') throw createError({ statusCode: 503, statusMessage: 'Verified managed deployment transport is not configured.' })
  const adapter = createSignedManagedSiteDeploymentAdapter({ endpointOrigin: transport.endpointOrigin, providerKey: configuration.providerKey, credentialReference: configuration.credentialReference, resolveCredential: resolveManagedSiteCredential })
  if (action === 'build_preview') return buildManagedSitePreview(ownerUserId, { releaseId: Number(body.releaseId), executionMode: 'live', idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
  if (action === 'deploy_production') return deployManagedSiteProduction(ownerUserId, { releaseId: Number(body.releaseId), executionMode: 'live', idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
  if (action === 'rollback') return rollbackManagedSiteRelease(ownerUserId, { fromReleaseId: Number(body.fromReleaseId), toReleaseId: Number(body.toReleaseId), executionMode: 'live', idempotencyKey: String(body.idempotencyKey || '') }, adapter, { repository })
  throw createError({ statusCode: 422, statusMessage: 'Managed-site orchestration action is unsupported.' })
})
