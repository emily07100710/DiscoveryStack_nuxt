import { projectFunnelPriceCatalog } from '../../managed-sites/funnel/quote-projection'
import { privateManagedSiteHeaders } from '../../managed-sites/live-connectors/http'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  return projectFunnelPriceCatalog()
})
