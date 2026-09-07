import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCloudflareManagedSiteDnsTls } from '../server/managed-sites/live-connectors/internal-broker/dns-setup'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { createInternalDnsTlsBrokerHmacV1Adapter } from '../server/managed-sites/live-connectors/broker-adapters'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { stableFingerprint } from '../server/seo-geo-core/repository'

const accountId = 'a'.repeat(32)
const zoneId = 'b'.repeat(32)
const input = { ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: 'new-brand.taipei', timeoutMs: 15_000 }
const project = { name: 'ds-o1-p2', subdomain: 'ds-o1-p2.pages.dev' }
const zone = { id: zoneId, name: input.canonicalDomain, account: { id: accountId }, type: 'full', status: 'active', name_servers: ['bob.ns.cloudflare.com', 'amy.ns.cloudflare.com'] }
const record = { id: 'c'.repeat(32), type: 'CNAME', name: input.canonicalDomain, content: project.subdomain, proxied: true }
const association = { id: 'domain-new-brand', name: input.canonicalDomain, zone_tag: zoneId, status: 'active', validation_data: { status: 'active' }, verification_data: { status: 'active' } }
const response = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, result, ...(Array.isArray(result) ? { result_info: { total_count: result.length, total_pages: result.length ? 1 : 0 } } : {}) }), { status })
afterEach(() => vi.unstubAllEnvs())

function setup(options: { zone?: Record<string, unknown>; records?: Record<string, unknown>[]; association?: Record<string, unknown>; pendingNameservers?: boolean; loseZoneResponse?: boolean } = {}) {
  let storedZone = options.zone
  let records = options.records || []
  let storedAssociation = options.association
  let authorized = true
  let loseZoneResponse = options.loseZoneResponse
  const beforeMutation = vi.fn(async () => { if (!authorized) throw Object.assign(new Error('payment or delegation revoked'), { statusCode: 409 }) })
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(url)); const path = parsed.pathname.replace('/client/v4', '')
    expect(parsed.origin).toBe('https://api.cloudflare.com')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-cloudflare-token')
    if (init?.method === 'POST') expect(authorized).toBe(true)
    if (path === `/accounts/${accountId}/pages/projects/${project.name}`) return response(project)
    if (path === '/zones' && init?.method === 'GET') {
      expect(parsed.searchParams.get('name')).toBe(input.canonicalDomain)
      return response(storedZone ? [storedZone] : [])
    }
    if (path === '/zones' && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ account: { id: accountId }, name: input.canonicalDomain, type: 'full' })
      storedZone = structuredClone(zone)
      if (loseZoneResponse) { loseZoneResponse = false; throw new Error('zone created but response lost') }
      return response(storedZone)
    }
    if (path === `/zones/${zoneId}`) return response({ ...storedZone, status: options.pendingNameservers ? 'pending' : 'active' })
    if (path === `/zones/${zoneId}/dns_records` && init?.method === 'GET') return response(records)
    if (path === `/zones/${zoneId}/dns_records` && init?.method === 'POST') { records = [{ ...JSON.parse(String(init.body)), id: record.id }]; return response(records[0]) }
    if (path === `/accounts/${accountId}/pages/projects/${project.name}/domains/${input.canonicalDomain}`) return storedAssociation ? response(storedAssociation) : response(null, 404)
    if (path === `/accounts/${accountId}/pages/projects/${project.name}/domains` && init?.method === 'POST') { expect(JSON.parse(String(init.body))).toEqual({ name: input.canonicalDomain }); storedAssociation = structuredClone(association); return response(storedAssociation) }
    throw new Error('unexpected provider path')
  })
  const setRegistrarNameservers = vi.fn(async (nameservers: string[]) => { await beforeMutation(); expect(nameservers).toEqual(zone.name_servers); return { verified: true } })
  const dependencies = { accountId, projectPrefix: 'ds', apiToken: 'synthetic-cloudflare-token', fetchImpl, beforeMutation, setRegistrarNameservers, sleep: async () => {} }
  return { dependencies, fetchImpl, beforeMutation, setRegistrarNameservers, run: () => setupCloudflareManagedSiteDnsTls(input, dependencies), revoke: () => { authorized = false }, mutations: () => fetchImpl.mock.calls.filter(call => call[1]?.method === 'POST') }
}

