import { getOwnerDatabaseUserId } from '../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../llm-visibility/api'
import { queryInputSchema } from '../../llm-visibility/contracts'
import { createVisibilityQuery } from '../../llm-visibility/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const input = await parseVisibilityBody(event, queryInputSchema)
  try { return await createVisibilityQuery(await getOwnerDatabaseUserId(owner.openId), input) } catch (error) { rethrowVisibilityError(error) }
})
