import { beforeEach, describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createInternalOwnershipBrokerHmacV1Adapter } from '../server/managed-sites/live-connectors/broker-adapters'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { securelyFetchManagedSiteWellKnown } from '../server/managed-sites/live-connectors/internal-broker/ownership-dns'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { createExistingSiteOwnershipChallenge, createExistingSiteRelease, verifyExistingSiteOwnership } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

const NOW = new Date()
const CREDENTIAL = 'ownership-hmac-secret-for-tests'
const config = { deploymentCredentialReference: 'envref:deployment-bearer-test', dnsTlsCredentialReference: 'envref:dns-tls-hmac-test', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cf-token-test', projectPrefix: 'ds' } }
const authority = { schemaVersion: 'managed-site-provider-authority-v1', capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'internal-dns-ownership:v1', readinessStatus: 'verified', executionMode: 'live', verifiedAt: NOW.toISOString(), authorityFingerprint: 'c'.repeat(64) } as const
const credentialResolver = async (reference: string) => reference === config.dnsTlsCredentialReference ? { ok: true as const, value: CREDENTIAL } : { ok: false as const, reason: 'missing_reference' as const }

function adapter(fetchImpl: typeof fetch) {
  return createInternalOwnershipBrokerHmacV1Adapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: 'internal-dns-tls-broker-hmac-v1', credentialReference: config.dnsTlsCredentialReference, resolveCredential: credentialResolver, fetchImpl, providerAuthorityFingerprint: authority.authorityFingerprint, clock: () => NOW })
}

const challengeInput = { ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: 'ownership.acme.taipei', verificationMethod: 'dns_txt' as const, providerAuthority: authority, requestFingerprint: 'd'.repeat(64), idempotencyKey: 'ownership-challenge-test', timeoutMs: 10_000 }

