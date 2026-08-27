import { getOwnerDatabaseUserId } from '../../audit/repository'
import { createManagedSitePreview } from '../../managed-sites/ordering-service'
import { databaseExistingSiteDiagnosisResolver } from '../../managed-sites/diagnosis-binding'
import { requireOwner } from '../../utils/auth'
import { managedSitePublicOrderingRepository, privateManagedSiteHeaders, strictManagedSiteBody } from '../../managed-sites/live-connectors/http'

export default defineEventHandler(async event => {
  const body = await strictManagedSiteBody(event, ['draftIdentity', 'locale', 'brandName', 'audience', 'brief', 'businessGoals', 'siteType', 'selectedModules', 'styleReferences', 'existingSiteUrl', 'diagnosisId', 'diagnosisFindingIds'])
  const needsOwner = Boolean(body && typeof body.existingSiteUrl === 'string')
  const ownerUserId = needsOwner ? await getOwnerDatabaseUserId((await requireOwner(event)).openId) : null
  privateManagedSiteHeaders(event)
  const result = await createManagedSitePreview(ownerUserId, body, managedSitePublicOrderingRepository(), undefined, databaseExistingSiteDiagnosisResolver)
  return {
    preview: result.projection,
    previewId: result.preview.id,
    previewAccessToken: result.accessToken,
    siteSpec: result.spec,
    claims: { paymentVerified: false, domainPurchased: false, dnsVerified: false, deployed: false },
    replayed: result.replayed,
  }
})
