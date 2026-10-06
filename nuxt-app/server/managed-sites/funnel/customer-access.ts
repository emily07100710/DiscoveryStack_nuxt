import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { normalizeRecipientEmail, tokenHash } from '../normalization'
import { getManagedSitePrePurchaseRepositories } from '../prepurchase-service'
import { MANAGED_SITE_SESSION_TTL_MS } from '../types'
import { getFunnelSessionRepository, type FunnelSessionRepository } from './session-repository'
import { loadFunnelSession, type FunnelAnswers } from './session-service'
import { ensurePaidFunnelCustomerMembership } from './paid-customer-membership'

type Repositories = ReturnType<typeof getManagedSitePrePurchaseRepositories>
export type FunnelCustomerAccessDependencies = {
  funnelRepository?: FunnelSessionRepository
  withTransaction?: NonNullable<Repositories['withTransaction']>
  clock?: () => Date
}

function unavailable(): never {
  throw createError({ statusCode: 409, statusMessage: '目前無法開啟這筆訂單的網站管理入口，請確認付款狀態或聯絡客服。' })
}

/** Exchange the exact paid funnel capability for an existing, scoped HttpOnly customer session. */
export async function claimFunnelCustomerAccess(ownerUserId: number, sessionId: number, funnelToken: string, dependencies: FunnelCustomerAccessDependencies = {}) {
  const clock = dependencies.clock || (() => new Date())
  const funnel = await loadFunnelSession(sessionId, funnelToken, dependencies.funnelRepository || getFunnelSessionRepository(), clock)
  if (!Number.isSafeInteger(ownerUserId) || ownerUserId < 1 || !funnel.projectId || !funnel.releaseId || !funnel.draftOrderId || !funnel.quoteId || !funnel.previewId || !['checkout_pending', 'converted'].includes(funnel.status)) unavailable()
  const email = normalizeRecipientEmail((funnel.answers as FunnelAnswers)?.contact?.email || '')
  // The bearer contributes 256 bits of entropy; neither token is stored in clear text.
  // Replays reuse the same eight-hour session and cannot extend it or undo revocation.
  const sessionToken = stableFingerprint({ scope: 'paid-funnel-customer-session-v1', sessionId, funnelToken, projectId: funnel.projectId, releaseId: funnel.releaseId })
  const sessionHash = tokenHash(sessionToken)
  const eventFingerprint = stableFingerprint({ scope: 'paid-funnel-customer-access-v1', ownerUserId, sessionId, projectId: funnel.projectId, releaseId: funnel.releaseId })
  const transact = dependencies.withTransaction || getManagedSitePrePurchaseRepositories().withTransaction!
  const result = await transact(async repositories => {
    // Serialize access issuance against payment settlement before reading any grant authority.
    const order = await repositories.ordering.findDraftOrderByIdForUpdate(funnel.draftOrderId!)
    if (!order || order.ownerUserId !== ownerUserId || order.projectId !== funnel.projectId || order.previewId !== funnel.previewId || order.quoteId !== funnel.quoteId || order.status !== 'payment_verified') unavailable()
    const [release, project, receipts, lead] = await Promise.all([
      repositories.live.findRelease(ownerUserId, funnel.releaseId!),
      repositories.managed.findProject(ownerUserId, funnel.projectId!),
      repositories.live.listReceiptsByDraftOrder(ownerUserId, order.id),
      repositories.ordering.findLeadById(order.leadId),
    ])
    if (!lead || normalizeRecipientEmail(lead.email) !== email || !project || project.status === 'suspended' || !release || release.projectId !== project.id || release.draftOrderId !== order.id || release.previewId !== order.previewId || release.quoteId !== order.quoteId) unavailable()
    const payment = receipts.find(row => row.releaseId === release.id && row.projectId === project.id && row.draftOrderId === order.id && row.contentHash === release.contentHash && row.canonicalDomain === release.canonicalDomain && row.receiptType === 'checkout_succeeded' && row.receiptStatus === 'verified' && (row.metadata as any)?.effective === true)
    if (!payment || receipts.some(row => row.releaseId === release.id && ['payment_refunded', 'payment_disputed'].includes(row.receiptType) && row.receiptStatus === 'verified' && (row.metadata as any)?.effective === true)) unavailable()
    const paidGrant = await ensurePaidFunnelCustomerMembership({ ownerUserId, projectId: project.id, draftOrderId: order.id, releaseId: release.id, paymentReceiptFingerprint: payment.receiptFingerprint, email, allowExistingMembership: false }, repositories.managed, clock)
    const issued = await repositories.managed.findAuditEventByFingerprint(ownerUserId, eventFingerprint)
    const previous = await repositories.managed.findSessionByHash(sessionHash)
    const membership = paidGrant.membership
    const now = clock()
    if (issued || previous) {
      if (!issued || !previous || previous.ownerUserId !== ownerUserId || previous.projectId !== project.id || previous.membershipId !== membership.id || previous.revokedAt || previous.expiresAt.getTime() <= now.getTime() || membership.status !== 'active' || membership.role !== 'editor' || (issued.metadata as any)?.membershipId !== membership.id || (issued.metadata as any)?.customerSessionId !== previous.id) unavailable()
      return { session: previous, projectId: project.id, replayed: true }
    }
    const session = await repositories.managed.insertSession({ ownerUserId, projectId: project.id, membershipId: membership.id, sessionHash, expiresAt: new Date(Math.min(now.getTime() + MANAGED_SITE_SESSION_TTL_MS, funnel.expiresAt.getTime())), revokedAt: null, lastSeenAt: now })
    await repositories.managed.insertAuditEvent({ ownerUserId, projectId: project.id, actorUserId: null, authority: 'system_workflow', action: 'paid_funnel_customer_access_issued', beforeFingerprint: null, afterFingerprint: stableFingerprint({ customerSessionId: session.id, membershipId: membership.id }), eventFingerprint, metadata: { funnelSessionId: funnel.id, releaseId: release.id, draftOrderId: order.id, membershipId: membership.id, customerSessionId: session.id }, occurredAt: now })
    return { session, projectId: project.id, replayed: false }
  })
  return { ...result, sessionToken }
}
