import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../../../llm-visibility/api'
import { visibilityCompetitorCreateSchema } from '../../../../llm-visibility/contracts'
import { createVisibilityCompetitor } from '../../../../llm-visibility/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const projectId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(projectId) || projectId <= 0) throw createError({ statusCode: 400, statusMessage: 'Project ID 無效。' })
  const input = await parseVisibilityBody(event, visibilityCompetitorCreateSchema)
  try { return await createVisibilityCompetitor(await getOwnerDatabaseUserId(owner.openId), projectId, input) } catch (error) { rethrowVisibilityError(error) }
})
