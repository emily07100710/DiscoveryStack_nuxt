import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { buildManagedSitePreview, createGeneratedManagedSiteRelease, createMockManagedSiteDeploymentAdapter, rollbackManagedSiteRelease } from '../server/managed-sites/live-connectors/deployment-orchestrator'
import { managedSiteProviderAuthorityMetadata, resolveManagedSiteProviderAuthority } from '../server/managed-sites/live-connectors/provider-registry'
import { createAuthoritativeManagedSiteReleaseFixture } from './fixtures/managed-site/live-connectors-application'

async function setup() {
  const line = await createAuthoritativeManagedSiteReleaseFixture({ canonicalDomain: 'deployment-retry.acme.taipei', buildPreview: false })
  return { managed: line.managed, live: line.live, project: line.prePurchase.project, version: line.prePurchase.version, candidate: line.generation.candidate!, release: line.release.release }
}

describe('managed-site deployment retries, replay, collision, and rollback', () => {
  it('uses bounded retry eligibility, exact replay, and rejects receipt identity collisions', async () => {
    const line = await setup()
    let now = new Date('2026-08-27T00:00:00.000Z')
    const retryAdapter = createMockManagedSiteDeploymentAdapter({ failOperations: { preview: 1 } })
    await expect(buildManagedSitePreview(1, { releaseId: line.release.id, executionMode: 'mocked', idempotencyKey: 'preview-retry-001' }, retryAdapter, { repository: line.live.repository, clock: () => now })).rejects.toThrow()
    expect(line.live.state.attempts.find(attempt => attempt.operation === 'preview_build')).toMatchObject({ status: 'retry_wait', attemptNumber: 1 })
    expect(line.live.state.releases.find(release => release.id === line.release.id)?.status).toBe('retry_wait')
    await expect(buildManagedSitePreview(1, { releaseId: line.release.id, executionMode: 'mocked', idempotencyKey: 'preview-retry-001' }, retryAdapter, { repository: line.live.repository, clock: () => now })).rejects.toMatchObject({ statusCode: 409 })
    now = new Date('2026-08-27T00:06:00.000Z')
    expect(line.live.state.releases.find(release => release.id === line.release.id)?.status).toBe('retry_wait')
    const success = await buildManagedSitePreview(1, { releaseId: line.release.id, executionMode: 'mocked', idempotencyKey: 'preview-retry-001' }, retryAdapter, { repository: line.live.repository, clock: () => now })
    expect(success.release?.status).toBe('preview_ready')
    expect(line.live.state.attempts.find(attempt => attempt.operation === 'preview_build')).toMatchObject({ status: 'succeeded', attemptNumber: 2 })
    const replay = await buildManagedSitePreview(1, { releaseId: line.release.id, executionMode: 'mocked', idempotencyKey: 'preview-retry-001' }, retryAdapter, { repository: line.live.repository, clock: () => now })
    expect(replay.replayed).toBe(true)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'preview_build_verified')).toHaveLength(1)

    const contentHash = stableFingerprint({ candidate: 2 })
    const candidate = await line.live.repository.insertGenerationCandidate({ ownerUserId: 1, projectId: line.project.id, sourceVersionId: line.version.id, requestSchemaVersion: 'managed-site-generation-request-v1', requestFingerprint: stableFingerprint({ request: 2 }), idempotencyKey: 'deployment-candidate-002', providerKey: 'mock-generator', providerModel: 'mock-v1', providerRequestId: 'deployment-generation-002', manifest: { fileCount: 1 }, manifestHash: stableFingerprint({ manifest: 2 }), contentHash, vaultReference: `vault:managed-site:1:${line.project.id}:candidate-2`, gateSummary: { security: 'passed' } } as any)
    const second = await createGeneratedManagedSiteRelease(1, { projectId: line.project.id, generationCandidateId: candidate.id, canonicalDomain: 'deployment-retry.acme.taipei', targetKey: 'production-secondary', idempotencyKey: 'deployment-release-002' }, { repository: line.live.repository, managedRepository: line.managed.repository })
    await expect(buildManagedSitePreview(1, { releaseId: second.release.id, executionMode: 'mocked', idempotencyKey: 'preview-collision-001' }, createMockManagedSiteDeploymentAdapter({ collision: { contentHash: 'f'.repeat(64) } }), { repository: line.live.repository, clock: () => now })).rejects.toMatchObject({ statusCode: 409 })
    expect(line.live.state.receipts.some(receipt => receipt.releaseId === second.release.id && receipt.receiptType === 'preview_build_verified')).toBe(false)
  })

  it('rolls back only to a prior verified deployment receipt and replays exactly once', async () => {
    const line = await setup()
    const authority = await resolveManagedSiteProviderAuthority(1, 'deployment', 'mocked', line.live.repository)
    const priorReceiptFingerprint = stableFingerprint({ receipt: 'prior-production' })
    const prior = await line.live.repository.insertRelease({ ownerUserId: 1, projectId: line.project.id, generationCandidateId: line.candidate.id, versionId: line.version.id, previewId: null, quoteId: null, draftOrderId: null, commerceSnapshotFingerprint: null, releaseKind: 'generated_site', targetKey: 'rollback-prior', canonicalDomain: 'deployment-retry.acme.taipei', contentHash: stableFingerprint({ release: 'prior' }), status: 'live_verified', previewUrl: 'https://prior.preview.discoverystack.dev', providerPreviewId: 'prior-preview', approvalFingerprint: stableFingerprint({ approval: 'prior' }), approvedAt: new Date(), activeDeploymentReceiptFingerprint: priorReceiptFingerprint, rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'retain_verified_release', projectionFingerprint: stableFingerprint({ projection: 'prior' }), idempotencyKey: 'rollback-prior-release' } as any)
    await line.live.repository.insertReceipt({ ownerUserId: 1, projectId: line.project.id, draftOrderId: null, releaseId: prior.id, attemptId: null, capability: 'deployment', providerKey: 'mock-deployment', providerEventId: 'prior-production-event', receiptType: 'production_deployment_verified', receiptStatus: 'verified', externalReference: 'prior-deployment', exactResponseIdentity: 'prior-response-identity', requestFingerprint: stableFingerprint({ prior: true }), contentHash: prior.contentHash, canonicalDomain: prior.canonicalDomain, metadata: { deploymentUrl: `https://${prior.canonicalDomain}`, ...managedSiteProviderAuthorityMetadata(authority) }, receiptFingerprint: priorReceiptFingerprint, verifiedAt: new Date() } as any)
    const current = await line.live.repository.insertRelease({ ownerUserId: 1, projectId: line.project.id, generationCandidateId: line.candidate.id, versionId: line.version.id, releaseKind: 'generated_site', targetKey: 'rollback-current', canonicalDomain: prior.canonicalDomain, contentHash: stableFingerprint({ release: 'current' }), status: 'live_verified', previewUrl: 'https://current.preview.discoverystack.dev', providerPreviewId: 'current-preview', approvalFingerprint: stableFingerprint({ approval: 'current' }), approvedAt: new Date(), activeDeploymentReceiptFingerprint: stableFingerprint({ receipt: 'current-production' }), rollbackFromReleaseId: null, blockedReasonCode: null, nextSafeAction: 'rollback_available', projectionFingerprint: stableFingerprint({ projection: 'current' }), idempotencyKey: 'rollback-current-release' } as any)
    const rolled = await rollbackManagedSiteRelease(1, { fromReleaseId: current.id, toReleaseId: prior.id, executionMode: 'mocked', idempotencyKey: 'rollback-operation-001' }, createMockManagedSiteDeploymentAdapter(), { repository: line.live.repository, clock: () => new Date('2026-08-27T00:00:00.000Z') })
    expect(rolled.release?.status).toBe('live_verified')
    expect(line.live.state.releases.find(release => release.id === current.id)?.status).toBe('rolled_back')
    expect(rolled.receipt).toMatchObject({ receiptType: 'rollback_deployment_verified', contentHash: prior.contentHash, canonicalDomain: prior.canonicalDomain })
    const replay = await rollbackManagedSiteRelease(1, { fromReleaseId: current.id, toReleaseId: prior.id, executionMode: 'mocked', idempotencyKey: 'rollback-operation-001' }, createMockManagedSiteDeploymentAdapter(), { repository: line.live.repository, clock: () => new Date('2026-08-27T00:00:00.000Z') })
    expect(replay.replayed).toBe(true)
    expect(line.live.state.receipts.filter(receipt => receipt.receiptType === 'rollback_deployment_verified')).toHaveLength(1)
  })
})
