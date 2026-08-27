import { describe, expect, it } from 'vitest'
import { stableFingerprint } from '../server/seo-geo-core/repository'
import { releaseManagedSiteDomainClaim } from '../server/managed-sites/live-connectors/domain-connectors'
import { createAuthoritativeManagedSiteReleaseFixture, managedSiteFixedNow as now } from './fixtures/managed-site/live-connectors-application'

describe('managed-site explicit active domain claim release', () => {
  it('retains history, frees only the nullable active key, and permits a later atomic claim', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); const release = await line.live.repository.findRelease(line.ownerUserId, line.release.release.id)
    const requestFingerprint = stableFingerprint({ domain: release!.canonicalDomain, releaseId: release!.id }); const projectionFingerprint = stableFingerprint({ requestFingerprint, status: 'pending' })
    const claim = await line.live.repository.insertDomainClaim({ canonicalDomain: release!.canonicalDomain, activeCanonicalDomainKey: release!.canonicalDomain, ownerUserId: line.ownerUserId, projectId: release!.projectId, releaseId: release!.id, claimKind: 'generated', status: 'pending', authorityReceiptFingerprint: null, requestFingerprint, idempotencyKey: 'claim-before-release', projectionFingerprint } as any)
    const result = await releaseManagedSiteDomainClaim(line.ownerUserId, { projectId: release!.projectId, releaseId: release!.id, claimId: claim.id, expectedProjectionFingerprint: claim.projectionFingerprint, idempotencyKey: 'explicit-domain-release-001' }, line.live.repository, () => now)
    expect(result.claim).toMatchObject({ canonicalDomain: release!.canonicalDomain, activeCanonicalDomainKey: null, status: 'released' })
    expect(line.live.state.domainClaims).toHaveLength(1); expect(line.live.state.receipts.filter(row => row.receiptType === 'domain_claim_released')).toHaveLength(1)
    const later = await line.live.repository.insertDomainClaim({ canonicalDomain: release!.canonicalDomain, activeCanonicalDomainKey: release!.canonicalDomain, ownerUserId: 2, projectId: 200, releaseId: 201, claimKind: 'existing', status: 'pending', authorityReceiptFingerprint: null, requestFingerprint: stableFingerprint({ later: true }), idempotencyKey: 'later-cross-owner-claim', projectionFingerprint: stableFingerprint({ later: 'pending' }) } as any)
    expect(later.ownerUserId).toBe(2); expect(line.live.state.domainClaims).toHaveLength(2)
  })

  it('fails closed while a domain is live or governed deployment/rollback is active', async () => {
    const line = await createAuthoritativeManagedSiteReleaseFixture(); const release = await line.live.repository.findRelease(line.ownerUserId, line.release.release.id)
    const requestFingerprint = stableFingerprint({ live: release!.id }); const projectionFingerprint = stableFingerprint({ requestFingerprint, status: 'verified' })
    const claim = await line.live.repository.insertDomainClaim({ canonicalDomain: release!.canonicalDomain, activeCanonicalDomainKey: release!.canonicalDomain, ownerUserId: line.ownerUserId, projectId: release!.projectId, releaseId: release!.id, claimKind: 'generated', status: 'verified', authorityReceiptFingerprint: 'a'.repeat(64), requestFingerprint, idempotencyKey: 'live-domain-claim', projectionFingerprint } as any)
    await line.live.repository.transitionRelease(line.ownerUserId, release!.id, release!.status, release!.projectionFingerprint, { status: 'live_verified', projectionFingerprint: stableFingerprint({ live: true }) })
    await expect(releaseManagedSiteDomainClaim(line.ownerUserId, { projectId: release!.projectId, releaseId: release!.id, claimId: claim.id, expectedProjectionFingerprint: claim.projectionFingerprint, idempotencyKey: 'blocked-live-release' }, line.live.repository, () => now)).rejects.toMatchObject({ statusCode: 409 })
    expect((await line.live.repository.findDomainClaim(release!.canonicalDomain))?.status).toBe('verified')
  })
})
