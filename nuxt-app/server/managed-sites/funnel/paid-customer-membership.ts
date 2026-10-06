import { createError } from 'h3'
import { stableFingerprint } from '../../seo-geo-core/repository'
import { normalizeRecipientEmail } from '../normalization'
import type { ManagedSiteRepository } from '../types'

export const PAID_FUNNEL_CUSTOMER_MEMBERSHIP_ACTION = 'paid_funnel_customer_membership_granted' as const

type GrantInput = {
  ownerUserId: number
  projectId: number
  draftOrderId: number
  releaseId: number
  paymentReceiptFingerprint: string
  email: string
  /** Only the verified payment webhook may bind or replace a pre-existing non-owner role. */
  allowExistingMembership: boolean
}

function conflict(message: string): never {
  throw createError({ statusCode: 409, statusMessage: message })
}

export function paidFunnelCustomerMembershipGrantFingerprint(input: Omit<GrantInput, 'allowExistingMembership' | 'email'> & { recipientFingerprint: string }): string {
  return stableFingerprint({
    scope: 'paid-funnel-customer-membership-v1',
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    draftOrderId: input.draftOrderId,
    releaseId: input.releaseId,
    paymentReceiptFingerprint: input.paymentReceiptFingerprint,
    recipientFingerprint: input.recipientFingerprint,
  })
}

/**
 * Materializes the exact paid contact as an editor. The caller must already be
 * inside the same transaction that accepted the effective payment receipt.
 * A browser-token recovery path may create a missing row, but it may never adopt
 * an unrelated invitation membership without the webhook-only flag.
 */
export async function ensurePaidFunnelCustomerMembership(input: GrantInput, repository: ManagedSiteRepository, clock: () => Date = () => new Date()) {
  if (![input.ownerUserId, input.projectId, input.draftOrderId, input.releaseId].every(value => Number.isSafeInteger(value) && value > 0) || !/^[a-f0-9]{64}$/u.test(input.paymentReceiptFingerprint)) conflict('Paid customer membership authority is invalid.')
  const email = normalizeRecipientEmail(input.email)
  const recipientFingerprint = stableFingerprint({ recipientEmail: email })
  const eventFingerprint = paidFunnelCustomerMembershipGrantFingerprint({ ...input, recipientFingerprint })
  const existingGrant = await repository.findAuditEventByFingerprint(input.ownerUserId, eventFingerprint)
  if (existingGrant) {
    const membershipId = Number((existingGrant.metadata as any)?.membershipId)
    const membership = Number.isSafeInteger(membershipId) ? await repository.findMembership(input.ownerUserId, membershipId) : null
    if (!membership || existingGrant.projectId !== input.projectId || existingGrant.action !== PAID_FUNNEL_CUSTOMER_MEMBERSHIP_ACTION || membership.projectId !== input.projectId || membership.principalEmail !== email || membership.role !== 'editor' || membership.status !== 'active' || !membership.acceptedAt || (existingGrant.metadata as any)?.draftOrderId !== input.draftOrderId || (existingGrant.metadata as any)?.releaseId !== input.releaseId || (existingGrant.metadata as any)?.paymentReceiptFingerprint !== input.paymentReceiptFingerprint || (existingGrant.metadata as any)?.recipientFingerprint !== recipientFingerprint) conflict('Paid customer membership grant is stale or mismatched.')
    return { membership, grant: existingGrant, replayed: true }
  }

  const project = await repository.findProject(input.ownerUserId, input.projectId)
  if (!project || project.ownerUserId !== input.ownerUserId || project.status === 'suspended') conflict('Paid customer project authority is unavailable.')
  const existing = await repository.findMembershipByEmail(input.ownerUserId, input.projectId, email)
  if (existing?.role === 'owner') conflict('A platform owner membership cannot be converted into paid customer access.')
  if (existing && !input.allowExistingMembership) conflict('An unrelated existing membership cannot satisfy paid funnel access.')

  const grantedAt = clock()
  const beforeFingerprint = existing ? stableFingerprint({ membershipId: existing.id, role: existing.role, status: existing.status, acceptedAt: existing.acceptedAt?.toISOString() || null, revokedAt: existing.revokedAt?.toISOString() || null }) : null
  const membership = existing
    ? await repository.updateMembership(input.ownerUserId, existing.id, { role: 'editor', status: 'active', invitedAt: existing.invitedAt || grantedAt, acceptedAt: grantedAt, revokedAt: null, updatedAt: grantedAt } as any)
    : await repository.insertMembership({ ownerUserId: input.ownerUserId, projectId: input.projectId, principalEmail: email, userId: null, role: 'editor', status: 'active', invitedAt: grantedAt, acceptedAt: grantedAt, revokedAt: null })
  if (!membership || membership.projectId !== input.projectId || membership.principalEmail !== email || membership.role !== 'editor' || membership.status !== 'active') conflict('Paid customer membership could not be materialized.')
  const afterFingerprint = stableFingerprint({ membershipId: membership.id, role: membership.role, status: membership.status, acceptedAt: membership.acceptedAt?.toISOString() || null })
  const grant = await repository.insertAuditEvent({
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    actorUserId: null,
    authority: 'system_workflow',
    action: PAID_FUNNEL_CUSTOMER_MEMBERSHIP_ACTION,
    beforeFingerprint,
    afterFingerprint,
    eventFingerprint,
    metadata: { grantVersion: 'paid-funnel-customer-membership-v1', draftOrderId: input.draftOrderId, releaseId: input.releaseId, paymentReceiptFingerprint: input.paymentReceiptFingerprint, recipientFingerprint, membershipId: membership.id, role: 'editor' },
    occurredAt: grantedAt,
  } as any)
  return { membership, grant, replayed: false }
}
