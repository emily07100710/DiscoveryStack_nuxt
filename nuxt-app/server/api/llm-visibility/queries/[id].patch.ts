import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../../llm-visibility/api'
import { visibilityQueryUpdateSchema } from '../../../llm-visibility/contracts'
import { updateVisibilityQuery } from '../../../llm-visibility/repository'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const queryId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(queryId) || queryId <= 0) throw createError({ statusCode: 400, statusMessage: 'Query ID 無效。' })
  const input = await parseVisibilityBody(event, visibilityQueryUpdateSchema)
  try { return await updateVisibilityQuery(await getOwnerDatabaseUserId(owner.openId), queryId, input) } catch (error) { rethrowVisibilityError(error) }
})
