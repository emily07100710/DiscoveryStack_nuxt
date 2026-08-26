import { getQuery, getRouterParam } from 'h3'
import { getManagedSitePublicPreview } from '../../../managed-sites/ordering-service'
import { parsePathId } from '../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  const previewId = parsePathId(getRouterParam(event, 'id'), 'Managed site preview id')
  const query = getQuery(event)
  const accessToken = typeof query.accessToken === 'string' ? query.accessToken : ''
  return getManagedSitePublicPreview(previewId, accessToken)
})
