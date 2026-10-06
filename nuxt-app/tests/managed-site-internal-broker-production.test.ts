import { EventEmitter } from 'node:events'
import type { request as httpsRequest } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createAuthenticatedBearerManagedSiteDeploymentAdapter } from '../server/managed-sites/live-connectors/deployment-transport'
import { validateDeploymentReceipt } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createManagedSiteInternalBrokerFetch } from '../server/managed-sites/live-connectors/internal-broker/broker-fetch'
import { deployCloudflarePagesProduction } from '../server/managed-sites/live-connectors/internal-broker/cloudflare-pages'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { MAX_MANAGED_SITE_PRODUCTION_HTML_BYTES, probeManagedSiteProductionHomepage } from '../server/managed-sites/live-connectors/internal-broker/production-probe'
import { renderManagedSiteStaticAssets } from '../server/managed-sites/live-connectors/internal-broker/static-renderer'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const domain = 'live.acme.taipei'
const html = '<!doctype html><html><body>Immutable released website</body></html>'
const command = { ownerUserId: 1, projectId: 2, releaseId: 3, canonicalDomain: domain, requestFingerprint: 'd'.repeat(64), assets: [{ path: 'index.html', contentType: 'text/html; charset=utf-8', content: html }], timeoutMs: 30_000 }

function cloudflareFixture(options: { projectId?: number; deploymentPatch?: Record<string, unknown>; domainPatch?: Record<string, unknown>; branch?: string; pointerChanged?: boolean; missingAssetsMalformed?: boolean } = {}) {
  const projectName = `ds-o1-p${options.projectId || 2}`
  const project: Record<string, any> = { id: 'cf-project-001', name: projectName, production_branch: options.branch || 'main', latest_deployment: null, canonical_deployment: null }
  const calls: Array<{ url: string; init: RequestInit }> = []
  const uploaded = new Map<string, string>()
  let manifest: Record<string, string> = {}
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); calls.push({ url, init })
    expect(new URL(url).origin).toBe('https://api.cloudflare.com')
    expect(new URL(url).pathname.startsWith(`/client/v4/accounts/${'a'.repeat(32)}/pages/projects/${projectName}`) || url.includes('/client/v4/pages/assets/')).toBe(true)
    const envelope = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, result }), { status })
    if (url.endsWith(`/pages/projects/${projectName}`)) return envelope(project)
    if (url.endsWith(`/domains/${domain}`)) return envelope({ name: domain, status: 'active', validation_data: { status: 'active' }, verification_data: { status: 'active' }, ...options.domainPatch })
    if (url.endsWith('/upload-token')) return envelope({ jwt: 'fake-upload-token-for-production-tests' })
    if (url.endsWith('/assets/check-missing')) return envelope(options.missingAssetsMalformed ? {} : JSON.parse(String(init.body)).hashes)
    if (url.endsWith('/assets/upload')) { for (const item of JSON.parse(String(init.body))) uploaded.set(item.key, Buffer.from(item.value, 'base64').toString('utf8')); return envelope({}) }
    if (url.endsWith('/deployments') && init.method === 'POST') {
      const form = init.body as FormData
      expect(form.get('branch')).toBe('main')
      manifest = JSON.parse(String(form.get('manifest')))
      const deployment = { id: 'cf-production-001', project_id: project.id, project_name: projectName, environment: 'production', url: `https://1234abcd.${projectName}.pages.dev/`, deployment_trigger: { metadata: { branch: 'main', commit_message: form.get('commit_message') } }, latest_stage: { name: 'deploy', status: 'active' }, ...options.deploymentPatch }
      project.latest_deployment = deployment
      return envelope(deployment, 201)
    }
    if (url.endsWith(`/deployments/${project.latest_deployment?.id}`)) {
      project.latest_deployment.latest_stage = { name: 'deploy', status: 'success' }
      project.canonical_deployment = options.pointerChanged ? { ...project.latest_deployment, id: 'another-deployment' } : project.latest_deployment
      return envelope(project.latest_deployment)
    }
    throw new Error(`Unexpected test request: ${init.method} ${url}`)
  }) as typeof fetch
  const productionProbe = vi.fn(async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: uploaded.get(manifest['/index.html']!) || '' }))
  return { calls, project, fetchImpl, productionProbe, options: { fetchImpl, productionProbe, accountId: 'a'.repeat(32), apiToken: 'fake-cf-token', projectPrefix: 'ds', sleep: async () => {} } }
}

