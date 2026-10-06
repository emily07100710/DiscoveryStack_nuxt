import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getOwnerContentOperationsWorkspace } from '../../content-operations/service'
import { toPublicContentOperationsError } from '../../content-operations/normalization'
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
