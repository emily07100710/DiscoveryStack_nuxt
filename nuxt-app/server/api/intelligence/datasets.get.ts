import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerPublicDatasetBuilds } from '../../public-intelligence/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  return listOwnerPublicDatasetBuilds(await getOwnerDatabaseUserId(owner.openId))
})
