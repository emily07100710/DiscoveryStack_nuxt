import { getManagedSitePriceCatalog } from '../../managed-sites/ordering-service'
import { privateManagedSiteHeaders } from '../../managed-sites/live-connectors/http'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  return getManagedSitePriceCatalog()
})
