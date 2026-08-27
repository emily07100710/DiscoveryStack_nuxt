import { createModelOpsPolicy } from '../../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, requiredIdempotency, routeError, readGeoBody, setGeoOutcomePrivateApiHeaders, strictKeys, withMutationIdempotency } from '../../_helpers'
import { projectPolicy } from '../_response'

const allowedKeys = ['idempotencyKey', 'cadence', 'minimumNewVerifiedCandidates', 'minimumNewQueryGroups', 'minimumNewWebsites', 'minimumObservationSpanDays', 'allowedModelFamilies', 'maximumTrainingRunsPerCycle', 'cooldownHours', 'shadowEvaluationEnabled', 'expiresAt'] as const

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    strictKeys(body, allowedKeys)
    const idempotencyKey = requiredIdempotency(body)
    const { modelOpsRepository } = getProductionModelOpsDependencies()
    const policy = await withMutationIdempotency(ownerUserId, 'geo-outcome-model/modelops/policies:create', idempotencyKey, body, async () => createModelOpsPolicy(ownerUserId, body, idempotencyKey, modelOpsRepository))
    return { status: 'success', policy: projectPolicy(policy), automaticallyEnabled: false, approvalsChanged: false }
  } catch (error) {
    return routeError(error)
  }
})
