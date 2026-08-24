import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createCalendarFromProductionPlan, parseCalendarInput } from '../../content-operations'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const parsed = parseCalendarInput(await readBody(event))
  try {
    return await createCalendarFromProductionPlan(ownerUserId, parsed)
  } catch (error: any) {
    if (error?.statusCode) throw createError({ statusCode: error.statusCode, statusMessage: typeof error.statusMessage === 'string' ? error.statusMessage : 'Content calendar request was rejected.' })
    throw createError({ statusCode: 503, statusMessage: 'Content calendar is temporarily unavailable.' })
  }
})
