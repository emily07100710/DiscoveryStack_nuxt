import { describe, expect, it, vi } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { resolveManagedSiteDnsMutationAuthority } from '../server/managed-sites/live-connectors/internal-broker/dns-mutation-authority'
import { managedSiteProviderAuthorityMetadata, resolveManagedSiteProviderAuthority } from '../server/managed-sites/live-connectors/provider-registry'
import type { ManagedSiteLiveConnectorRepository } from '../server/managed-sites/live-connectors/types'

async function setup() {
  const identity = { ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: 'new-brand.taipei', contentHash: 'a'.repeat(64), providerAuthorityFingerprint: '' }
  const release = { id: 3, ownerUserId: 1, projectId: 2, canonicalDomain: identity.canonicalDomain, contentHash: identity.contentHash, status: 'payment_verified', draftOrderId: 4, commerceSnapshotFingerprint: 'b'.repeat(64) }
  const claim = { id: 5, ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: identity.canonicalDomain, status: 'verified', authorityReceiptFingerprint: 'c'.repeat(64), projectionFingerprint: 'd'.repeat(64) }
  const configuration = (capability: string, providerKey: string, capabilityIdentity: string) => ({ ownerUserId: 1, capability, providerKey, readinessStatus: 'verified', credentialReference: `envref:${capability}`, configurationFingerprint: stableFingerprint({ capability }), verificationReceiptFingerprint: stableFingerprint({ providerKey }), capabilityIdentity, verifiedAt: new Date('2030-01-01T00:00:00Z'), transportConfiguration: { endpointOrigin: capability === 'domain_registration' ? 'https://api.porkbun.com' : 'https://managed-sites-broker.internal' } })
  const configurations = { domain_registration: configuration('domain_registration', 'porkbun', 'porkbun:production'), dns_tls: configuration('dns_tls', 'internal-dns-tls-broker-hmac-v1', 'internal-dns-ownership:v1') }
  const receipt = { ownerUserId: 1, projectId: 2, releaseId: 3, draftOrderId: 4, canonicalDomain: identity.canonicalDomain, receiptType: 'domain_registered', receiptStatus: 'verified', capability: 'domain_registration', providerKey: 'porkbun', contentHash: identity.contentHash, receiptFingerprint: claim.authorityReceiptFingerprint, verifiedAt: new Date(), externalReference: 'porkbun-registration-test', exactResponseIdentity: 'porkbun-observed-registration-test', metadata: {} as Record<string, any> }
  const repository = { findDomainClaim: vi.fn(async () => claim), findReceiptByFingerprint: vi.fn(async () => receipt), findRelease: vi.fn(async () => release), findProviderConfiguration: vi.fn(async (_owner: number, capability: keyof typeof configurations) => configurations[capability]) }
  const credentialResolver = vi.fn(async () => ({ ok: true as const, value: 'synthetic-test-credential' }))
  const registrarAuthority = await resolveManagedSiteProviderAuthority(1, 'domain_registration', 'live', repository as unknown as ManagedSiteLiveConnectorRepository, credentialResolver)
  const dnsAuthority = await resolveManagedSiteProviderAuthority(1, 'dns_tls', 'live', repository as unknown as ManagedSiteLiveConnectorRepository, credentialResolver)
  identity.providerAuthorityFingerprint = dnsAuthority.authorityFingerprint
  const payment = { canonicalDomain: identity.canonicalDomain, delegationFingerprint: 'e'.repeat(64), procurementPolicyFingerprint: 'f'.repeat(64), paymentReceiptFingerprint: '1'.repeat(64) }
  const delegatedPaymentAuthority = vi.fn(async () => payment)
  receipt.metadata = { commerceSnapshotFingerprint: release.commerceSnapshotFingerprint, paymentReceiptFingerprint: payment.paymentReceiptFingerprint, ...managedSiteProviderAuthorityMetadata(registrarAuthority), purchaseAuthority: { kind: 'customer_domain_delegation_v1', sessionId: 6, delegationFingerprint: payment.delegationFingerprint, procurementPolicyFingerprint: payment.procurementPolicyFingerprint } }
  const run = () => resolveManagedSiteDnsMutationAuthority(identity, { repository: repository as unknown as ManagedSiteLiveConnectorRepository, credentialResolver, delegatedPaymentAuthority })
  return { identity, release, claim, receipt, configurations, repository, payment, delegatedPaymentAuthority, run }
}

