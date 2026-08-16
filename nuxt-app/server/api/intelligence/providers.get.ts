import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { getOwnerProviderStatus } from '../../public-intelligence/provider-repository'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return getOwnerProviderStatus(ownerUserId)
})
