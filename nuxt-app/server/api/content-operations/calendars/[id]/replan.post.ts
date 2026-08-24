import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parseReplanInput, replanOwnerContentCalendar, toPublicContentOperationsError } from '../../../../content-operations'
import { requireOwner } from '../../../../utils/auth'

function calendarId(event: Parameters<typeof requireOwner>[0]): number {
  const value = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(value) || value < 1) throw createError({ statusCode: 422, statusMessage: 'Calendar id is invalid.' })
  return value
}

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    const body = await readBody(event)
    parseReplanInput(body)
    return await replanOwnerContentCalendar(ownerUserId, calendarId(event), body)
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Calendar replan is temporarily unavailable.')
  }
})
