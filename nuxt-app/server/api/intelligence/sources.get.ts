import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerPublicSources } from '../../public-intelligence/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'no-store')
  const owner = await requireOwner(event)
  const query = getQuery(event)
  const stringQuery = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  return listOwnerPublicSources(await getOwnerDatabaseUserId(owner.openId), { search: stringQuery(query.search), reviewStatus: stringQuery(query.reviewStatus) as 'pending' | 'approved' | 'needs_policy_review' | 'rejected' | 'removed' | undefined, allowedUse: stringQuery(query.allowedUse) as 'research_only' | 'evaluation_candidate' | 'training_candidate' | 'blocked' | undefined, includeRemoved: query.includeRemoved === 'true' })
})
