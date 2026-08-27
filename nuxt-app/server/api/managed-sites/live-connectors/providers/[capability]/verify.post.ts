import { getRouterParam } from 'h3'
import { managedSiteOwnerContext, strictManagedSiteBody } from '../../../../../managed-sites/live-connectors/http'
import { verifyManagedSiteProviderConfiguration } from '../../../../../managed-sites/live-connectors/provider-registry'
import { MANAGED_SITE_CONNECTOR_CAPABILITIES, type ManagedSiteConnectorCapability } from '../../../../../managed-sites/live-connectors/types'

export default defineEventHandler(async event => {
  const { ownerUserId, repository, credentialResolver, verifierRegistry, fetchImpl } = await managedSiteOwnerContext(event)
  await strictManagedSiteBody(event, [])
  const capability = String(getRouterParam(event, 'capability') || '') as ManagedSiteConnectorCapability
  if (!MANAGED_SITE_CONNECTOR_CAPABILITIES.includes(capability)) throw createError({ statusCode: 422, statusMessage: 'Provider capability is invalid.' })
  const result = await verifyManagedSiteProviderConfiguration(ownerUserId, capability, repository, credentialResolver, () => new Date(), verifierRegistry, fetchImpl)
  return { capability, providerKey: result.configuration.providerKey, status: result.configuration.readinessStatus, verificationReceiptFingerprint: result.receiptFingerprint, credentialValue: null }
})
