import { readBody, getRouterParam } from 'h3'
import { getManagedSitePublicPreview } from '../../../managed-sites/ordering-service'
import { parsePathId } from '../../../managed-sites/normalization'

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  const previewId = parsePathId(getRouterParam(event, 'id'), 'Managed site preview id')
  const body = await readBody(event) as { accessToken?: unknown } | null
  const accessToken = body && typeof body.accessToken === 'string' ? body.accessToken : ''
  return getManagedSitePublicPreview(previewId, accessToken)
})