describe('durable paid new-domain DNS mutation authority', () => {
  it('binds current exact registration, paid delegation, provider verification and DNS request without returning contact or secrets', async () => {
    const line = await setup()
    const authority = await line.run()
    expect(authority).toMatchObject({ registrationReceiptFingerprint: line.receipt.receiptFingerprint, registrar: { endpointOrigin: 'https://api.porkbun.com', credentialReference: 'envref:domain_registration' } })
    expect(authority?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(line.delegatedPaymentAuthority).toHaveBeenCalledWith(1, 3, 6)
    expect(JSON.stringify(authority)).not.toMatch(/synthetic-test-credential|registrant|email/u)
  })

  it('leaves existing-domain ownership and nondelegated owner purchases verify-only', async () => {
    const line = await setup()
    delete line.receipt.metadata.purchaseAuthority
    line.receipt.receiptType = 'existing_site_ownership_verified'
    await expect(line.run()).resolves.toBeNull()
    expect(line.delegatedPaymentAuthority).not.toHaveBeenCalled()
  })

  it('does not infer mutation authority when no durable domain claim exists', async () => {
    const line = await setup()
    line.repository.findDomainClaim.mockResolvedValue(null as any)
    await expect(line.run()).resolves.toBeNull()
    expect(line.repository.findReceiptByFingerprint).not.toHaveBeenCalled()
  })

  it.each(['claimOwner', 'claimProject', 'claimRelease', 'claimPending', 'receiptProject', 'receiptDomain', 'receiptStatus', 'releaseContent', 'releaseStatus', 'draftOrder', 'commerce', 'malformedDelegation', 'delegation', 'policy', 'payment', 'registrarEnvironment', 'registrarRotation', 'dnsRotation'] as const)('rejects changed or mismatched %s authority', async change => {
    const line = await setup()
    if (change === 'claimOwner') line.claim.ownerUserId = 8
    if (change === 'claimProject') line.claim.projectId = 8
    if (change === 'claimRelease') line.claim.releaseId = 8
    if (change === 'claimPending') line.claim.status = 'pending'
    if (change === 'receiptProject') line.receipt.projectId = 8
    if (change === 'receiptDomain') line.receipt.canonicalDomain = 'other.taipei'
    if (change === 'receiptStatus') line.receipt.receiptStatus = 'rejected'
    if (change === 'releaseContent') line.release.contentHash = '8'.repeat(64)
    if (change === 'releaseStatus') line.release.status = 'rolled_back'
    if (change === 'draftOrder') line.receipt.draftOrderId = 8
    if (change === 'commerce') line.receipt.metadata.commerceSnapshotFingerprint = '8'.repeat(64)
    if (change === 'malformedDelegation') line.receipt.metadata.purchaseAuthority.sessionId = 0
    if (change === 'delegation') line.payment.delegationFingerprint = '8'.repeat(64)
    if (change === 'policy') line.payment.procurementPolicyFingerprint = '8'.repeat(64)
    if (change === 'payment') line.payment.paymentReceiptFingerprint = '8'.repeat(64)
    if (change === 'registrarEnvironment') line.configurations.domain_registration.capabilityIdentity = 'porkbun:sandbox'
    if (change === 'registrarRotation') line.configurations.domain_registration.verificationReceiptFingerprint = '8'.repeat(64)
    if (change === 'dnsRotation') line.configurations.dns_tls.verificationReceiptFingerprint = '8'.repeat(64)
    await expect(line.run()).rejects.toMatchObject({ statusCode: 409 })
  })

  it.each(['test payment', 'refund', 'revoked delegation'])('propagates the shared live payment guard rejection for %s', async reason => {
    const line = await setup()
    line.delegatedPaymentAuthority.mockRejectedValue(Object.assign(new Error(reason), { statusCode: 409 }))
    await expect(line.run()).rejects.toMatchObject({ statusCode: 409 })
  })
})
