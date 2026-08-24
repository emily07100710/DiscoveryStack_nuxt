import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getOwnerContentOperationsWorkspace } from '../../content-operations'
import { requireOwner } from '../../utils/auth'

function privateHeaders(event: Parameters<typeof requireOwner>[0]) {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
}

export default defineEventHandler(async (event) => {
  privateHeaders(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  try {
    return await getOwnerContentOperationsWorkspace(ownerUserId)
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'Content Operations workspace is temporarily unavailable.' })
  }
})
