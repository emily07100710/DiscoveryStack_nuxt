import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { parseReplanInput, replanOwnerContentCalendar } from '../../../../content-operations'
import { requireOwner } from '../../../../utils/auth'

function calendarId(event: Parameters<typeof requireOwner>[0]): number {
  const value = Number(getRouterParam(event, 'id'))
  if (!Number.isSafeInteger(value) || value < 1) throw createError({ statusCode: 422, statusMessage: 'Calendar id is invalid.' })
  return value
}

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const parsed = parseReplanInput(await readBody(event))
  try {
    return await replanOwnerContentCalendar(ownerUserId, calendarId(event), parsed)
  } catch (error: any) {
    if (error?.statusCode) throw createError({ statusCode: error.statusCode, statusMessage: typeof error.statusMessage === 'string' ? error.statusMessage : 'Calendar replan request was rejected.' })
    throw createError({ statusCode: 503, statusMessage: 'Calendar replan is temporarily unavailable.' })
  }
})
