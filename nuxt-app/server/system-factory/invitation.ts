import { randomBytes } from 'node:crypto'
import { fingerprint, normalizeText, SystemFactoryError } from './canonical'

export type InvitationRecord = { invitationId: string; ownerId: string; tenantId: string; principalEmailHash: string; tokenHash: string; roleKey: string; status: 'pending' | 'accepted' | 'expired' | 'revoked'; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }

export function issueInvitation(input: { ownerId: string; tenantId: string; email: string; roleKey: string; healthyReceiptFingerprint: string; now?: Date; token?: string }): { record: InvitationRecord; token: string } {
  if (!/^[a-f0-9]{64}$/u.test(input.healthyReceiptFingerprint)) throw new SystemFactoryError('HEALTH_REQUIRED', 'Verified health receipt is required before an invitation.', 409)
  const email = normalizeText(input.email, 'Invitation email', 320).toLocaleLowerCase('en-US'); if (!/^\S+@\S+\.\S+$/u.test(email)) throw new SystemFactoryError('INVALID_EMAIL', 'Invitation email is invalid.')
  const token = input.token || randomBytes(32).toString('base64url'); if (token.length < 32 || token.length > 256) throw new SystemFactoryError('INVALID_TOKEN', 'Invitation token is invalid.')
  const now = input.now || new Date(); const principalEmailHash = fingerprint({ email }); const tokenHash = fingerprint({ token }); const invitationId = `system-invite-${fingerprint({ ownerId: input.ownerId, tenantId: input.tenantId, principalEmailHash, roleKey: input.roleKey }).slice(0, 24)}`
  return { token, record: { invitationId, ownerId: input.ownerId, tenantId: input.tenantId, principalEmailHash, tokenHash, roleKey: input.roleKey, status: 'pending', expiresAt: new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString(), acceptedAt: null, revokedAt: null } }
}

export function acceptInvitation(record: InvitationRecord, token: string, now = new Date()): InvitationRecord {
  if (record.status !== 'pending' || record.revokedAt || Date.parse(record.expiresAt) <= now.getTime() || fingerprint({ token }) !== record.tokenHash) throw new SystemFactoryError('INVITATION_INVALID', 'System invitation is invalid or expired.', 404)
  return { ...record, status: 'accepted', acceptedAt: now.toISOString() }
}

export function revokeInvitation(record: InvitationRecord, now = new Date()): InvitationRecord {
  if (record.status !== 'pending') throw new SystemFactoryError('INVITATION_TERMINAL', 'Only a pending invitation can be revoked.', 409)
  return { ...record, status: 'revoked', revokedAt: now.toISOString() }
}
