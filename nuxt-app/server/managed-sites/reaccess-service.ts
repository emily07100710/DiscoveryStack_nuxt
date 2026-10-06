import { randomBytes } from 'node:crypto'
import type { ManagedSiteInvitation, ManagedSiteMembership, ManagedSiteProject } from '../database/schema'
import { resolveControlledOwnerDatabaseUserId } from '../audit/repository'
import { stableFingerprint } from '../seo-geo-core/repository'
import { normalizePublicSiteOrigin } from '../utils/publicCors'
import { managedSiteEmailTransportFromEnv, type ManagedSiteEmailTransport } from './contact-inbox/email-transport'
import { eventFingerprint, normalizeRecipientEmail, tokenHash } from './normalization'
import { getManagedSiteRepository } from './repository'
import {
  MANAGED_SITE_REACCESS_COOLDOWN_MS,
  MANAGED_SITE_REACCESS_MAX_PER_WINDOW,
  MANAGED_SITE_REACCESS_PATH,
  MANAGED_SITE_REACCESS_TTL_MS,
  MANAGED_SITE_REACCESS_WINDOW_MS,
  type ManagedSiteRepository,
} from './types'

/**
 * Customer self-serve re-access.
 *
 * The managed-site customer session lasts 8 hours. Before this, a paying customer
 * who came back the next day — or opened their site on a second device — had no way
 * back in on their own: the only door was an owner-issued invitation. This module is
 * that door, opened by the customer, without widening anyone's authority:
 *
 *   - It NEVER creates a membership. It only re-issues a link to an address that
 *     already holds an active membership, so it cannot grant access to a stranger.
 *   - It excludes `owner` memberships. Those rows are platform principals created by
 *     the server (their `principalEmail` is a synthetic principal string, not a
 *     customer mailbox), so they are not a self-serve identity.
 *   - It reuses the existing single-use invitation ledger and the existing accept
 *     path, so token handling, claiming and session minting stay in one place.
 *   - Every reply is identical. Whether the address has access, is throttled, or the
 *     platform is unconfigured, the caller sees the same acknowledgement, so this
 *     endpoint cannot be used to test which email addresses are customers.
 *
 * Owner-visible truth lives in the audit ledger and in the returned diagnostics,
 * never in the HTTP body.
 */

export { MANAGED_SITE_REACCESS_PATH } from './types'
const MAX_REACCESS_PROJECTS = 10

export type ManagedSiteReaccessDependencies = {
  repository?: ManagedSiteRepository
  emailTransport?: ManagedSiteEmailTransport
  clock?: () => Date
  resolveOwnerUserId?: () => Promise<number>
  /** Absolute origin the emailed link points at. Defaults to NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN. */
  portalOrigin?: string
  nodeEnv?: string
}

export type ManagedSiteReaccessDiagnostics =
  | { outcome: 'invalid_email' }
  | { outcome: 'not_configured', missing: 'portal_origin' | 'email_transport' }
  | { outcome: 'platform_unavailable' }
  | { outcome: 'no_active_membership' }
  | { outcome: 'throttled', retryAfterSeconds: number }
  | { outcome: 'delivery_failed', issued: number }
  | { outcome: 'sent', issued: number }

export type ManagedSiteReaccessResult = {
  /** Identical for every caller and every address. Safe to serialize. */
  acknowledged: true
  /**
   * Server-side only. MUST NOT reach an unauthenticated response body, header or
   * status code — it is what tells one email address apart from another.
   */
  diagnostics: ManagedSiteReaccessDiagnostics
}

function neutral(diagnostics: ManagedSiteReaccessDiagnostics): ManagedSiteReaccessResult {
  return { acknowledged: true, diagnostics }
}

function safeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 320) return null
  try {
    return normalizeRecipientEmail(raw)
  } catch {
    return null
  }
}

/** The link host must be configured, never taken from the request: a poisoned Host header would redirect the token. */
export function resolveManagedSiteReaccessOrigin(dependencies: ManagedSiteReaccessDependencies = {}): string {
  const configured = dependencies.portalOrigin ?? process.env.NUXT_DISCOVERYSTACK_PRIVATE_ORIGIN ?? ''
  return normalizePublicSiteOrigin(configured, dependencies.nodeEnv || process.env.NODE_ENV || 'production')
}

/**
 * Building the transport validates the configured provider endpoint and throws when
 * it is not allowlisted. A misconfigured server is "not configured", not a crash.
 */
function resolveTransport(dependencies: ManagedSiteReaccessDependencies): ManagedSiteEmailTransport | null {
  // `configured` is checked on both branches on purpose. An unconfigured transport
  // still exposes send(), and calling it would turn a missing setting into a
  // delivery failure — which revokes rows and reads to the owner as a provider
  // outage instead of the configuration gap it actually is.
  if (dependencies.emailTransport) return dependencies.emailTransport.configured ? dependencies.emailTransport : null
  try {
    const transport = managedSiteEmailTransportFromEnv()
    return transport.configured ? transport : null
  } catch {
    return null
  }
}

