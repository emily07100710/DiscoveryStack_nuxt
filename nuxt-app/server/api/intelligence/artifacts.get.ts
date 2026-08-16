import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerPublicArtifacts } from '../../public-intelligence/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  return listOwnerPublicArtifacts(await getOwnerDatabaseUserId(owner.openId))
})
