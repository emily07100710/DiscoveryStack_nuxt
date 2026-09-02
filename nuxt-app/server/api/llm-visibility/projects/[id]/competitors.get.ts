import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { rethrowVisibilityError, setPrivateApiHeaders } from '../../../../llm-visibility/api'
import { listVisibilityCompetitors } from '../../../../llm-visibility/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const projectId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(projectId) || projectId <= 0) throw createError({ statusCode: 400, statusMessage: 'Project ID 無效。' })
  try { return await listVisibilityCompetitors(await getOwnerDatabaseUserId(owner.openId), projectId) } catch (error) { rethrowVisibilityError(error) }
})
