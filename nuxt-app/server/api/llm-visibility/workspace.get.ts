import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listVisibilityWorkspace } from '../../llm-visibility/repository'
import { setPrivateApiHeaders } from '../../llm-visibility/api'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setPrivateApiHeaders(event)
  const owner = await requireOwner(event)
  return listVisibilityWorkspace(await getOwnerDatabaseUserId(owner.openId))
})
