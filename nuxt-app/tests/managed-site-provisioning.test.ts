import { describe, expect, it } from 'vitest'
import { createManagedSiteProject, createManagedSiteVersion } from '../server/managed-sites/service'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { createManagedSiteMemoryRepository } from './fixtures/managed-site/repository'
import { createProvisioningMemoryRepository } from './fixtures/managed-site/provisioning-repository'
import { createManagedSiteDomainIntent, createManagedSiteProvisioningPlan, executeManagedSiteProvisioningPlan, getProvisioningWorkspace, normalizeDomain } from '../server/managed-sites/provisioning-service'

const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const, principal: 'owner@example.test' }

async function makeLineage() {
  const managed = createManagedSiteMemoryRepository()
  const provisioning = createProvisioningMemoryRepository()
  const project = await createManagedSiteProject(1, actor, { canonicalClientIdentity: 'provisioning-client', canonicalWebsiteIdentity: 'https://provisioning.example.test', siteType: 'brand_blog', idempotencyKey: 'provisioning-project-1' }, managed.repository)
  const version = await createManagedSiteVersion(1, project.project.id, actor, { siteSpecSnapshot: { schemaVersion: 'site-spec-v1', pageCatalog: ['home'] }, designTokenSnapshot: { colorPrimary: '#315bd6' }, selectedModuleSnapshot: ['managed_content_admin'], contentFingerprint: stableFingerprint({ version: 1 }), createdByAuthority: 'owner_session', lifecycleStatus: 'preview' }, managed.repository)
  return { managed, provisioning, project, version: version.version! }
}

describe('managed site provisioning core', () => {
  it('normalizes public domains and rejects URLs, wildcards, private names, and malformed labels', () => {
    expect(normalizeDomain('Example.COM.')).toBe('example.com')
    expect(() => normalizeDomain('https://example.com')).toThrow()
    expect(() => normalizeDomain('*.example.com')).toThrow()
    expect(() => normalizeDomain('localhost')).toThrow()
    expect(() => normalizeDomain('example..com')).toThrow()
  })

  it('creates an owner-scoped domain intent and replays exact idempotency', async () => {
    const line = await makeLineage()
    const first = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'Acme.example.com.', providerKey: 'porkbun-neutral', idempotencyKey: 'domain-intent-1' }, line.provisioning.repository, line.managed.repository)
    const replay = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'acme.example.com', providerKey: 'porkbun-neutral', idempotencyKey: 'domain-intent-1' }, line.provisioning.repository, line.managed.repository)
    expect(first.intent.normalizedDomain).toBe('acme.example.com')
    expect(first.execution.externalCalls).toBe(false)
    expect(replay.replayed).toBe(true)
    await expect(createManagedSiteDomainIntent(2, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'other.example.com', idempotencyKey: 'domain-cross-1' }, line.provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('creates an ordered provisioning plan and fails closed in dry-run without deployed claims', async () => {
    const line = await makeLineage()
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'customer_owned', requestedDomain: 'customer.example.com', idempotencyKey: 'domain-dry-run-1' }, line.provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'vercel', deploymentMode: 'preview_only', idempotencyKey: 'plan-dry-run-1' }, line.provisioning.repository, line.managed.repository)
    expect(plan.steps.map(step => step.stepKey)).toEqual(['domain_intent', 'domain_registration', 'dns_configuration', 'tls_verification', 'deployment'])
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'dry_run', undefined, line.provisioning.repository, line.managed.repository)
    expect(result.plan?.status).toBe('blocked')
    expect(result.externalCalls).toBe(false)
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.results.find(step => step.stepKey === 'domain_registration')?.providerConfigured).toBe(false)
    expect(result.events).toHaveLength(5)
  })

  it('supports an injected mocked provider path without enabling external execution', async () => {
    const line = await makeLineage()
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'new_registration', requestedDomain: 'mocked.example.com', providerKey: 'mock-registrar', idempotencyKey: 'domain-mocked-1' }, line.provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'cloudflare_pages', deploymentMode: 'customer_authorized', idempotencyKey: 'plan-mocked-1' }, line.provisioning.repository, line.managed.repository)
    const result = await executeManagedSiteProvisioningPlan(1, plan.plan.id, 'mocked', {
      async checkDomainAvailability(input) { return { status: 'available', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalCalls: false, limitation: 'Injected mock only.' } },
      async registerDomain(input) { return { status: 'registered', normalizedDomain: input.normalizedDomain, providerKey: input.providerKey, externalReference: 'mock-domain-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async configureDns(input) { return { status: 'configured', normalizedDomain: input.normalizedDomain, records: [{ type: 'CNAME', name: '@', value: 'mock.pages.dev' }], externalCalls: false, limitation: 'Injected mock only.' } },
      async verifyTls(input) { return { status: 'verified', normalizedDomain: input.normalizedDomain, certificateReference: 'mock-tls-ref', externalCalls: false, limitation: 'Injected mock only.' } },
      async deploySite(input) { return { status: 'deployed', platform: input.platform, deployedUrl: `https://${input.normalizedDomain}`, externalReference: 'mock-deployment-ref', externalCalls: false, limitation: 'Injected mock only.' } },
    }, line.provisioning.repository, line.managed.repository)
    expect(result.plan?.status).toBe('succeeded')
    expect(result.plan?.deploymentStatus).toBe('built')
    expect(result.externalCalls).toBe(false)
    expect(result.plan?.deployedUrl).toBeNull()
    expect(result.results.every(step => step.externalCalls === false)).toBe(true)
  })

  it('rejects external execution and reports every provider as not connected', async () => {
    const line = await makeLineage()
    const intent = await createManagedSiteDomainIntent(1, { projectId: line.project.project.id, mode: 'assisted', requestedDomain: 'blocked.example.com', idempotencyKey: 'domain-blocked-1' }, line.provisioning.repository, line.managed.repository)
    const plan = await createManagedSiteProvisioningPlan(1, { projectId: line.project.project.id, versionId: line.version.id, domainIntentId: intent.intent.id, platform: 'manual_export', deploymentMode: 'preview_only', idempotencyKey: 'plan-blocked-1' }, line.provisioning.repository, line.managed.repository)
    expect(getProvisioningWorkspace().domain.configured).toBe(false)
    expect(getProvisioningWorkspace().deployment.message).toContain('尚未連線')
    await expect(executeManagedSiteProvisioningPlan(1, plan.plan.id, 'external', undefined, line.provisioning.repository, line.managed.repository)).rejects.toMatchObject({ statusCode: 403 })
  })
})
