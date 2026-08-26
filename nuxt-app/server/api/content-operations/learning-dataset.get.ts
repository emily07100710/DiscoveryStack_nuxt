import { buildOwnerContentLearningDataset, toPublicContentOperationsError } from '../../content-operations'
import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'

export default defineEventHandler(async event => {
  setResponseHeaders(event, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' })
  try {
    const owner = await requireOwner(event)
    const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
    return await buildOwnerContentLearningDataset(ownerUserId)
  } catch (error) {
    throw toPublicContentOperationsError(error, 'GEO content learning dataset is temporarily unavailable.')
  }
})
