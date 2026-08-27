import { getRouterParam } from 'h3'
import { predict } from '../../../../geo-outcome-model'
import { readGeoBody, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders } from '../../_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const id = getRouterParam(event, 'id')
    if (!id) throw new Error('Model artifact id is required.')
    const body = await readGeoBody(event)
    strictKeys(body, ['observation'])
    if (!body.observation || typeof body.observation !== 'object' || Array.isArray(body.observation)) throw new Error('observation object is required.')
    const prediction = await predict(ownerUserId, id, body.observation)
    return { status: 'success', predictionType: 'experimental_prediction', prediction }
  } catch (error) { return routeError(error) }
})
