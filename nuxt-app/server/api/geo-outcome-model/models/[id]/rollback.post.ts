import { rollbackModelOpsArtifact } from '../../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, requiredIdempotency, routeError, readGeoBody, setGeoOutcomePrivateApiHeaders, strictKeys, withMutationIdempotency } from '../../_helpers'
import { projectArtifact, projectRollbackDecision } from '../../modelops/_response'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const artifactId = getRouterParam(event, 'id') || ''
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'rollbackArtifactHash', 'reason'])
    const idempotencyKey = requiredIdempotency(body)
    if (typeof body.rollbackArtifactHash !== 'string' || typeof body.reason !== 'string') throw new Error('rollbackArtifactHash and reason are required.')
    const { outcomeRepository, modelOpsRepository } = getProductionModelOpsDependencies()
    const result = await withMutationIdempotency(ownerUserId, `models/${artifactId}/rollback`, idempotencyKey, { artifactId, body }, async () => rollbackModelOpsArtifact(ownerUserId, artifactId, body.rollbackArtifactHash as string, body.reason as string, outcomeRepository, modelOpsRepository, ownerUserId))
    return { status: 'success', decision: projectRollbackDecision(result.decision), revokedArtifact: projectArtifact(result.revokedArtifact), productionActive: false, automaticRollback: false }
  } catch (error) {
    return routeError(error)
  }
})
