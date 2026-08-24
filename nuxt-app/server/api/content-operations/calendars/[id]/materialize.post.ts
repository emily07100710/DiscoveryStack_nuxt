import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { materializeOwnerDueContent, parseMaterializeInput, toPublicContentOperationsError } from '../../../../content-operations'
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
    const parsed = parseMaterializeInput(await readBody(event))
    return await materializeOwnerDueContent(ownerUserId, { calendarId: calendarId(event), ...parsed })
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Calendar materialization is temporarily unavailable.')
  }
})
