import { readBody, setResponseHeader } from 'h3'
import { requireOwner } from '../../../utils/auth'
import { getOwnerDatabaseUserId } from '../../../audit/repository'
import { configureManagedSiteProvider } from '../../../managed-sites/live-connectors/provider-registry'

export default defineEventHandler(async event => {
  const owner = await requireOwner(event)
  const ownerUserId = await getOwnerDatabaseUserId(owner.openId)
  setResponseHeader(event, 'Cache-Control', 'private, no-store, max-age=0')
  const result = await configureManagedSiteProvider(ownerUserId, await readBody(event))
  return { capability: result.configuration.capability, providerKey: result.configuration.providerKey, status: result.configuration.readinessStatus, credentialReferenceConfigured: Boolean(result.configuration.credentialReference), verificationReceiptConfigured: Boolean(result.configuration.verificationReceiptFingerprint), verifiedAt: result.configuration.verifiedAt, replayed: result.replayed }
})
