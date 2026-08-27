import { getRouterParam } from 'h3'
import { reviewModel } from '../../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const id = getRouterParam(event, 'id')
    if (!id) throw new Error('Model artifact id is required.')
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'decision', 'reason'])
    const idempotencyKey = requiredIdempotency(body)
    if (body.decision !== 'approve_for_shadow' && body.decision !== 'revoke') throw new Error('Model decision is invalid.')
    if (typeof body.reason !== 'string') throw new Error('Review reason is required.')
    const result = await withMutationIdempotency(ownerUserId, `models/${id}/review`, idempotencyKey, { decision: body.decision, reason: body.reason }, transaction => reviewModel(ownerUserId, id, body.decision as 'approve_for_shadow' | 'revoke', ownerUserId, body.reason as string, transaction))
    return { status: 'success', artifact: result.artifact, gate: result.gate, ledger: result.ledger, productionActive: false }
  } catch (error) { return routeError(error) }
})
