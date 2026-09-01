import { describe, expect, it } from 'vitest'
import { createS3ManagedSiteArtifactVault } from '../server/managed-sites/live-connectors/s3-vault'
import { parseManagedSiteInternalBrokerConfiguration } from '../server/managed-sites/live-connectors/internal-broker/config'
import { MANAGED_SITE_INTERNAL_BROKER_ORIGIN } from '../server/managed-sites/live-connectors/internal-broker/constants'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { managedSiteLiveDeploymentAdapter } from '../server/managed-sites/live-connectors/runtime-adapters'
import { buildManagedSitePreview } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

describe.runIf(process.env.DS_RUN_REAL_MANAGED_DEPLOYMENT_TESTS === '1')('managed-site real Cloudflare preview deployment', () => {
  it('stores the immutable bundle, deploys it, and observes the public preview bytes', async () => {
    const configuration = parseManagedSiteInternalBrokerConfiguration(); expect(configuration).not.toBeNull()
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = [process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS, MANAGED_SITE_INTERNAL_BROKER_ORIGIN].filter(Boolean).join(',')
    const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'real-preview.discoverystack.dev', buildPreview: false })
    const candidate = line.live.state.candidates.find(item => item.id === line.generation.candidate!.id)!; const bundle = line.vault.records.get(candidate.vaultReference)!
    const stored = await createS3ManagedSiteArtifactVault().storeImmutableCandidate(bundle); candidate.vaultReference = stored.vaultReference
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: configuration!.deploymentCredentialReference, transportConfiguration: { endpointOrigin: MANAGED_SITE_INTERNAL_BROKER_ORIGIN }, idempotencyKey: 'real-deployment-provider-configuration' }, line.live.repository)
    await verifyManagedSiteProviderConfiguration(1, 'deployment', line.live.repository)
    const adapter = await managedSiteLiveDeploymentAdapter(1, line.live.repository)
    const result = await buildManagedSitePreview(1, { releaseId: line.release.release.id, executionMode: 'live', idempotencyKey: `real-preview-${Date.now()}` }, adapter, { repository: line.live.repository })
    const previewUrl = result.release?.previewUrl || ''; expect(previewUrl).toMatch(/^https:\/\/[^/]+\.pages\.dev\/?$/u)
    console.log(`REAL MANAGED-SITE PREVIEW URL: ${previewUrl}`)
    const deadline = Date.now() + 60_000; let observed = ''
    while (Date.now() < deadline) { try { const response = await fetch(previewUrl, { redirect: 'error' }); if (response.status === 200) { observed = await response.text(); if (observed.includes('Authoritative Managed Site')) break } } catch { /* retry bounded public propagation */ } await new Promise(resolve => setTimeout(resolve, 2_000)) }
    expect(observed).toContain('Authoritative Managed Site')
  }, 120_000)
})
