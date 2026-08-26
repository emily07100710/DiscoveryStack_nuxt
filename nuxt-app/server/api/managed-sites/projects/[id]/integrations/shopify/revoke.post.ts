import { requireOwner } from '../../../../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../../../../audit/repository'
import { getIntegrationRepository } from '../../../../../../managed-sites/modules-repository'
import { getManagedSiteRepository } from '../../../../../../managed-sites/repository'
import { parsePathId } from '../../../../../../managed-sites/normalization'
import { revokeShopifyIntegration } from '../../../../../../managed-sites/shopify-service'

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  const projectId = parsePathId(getRouterParam(event, 'id'), 'Managed site project id')
  const body = await readBody(event) || {}
  const result = await revokeShopifyIntegration(ownerUserId, projectId, Number(body.integrationId), getIntegrationRepository(), getManagedSiteRepository())
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  return result
})