describe('automatically configure newly purchased domain DNS', () => {
  it('creates only the exact configured-account zone, Pages CNAME and Pages association, then observes readiness', async () => {
    const line = setup()
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'verified', tlsStatus: 'verified' })
    expect(line.mutations().map(call => new URL(String(call[0])).pathname)).toEqual(['/client/v4/zones', `/client/v4/zones/${zoneId}/dns_records`, `/client/v4/accounts/${accountId}/pages/projects/${project.name}/domains`])
    expect(line.setRegistrarNameservers).toHaveBeenCalledTimes(1)
  })

  it('resumes partial setup by reusing provider state after a lost zone-creation response', async () => {
    const line = setup({ loseZoneResponse: true })
    await expect(line.run()).rejects.toMatchObject({ statusCode: 503 })
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'verified', tlsStatus: 'verified' })
    expect(line.mutations().filter(call => new URL(String(call[0])).pathname === '/client/v4/zones')).toHaveLength(1)
  })

  it('reuses all exact existing records and associations without duplicate Cloudflare mutations', async () => {
    const line = setup({ zone, records: [record], association })
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'verified', tlsStatus: 'verified' })
    expect(line.mutations()).toHaveLength(0)
  })

  it('returns pending while registrar nameserver activation is propagating and resumes later', async () => {
    const line = setup({ pendingNameservers: true })
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'propagation_pending', tlsStatus: 'pending' })
    expect(line.mutations()).toHaveLength(2)
    expect(line.mutations().some(call => String(call[0]).endsWith('/domains'))).toBe(false)
  })

  it.each([
    { zone: { ...zone, account: { id: 'f'.repeat(32) } } },
    { zone, records: [{ ...record, content: 'other-project.pages.dev' }] },
    { zone, records: [{ type: 'MX', name: input.canonicalDomain, content: 'mail.example.com' }] },
    { association: { ...association, name: 'unrelated.taipei' } },
    { zone, association: { ...association, zone_tag: 'f'.repeat(32) } },
  ])('does not overwrite a foreign zone, conflicting DNS, or unrelated domain association', async state => {
    const line = setup(state)
    await expect(line.run()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.mutations()).toHaveLength(0)
    expect(line.setRegistrarNameservers).not.toHaveBeenCalled()
  })

  it('does nothing when durable authority is absent', async () => {
    const line = setup()
    line.revoke()
    await expect(line.run()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.fetchImpl).not.toHaveBeenCalled()
    expect(line.setRegistrarNameservers).not.toHaveBeenCalled()
  })

  it('stops before the next mutation if payment is refunded during setup', async () => {
    const line = setup()
    const provider = line.fetchImpl.getMockImplementation()!
    line.fetchImpl.mockImplementation(async (...args) => {
      const result = await provider(...args)
      if (String(args[0]).endsWith('/zones') && args[1]?.method === 'POST') line.revoke()
      return result
    })
    await expect(line.run()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.mutations()).toHaveLength(1)
    expect(line.setRegistrarNameservers).not.toHaveBeenCalled()
  })
})

