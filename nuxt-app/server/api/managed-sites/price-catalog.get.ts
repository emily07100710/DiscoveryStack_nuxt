import { getManagedSitePriceCatalog } from '../../managed-sites/ordering-service'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'public, max-age=300')
  return getManagedSitePriceCatalog()
})
