import { createError } from 'h3'
import { stableFingerprint } from '../../../seo-geo-core/repository'
import { getManagedSiteLiveConnectorRepository } from '../repository'
import { managedSiteProviderAuthorityMetadata, resolveManagedSiteCredential, resolveManagedSiteProviderAuthority } from '../provider-registry'
import type { ManagedSiteCredentialResolver, ManagedSiteLiveConnectorRepository } from '../types'

export type ManagedSiteDnsMutationIdentity = { ownerUserId: number; projectId: number; releaseId: number; canonicalDomain: string; contentHash: string; providerAuthorityFingerprint: string }
export type ManagedSiteDnsMutationAuthority = {
  fingerprint: string
  registrationReceiptFingerprint: string
  registrar: { endpointOrigin: string; credentialReference: string; providerAuthorityFingerprint: string }
}
export type ManagedSiteDnsMutationAuthorityResolver = (identity: ManagedSiteDnsMutationIdentity) => Promise<ManagedSiteDnsMutationAuthority | null>
type DelegatedPaymentAuthority = { canonicalDomain: string; delegationFingerprint: string; procurementPolicyFingerprint: string; paymentReceiptFingerprint: string }
type Dependencies = {
  repository?: ManagedSiteLiveConnectorRepository
  credentialResolver?: ManagedSiteCredentialResolver
  delegatedPaymentAuthority?: (ownerUserId: number, releaseId: number, sessionId: number) => Promise<DelegatedPaymentAuthority>
}
const FINGERPRINT = /^[a-f0-9]{64}$/u
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function conflict(): never { throw createError({ statusCode: 409, statusMessage: 'Automatic DNS setup requires the exact current paid customer domain registration authority.' }) }

/** A signed broker request is transport authentication, not customer authority to mutate DNS. */
export async function resolveManagedSiteDnsMutationAuthority(identity: ManagedSiteDnsMutationIdentity, dependencies: Dependencies = {}): Promise<ManagedSiteDnsMutationAuthority | null> {
  const repository = dependencies.repository || getManagedSiteLiveConnectorRepository()
  const credentialResolver = dependencies.credentialResolver || resolveManagedSiteCredential
  const claim = await repository.findDomainClaim(identity.canonicalDomain)
  if (!claim) return null
  if (claim.ownerUserId !== identity.ownerUserId || claim.projectId !== identity.projectId || claim.releaseId !== identity.releaseId || claim.canonicalDomain !== identity.canonicalDomain || claim.status !== 'verified' || !claim.authorityReceiptFingerprint) conflict()
  const receipt = await repository.findReceiptByFingerprint(identity.ownerUserId, claim.authorityReceiptFingerprint)
  if (!receipt || receipt.receiptFingerprint !== claim.authorityReceiptFingerprint || receipt.ownerUserId !== identity.ownerUserId || receipt.projectId !== identity.projectId || receipt.releaseId !== identity.releaseId || receipt.canonicalDomain !== identity.canonicalDomain || receipt.receiptStatus !== 'verified') conflict()
  const metadata = record(receipt.metadata)
  // Existing domains and ordinary owner purchases retain the established read-only readiness path.
  if (metadata.purchaseAuthority === undefined) return null
  const purchase = record(metadata.purchaseAuthority)
  if (receipt.receiptType !== 'domain_registered' || receipt.capability !== 'domain_registration' || receipt.providerKey !== 'porkbun' || receipt.contentHash !== identity.contentHash || !receipt.verifiedAt || !receipt.externalReference || !receipt.exactResponseIdentity || purchase.kind !== 'customer_domain_delegation_v1' || !Number.isSafeInteger(purchase.sessionId) || Number(purchase.sessionId) <= 0 || !FINGERPRINT.test(String(purchase.delegationFingerprint)) || !FINGERPRINT.test(String(purchase.procurementPolicyFingerprint))) conflict()
  const release = await repository.findRelease(identity.ownerUserId, identity.releaseId)
  if (!release || release.projectId !== identity.projectId || release.canonicalDomain !== identity.canonicalDomain || release.contentHash !== identity.contentHash || !['payment_verified', 'provisioning', 'retry_wait'].includes(release.status) || receipt.draftOrderId !== release.draftOrderId || metadata.commerceSnapshotFingerprint !== release.commerceSnapshotFingerprint) conflict()
  const delegatedPaymentAuthority = dependencies.delegatedPaymentAuthority || (async (ownerUserId, releaseId, sessionId) => {
    const { assertFunnelDomainMutationAuthority } = await import('../../funnel/domain-purchase-authority')
    return assertFunnelDomainMutationAuthority(ownerUserId, releaseId, sessionId, { repository, credentialResolver, executionMode: 'live' })
  })
  const payment = await delegatedPaymentAuthority(identity.ownerUserId, identity.releaseId, Number(purchase.sessionId))
  if (payment.canonicalDomain !== identity.canonicalDomain || payment.delegationFingerprint !== purchase.delegationFingerprint || payment.procurementPolicyFingerprint !== purchase.procurementPolicyFingerprint || payment.paymentReceiptFingerprint !== metadata.paymentReceiptFingerprint) conflict()
  const registrarAuthority = await resolveManagedSiteProviderAuthority(identity.ownerUserId, 'domain_registration', 'live', repository, credentialResolver)
  if (registrarAuthority.providerKey !== 'porkbun' || registrarAuthority.capabilityIdentity !== 'porkbun:production' || Object.entries(managedSiteProviderAuthorityMetadata(registrarAuthority)).some(([key, value]) => metadata[key] !== value)) conflict()
  const dnsAuthority = await resolveManagedSiteProviderAuthority(identity.ownerUserId, 'dns_tls', 'live', repository, credentialResolver)
  if (dnsAuthority.providerKey !== 'internal-dns-tls-broker-hmac-v1' || dnsAuthority.authorityFingerprint !== identity.providerAuthorityFingerprint) conflict()
  const configuration = await repository.findProviderConfiguration(identity.ownerUserId, 'domain_registration')
  const endpointOrigin = record(configuration?.transportConfiguration).endpointOrigin
  if (!configuration?.credentialReference || configuration.configurationFingerprint !== registrarAuthority.configurationFingerprint || typeof endpointOrigin !== 'string' || !endpointOrigin) conflict()
  const registrar = { endpointOrigin, credentialReference: configuration.credentialReference, providerAuthorityFingerprint: registrarAuthority.authorityFingerprint }
  return { registrationReceiptFingerprint: receipt.receiptFingerprint, registrar, fingerprint: stableFingerprint({ scope: 'paid-new-domain-dns-authority-v1', ...identity, claimId: claim.id, claimProjectionFingerprint: claim.projectionFingerprint, registrationReceiptFingerprint: receipt.receiptFingerprint, sessionId: purchase.sessionId, delegationFingerprint: payment.delegationFingerprint, procurementPolicyFingerprint: payment.procurementPolicyFingerprint, paymentReceiptFingerprint: payment.paymentReceiptFingerprint, registrar }) }
}
