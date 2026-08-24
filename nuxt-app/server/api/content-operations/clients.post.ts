import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createOwnerContentClient, parseClientInput } from '../../content-operations'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const parsed = parseClientInput(await readBody(event))
  try {
    return await createOwnerContentClient(ownerUserId, parsed)
  } catch (error: any) {
    if (error?.statusCode) throw createError({ statusCode: error.statusCode, statusMessage: typeof error.statusMessage === 'string' ? error.statusMessage : 'Content operation request was rejected.' })
    throw createError({ statusCode: 503, statusMessage: 'Content operation client is temporarily unavailable.' })
  }
})
