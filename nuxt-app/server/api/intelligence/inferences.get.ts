import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerPublicInferences } from '../../public-intelligence/analysis'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  return listOwnerPublicInferences(await getOwnerDatabaseUserId(owner.openId))
})
