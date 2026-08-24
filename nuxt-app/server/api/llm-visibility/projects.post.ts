import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../llm-visibility/api'
import { projectInputSchema } from '../../llm-visibility/contracts'
import { createVisibilityProject } from '../../llm-visibility/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const input = await parseVisibilityBody(event, projectInputSchema)
  try { return await createVisibilityProject(await getOwnerDatabaseUserId(owner.openId), input) } catch (error) { rethrowVisibilityError(error) }
})
