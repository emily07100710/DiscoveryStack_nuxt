import { createApp, createError, createRouter, defineEventHandler, send, setResponseStatus, toWebHandler } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { suspendManagedSiteProject } from '../server/managed-sites/service'
import { createManagedSiteDomainPurchaseIntent, executeManagedSiteDnsTls } from '../server/managed-sites/live-connectors/domain-connectors'
import { buildManagedSitePreview, deployManagedSiteProduction, rollbackManagedSiteRelease } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { advanceEligibleManagedSiteProvisioning } from '../server/managed-sites/live-connectors/provision-advancer'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import { resolveManagedSiteProviderAuthority } from '../server/managed-sites/live-connectors/provider-registry'
import { createMemoryEditorSchedulerPort, runEditorSchedulerTick, type EditorJobHandlers } from '../server/managed-sites/page-editor/scheduler'
import type { ManagedSiteDeploymentAdapter, ManagedSiteDeploymentReceipt } from '../server/managed-sites/live-connectors/types'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

const NOW = new Date('2030-01-02T00:00:00.000Z')
const actor = { ownerUserId: 1, actorUserId: 1, authority: 'owner_session' as const, role: 'owner' as const }

async function suspendedLine() {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: `suspended-${Math.random().toString(36).slice(2)}.acme.taipei`, buildPreview: false })
  await suspendManagedSiteProject(1, line.prePurchase.project.id, actor, { reason: 'Owner requested a bounded suspension', idempotencyKey: 'guard-suspend-001' }, line.managed.repository)
  return line
}

function previewReceipt(input: Parameters<ManagedSiteDeploymentAdapter['buildPreview']>[0]): ManagedSiteDeploymentReceipt {
  const core = { providerKey: 'internal-deployment-bearer-v1', providerEventId: `event-${input.releaseId}`, providerDeploymentId: `deployment-${input.releaseId}`, projectId: input.projectId, versionId: input.versionId, contentHash: input.contentHash, canonicalDomain: input.canonicalDomain, deploymentUrl: `https://preview-${input.releaseId}.pages.dev`, status: 'preview_ready' as const, observedAt: NOW.toISOString(), providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint }
  return { ...core, payloadHash: stableFingerprint(core), exactResponseIdentity: `guard-response:${input.releaseId}` }
}

