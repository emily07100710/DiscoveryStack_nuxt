import { getRouterParam, readBody } from 'h3'
import { createManagedSiteLeadIntent } from '../../../../managed-sites/ordering-service'
import { parsePathId } from '../../../../managed-sites/normalization'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  const previewId = parsePathId(getRouterParam(event, 'id'), 'Managed site preview id')
  const body = await readBody(event)
  return createManagedSiteLeadIntent({ ...(body || {}), previewId })
})
