import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerTrainingRuns } from '../../public-intelligence/training'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return listOwnerTrainingRuns(ownerUserId)
})