/** True when a re-access request could actually be delivered. Global configuration only — never per address. */
export function managedSiteReaccessConfiguration(dependencies: ManagedSiteReaccessDependencies = {}) {
  const portalOrigin = resolveManagedSiteReaccessOrigin(dependencies)
  const transport = resolveTransport(dependencies)
  const emailConfigured = Boolean(transport?.configured)
  return { portalOrigin, emailConfigured, ready: Boolean(portalOrigin) && emailConfigured }
}

function reaccessLink(portalOrigin: string, rawToken: string): string {
  return `${portalOrigin}${MANAGED_SITE_REACCESS_PATH}?token=${encodeURIComponent(rawToken)}`
}

function siteLabel(project: ManagedSiteProject): string {
  return project.canonicalWebsiteIdentity || project.canonicalClientIdentity || `#${project.id}`
}

function composeReaccessEmail(links: Array<{ project: ManagedSiteProject, url: string }>) {
  const lines = links.map(link => `・${siteLabel(link.project)}\n  ${link.url}`).join('\n\n')
  const heading = links.length > 1 ? '這是您名下網站的管理連結：' : '這是您的網站管理連結：'
  return {
    subject: '重新進入您的網站管理後台',
    text: [
      '您好，',
      '',
      heading,
      '',
      lines,
      '',
      '連結 30 分鐘內有效，而且只能使用一次。',
      '如果這不是您本人要求的，請直接忽略這封信；沒有人會因此進入您的網站，您的網站也不會有任何變動。',
    ].join('\n'),
  }
}

/**
 * Throttle on the invitation ledger itself, so the limit survives restarts and is
 * shared by every server instance. Revoked rows do not count: a send that failed
 * revokes what it created, and must not lock the customer out of retrying.
 */
function evaluateThrottle(history: ManagedSiteInvitation[], at: Date): { throttled: boolean, retryAfterSeconds: number } {
  const issued = history
    .filter(row => row.status !== 'revoked' && row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime()))
    .map(row => row.createdAt.getTime())
    .sort((left, right) => right - left)
  if (!issued.length) return { throttled: false, retryAfterSeconds: 0 }
  const nowMs = at.getTime()
  const sinceLatest = nowMs - issued[0]!
  if (sinceLatest < MANAGED_SITE_REACCESS_COOLDOWN_MS) {
    return { throttled: true, retryAfterSeconds: Math.max(1, Math.ceil((MANAGED_SITE_REACCESS_COOLDOWN_MS - sinceLatest) / 1000)) }
  }
  const inWindow = issued.filter(time => nowMs - time < MANAGED_SITE_REACCESS_WINDOW_MS)
  if (inWindow.length >= MANAGED_SITE_REACCESS_MAX_PER_WINDOW) {
    const oldest = inWindow[inWindow.length - 1]!
    return { throttled: true, retryAfterSeconds: Math.max(1, Math.ceil((MANAGED_SITE_REACCESS_WINDOW_MS - (nowMs - oldest)) / 1000)) }
  }
  return { throttled: false, retryAfterSeconds: 0 }
}

async function recordReaccessAudit(repository: ManagedSiteRepository, input: {
  ownerUserId: number
  projectId: number
  membership: ManagedSiteMembership
  invitationId: number
  recipientFingerprint: string
  expiresAt: Date
  action: 'managed_site_reaccess_link_issued' | 'managed_site_reaccess_link_voided'
}) {
  const idempotencyKey = `${input.action}:${input.invitationId}`
  const afterFingerprint = stableFingerprint({ invitationId: input.invitationId, membershipId: input.membership.id, action: input.action })
  await repository.insertAuditEvent({
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    actorUserId: input.membership.userId,
    authority: 'customer_session',
    action: input.action,
    beforeFingerprint: null,
    afterFingerprint,
    eventFingerprint: eventFingerprint(input.ownerUserId, input.projectId, input.action, idempotencyKey, null, afterFingerprint),
    // The raw address is deliberately absent: the ledger keeps a fingerprint only.
    metadata: {
      invitationId: input.invitationId,
      membershipId: input.membership.id,
      role: input.membership.role,
      recipientFingerprint: input.recipientFingerprint,
      expiresAt: input.expiresAt.toISOString(),
    },
  } as any)
}

