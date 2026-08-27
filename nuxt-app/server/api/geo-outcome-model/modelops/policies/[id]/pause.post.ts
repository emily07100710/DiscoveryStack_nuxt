import { changeModelOpsPolicy } from '../../../../../geo-outcome-model/modelops-service'
import { getProductionModelOpsDependencies } from '../../../../../geo-outcome-model/modelops-runtime'
import { requireGeoOutcomeOwner, requiredIdempotency, routeError, readGeoBody, setGeoOutcomePrivateApiHeaders, strictKeys, withMutationIdempotency } from '../../../_helpers'
import { projectPolicy } from '../../_response'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const policyId = getRouterParam(event, 'id') || ''
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'reason'])
    const idempotencyKey = requiredIdempotency(body)
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    const { modelOpsRepository } = getProductionModelOpsDependencies()
    const policy = await withMutationIdempotency(ownerUserId, 'geo-outcome-model/modelops/policies/pause', idempotencyKey, { policyId, body }, async () => changeModelOpsPolicy(ownerUserId, policyId, 'pause', modelOpsRepository, reason))
    return { status: 'success', policy: projectPolicy(policy), automaticallyReenabled: false }
  } catch (error) {
    return routeError(error)
  }
})
