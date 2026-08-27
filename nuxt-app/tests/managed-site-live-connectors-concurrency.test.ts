import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { configureManagedSiteProvider, verifyManagedSiteProviderConfiguration } from '../server/managed-sites/live-connectors/provider-registry'
import { assertAllowedManagedSiteProviderOrigin, MANAGED_SITE_PROVIDER_VERIFIERS, resolveManagedSiteProviderVerifier } from '../server/managed-sites/live-connectors/provider-verifiers'
import { createLiveConnectorMemoryRepository } from './fixtures/managed-site/live-connectors-repository'
import { approveManagedSitePreview, buildManagedSitePreview } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow } from './fixtures/managed-site/live-connectors-application'

describe('managed-site connector CAS, provider race, and atomic domain claim boundaries', () => {
  it('rejects a stale provider verification when configuration changes during verifier I/O', async () => {
    const live = createLiveConnectorMemoryRepository(); const resolver = async () => ({ ok: true as const, value: 'runtime-only' })
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: 'vault:race-one', transportConfiguration: { endpointOrigin: 'https://provider-one.example' }, idempotencyKey: 'race-config-one' }, live.repository)
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve })
    const registry: any = new Map([['internal-deployment-bearer-v1', new Map([['deployment', async (input: any) => { await wait; return { capability: 'deployment', providerKey: input.providerKey, configurationFingerprint: input.configurationFingerprint, providerAccountId: 'account-race', providerEventId: 'event-race', payloadHash: 'a'.repeat(64), exactResponseIdentity: 'verification-race', observedAt: '2026-08-27T00:00:00.000Z' } }]])]])
    const verifying = verifyManagedSiteProviderConfiguration(1, 'deployment', live.repository, resolver, () => new Date('2026-08-27T00:00:00.000Z'), registry)
    await Promise.resolve()
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: 'vault:race-two', transportConfiguration: { endpointOrigin: 'https://provider-two.example' }, idempotencyKey: 'race-config-two' }, live.repository)
    release()
    await expect(verifying).rejects.toMatchObject({ statusCode: 409 })
    expect(live.state.configurations[0]).toMatchObject({ readinessStatus: 'configured', credentialReference: 'vault:race-two', verificationReceiptFingerprint: null })
  })

  it('permits only one stale release projection transition and keeps owner scope exact', async () => {
    const live = createLiveConnectorMemoryRepository(); const fingerprint = stableFingerprint({ release: 1, state: 'preview_ready' })
    const release = await live.repository.insertRelease({ ownerUserId: 1, projectId: 10, generationCandidateId: 20, versionId: 30, previewId: 40, quoteId: 50, draftOrderId: 60, commerceSnapshotFingerprint: 'a'.repeat(64), releaseKind: 'generated_site', targetKey: 'primary', canonicalDomain: 'cas.acme.taipei', contentHash: 'b'.repeat(64), status: 'preview_ready', previewUrl: 'https://preview.example/one', providerPreviewId: 'preview-one', approvalFingerprint: null, approvedAt: null, activeDeploymentReceiptFingerprint: null, rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'approve_preview', projectionFingerprint: fingerprint, idempotencyKey: 'release-cas-test' } as any)
    const [approval, retry] = await Promise.all([
      live.repository.transitionRelease(1, release.id, 'preview_ready', fingerprint, { status: 'approved', projectionFingerprint: stableFingerprint({ winner: 'approval' }) }),
      live.repository.transitionRelease(1, release.id, 'preview_ready', fingerprint, { status: 'retry_wait', projectionFingerprint: stableFingerprint({ winner: 'retry' }) }),
    ])
    expect([approval, retry].filter(Boolean)).toHaveLength(1)
    expect(await live.repository.transitionRelease(2, release.id, (approval || retry)!.status, (approval || retry)!.projectionFingerprint, { status: 'failed' })).toBeNull()
  })

  it('atomically rejects concurrent cross-owner claims for one canonical domain', async () => {
    const live = createLiveConnectorMemoryRepository(); const base = { canonicalDomain: 'unique.acme.taipei', projectId: 10, releaseId: 20, claimKind: 'generated' as const, status: 'pending' as const, authorityReceiptFingerprint: null, requestFingerprint: 'a'.repeat(64), projectionFingerprint: 'b'.repeat(64) }
    const results = await Promise.allSettled([
      live.repository.insertDomainClaim({ ...base, ownerUserId: 1, idempotencyKey: 'domain-owner-one' } as any),
      live.repository.insertDomainClaim({ ...base, ownerUserId: 2, projectId: 11, releaseId: 21, requestFingerprint: 'c'.repeat(64), idempotencyKey: 'domain-owner-two' } as any),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(live.state.domainClaims).toHaveLength(1)
  })

  it('rejects stale gate receipts after the release content projection changes', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture({ buildPreview: false })
    const built = await buildManagedSitePreview(1, { releaseId: line.release.release.id, executionMode: 'mocked', idempotencyKey: 'stale-gate-preview' }, line.deploymentAdapter, { repository: line.live.repository, clock: () => managedSiteFixedNow })
    const changed = await line.live.repository.transitionRelease(1, built.release.id, 'preview_ready', built.release.projectionFingerprint, { status: 'preview_ready', contentHash: 'f'.repeat(64), projectionFingerprint: stableFingerprint({ staleGateAttack: true }) })
    expect(changed).not.toBeNull()
    await expect(approveManagedSitePreview(1, { releaseId: built.release.id, idempotencyKey: 'stale-gate-approval' }, line.live.repository, () => managedSiteFixedNow)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('fails closed for unsupported verifier and non-server-allowlisted endpoint origins', () => {
    expect(() => resolveManagedSiteProviderVerifier('stripe', 'payment')).toThrow()
    expect(() => assertAllowedManagedSiteProviderOrigin('https://owner-supplied.com/v1', 'https://approved.com')).toThrow()
    expect(assertAllowedManagedSiteProviderOrigin('https://approved.com/v1', 'https://approved.com')).toBe('https://approved.com')
  })

  it('verifies the exact internal bearer deployment challenge identity without accepting caller receipts', async () => {
    const live = createLiveConnectorMemoryRepository(); const clock = () => new Date('2026-08-27T00:00:00.000Z')
    await configureManagedSiteProvider(1, { capability: 'deployment', providerKey: 'internal-deployment-bearer-v1', readinessStatus: 'configured', credentialReference: 'vault:deployment-runtime', transportConfiguration: { endpointOrigin: 'https://deployment.acmecloud.com' }, idempotencyKey: 'deployment-verifier-config' }, live.repository, clock)
    const previous = process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
    process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = 'https://deployment.acmecloud.com'
    try {
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe('error')
        const request = JSON.parse(String(init?.body))
        const challengeHash = createHash('sha256').update(request.challenge).digest('hex')
        const core = { challengeHash, providerAccountId: 'deployment-account-001', providerEventId: 'deployment-verification-event-001', observedAt: clock().toISOString(), configurationFingerprint: request.configurationFingerprint }
        return new Response(JSON.stringify({ schemaVersion: 'managed-site-provider-verification-v1', challengeHash, providerAccountId: core.providerAccountId, providerEventId: core.providerEventId, observedAt: core.observedAt, payloadHash: stableFingerprint(core), exactResponseIdentity: 'deployment-verification-response-001' }), { status: 200 })
      }
      const result = await verifyManagedSiteProviderConfiguration(1, 'deployment', live.repository, async () => ({ ok: true, value: 'runtime-only' }), clock, MANAGED_SITE_PROVIDER_VERIFIERS, fetchImpl as typeof fetch)
      expect(result.configuration).toMatchObject({ readinessStatus: 'verified', providerKey: 'internal-deployment-bearer-v1' })
    } finally {
      if (previous === undefined) delete process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS
      else process.env.DISCOVERYSTACK_MANAGED_SITE_ALLOWED_PROVIDER_ORIGINS = previous
    }
  })
})
