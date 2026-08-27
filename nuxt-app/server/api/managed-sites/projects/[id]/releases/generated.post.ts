import { managedSiteOwnerContext, managedSitePathId, strictManagedSiteBody } from '../../../../../managed-sites/live-connectors/http'
import { createGeneratedManagedSiteRelease } from '../../../../../managed-sites/live-connectors/deployment-orchestrator'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const projectId = managedSitePathId(event, 'id', 'Managed-site project id')
  const body = await strictManagedSiteBody(event, ['generationCandidateId', 'canonicalDomain', 'targetKey', 'idempotencyKey'])
  return createGeneratedManagedSiteRelease(ownerUserId, { projectId, generationCandidateId: Number(body.generationCandidateId), canonicalDomain: String(body.canonicalDomain || ''), targetKey: String(body.targetKey || ''), idempotencyKey: String(body.idempotencyKey || '') }, { repository })
})
