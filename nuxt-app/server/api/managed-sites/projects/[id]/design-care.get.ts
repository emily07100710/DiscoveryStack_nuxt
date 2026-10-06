import { getRouterParam } from 'h3'
import { getOwnerDatabaseUserId } from '../../../../audit/repository'
import { getManagedSiteDesignCare } from '../../../../managed-sites/design-care'
import { privateManagedSiteHeaders } from '../../../../managed-sites/live-connectors/http'
import { parsePathId } from '../../../../managed-sites/normalization'
import { requireOwner } from '../../../../utils/auth'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  return getManagedSiteDesignCare(ownerUserId, projectId, { kind: 'owner' })
})
