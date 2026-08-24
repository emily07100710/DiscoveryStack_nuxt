import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getOwnerContentOperationsWorkspace, toPublicContentOperationsError } from '../../content-operations'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    return await getOwnerContentOperationsWorkspace(ownerUserId)
  } catch (error) {
    throw toPublicContentOperationsError(error, 'Content operation workspace is temporarily unavailable.')
  }
})