describe('managed-site internal ownership broker', () => {
  beforeEach(() => { process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = MANAGED_SITE_INTERNAL_BROKER_ORIGIN })

  it('creates deterministic opaque tokens and verifies split TXT chunks', async () => {
    let expected = ''
    const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, clock: () => NOW, dnsTxtResolver: async () => [['discoverystack-site-', `verification=${expected}`]] })
    const ownership = adapter(brokerFetch)
    const first = await ownership.createChallenge(challengeInput); const second = await ownership.createChallenge(challengeInput)
    expect(first.challengeReference).toBe(second.challengeReference); expect(first.challengeReference).toMatch(/^dsv1-[a-f0-9]{40}$/u)
    expected = first.challengeReference
    const verified = await ownership.verify({ projectId: 2, canonicalDomain: challengeInput.canonicalDomain, challengeReference: expected, providerAuthority: authority, requestFingerprint: 'e'.repeat(64), timeoutMs: 10_000 })
    expect(verified.status).toBe('verified'); expect(verified.evidenceHash).toMatch(/^[a-f0-9]{64}$/u)
    const restartedFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, clock: () => NOW, ownershipIdentityResolver: async () => ({ ownerUserId: challengeInput.ownerUserId, projectId: challengeInput.projectId, releaseId: challengeInput.releaseId, canonicalDomain: challengeInput.canonicalDomain, verificationMethod: challengeInput.verificationMethod, requestFingerprint: challengeInput.requestFingerprint }), dnsTxtResolver: async () => [[`discoverystack-site-verification=${expected}`]] })
    expect((await adapter(restartedFetch).verify({ projectId: 2, canonicalDomain: challengeInput.canonicalDomain, challengeReference: expected, providerAuthority: authority, requestFingerprint: '3'.repeat(64), timeoutMs: 10_000 })).status).toBe('verified')
  })

  it('returns pending for TXT absence and failed for a mismatched token', async () => {
    const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, clock: () => NOW, dnsTxtResolver: async () => [] })
    const ownership = adapter(brokerFetch); const challenge = await ownership.createChallenge(challengeInput)
    expect((await ownership.verify({ projectId: 2, canonicalDomain: challengeInput.canonicalDomain, challengeReference: challenge.challengeReference, providerAuthority: authority, requestFingerprint: 'e'.repeat(64), timeoutMs: 10_000 })).status).toBe('pending')
    expect((await ownership.verify({ projectId: 2, canonicalDomain: challengeInput.canonicalDomain, challengeReference: `dsv1-${'f'.repeat(40)}`, providerAuthority: authority, requestFingerprint: 'f'.repeat(64), timeoutMs: 10_000 })).status).toBe('failed')
  })

  it('verifies well-known files, treats redirects as pending, and rejects special-use DNS answers before connecting', async () => {
    let response = { status: 200, body: '' }; const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, clock: () => NOW, wellKnownFileFetcher: async () => response })
    const ownership = adapter(brokerFetch); const input = { ...challengeInput, verificationMethod: 'well_known_file' as const, idempotencyKey: 'well-known-challenge' }
    const challenge = await ownership.createChallenge(input); response = { status: 200, body: `other\n${challenge.challengeReference}\n` }
    expect((await ownership.verify({ projectId: 2, canonicalDomain: input.canonicalDomain, challengeReference: challenge.challengeReference, providerAuthority: authority, requestFingerprint: '1'.repeat(64), timeoutMs: 10_000 })).status).toBe('verified')
    response = { status: 302, body: challenge.challengeReference }
    expect((await ownership.verify({ projectId: 2, canonicalDomain: input.canonicalDomain, challengeReference: challenge.challengeReference, providerAuthority: authority, requestFingerprint: '2'.repeat(64), timeoutMs: 10_000 })).status).toBe('pending')
    expect(await securelyFetchManagedSiteWellKnown(input.canonicalDomain, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })).toEqual({ status: 0, body: '' })
  })

  it('drives the governed orchestrator from challenge to live_verified with the real broker fetch', async () => {
    process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify({ [config.dnsTlsCredentialReference]: CREDENTIAL })
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'ownership-live.acme.taipei', buildPreview: false })
    await configureManagedSiteProvider(1, { capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', readinessStatus: 'configured', credentialReference: config.dnsTlsCredentialReference, transportConfiguration: { endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN }, idempotencyKey: 'ownership-live-config' }, line.live.repository, () => NOW)
    let expected = ''
    const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, clock: () => NOW, dnsTxtResolver: async () => [[`discoverystack-site-verification=${expected}`]] })
    await verifyManagedSiteProviderConfiguration(1, 'dns_tls', line.live.repository, credentialResolver, () => NOW, undefined, brokerFetch)
    const existing = await createExistingSiteRelease(1, { projectId: line.prePurchase.project.id, canonicalDomain: 'ownership-live.acme.taipei', targetKey: 'ownership-existing', idempotencyKey: 'ownership-existing-release' }, { repository: line.live.repository, managedRepository: line.managed.repository })
    const configuration = await line.live.repository.findProviderConfiguration(1, 'dns_tls'); expect(configuration?.readinessStatus).toBe('verified')
    const liveAuthority = { schemaVersion: 'managed-site-provider-authority-v1', capability: 'dns_tls', providerKey: configuration!.providerKey, configurationFingerprint: configuration!.configurationFingerprint, verificationReceiptFingerprint: configuration!.verificationReceiptFingerprint!, capabilityIdentity: configuration!.capabilityIdentity!, readinessStatus: 'verified', executionMode: 'live', verifiedAt: configuration!.verifiedAt!.toISOString(), authorityFingerprint: stableFingerprint({ schemaVersion: 'managed-site-provider-authority-v1', capability: 'dns_tls', providerKey: configuration!.providerKey, configurationFingerprint: configuration!.configurationFingerprint, verificationReceiptFingerprint: configuration!.verificationReceiptFingerprint!, capabilityIdentity: configuration!.capabilityIdentity!, readinessStatus: 'verified', executionMode: 'live', verifiedAt: configuration!.verifiedAt!.toISOString() }) } as const
    const ownership = createInternalOwnershipBrokerHmacV1Adapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: configuration!.providerKey, credentialReference: config.dnsTlsCredentialReference, resolveCredential: credentialResolver, fetchImpl: brokerFetch, providerAuthorityFingerprint: liveAuthority.authorityFingerprint, clock: () => NOW })
    const challenge = await createExistingSiteOwnershipChallenge(1, { releaseId: existing.release.id, idempotencyKey: 'ownership-live-challenge', executionMode: 'live' }, line.live.repository, () => NOW, ownership)
    expected = challenge.challengeReference
    const verified = await verifyExistingSiteOwnership(1, { releaseId: existing.release.id, challengeReceiptFingerprint: challenge.receipt.receiptFingerprint, executionMode: 'live', idempotencyKey: 'ownership-live-verify' }, ownership, { repository: line.live.repository, credentialResolver, clock: () => NOW })
    expect(verified.release?.status).toBe('live_verified')
  })
})
