import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { buildManagedSitePreview } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { advanceEligibleManagedSiteProvisioning } from '../server/managed-sites/live-connectors/provision-advancer'
import { configureManagedSiteProvider } from '../server/managed-sites/live-connectors/provider-registry'
import type { ManagedSiteDeploymentAdapter, ManagedSiteDeploymentReceipt } from '../server/managed-sites/live-connectors/types'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

const START = new Date('2026-09-01T00:00:00.000Z')
const credentialResolver = async () => ({ ok: true as const, value: 'runtime-only-deployment-value' })

function receipt(input: Parameters<ManagedSiteDeploymentAdapter['buildPreview']>[0]): ManagedSiteDeploymentReceipt {
  const core = { providerKey: 'internal-deployment-bearer-v1', providerEventId: `event-${input.releaseId}`, providerDeploymentId: `deployment-${input.releaseId}`, projectId: input.projectId, versionId: input.versionId, contentHash: input.contentHash, canonicalDomain: input.canonicalDomain, deploymentUrl: `https://preview-${input.releaseId}.pages.dev`, status: 'preview_ready' as const, observedAt: START.toISOString(), providerAuthorityFingerprint: input.providerAuthority.authorityFingerprint }
  return { ...core, payloadHash: stableFingerprint(core), exactResponseIdentity: `live-test-response:${input.releaseId}` }
}

async function retryLine() {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'advancer.acme.taipei', buildPreview: false })
  await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: 'envref:deployment-runtime-key', transportConfiguration: { endpointOrigin: 'https://provider.acme.taipei' }, idempotencyKey: 'advancer-live-configuration' }, line.live.repository, () => START)
  const configuration = await line.live.repository.findProviderConfiguration(1, 'deployment')
  await line.live.repository.verifyProviderConfigurationCas(1, configuration!.id, configuration!.configurationFingerprint, { readinessStatus: 'verified', verificationReceiptFingerprint: 'a'.repeat(64), capabilityIdentity: 'cloudflare-pages:test', verifiedAt: START })
  const failure: ManagedSiteDeploymentAdapter = { async buildPreview() { throw Object.assign(new Error('temporary failure'), { retryable: true }) }, async deployProduction() { throw new Error('unused') }, async rollback() { throw new Error('unused') } }
  await expect(buildManagedSitePreview(1, { releaseId: line.release.release.id, executionMode: 'live', idempotencyKey: 'advancer-preview-attempt' }, failure, { repository: line.live.repository, credentialResolver, clock: () => START })).rejects.toThrow()
  return line
}

describe('managed-site provisioning advancer', () => {
  it('advances an eligible retry to success and leaves a future retry untouched', async () => {
    const line = await retryLine(); const success: ManagedSiteDeploymentAdapter = { async buildPreview(input) { return receipt(input) }, async deployProduction() { throw new Error('unused') }, async rollback() { throw new Error('unused') } }
    expect(await advanceEligibleManagedSiteProvisioning({ ownerUserId: 1, limit: 3 }, { repository: line.live.repository, credentialResolver, clock: () => new Date(START.getTime() + 4 * 60_000), deploymentAdapter: async () => success })).toEqual({ scanned: 0, advanced: 0, failed: 0 })
    expect(line.live.state.releases.find(item => item.id === line.release.release.id)?.status).toBe('retry_wait')
    expect(await advanceEligibleManagedSiteProvisioning({ ownerUserId: 1, limit: 3 }, { repository: line.live.repository, credentialResolver, clock: () => new Date(START.getTime() + 6 * 60_000), deploymentAdapter: async () => success })).toEqual({ scanned: 1, advanced: 1, failed: 0 })
    expect(line.live.state.releases.find(item => item.id === line.release.release.id)?.status).toBe('preview_ready')
  })

  it('keeps lease contention safe when two advancers race', async () => {
    const line = await retryLine(); let calls = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    const success: ManagedSiteDeploymentAdapter = { async buildPreview(input) { calls++; await gate; return receipt(input) }, async deployProduction() { throw new Error('unused') }, async rollback() { throw new Error('unused') } }
    const dependencies = { repository: line.live.repository, credentialResolver, clock: () => new Date(START.getTime() + 6 * 60_000), deploymentAdapter: async () => success }
    const first = advanceEligibleManagedSiteProvisioning({ ownerUserId: 1 }, dependencies); await Promise.resolve(); const second = advanceEligibleManagedSiteProvisioning({ ownerUserId: 1 }, dependencies); await Promise.resolve(); release()
    const summaries = await Promise.all([first, second])
    expect(summaries.reduce((sum, item) => sum + item.advanced, 0)).toBe(1); expect(calls).toBe(1)
    expect(line.live.state.receipts.filter(item => item.receiptType === 'preview_build_verified')).toHaveLength(1)
  })

  it('skips eligible work without error when live adapters are unconfigured', async () => {
    const line = await retryLine()
    expect(await advanceEligibleManagedSiteProvisioning({ ownerUserId: 1 }, { repository: line.live.repository, clock: () => new Date(START.getTime() + 6 * 60_000), deploymentAdapter: async () => { throw new Error('unconfigured') } })).toEqual({ scanned: 1, advanced: 0, failed: 0 })
  })
})
