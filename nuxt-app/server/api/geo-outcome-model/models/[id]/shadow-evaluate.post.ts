import { evaluateModelOpsShadow } from '../../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, requiredIdempotency, routeError, readGeoBody, setGeoOutcomePrivateApiHeaders, strictKeys, withMutationIdempotency } from '../../_helpers'
import { projectShadowEvaluation } from '../../modelops/_response'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const artifactId = getRouterParam(event, 'id') || ''
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey'])
    const idempotencyKey = requiredIdempotency(body)
    const { outcomeRepository, modelOpsRepository } = getProductionModelOpsDependencies()
    const evaluation = await withMutationIdempotency(ownerUserId, `models/${artifactId}/shadow-evaluate`, idempotencyKey, { artifactId, body }, async () => evaluateModelOpsShadow(ownerUserId, artifactId, outcomeRepository, modelOpsRepository))
    return { status: 'success', evaluation: projectShadowEvaluation(evaluation), productionActive: false, rollbackRequired: evaluation.status === 'needs_owner_attention' }
  } catch (error) {
    return routeError(error)
  }
})
