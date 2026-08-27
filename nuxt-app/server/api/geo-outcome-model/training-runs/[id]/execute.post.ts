import { getRouterParam } from 'h3'
import { executeTrainingRun } from '../../../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const id = getRouterParam(event, 'id')
    if (!id) throw new Error('Training run id is required.')
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey'])
    const idempotencyKey = requiredIdempotency(body)
    const trainingRun = await withMutationIdempotency(ownerUserId, `training-runs/${id}/execute`, idempotencyKey, {}, transaction => executeTrainingRun(ownerUserId, id, transaction))
    return { status: 'success', trainingRun }
  } catch (error) { return routeError(error) }
})
