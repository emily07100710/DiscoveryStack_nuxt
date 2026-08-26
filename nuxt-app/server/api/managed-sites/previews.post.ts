import { readBody } from 'h3'
import { createManagedSitePreview } from '../../managed-sites/ordering-service'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  const result = await createManagedSitePreview(null, await readBody(event))
  return {
    preview: result.projection,
    previewId: result.preview.id,
    previewAccessToken: result.accessToken,
    siteSpec: result.spec,
    claims: { paymentVerified: false, domainPurchased: false, dnsVerified: false, deployed: false },
    replayed: result.replayed,
  }
})
