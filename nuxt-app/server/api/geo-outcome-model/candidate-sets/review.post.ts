import { getDatabase } from '../../../database'
import { executeCandidateSetReviewMutation } from '../candidate-set-review-mutation'
import { readGeoBody, requireGeoOutcomeOwner, routeError, setGeoOutcomePrivateApiHeaders } from '../_helpers'

export default defineEventHandler(async event => {
  setGeoOutcomePrivateApiHeaders(event)
  try {
    const { ownerUserId } = await requireGeoOutcomeOwner(event)
    const body = await readGeoBody(event)
    const database = getDatabase()
    if (!database) throw createError({ statusCode: 503, statusMessage: 'GEO outcome model storage is not configured.' })
    return await executeCandidateSetReviewMutation({ ownerUserId, reviewerUserId: ownerUserId, body, database })
  } catch (error) { return routeError(error) }
})
