import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { parseVisibilityBody, rethrowVisibilityError, setPrivateApiHeaders } from '../../../llm-visibility/api'
import { visibilityCompetitorUpdateSchema } from '../../../llm-visibility/contracts'
import { updateVisibilityCompetitor } from '../../../llm-visibility/repository'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  const competitorId = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(competitorId) || competitorId <= 0) throw createError({ statusCode: 400, statusMessage: 'Competitor ID 無效。' })
  const input = await parseVisibilityBody(event, visibilityCompetitorUpdateSchema)
  try { return await updateVisibilityCompetitor(await getOwnerDatabaseUserId(owner.openId), competitorId, input) } catch (error) { rethrowVisibilityError(error) }
})
