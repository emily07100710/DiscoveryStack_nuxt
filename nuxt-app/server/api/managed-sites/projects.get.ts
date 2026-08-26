import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerManagedSites } from '../../managed-sites/service'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return { projects: await listOwnerManagedSites(ownerUserId) }
})
