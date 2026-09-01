import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createInternalOwnershipBrokerHmacV1Adapter } from '../server/managed-sites/live-connectors/broker-adapters'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { parseManagedSiteInternalBrokerConfiguration } from '../server/managed-sites/live-connectors/internal-broker/config'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { resolveManagedSiteCredential } from '../server/managed-sites/live-connectors/provider-registry'

describe.runIf(process.env.DS_RUN_REAL_OWNERSHIP_TESTS === '1')('managed-site real DNS ownership verification', () => {
  const domain = String(process.env.DS_REAL_OWNERSHIP_DOMAIN || '').trim().toLowerCase()
  const configuration = parseManagedSiteInternalBrokerConfiguration()
  const authority = { schemaVersion: 'managed-site-provider-authority-v1', capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'internal-dns-ownership:v1', readinessStatus: 'verified', executionMode: 'live', verifiedAt: new Date().toISOString(), authorityFingerprint: stableFingerprint({ realOwnershipDomain: domain }) } as const
  const brokerFetch = createManagedSiteInternalBrokerFetch()
  const adapter = () => createInternalOwnershipBrokerHmacV1Adapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: 'internal-dns-tls-broker-hmac-v1', credentialReference: configuration!.dnsTlsCredentialReference, resolveCredential: resolveManagedSiteCredential, fetchImpl: brokerFetch, providerAuthorityFingerprint: authority.authorityFingerprint })
  let challengeReference = ''

  it('prints the exact TXT record the owner must create', async () => {
    expect(configuration).not.toBeNull(); expect(domain).toMatch(/^[a-z0-9.-]+$/u)
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = [process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS, MANAGED_SITE_INTERNAL_BROKER_ORIGIN].filter(Boolean).join(',')
    const challenge = await adapter().createChallenge({ ownerUserId: 1, projectId: 1, releaseId: 1, canonicalDomain: domain, verificationMethod: 'dns_txt', providerAuthority: authority, requestFingerprint: stableFingerprint({ realOwnershipDomain: domain, operation: 'challenge' }), idempotencyKey: 'real-ownership-challenge', timeoutMs: 10_000 })
    challengeReference = challenge.challengeReference
    console.log(`CREATE TXT: _discoverystack-challenge.${domain}  TXT  "discoverystack-site-verification=${challengeReference}"`)
    expect(challengeReference).toMatch(/^dsv1-[a-f0-9]{40}$/u)
  })

  it.runIf(process.env.DS_EXPECT_OWNERSHIP_VERIFIED === '1')('reports verified only after real DNS contains the exact token', async () => {
    expect(challengeReference).toMatch(/^dsv1-/u)
    const result = await adapter().verify({ projectId: 1, canonicalDomain: domain, challengeReference, providerAuthority: authority, requestFingerprint: stableFingerprint({ realOwnershipDomain: domain, operation: 'verify' }), timeoutMs: 30_000 })
    expect(result.status).toBe('verified')
  })
})
