import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { materializeOwnerDueContent, parseMaterializeInput } from '../../../../content-operations'
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
  const parsed = parseMaterializeInput(await readBody(event))
  try {
    return await materializeOwnerDueContent(ownerUserId, { calendarId: calendarId(event), ...parsed })
  } catch (error: any) {
    if (error?.statusCode) throw createError({ statusCode: error.statusCode, statusMessage: typeof error.statusMessage === 'string' ? error.statusMessage : 'Calendar materialization request was rejected.' })
    throw createError({ statusCode: 503, statusMessage: 'Calendar materialization is temporarily unavailable.' })
  }
})
