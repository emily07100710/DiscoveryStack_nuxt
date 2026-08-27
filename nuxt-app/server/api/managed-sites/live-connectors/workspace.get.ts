import { setResponseHeader } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { getManagedSiteLiveConnectorWorkspace } from '../../../managed-sites/live-connectors/workspace'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  return getManagedSiteLiveConnectorWorkspace(ownerUserId)
})