describe('managed-site suspension guards', () => {
  it('refuses direct domain, DNS/TLS, preview, production, and rollback calls before adapters are touched', async () => {
    const line = await suspendedLine(); const release = line.live.state.releases[0]!
    const domain = { quote: vi.fn(), createPurchaseIntent: vi.fn() }
    await expect(createManagedSiteDomainPurchaseIntent(1, { projectId: release.projectId, releaseId: release.id, draftOrderId: release.draftOrderId!, quoteReceiptFingerprint: 'a'.repeat(64), paymentReceiptFingerprint: 'b'.repeat(64), ownerConfirmationFingerprint: 'c'.repeat(64), executionMode: 'mocked', idempotencyKey: 'guard-domain-purchase' }, domain as any, { repository: line.live.repository, managedRepository: line.managed.repository })).rejects.toMatchObject({ statusCode: 409 })
    expect(domain.createPurchaseIntent).not.toHaveBeenCalled()
    const dns = { configureAndVerify: vi.fn() }
    await expect(executeManagedSiteDnsTls(1, { projectId: release.projectId, releaseId: release.id, executionMode: 'mocked', idempotencyKey: 'guard-dns-tls' }, dns as any, { repository: line.live.repository, managedRepository: line.managed.repository })).rejects.toMatchObject({ statusCode: 409 })
    expect(dns.configureAndVerify).not.toHaveBeenCalled()
    const deployment = { buildPreview: vi.fn(), deployProduction: vi.fn(), rollback: vi.fn() }
    await expect(buildManagedSitePreview(1, { releaseId: release.id, executionMode: 'mocked', idempotencyKey: 'guard-preview-build' }, deployment as any, { repository: line.live.repository, managedRepository: line.managed.repository })).rejects.toMatchObject({ statusCode: 409 })
    expect(deployment.buildPreview).not.toHaveBeenCalled()
    Object.assign(release, { status: 'provisioning', approvalFingerprint: 'd'.repeat(64) })
    await expect(deployManagedSiteProduction(1, { releaseId: release.id, executionMode: 'mocked', idempotencyKey: 'guard-production' }, deployment as any, { repository: line.live.repository, orderingRepository: line.ordering.repository, managedRepository: line.managed.repository, productionTransaction: line.productionTransaction })).rejects.toMatchObject({ statusCode: 409 })
    expect(deployment.deployProduction).not.toHaveBeenCalled()
    const target = { ...structuredClone(release), id: release.id + 100, status: 'live_verified' as const, activeDeploymentReceiptFingerprint: 'e'.repeat(64) }
    Object.assign(release, { status: 'live_verified', activeDeploymentReceiptFingerprint: 'f'.repeat(64) }); line.live.state.releases.push(target as any)
    await expect(rollbackManagedSiteRelease(1, { fromReleaseId: release.id, toReleaseId: target.id, executionMode: 'mocked', idempotencyKey: 'guard-rollback' }, deployment as any, { repository: line.live.repository, managedRepository: line.managed.repository })).rejects.toMatchObject({ statusCode: 409 })
    expect(deployment.rollback).not.toHaveBeenCalled()
  })

  it('blocks a suspended provisioning retry while advancing a second project in the same tick', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'guard-advancer.acme.taipei', buildPreview: false })
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: 'envref:guard-deployment', transportConfiguration: { endpointOrigin: 'https://provider.acme.taipei' }, idempotencyKey: 'guard-deployment-config' }, line.live.repository, () => NOW)
    const configuration = await line.live.repository.findProviderConfiguration(1, 'deployment'); await line.live.repository.verifyProviderConfigurationCas(1, configuration!.id, configuration!.configurationFingerprint, { readinessStatus: 'verified', verificationReceiptFingerprint: 'a'.repeat(64), capabilityIdentity: 'cloudflare-pages:live', verifiedAt: NOW })
    const failing: ManagedSiteDeploymentAdapter = { async buildPreview() { throw new Error('seed retry') }, async deployProduction() { throw new Error('unused') }, async rollback() { throw new Error('unused') } }
    await expect(buildManagedSitePreview(1, { releaseId: line.release.release.id, executionMode: 'live', idempotencyKey: 'guard-retry-one' }, failing, { repository: line.live.repository, managedRepository: line.managed.repository, credentialResolver: async () => ({ ok: true, value: 'runtime-only' }), clock: () => NOW })).rejects.toThrow('seed retry')
    const firstProject = line.managed.state.projects[0]!; const firstRelease = line.live.state.releases[0]!; const firstCandidate = line.live.state.candidates[0]!; const firstAttempt = line.live.state.attempts.find(item => item.operation === 'preview_build')!
    const offset = 10_000; const secondProjectId = firstProject.id + offset; const secondCandidateId = firstCandidate.id + offset; const secondReleaseId = firstRelease.id + offset; line.managed.state.projects.push({ ...structuredClone(firstProject), id: secondProjectId, status: 'payment_pending' } as any); line.live.state.candidates.push({ ...structuredClone(firstCandidate), id: secondCandidateId, projectId: secondProjectId } as any); line.live.state.releases.push({ ...structuredClone(firstRelease), id: secondReleaseId, projectId: secondProjectId, generationCandidateId: secondCandidateId, idempotencyKey: 'guard-second-release' } as any); const authority = await resolveManagedSiteProviderAuthority(1, 'deployment', 'live', line.live.repository, async () => ({ ok: true, value: 'runtime-only' })); const secondRequestFingerprint = stableFingerprint({ operation: 'preview_build', releaseId: secondReleaseId, projectId: secondProjectId, versionId: firstRelease.versionId, contentHash: firstRelease.contentHash, vaultReference: firstCandidate.vaultReference, providerAuthorityFingerprint: authority.authorityFingerprint }); line.live.state.attempts.push({ ...structuredClone(firstAttempt), id: firstAttempt.id + offset, projectId: secondProjectId, releaseId: secondReleaseId, idempotencyKey: 'guard-retry-two', requestFingerprint: secondRequestFingerprint } as any)
    await suspendManagedSiteProject(1, firstProject.id, actor, { reason: 'Suspend only the first retry project', idempotencyKey: 'guard-first-suspend' }, line.managed.repository)
    const buildPreview = vi.fn(async input => previewReceipt(input)); const adapter: ManagedSiteDeploymentAdapter = { buildPreview, async deployProduction() { throw new Error('unused') }, async rollback() { throw new Error('unused') } }; const factory = vi.fn(async () => adapter)
    const summary = await advanceEligibleManagedSiteProvisioning({ ownerUserId: 1, limit: 10 }, { repository: line.live.repository, managedRepository: line.managed.repository, credentialResolver: async () => ({ ok: true, value: 'runtime-only' }), clock: () => new Date(NOW.getTime() + 6 * 60_000), deploymentAdapter: factory })
    expect(summary).toEqual({ scanned: 2, advanced: 1, failed: 1 }); expect(factory).toHaveBeenCalledTimes(1); expect(buildPreview).toHaveBeenCalledTimes(1); expect(line.live.state.releases.find(item => item.projectId === firstProject.id)?.status).toBe('retry_wait'); expect(line.live.state.releases.find(item => item.projectId === firstProject.id + offset)?.status).toBe('preview_ready')
  })

  it('blocks editor scheduler handlers for suspended or unavailable projects', async () => {
    const job = { jobId: 'suspended-editor-job', ownerUserId: 1, projectId: 10, kind: 'publish_retry' as const, attempt: 0, availableAt: NOW.toISOString(), leaseUntil: null, stateFingerprint: 'a'.repeat(64) }
    const memory = createMemoryEditorSchedulerPort([job]); const publish = vi.fn(async () => ({ outcome: 'publication_succeeded', externalCalls: true })); const handlers = { media_processing: publish, media_object_cleanup: publish, scheduled_visibility: publish, orphan_upload_expiry: publish, trash_retention: publish, publish_retry: publish } satisfies EditorJobHandlers
    const result = await runEditorSchedulerTick(memory.port, handlers, NOW, async () => false)
    expect(result.receipts).toEqual([expect.objectContaining({ status: 'blocked', reasonCode: 'PROJECT_SUSPENDED_OR_UNAVAILABLE', externalCalls: false })]); expect(publish).not.toHaveBeenCalled()
  })

  it('refuses an editor mutation for a suspended project', async () => {
    vi.resetModules(); vi.doMock('../server/managed-sites/auth', () => ({ requireManagedSiteCustomer: async () => ({ project: { id: 10, ownerUserId: 1, status: 'suspended' }, membership: { userId: 8, role: 'owner' } }) }))
    const { requireEditorActor } = await import('../server/managed-sites/page-editor/http')
    const app = createApp({ debug: false, onError: async (error, event) => { setResponseStatus(event, error.statusCode || 500, error.statusMessage); await send(event, '', 'text/plain') } }); const router = createRouter(); router.post('/editor-mutation', defineEventHandler(event => requireEditorActor(event, 'content:write'))); app.use(router)
    const response = await toWebHandler(app)(new Request('https://editor.test/editor-mutation', { method: 'POST', headers: { origin: 'https://editor.test' }, body: '{}' }))
    expect(response.status).toBe(403)
    vi.doUnmock('../server/managed-sites/auth'); vi.resetModules()
  })
})
