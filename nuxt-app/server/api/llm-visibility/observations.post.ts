import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../llm-visibility/api'
import { ownerManualObservationImportSchema } from '../../llm-visibility/contracts'
import { createDrizzleVisibilityWorkflowRepository } from '../../llm-visibility/repository'
import { importObservationSnapshot } from '../../llm-visibility/service'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const input = await parseVisibilityBody(event, ownerManualObservationImportSchema)
  try { return await importObservationSnapshot(createDrizzleVisibilityWorkflowRepository(), await getOwnerDatabaseUserId(owner.openId), input) } catch (error) { rethrowVisibilityError(error) }
})
