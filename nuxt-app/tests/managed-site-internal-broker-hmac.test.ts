import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedSiteHmacBrokerTransport, managedSiteBrokerSignature } from '../server/managed-sites/live-connectors/hmac-broker-transport'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'

const NOW = new Date('2026-09-01T04:00:00.000Z')
const CREDENTIAL = 'dns-hmac-test-secret-32-bytes-minimum'
const configuration = { deploymentCredentialReference: 'envref:managed-deployment-bearer', dnsTlsCredentialReference: 'envref:managed-dns-tls-hmac', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cloudflare-pages-api-token', projectPrefix: 'ds' } }
const resolver = async (reference: string) => reference === configuration.dnsTlsCredentialReference ? { ok: true as const, value: CREDENTIAL } : { ok: false as const, reason: 'missing_reference' as const }

function signedRequest(raw: string, nonce = 'request-nonce-0001', timestamp = NOW.toISOString(), signatureMutation = '') {
  const path = '/v1/managed-sites/verify' as const; const bodyHash = createHash('sha256').update(raw).digest('hex')
  const signature = managedSiteBrokerSignature({ method: 'POST', path, timestamp, nonce, bodyHash }, CREDENTIAL)
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-discoverystack-provider-key': 'internal-dns-tls-broker-hmac-v1', 'x-discoverystack-timestamp': timestamp, 'x-discoverystack-nonce': nonce, 'x-discoverystack-body-sha256': bodyHash, 'x-discoverystack-signature': signatureMutation || signature }, body: raw }
}

describe('managed-site internal HMAC broker', () => {
  beforeEach(() => { process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = MANAGED_SITE_INTERNAL_BROKER_ORIGIN })

  it('roundtrips the exact dns_tls verification echo through the real HMAC transport', async () => {
    let serial = 0
    const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => configuration, credentialResolver: resolver, clock: () => NOW, nonceFactory: () => `server-nonce-${++serial}` })
    const transport = createManagedSiteHmacBrokerTransport({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: 'internal-dns-tls-broker-hmac-v1', credentialReference: configuration.dnsTlsCredentialReference, resolveCredential: resolver, fetchImpl: brokerFetch, clock: () => NOW, nonceFactory: () => 'client-nonce-0001' })
    const response = await transport.post('/v1/managed-sites/verify', { schemaVersion: 'managed-site-broker-verification-v1', capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', configurationFingerprint: 'b'.repeat(64), challengeHash: 'c'.repeat(64) })
    expect(response.body).toMatchObject({ capability: 'dns_tls', capabilityIdentity: 'internal-dns-ownership:v1', providerEventId: response.providerRequestId, observedAt: NOW.toISOString() })
  })

  it('rejects tampering, stale timestamps, replay, and oversized bodies', async () => {
    let serial = 0
    const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => configuration, credentialResolver: resolver, clock: () => NOW, nonceFactory: () => `server-nonce-${++serial}` })
    const raw = JSON.stringify({ schemaVersion: 'managed-site-broker-verification-v1', capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', configurationFingerprint: 'b'.repeat(64), challengeHash: 'c'.repeat(64) })
    expect((await brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, signedRequest(raw, 'tampered-nonce-01', NOW.toISOString(), 'f'.repeat(64)))).status).toBe(401)
    expect((await brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, signedRequest(raw, 'stale-nonce-0001', '2026-09-01T03:54:59.000Z'))).status).toBe(401)
    const replayRequest = signedRequest(raw, 'replayed-nonce-01')
    expect((await brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, replayRequest)).status).toBe(200)
    expect((await brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, replayRequest)).status).toBe(409)
    expect((await brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, { method: 'POST', headers: signedRequest(raw).headers, body: 'x'.repeat(128 * 1024 + 1) })).status).toBe(413)
  })

  it('fails closed with 503 when configuration is absent and never calls global fetch', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => null })
    const response = await brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(503); expect(network).not.toHaveBeenCalled(); network.mockRestore()
  })
})
