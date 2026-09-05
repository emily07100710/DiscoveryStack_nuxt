import { getRouterParam } from 'h3'
import { createManagedSiteQuote } from '../../../../managed-sites/ordering-service'
import { parsePathId } from '../../../../managed-sites/normalization'
import { managedSitePublicOrderingRepository, privateManagedSiteHeaders, strictManagedSiteBody } from '../../../../managed-sites/live-connectors/http'

export default defineEventHandler(async (event) => {
  privateManagedSiteHeaders(event)
  const previewId = parsePathId(getRouterParam(event, 'id'), 'Managed site preview id')
  const body = await strictManagedSiteBody(event, ['previewAccessToken', 'planKey', 'cadenceDays', 'domainOption', 'designTier', 'domainTld', 'moduleKeys', 'idempotencyKey'])
  return createManagedSiteQuote({ ...body, previewId } as any, managedSitePublicOrderingRepository())
})
