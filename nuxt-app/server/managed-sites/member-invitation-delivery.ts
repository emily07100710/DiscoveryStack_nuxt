import { stableFingerprint } from '../seo-geo-core/repository'
import { createError } from 'h3'
import { managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from './contact-inbox/email-transport'
import { resolveManagedSiteReaccessOrigin } from './reaccess-service'
import { getManagedSiteRepository } from './repository'
import { inviteManagedSiteMember } from './service'
import { createManagedSiteEmailOutboxRuntime, attemptManagedSiteEmailOutboxItem } from './email-outbox/runtime'
import type { ManagedSiteEmailOutboxRepository } from './email-outbox/types'
import { MANAGED_SITE_REACCESS_PATH, type ManagedSiteActor, type ManagedSiteRepository, type ManagedSiteRole } from './types'

export type ManagedSiteMemberInvitationDeliveryStatus = 'sent' | 'manual_required' | 'delivery_failed' | 'already_pending'

export type ManagedSiteMemberInvitationDeliveryDependencies = {
  repository?: ManagedSiteRepository
  emailTransport?: ManagedSiteEmailTransport
  portalOrigin?: string
  nodeEnv?: string
  durableOutbox?: boolean
}

function roleLabel(role: Exclude<ManagedSiteRole, 'owner'>): string {
  return ({ administrator: '管理員', editor: '編輯者', reviewer: '審稿者', analyst: '分析者' } as const)[role]
}

function invitationPath(token: string): string {
  return `${MANAGED_SITE_REACCESS_PATH}?token=${encodeURIComponent(token)}`
}

function composeInvitationEmail(input: {
  siteLabel: string
  role: Exclude<ManagedSiteRole, 'owner'>
  invitationUrl: string
  reaccessUrl: string
  expiresAt: Date
}) {
  return {
    subject: `您受邀管理 ${input.siteLabel} 的網站`,
    text: [
      '您好，',
      '',
      `您已受邀以「${roleLabel(input.role)}」身分管理 ${input.siteLabel} 的 DiscoveryStack 網站。`,
      `請在 ${input.expiresAt.toISOString()} 前開啟以下一次性連結：`,
      '',
      input.invitationUrl,
      '',
      '開啟連結只會顯示確認頁；按下「進入網站後台」後，連結才會被使用。',
      `若連結已失效，請至 ${input.reaccessUrl} 輸入本信箱，重新取得短效登入連結。`,
      '如果您不認得這項邀請，請直接忽略這封信。',
    ].join('\n'),
  }
}

/**
 * Creates the durable invitation first, then attempts delivery through the configured
 * mail transport. A successful send removes the bearer from the owner response; an
 * unavailable or failed transport returns the one-time manual URL so the owner can
 * still complete onboarding through a separate trusted channel.
 */
export async function inviteAndDeliverManagedSiteMember(
  ownerUserId: number,
  projectId: number,
  actor: ManagedSiteActor,
  input: unknown,
  dependencies: ManagedSiteMemberInvitationDeliveryDependencies = {},
) {
  const repository = dependencies.repository || getManagedSiteRepository()
  const durableOutbox = dependencies.durableOutbox ?? process.env.NODE_ENV !== 'test'
  const portalOrigin = resolveManagedSiteReaccessOrigin({ portalOrigin: dependencies.portalOrigin, nodeEnv: dependencies.nodeEnv })
  const project = await repository.findProject(ownerUserId, projectId)
  const siteLabel = project?.canonicalClientIdentity || project?.canonicalWebsiteIdentity || `網站專案 #${projectId}`
  let transport: ManagedSiteEmailTransport | null = dependencies.emailTransport || null
  if (!transport) {
    try { transport = managedSiteEmailTransportFromEnv() } catch { transport = null }
  }
  let itemId: string | null = null
  const canQueue = durableOutbox && Boolean(portalOrigin && transport?.configured && process.env.NUXT_MANAGED_SITE_EMAIL_OUTBOX_ENCRYPTION_KEY)
  const result = await inviteManagedSiteMember(ownerUserId, projectId, actor, input, repository, canQueue
    ? async ({ invitation, membership, rawToken, outboxRepository }: { invitation: any; membership: any; rawToken: string; outboxRepository: ManagedSiteEmailOutboxRepository }) => {
        if (invitation.role === 'owner' || membership.role === 'owner') throw createError({ statusCode: 500, statusMessage: 'Managed-site member invitation role is invalid.' })
        const invitationUrl = `${portalOrigin}${invitationPath(rawToken)}`
        const message = composeInvitationEmail({ siteLabel, role: invitation.role as Exclude<ManagedSiteRole, 'owner'>, invitationUrl, reaccessUrl: `${portalOrigin}${MANAGED_SITE_REACCESS_PATH}`, expiresAt: invitation.expiresAt })
        const idempotencyKey = stableFingerprint({ scope: 'managed-site-member-invitation-delivery-v1', ownerUserId, projectId, invitationId: invitation.id })
        const stored = await createManagedSiteEmailOutboxRuntime(outboxRepository).enqueueOnly({
          idempotencyKey,
          context: { purpose: 'member_invitation', ownerUserId, projectId, authority: { invitationId: invitation.id, tokenHash: invitation.tokenHash }, expiresAt: invitation.expiresAt },
          message: { to: invitation.recipientEmail, ...message },
        })
        if (!stored.itemId || (!stored.accepted && stored.status !== 'queued')) throw createError({ statusCode: 503, statusMessage: 'Managed-site email outbox is not configured.' })
        itemId = stored.itemId
      }
    : undefined)
  const reaccessPath = MANAGED_SITE_REACCESS_PATH

  if (!result.invitationToken) {
    return {
      ...result,
      invitationToken: null,
      invitationUrl: null,
      reaccessPath,
      delivery: { status: 'already_pending' as const },
    }
  }

  const path = invitationPath(result.invitationToken)
  const manualUrl = portalOrigin ? `${portalOrigin}${path}` : path

  if (!portalOrigin || !transport?.configured || (durableOutbox && !itemId)) {
    return {
      ...result,
      invitationUrl: manualUrl,
      reaccessPath,
      delivery: {
        status: 'manual_required' as const,
        missing: !portalOrigin ? 'portal_origin' as const : 'email_transport' as const,
      },
    }
  }

  const invitationUrl = `${portalOrigin}${path}`
  if (result.invitation.role === 'owner') throw createError({ statusCode: 500, statusMessage: 'Managed-site member invitation role is invalid.' })
  const message = composeInvitationEmail({
    siteLabel,
    role: result.invitation.role,
    invitationUrl,
    reaccessUrl: `${portalOrigin}${MANAGED_SITE_REACCESS_PATH}`,
    expiresAt: result.invitation.expiresAt,
  })

  try {
    if (durableOutbox && itemId) {
      const delivery = await attemptManagedSiteEmailOutboxItem(itemId)
      if (!delivery.accepted) return { ...result, invitationUrl: manualUrl, reaccessPath, delivery: { status: 'delivery_failed' as const } }
      return { ...result, invitationToken: null, invitationUrl: null, reaccessPath, delivery: { status: 'sent' as const } }
    }
    await transport.send({
      to: result.invitation.recipientEmail,
      subject: message.subject,
      text: message.text,
      idempotencyKey: stableFingerprint({
        scope: 'managed-site-member-invitation-delivery-v1',
        ownerUserId,
        projectId,
        invitationId: result.invitation.id,
      }),
    })
  } catch {
    return {
      ...result,
      invitationUrl: manualUrl,
      reaccessPath,
      delivery: { status: 'delivery_failed' as const },
    }
  }

  return {
    ...result,
    invitationToken: null,
    invitationUrl: null,
    reaccessPath,
    delivery: { status: 'sent' as const },
  }
}
