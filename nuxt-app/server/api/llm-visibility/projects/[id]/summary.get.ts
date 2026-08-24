import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { rethrowVisibilityError, setPrivateApiHeaders } from '../../../../llm-visibility/api'
import { getVisibilityProjectSummary } from '../../../../llm-visibility/repository'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Project ID 無效。' })
  try { return await getVisibilityProjectSummary(await getOwnerDatabaseUserId(owner.openId), id) } catch (error) { rethrowVisibilityError(error) }
})