export async function requestManagedSiteReaccess(rawEmail: unknown, dependencies: ManagedSiteReaccessDependencies = {}): Promise<ManagedSiteReaccessResult> {
  const clock = dependencies.clock || (() => new Date())
  const email = safeEmail(rawEmail)
  if (!email) return neutral({ outcome: 'invalid_email' })

  const portalOrigin = resolveManagedSiteReaccessOrigin(dependencies)
  if (!portalOrigin) return neutral({ outcome: 'not_configured', missing: 'portal_origin' })

  const transport = resolveTransport(dependencies)
  if (!transport) return neutral({ outcome: 'not_configured', missing: 'email_transport' })

  let repository: ManagedSiteRepository
  let ownerUserId: number
  let memberships: ManagedSiteMembership[]
  try {
    repository = dependencies.repository || getManagedSiteRepository()
    ownerUserId = dependencies.resolveOwnerUserId
      ? await dependencies.resolveOwnerUserId()
      : await resolveControlledOwnerDatabaseUserId(process.env.OWNER_OPEN_ID || '')
    memberships = (await repository.listActiveMembershipsByEmail(ownerUserId, email))
      .filter(row => row.status === 'active' && row.role !== 'owner')
      .slice(0, MAX_REACCESS_PROJECTS)
  } catch {
    // Never let an infrastructure failure become an oracle: answer exactly as if
    // the address had no access.
    return neutral({ outcome: 'platform_unavailable' })
  }
  if (!memberships.length) return neutral({ outcome: 'no_active_membership' })

  const recipientFingerprint = stableFingerprint({ recipientEmail: email })
  const issuedAt = clock()
  const expiresAt = new Date(issuedAt.getTime() + MANAGED_SITE_REACCESS_TTL_MS)
  const created: Array<{ invitation: ManagedSiteInvitation, membership: ManagedSiteMembership }> = []
  const links: Array<{ project: ManagedSiteProject, url: string }> = []

  try {
    for (const membership of memberships) {
      const history = (await repository.listInvitations(ownerUserId, membership.projectId)).filter(row => row.recipientEmail === email)
      const throttle = evaluateThrottle(history, issuedAt)
      if (throttle.throttled) return neutral({ outcome: 'throttled', retryAfterSeconds: throttle.retryAfterSeconds })
    }

    for (const membership of memberships) {
      const project = await repository.findProject(ownerUserId, membership.projectId)
      if (!project) continue
      const rawToken = randomBytes(32).toString('base64url')
      const invitation = await repository.transaction(async transaction => {
        const row = await transaction.insertInvitation({
          ownerUserId,
          projectId: membership.projectId,
          membershipId: membership.id,
          recipientEmail: email,
          role: membership.role,
          tokenHash: tokenHash(rawToken),
          status: 'pending',
          expiresAt,
          acceptedAt: null,
          revokedAt: null,
          // Stamped from the service clock so the throttle window is decided by one
          // clock rather than by whichever database node inserted the row.
          createdAt: issuedAt,
        } as any)
        await recordReaccessAudit(transaction, { ownerUserId, projectId: membership.projectId, membership, invitationId: row.id, recipientFingerprint, expiresAt, action: 'managed_site_reaccess_link_issued' })
        return row
      })
      created.push({ invitation, membership })
      links.push({ project, url: reaccessLink(portalOrigin, rawToken) })
    }
  } catch {
    await voidIssuedInvitations(repository, ownerUserId, created, recipientFingerprint, expiresAt, clock)
    return neutral({ outcome: 'platform_unavailable' })
  }

  if (!links.length) return neutral({ outcome: 'no_active_membership' })

  const message = composeReaccessEmail(links)
  const deliveryFingerprint = stableFingerprint({ invitationIds: created.map(entry => entry.invitation.id).sort((left, right) => left - right) })
  try {
    await transport.send({
      to: email,
      subject: message.subject,
      text: message.text,
      idempotencyKey: `managed-site-reaccess:${deliveryFingerprint}`,
    })
  } catch {
    // The tokens are already live but unreachable. Void them so nothing usable is
    // left behind and so the customer is not throttled out of an immediate retry.
    await voidIssuedInvitations(repository, ownerUserId, created, recipientFingerprint, expiresAt, clock)
    return neutral({ outcome: 'delivery_failed', issued: created.length })
  }
  return neutral({ outcome: 'sent', issued: created.length })
}

async function voidIssuedInvitations(
  repository: ManagedSiteRepository,
  ownerUserId: number,
  created: Array<{ invitation: ManagedSiteInvitation, membership: ManagedSiteMembership }>,
  recipientFingerprint: string,
  expiresAt: Date,
  clock: () => Date,
) {
  for (const entry of created) {
    try {
      await repository.updateInvitation(ownerUserId, entry.invitation.id, { status: 'revoked', revokedAt: clock() } as any)
      await recordReaccessAudit(repository, {
        ownerUserId,
        projectId: entry.membership.projectId,
        membership: entry.membership,
        invitationId: entry.invitation.id,
        recipientFingerprint,
        expiresAt,
        action: 'managed_site_reaccess_link_voided',
      })
    } catch {
      // Best effort. An orphan row still expires on its own within 30 minutes.
    }
  }
}
