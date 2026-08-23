import { getOwnerDatabaseUserId } from '../../audit/repository'
import { listOwnerSeoGeoWorkspace } from '../../seo-geo-core/repository'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  setHeader(event, 'cache-control', 'no-store')
  const owner = await requireOwner(event)
  return listOwnerSeoGeoWorkspace(await getOwnerDatabaseUserId(owner.openId))
})