describe('managed-site Cloudflare production driver', () => {
  it('uploads the immutable assets to main, observes canonical bytes, and recovers exact provider replay without another upload', async () => {
    const cf = cloudflareFixture()
    await expect(deployCloudflarePagesProduction(command, cf.options)).resolves.toEqual({ deploymentId: 'cf-production-001', deploymentUrl: `https://${domain}/`, projectName: 'ds-o1-p2' })
    await expect(deployCloudflarePagesProduction(command, cf.options)).resolves.toMatchObject({ deploymentId: 'cf-production-001' })
    expect(cf.calls.filter(call => call.url.endsWith('/deployments') && call.init.method === 'POST')).toHaveLength(1)
    expect(cf.productionProbe).toHaveBeenCalledWith(domain, expect.any(Number))
    expect(cf.calls.some(call => call.init.method === 'PATCH' || call.init.method === 'DELETE' || call.url.endsWith('/domains') || call.url.includes('/dns_records'))).toBe(false)
  })

  it('verifies an explicitly published non-home route in addition to the canonical homepage', async () => {
    const about = '<!doctype html><html><body>Exact about route</body></html>'
    const routedCommand = { ...command, assets: [...command.assets, { path: 'about/index.html', contentType: 'text/html; charset=utf-8', content: about }], verificationAssetPath: 'about/index.html' }
    const cf = cloudflareFixture()
    const productionProbe = vi.fn(async (_domain: string, _timeoutMs: number, pathname = '/') => ({ status: 200, contentType: 'text/html; charset=utf-8', body: pathname === '/about/' ? about : html }))
    await expect(deployCloudflarePagesProduction(routedCommand, { ...cf.options, productionProbe })).resolves.toMatchObject({ deploymentId: 'cf-production-001' })
    expect(productionProbe).toHaveBeenNthCalledWith(1, domain, expect.any(Number))
    expect(productionProbe).toHaveBeenNthCalledWith(2, domain, expect.any(Number), '/about/')

    const mismatch = cloudflareFixture()
    await expect(deployCloudflarePagesProduction(routedCommand, { ...mismatch.options, productionProbe: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) })).rejects.toMatchObject({ statusCode: 503 })
  })

  it.each([
    { environment: 'preview' },
    { project_name: 'ds-o2-p2' },
    { project_id: 'another-project' },
    { url: 'https://ds-o1-p2.attacker.pages.dev/' },
    { deployment_trigger: { metadata: { branch: 'main', commit_message: 'another-command' } } },
  ])('rejects deployment identity collision %j', async deploymentPatch => {
    const cf = cloudflareFixture({ deploymentPatch })
    await expect(deployCloudflarePagesProduction(command, cf.options)).rejects.toMatchObject({ statusCode: 409 })
    expect(cf.productionProbe).not.toHaveBeenCalled()
  })

  it.each([
    { domainPatch: { name: 'another.acme.taipei' } },
    { domainPatch: { status: 'pending' } },
    { domainPatch: { validation_data: { status: 'pending' } } },
    { domainPatch: { verification_data: { status: 'pending' } } },
    { branch: 'some-other-production' },
  ])('fails before uploads when custom-domain authority is incomplete %j', async options => {
    const cf = cloudflareFixture(options)
    await expect(deployCloudflarePagesProduction(command, cf.options)).rejects.toThrow()
    expect(cf.calls.some(call => call.init.method === 'POST')).toBe(false)
  })

  it('does not accept malformed missing-assets responses or a different canonical deployment', async () => {
    const malformed = cloudflareFixture({ missingAssetsMalformed: true })
    await expect(deployCloudflarePagesProduction(command, malformed.options)).rejects.toMatchObject({ statusCode: 502 })
    expect(malformed.calls.some(call => call.url.endsWith('/deployments'))).toBe(false)
    const changed = cloudflareFixture({ pointerChanged: true })
    await expect(deployCloudflarePagesProduction(command, changed.options)).rejects.toMatchObject({ statusCode: 503 })
    expect(changed.productionProbe).not.toHaveBeenCalled()
  })

  it.each([
    { status: 200, contentType: 'text/html', body: 'An unrelated site' },
    { status: 302, contentType: 'text/html', body: html },
    { status: 200, contentType: 'application/json', body: html },
  ])('does not issue production evidence for an unverified canonical homepage %j', async observed => {
    const cf = cloudflareFixture()
    await expect(deployCloudflarePagesProduction(command, { ...cf.options, productionProbe: async () => observed })).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('managed-site production homepage probe', () => {
  it.each([
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
  ])('never opens a request for private or mixed DNS answers %j', async (...addresses) => {
    const request = vi.fn() as unknown as typeof httpsRequest
    await expect(probeManagedSiteProductionHomepage(domain, 1_000, { lookup: async () => addresses, request })).resolves.toMatchObject({ status: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('pins the public address, keeps TLS servername, and refuses redirects and oversized bodies', async () => {
    for (const [status, length, body, expected] of [[200, 0, html, 200], [302, 0, html, 0], [200, MAX_MANAGED_SITE_PRODUCTION_HTML_BYTES + 1, html, 0], [200, 0, 'x'.repeat(MAX_MANAGED_SITE_PRODUCTION_HTML_BYTES + 1), 0]] as const) {
      const request = vi.fn((options: any, callback: any) => {
        expect(options.servername).toBe(domain); expect(options.family).toBe(4); expect(options.path).toBe('/'); expect(options.rejectUnauthorized).not.toBe(false)
        const lookupCallback = vi.fn(); options.lookup('ignored', {}, lookupCallback); expect(lookupCallback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
        const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => {
          const incoming = Object.assign(new EventEmitter(), { statusCode: status, headers: { 'content-type': 'text/html', 'content-length': String(length) }, destroy: vi.fn() })
          callback(incoming); incoming.emit('data', Buffer.from(body)); incoming.emit('end')
        } })
        return outgoing
      }) as unknown as typeof httpsRequest
      await expect(probeManagedSiteProductionHomepage(domain, 1_000, { lookup: async () => [{ address: '93.184.216.34', family: 4 }], request })).resolves.toMatchObject({ status: expected })
    }
  })
})

describe('managed-site production broker command', () => {
  it('returns a valid production receipt from the immutable vault and rejects missing approval before Cloudflare calls', async () => {
    vi.stubEnv('DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS', MANAGED_SITE_INTERNAL_BROKER_ORIGIN)
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: domain, buildPreview: false })
    const candidate = line.generation.candidate!
    const bundle = line.vault.records.get(candidate.vaultReference)!
    const vaultReference = `vault:s3:1:${candidate.projectId}:${candidate.requestFingerprint}`
    const cf = cloudflareFixture({ projectId: candidate.projectId })
    const config = { deploymentCredentialReference: 'envref:deployment-key', dnsTlsCredentialReference: 'envref:dns-key', cloudflare: { accountId: 'a'.repeat(32), apiTokenReference: 'envref:cf-token', projectPrefix: 'ds' } }
    const credentialResolver = async () => ({ ok: true as const, value: 'fake-test-credential' })
    const broker = createManagedSiteInternalBrokerFetch({ configurationResolver: () => config, credentialResolver, cloudflareFetch: cf.fetchImpl, productionProbe: cf.productionProbe, sleep: async () => {}, vaultFactory: () => ({ async lookupImmutableCandidate(input) { return input.ownerUserId === 1 && input.projectId === candidate.projectId && input.requestFingerprint === candidate.requestFingerprint ? { bundle, vaultReference, exactResponseIdentity: 'test-vault' } : null }, async storeImmutableCandidate() { throw new Error('unused') } }) })
    const authorityProjection = { schemaVersion: 'managed-site-provider-authority-v1' as const, capability: 'deployment' as const, providerKey: 'internal-deployment-bearer-v1', configurationFingerprint: 'a'.repeat(64), verificationReceiptFingerprint: 'b'.repeat(64), capabilityIdentity: 'cloudflare-pages:test', readinessStatus: 'verified' as const, executionMode: 'live' as const, verifiedAt: new Date().toISOString() }
    const providerAuthority = { ...authorityProjection, authorityFingerprint: stableFingerprint(authorityProjection) }
    const input = { projectId: candidate.projectId, versionId: line.prePurchase.version.id, releaseId: line.release.release.id, vaultReference, contentHash: candidate.contentHash, canonicalDomain: domain, previewReceiptFingerprint: 'e'.repeat(64), approvalFingerprint: 'f'.repeat(64), providerAuthority, requestFingerprint: command.requestFingerprint, timeoutMs: 30_000 }
    input.requestFingerprint = stableFingerprint({ operation: 'production_deploy', releaseId: input.releaseId, projectId: input.projectId, versionId: input.versionId, contentHash: input.contentHash, canonicalDomain: input.canonicalDomain, previewReceiptFingerprint: input.previewReceiptFingerprint, approvalFingerprint: input.approvalFingerprint, providerAuthorityFingerprint: providerAuthority.authorityFingerprint })
    const invalid = await broker(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/production`, { method: 'POST', headers: { authorization: 'Bearer fake-test-credential', 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 'discoverystack-managed-deployment-command-v1', providerKey: providerAuthority.providerKey, operation: 'production', ...input, approvalFingerprint: undefined }) })
    expect(invalid.status).toBe(422); expect(cf.calls).toHaveLength(0)
    for (const patch of [{ providerAuthority: { ...providerAuthority, authorityFingerprint: '0'.repeat(64) } }, { requestFingerprint: '0'.repeat(64) }, { vaultReference: vaultReference.replace('vault:s3:1:', 'vault:s3:2:') }, { contentHash: '0'.repeat(64) }]) {
      const invalidLineage = await broker(`${MANAGED_SITE_INTERNAL_BROKER_ORIGIN}/v1/managed-sites/production`, { method: 'POST', headers: { authorization: 'Bearer fake-test-credential', 'content-type': 'application/json' }, body: JSON.stringify({ schemaVersion: 'discoverystack-managed-deployment-command-v1', providerKey: providerAuthority.providerKey, operation: 'production', ...input, ...patch }) })
      expect(invalidLineage.status).toBe(409); expect(cf.calls).toHaveLength(0)
    }
    const adapter = createAuthenticatedBearerManagedSiteDeploymentAdapter({ endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN, providerKey: providerAuthority.providerKey, credentialReference: config.deploymentCredentialReference, resolveCredential: credentialResolver, fetchImpl: broker })
    const receipt = await adapter.deployProduction(input)
    expect(() => validateDeploymentReceipt(receipt, { providerKey: providerAuthority.providerKey, providerAuthorityFingerprint: providerAuthority.authorityFingerprint, projectId: input.projectId, versionId: input.versionId, contentHash: input.contentHash, canonicalDomain: domain, status: 'production_verified' })).not.toThrow()
    expect(receipt.deploymentUrl).toBe(`https://${domain}/`)
    expect(cf.productionProbe.mock.results).toHaveLength(1)
    expect(renderManagedSiteStaticAssets(bundle.blueprint, bundle.files).some(asset => asset.path === 'index.html')).toBe(true)
  })
})
