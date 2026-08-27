import { createError } from 'h3'
import { recordManualObservation } from '../../geo-outcome-model'
import { readGeoBody, requiredIdempotency, routeError, strictKeys, requireGeoOutcomeOwner, setGeoOutcomePrivateApiHeaders, withMutationIdempotency } from './_helpers'

export default defineEventHandler(async (event) => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    strictKeys(body, ['idempotencyKey', 'observation'])
    const idempotencyKey = requiredIdempotency(body)
    if (!body.observation || typeof body.observation !== 'object' || Array.isArray(body.observation)) throw createError({ statusCode: 422, statusMessage: 'observation object is required.' })
    const observation = await withMutationIdempotency(ownerUserId, 'observations.manual', idempotencyKey, body.observation, transaction => recordManualObservation(ownerUserId, body.observation, transaction))
    return { status: 'success', observation: { observationFingerprint: observation.observationFingerprint, runIdentity: observation.runIdentity, labelBasis: observation.labelBasis, verificationStatus: observation.verificationStatus } }
  } catch (error) { return routeError(error) }
})
