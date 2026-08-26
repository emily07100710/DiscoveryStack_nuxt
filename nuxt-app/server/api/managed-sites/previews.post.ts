import { readBody } from 'h3'
import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createManagedSitePreview } from '../../managed-sites/ordering-service'
import { databaseExistingSiteDiagnosisResolver } from '../../managed-sites/diagnosis-binding'
import { requireOwner } from '../../utils/auth'

export default defineEventHandler(async event => {
  const body = await readBody(event) as Record<string, unknown> | null
  const needsOwner = Boolean(body && typeof body.existingSiteUrl === 'string')
  const ownerUserId = needsOwner ? await getOwnerDatabaseUserId((await requireOwner(event)).openId) : null
  setHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  const result = await createManagedSitePreview(ownerUserId, body, undefined, undefined, databaseExistingSiteDiagnosisResolver)
  return {
    preview: result.projection,
    previewId: result.preview.id,
    previewAccessToken: result.accessToken,
    siteSpec: result.spec,
    claims: { paymentVerified: false, domainPurchased: false, dnsVerified: false, deployed: false },
    replayed: result.replayed,
  }
})
