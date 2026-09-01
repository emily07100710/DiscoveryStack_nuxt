import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticatedBearerManagedSiteDeploymentAdapter } from '../server/managed-sites/live-connectors/deployment-transport'
import { buildManagedSitePreview, validateDeploymentReceipt } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { configureManagedSiteProvider, resolveManagedSiteProviderAuthority, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

const config = { deploymentCredentialReference: 'envref:deployment-runtime-key', dnsTlsCredentialReference: 'envref:dns-hmac-test', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cf-pages-access-key', projectPrefix: 'ds' } }
const secrets: Record<string, string> = { [config.deploymentCredentialReference]: 'deployment-test-bearer-secret', [config.cloudflare.apiTokenReference]: 'cloudflare-test-token', [config.dnsTlsCredentialReference]: 'dns-test-secret' }
const credentialResolver = async (reference: string) => secrets[reference] ? { ok: true as const, value: secrets[reference]! } : { ok: false as const, reason: 'missing_reference' as const }

function cfFetch(mode: 'success' | 'probe-failure' | 'rate-limit' | 'server-error' = 'success') {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init })
    const pathname = new URL(url).pathname
    const envelope = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: status }] }), { status, headers: { 'content-type': 'application/json' } })
    if (pathname.endsWith('/pages/projects') && new URL(url).searchParams.get('per_page') === '1') return mode === 'probe-failure' ? envelope(null, 403) : envelope([])
    if (mode === 'rate-limit' && init?.method === 'GET' && /\/pages\/projects\/[^/]+$/u.test(pathname)) return envelope(null, 429)
    if (mode === 'server-error' && init?.method === 'GET' && /\/pages\/projects\/[^/]+$/u.test(pathname)) return envelope(null, 503)
    if (init?.method === 'GET' && /\/pages\/projects\/[^/]+$/u.test(pathname)) return envelope(null, 404)
    if (init?.method === 'POST' && pathname.endsWith('/pages/projects')) return envelope({ name: 'created' }, 201)
    if (pathname.endsWith('/upload-token')) return envelope({ jwt: 'test-upload-jwt-token-at-least-sixteen' })
    if (pathname.endsWith('/pages/assets/check-missing')) { const body = JSON.parse(String(init?.body)); return envelope(body.hashes) }
    if (pathname.endsWith('/pages/assets/upload')) return envelope({ uploaded: true })
    const projectName = /\/pages\/projects\/([^/]+)/u.exec(pathname)?.[1] || 'ds-o1-p1'
    if (init?.method === 'POST' && pathname.endsWith('/deployments')) return envelope({ id: 'cf-deployment-001', latest_stage: { name: 'deploy', status: 'queued' }, url: `https://preview-${projectName}.pages.dev` }, 201)
    if (init?.method === 'GET' && pathname.endsWith('/deployments/cf-deployment-001')) return envelope({ id: 'cf-deployment-001', latest_stage: { name: 'deploy', status: 'success' }, url: `https://preview-${projectName}.pages.dev` })
    throw new Error(`unexpected Cloudflare mock call: ${init?.method} ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

async function setup(mode: 'success' | 'rate-limit' | 'server-error' = 'success') {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'broker-preview.acme.taipei', buildPreview: false })
  const candidate = line.live.state.candidates.find(item => item.id === line.generation.candidate!.id)!
  const oldReference = candidate.vaultReference; const bundle = line.vault.records.get(oldReference)!
  const strictReference = `vault:s3:1:${candidate.projectId}:${candidate.requestFingerprint}`; candidate.vaultReference = strictReference
  await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: config.deploymentCredentialReference, transportConfiguration: { endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN }, idempotencyKey: 'broker-deployment-config' }, line.live.repository)
  const cloudflare = cfFetch(mode)
  const brokerFetch = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, cloudflareFetch: cloudflare.fetchImpl, vaultFactory: () => ({ async lookupImmutableCandidate(input) { return input.ownerUserId === 1 && input.projectId === candidate.projectId && input.requestFingerprint === candidate.requestFingerprint ? { bundle: structuredClone(bundle), vaultReference: strictReference, exactResponseIdentity: 'vault-test-identity' } : null }, async storeImmutableCandidate() { throw new Error('not used') } }), sleep: async () => {} })
  await verifyManagedSiteProviderConfiguration(1, 'deployment', line.live.repository, credentialResolver, () => new Date(), undefined, brokerFetch)
  const authority = await resolveManagedSiteProviderAuthority(1, 'deployment', 'live', line.live.repository, credentialResolver)
  const adapter = createAuthenticatedBearerManagedSiteDeploymentAdapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: 'internal-deployment-bearer-v1', credentialReference: config.deploymentCredentialReference, resolveCredential: credentialResolver, providerAuthorityFingerprint: authority.authorityFingerprint, fetchImpl: brokerFetch })
  return { line, candidate, bundle, brokerFetch, adapter, authority, cloudflare }
}

describe('managed-site internal deployment broker', () => {
  beforeEach(() => { process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = MANAGED_SITE_INTERNAL_BROKER_ORIGIN; process.env.DISCOVERYSTACK_MANAGED_SITE_CREDENTIALS_JSON = JSON.stringify(secrets) })

  it('performs an honest Cloudflare capability probe and rejects probe failure', async () => {
    const success = cfFetch(); const broker = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, cloudflareFetch: success.fetchImpl })
    const raw = await broker(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets[config.deploymentCredentialReference]}` }, body: JSON.stringify({ schemaVersion: 'managed-site-provider-verification-v1', challenge: 'x'.repeat(64), configurationFingerprint: 'a'.repeat(64) }) })
    expect(raw.status).toBe(200); expect(Object.keys(await raw.json())).toHaveLength(7)
    const failureCf = cfFetch('probe-failure'); const failing = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, cloudflareFetch: failureCf.fetchImpl })
    expect((await failing(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/verify`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets[config.deploymentCredentialReference]}` }, body: JSON.stringify({ schemaVersion: 'managed-site-provider-verification-v1', challenge: 'x'.repeat(64), configurationFingerprint: 'a'.repeat(64) }) })).status).toBe(424)
  })

  it('drives buildManagedSitePreview to preview_ready through the full Direct Upload dance', async () => {
    const line = await setup(); let providerReceipt: Awaited<ReturnType<typeof line.adapter.buildPreview>> | null = null
    const capturingAdapter = { ...line.adapter, async buildPreview(input: Parameters<typeof line.adapter.buildPreview>[0]) { providerReceipt = await line.adapter.buildPreview(input); return providerReceipt } }
    const result = await buildManagedSitePreview(1, { releaseId: line.line.release.release.id, executionMode: 'live', idempotencyKey: 'broker-live-preview' }, capturingAdapter, { repository: line.line.live.repository, credentialResolver })
    expect(result.release?.status).toBe('preview_ready'); expect(result.release?.previewUrl).toBe(`https://preview-ds-o1-p${line.candidate.projectId}.pages.dev/`)
    expect(() => validateDeploymentReceipt(providerReceipt!, { providerKey: line.authority.providerKey, providerAuthorityFingerprint: line.authority.authorityFingerprint, projectId: line.candidate.projectId, versionId: line.line.prePurchase.version.id, contentHash: line.candidate.contentHash, canonicalDomain: line.line.release.release.canonicalDomain, status: 'preview_ready' })).not.toThrow()
    expect(line.cloudflare.calls.some(call => call.url.endsWith('/pages/assets/check-missing'))).toBe(true)
    expect(line.cloudflare.calls.some(call => call.url.endsWith('/deployments/cf-deployment-001'))).toBe(true)
  })

  it('rejects vault contentHash mismatch with 409 and makes Cloudflare 429 retryable', async () => {
    const line = await setup(); (line.bundle.manifest as any).contentHash = 'f'.repeat(64)
    const authority = line.authority
    const response = await line.brokerFetch(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/preview`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets[config.deploymentCredentialReference]}` }, body: JSON.stringify({ schemaVersion: 'discoverystack-managed-deployment-command-v1', providerKey: 'internal-deployment-bearer-v1', operation: 'preview', projectId: line.candidate.projectId, versionId: line.line.prePurchase.version.id, releaseId: line.line.release.release.id, vaultReference: line.candidate.vaultReference, contentHash: line.candidate.contentHash, canonicalDomain: line.line.release.release.canonicalDomain, providerAuthority: authority, requestFingerprint: 'e'.repeat(64), timeoutMs: 30_000 }) })
    expect(response.status).toBe(409)
    const limited = await setup('rate-limit')
    await expect(buildManagedSitePreview(1, { releaseId: limited.line.release.release.id, executionMode: 'live', idempotencyKey: 'broker-rate-limited-preview' }, limited.adapter, { repository: limited.line.live.repository, credentialResolver })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(limited.line.live.state.releases.find(item => item.id === limited.line.release.release.id)?.status).toBe('retry_wait')
    const unavailable = await setup('server-error')
    await expect(buildManagedSitePreview(1, { releaseId: unavailable.line.release.release.id, executionMode: 'live', idempotencyKey: 'broker-upstream-failed-preview' }, unavailable.adapter, { repository: unavailable.line.live.repository, credentialResolver })).rejects.toMatchObject({ code: 'UPSTREAM_FAILURE', retryable: true })
  })
})
