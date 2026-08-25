import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../llm-visibility/api'
import { providerObservationRunInputSchema } from '../../llm-visibility/contracts'
import { runOwnerProviderObservation } from '../../llm-visibility/repository'
import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const input = await parseVisibilityBody(event, providerObservationRunInputSchema)
  try { return await runOwnerProviderObservation(await getOwnerDatabaseUserId(owner.openId), input) } catch (error) { rethrowVisibilityError(error) }
})