describe('signed automatic DNS broker integration', () => {
  function brokerSetup() {
    vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', `${MANAGED_SITE_INTERNAL_BROKER_ORIGIN},https://api.porkbun.com`)
    const line = setup()
    const configuration = { deploymentCredentialReference: 'envref:deploy', dnsTlsCredentialReference: 'envref:dns', cloudflare: { accountId, apiTokenReference: 'envref:cf', projectPrefix: 'ds' } }
    const credentials: Record<string, string> = { 'envref:dns': 'synthetic-dns-hmac-credential', 'envref:cf': line.dependencies.apiToken, 'envref:registrar': JSON.stringify({ apiKey: 'pk1_synthetic-production', secretApiKey: 'synthetic-registrar-secret' }) }
    const credentialResolver = async (reference: string) => ({ ok: true as const, value: credentials[reference]! })
    let nameservers = ['curitiba.ns.porkbun.com', 'salvador.ns.porkbun.com']
    const porkbunFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = JSON.parse(String(init?.body))
      expect(value.apikey).toBe('pk1_synthetic-production')
      expect(value.secretapikey).toBe('synthetic-registrar-secret')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      if (String(url) === `https://api.porkbun.com/api/json/v3/domain/updateNs/${input.canonicalDomain}`) { nameservers = value.ns; return new Response(JSON.stringify({ status: 'SUCCESS' })) }
      expect(String(url)).toBe(`https://api.porkbun.com/api/json/v3/domain/getNs/${input.canonicalDomain}`)
      return new Response(JSON.stringify({ status: 'SUCCESS', ns: nameservers }))
    })
    const grant = { fingerprint: '1'.repeat(64), registrationReceiptFingerprint: '2'.repeat(64), registrar: { endpointOrigin: 'https://api.porkbun.com', credentialReference: 'envref:registrar', providerAuthorityFingerprint: '3'.repeat(64) } }
    const dnsMutationAuthorityResolver = vi.fn(async () => grant as typeof grant | null)
    const core = { schemaVersion: 'managed-site-provider-authority-v1', capability: 'dns_tls', providerKey: 'internal-dns-tls-broker-hmac-v1', configurationFingerprint: '4'.repeat(64), verificationReceiptFingerprint: '5'.repeat(64), capabilityIdentity: 'internal-dns-ownership:v1', readinessStatus: 'verified', executionMode: 'live', verifiedAt: new Date().toISOString() } as const
    const providerAuthority = { ...core, authorityFingerprint: stableFingerprint(core) }
    const identity = { ownerUserId: input.ownerUserId, projectId: input.projectId, releaseId: input.releaseId, contentHash: '6'.repeat(64), canonicalDomain: input.canonicalDomain, providerAuthorityFingerprint: providerAuthority.authorityFingerprint }
    const broker = createManagedSiteInternalBrokerFetch({ configurationResolver: () => configuration, credentialResolver, cloudflareFetch: line.fetchImpl, porkbunFetch, dnsMutationAuthorityResolver, sleep: async () => {} })
    const adapter = createInternalDnsTlsBrokerHmacV1Adapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: core.providerKey, credentialReference: configuration.dnsTlsCredentialReference, resolveCredential: credentialResolver, fetchImpl: broker })
    const run = () => adapter.configureAndVerify({ ...input, contentHash: identity.contentHash, providerAuthority, requestFingerprint: stableFingerprint(identity), idempotencyKey: 'synthetic-auto-dns-test' })
    return { ...line, run, porkbunFetch, dnsMutationAuthorityResolver, credentials, configuration, grant }
  }

  it('uses durable authority for the exact domain and signs readiness after Cloudflare and registrar readback', async () => {
    const line = brokerSetup()
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'verified', tlsStatus: 'verified', canonicalDomain: input.canonicalDomain })
    expect(line.porkbunFetch.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual([`/api/json/v3/domain/getNs/${input.canonicalDomain}`, `/api/json/v3/domain/updateNs/${input.canonicalDomain}`, `/api/json/v3/domain/getNs/${input.canonicalDomain}`])
    expect(line.dnsMutationAuthorityResolver.mock.calls.length).toBeGreaterThan(5)
    expect(line.mutations()).toHaveLength(3)
    // Replayed signed requests inspect provider state and never repeat setup writes.
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'verified', tlsStatus: 'verified' })
    expect(line.mutations()).toHaveLength(3)
    expect(line.porkbunFetch.mock.calls.filter(call => String(call[0]).includes('/updateNs/'))).toHaveLength(1)
  })

  it('uses only read-only readiness when transport authentication has no customer mutation grant', async () => {
    const line = brokerSetup()
    line.dnsMutationAuthorityResolver.mockResolvedValue(null)
    await expect(line.run()).resolves.toMatchObject({ dnsStatus: 'propagation_pending', tlsStatus: 'pending' })
    expect(line.mutations()).toHaveLength(0)
    expect(line.porkbunFetch).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'account changed', 'credential changed'])('stops before mutation when authority is %s after the initial provider read', async change => {
    const line = brokerSetup()
    const cloudflare = line.fetchImpl.getMockImplementation()!
    line.fetchImpl.mockImplementation(async (...args) => {
      const result = await cloudflare(...args)
      if (change === 'revoked') line.dnsMutationAuthorityResolver.mockResolvedValue(null)
      if (change === 'account changed') line.configuration.cloudflare.accountId = 'f'.repeat(32)
      if (change === 'credential changed') line.credentials['envref:cf'] = 'rotated-cloudflare-token'
      return result
    })
    await expect(line.run()).rejects.toMatchObject({ statusCode: 409 })
    expect(line.mutations()).toHaveLength(0)
    expect(line.porkbunFetch).not.toHaveBeenCalled()
  })
})
