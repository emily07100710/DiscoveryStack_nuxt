import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../../../llm-visibility/api'
import { ownerManualObservationReviewSchema } from '../../../../llm-visibility/contracts'
import { reviewVisibilityObservation } from '../../../../llm-visibility/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const observationId = Number(getRouterParam(event, 'id'))
  const input = await parseVisibilityBody(event, ownerManualObservationReviewSchema)
  try { return await reviewVisibilityObservation(ownerUserId, ownerUserId, observationId, input) } catch (error) { rethrowVisibilityError(error) }
})
