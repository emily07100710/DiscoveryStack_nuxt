import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { rethrowVisibilityError, setPrivateApiHeaders } from '../../../llm-visibility/api'
import { deactivateVisibilityCompetitor } from '../../../llm-visibility/repository'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const competitorId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(competitorId) || competitorId <= 0) throw createError({ statusCode: 400, statusMessage: 'Competitor ID 無效。' })
  try { return await deactivateVisibilityCompetitor(await getOwnerDatabaseUserId(owner.openId), competitorId) } catch (error) { rethrowVisibilityError(error) }
})
