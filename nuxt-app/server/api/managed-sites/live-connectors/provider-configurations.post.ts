import { managedSiteOwnerContext, strictManagedSiteBody } from '../../../managed-sites/live-connectors/http'
import { configureManagedSiteProvider } from '../../../managed-sites/live-connectors/provider-registry'

export default defineEventHandler(async event => {
  const { ownerUserId, repository } = await managedSiteOwnerContext(event)
  const body = await strictManagedSiteBody(event, ['capability', 'providerKey', 'readinessStatus', 'credentialReference', 'transportConfiguration', 'idempotencyKey'])
  const result = await configureManagedSiteProvider(ownerUserId, body as any, repository)
  return { capability: result.configuration.capability, providerKey: result.configuration.providerKey, status: result.configuration.readinessStatus, credentialReferenceConfigured: Boolean(result.configuration.credentialReference), verificationReceiptConfigured: Boolean(result.configuration.verificationReceiptFingerprint), verifiedAt: result.configuration.verifiedAt, replayed: result.replayed }
})
