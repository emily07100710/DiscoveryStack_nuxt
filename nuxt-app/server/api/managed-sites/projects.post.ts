import { readBody } from 'h3'
import { requireOwner } from '../../utils/auth'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createManagedSiteProject } from '../../managed-sites/service'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  return createManagedSiteProject(ownerUserId, { ownerUserId, actorUserId: ownerUserId, authority: 'owner_session', role: 'owner', principal: owner.openId }, await readBody(event))
})
