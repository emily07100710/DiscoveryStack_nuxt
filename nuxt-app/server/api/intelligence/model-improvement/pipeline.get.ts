import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { listModelImprovementPipeline } from '../../../model-improvement/pipeline'
import { requireOwner } from '../../../utils/auth'

export default defineEventHandler(async (event) => {
  setHeader(event, 'cache-control', 'private, no-store, max-age=0')
  const owner = await requireOwner(event)
  return listModelImprovementPipeline(await getOwnerDatabaseUserId(owner.openId))
})
