import { describe, expect, it, vi } from 'vitest'
import { projectManagedSiteLaunchStatus } from '../server/managed-sites/funnel/launch-status'

function fixture() {
  const release: any = { id: 7, ownerUserId: 1, projectId: 2, draftOrderId: 3, quoteId: 4, previewId: 5, status: 'live_verified', canonicalDomain: 'customer.example', contentHash: 'a'.repeat(64), activeDeploymentReceiptFingerprint: 'b'.repeat(64), previewUrl: 'https://preview.example', blockedReasonCode: null }
  const order: any = { id: 3, ownerUserId: 1, projectId: 2, quoteId: 4, previewId: 5, status: 'payment_verified' }
  const receipt: any = { releaseId: 7, projectId: 2, canonicalDomain: release.canonicalDomain, contentHash: release.contentHash, receiptType: 'production_deployment_verified', receiptStatus: 'verified', metadata: { deploymentUrl: 'https://customer.example/' } }
  const repository = { findReceiptByFingerprint: vi.fn(async () => receipt) } as any
  const ordering = { findDraftOrderById: vi.fn(async () => order), listModuleFulfilmentsByDraftOrder: vi.fn(async () => []) } as any
  return { release, order, receipt, repository, ordering, project: () => projectManagedSiteLaunchStatus(1, release, repository, ordering) }
}

describe('customer selected-domain launch status', () => {
  it('exposes the exact paid production URL only after immutable verification', async () => {
    const f = fixture()
    expect(await f.project()).toMatchObject({ order: { status: 'payment_verified' }, release: { liveUrl: 'https://customer.example/' }, checkoutUrl: null })
  })
  it.each([{ receiptStatus: 'pending' }, { contentHash: 'wrong' }, { releaseId: 999 }, { canonicalDomain: 'other.example' }, { metadata: { deploymentUrl: 'https://different.example/' } }])('withholds mismatched production evidence %j', async patch => {
    const f = fixture(); Object.assign(f.receipt, patch)
    expect((await f.project())!.release.liveUrl).toBeNull()
  })
  it.each(['payment_pending', 'refunded', 'disputed'])('does not announce a paid live handoff for %s', async status => {
    const f = fixture(); f.order.status = status
    expect((await f.project())!.release.liveUrl).toBeNull()
  })
  it('rejects another owner or commercial lineage before projecting status', async () => {
    const f = fixture(); f.order.ownerUserId = 9
    expect(await f.project()).toBeNull()
    expect(f.repository.findReceiptByFingerprint).not.toHaveBeenCalled()
    f.order.ownerUserId = 1; f.order.quoteId = 99
    expect(await f.project()).toBeNull()
  })
  it('projects only approved customer copy for blocked domain setup', async () => {
    const f = fixture(); f.release.status = 'blocked'; f.release.blockedReasonCode = 'DOMAIN_DELEGATION_REVIEW_REQUIRED'
    expect((await f.project())!.attention).toContain('尚未替換網域或加收費用')
    f.release.blockedReasonCode = 'raw-secret-provider-error'
    expect((await f.project())!.attention).toBeNull()
  })
})
