import type { ManagedSiteEmailTransport } from '../contact-inbox/email-transport'

export type ManagedSiteEmailPurpose = 'inbox_verification' | 'customer_reaccess' | 'member_invitation' | 'contact_form_forward' | 'workspace_ready'

export type ManagedSiteEmailOutboxContext =
  | { purpose: 'inbox_verification'; ownerUserId: null; projectId: number | null; authority: { funnelSessionId: number; bindingId: number; codeHash: string }; expiresAt: Date }
  | { purpose: 'customer_reaccess'; ownerUserId: number; projectId: null; authority: { bindings: Array<{ projectId: number; invitationId: number; membershipId: number; tokenHash: string }> }; expiresAt: Date }
  | { purpose: 'member_invitation'; ownerUserId: number; projectId: number; authority: { invitationId: number; tokenHash: string }; expiresAt: Date }
  | { purpose: 'contact_form_forward'; ownerUserId: number; projectId: number; authority: { submissionId: number; bindingId: number; dedupeKey: string }; expiresAt: Date }
  | { purpose: 'workspace_ready'; ownerUserId: number; projectId: number; authority: { releaseId: number; draftOrderId: number; membershipId: number; paymentReceiptFingerprint: string; workspaceReceiptFingerprint: string; productionReceiptFingerprint: string; requestFingerprint: string }; expiresAt: Date }

export type ManagedSiteEmailMessage = { to: string; subject: string; text: string; replyTo?: string; idempotencyKey: string }
export type ManagedSiteEmailSafeCode = 'outbox_disabled' | 'outbox_unconfigured' | 'authority_stale' | 'outbox_expired' | 'outbox_collision' | 'outbox_busy' | 'provider_unavailable' | 'retry_window_expired' | 'attempt_limit' | 'outbox_storage_unavailable' | 'invalid_input'
export type ManagedSiteEmailOutboxResult =
  | { accepted: true; itemId: string; receiptId: string }
  | { accepted: false; itemId: string | null; status: 'queued' | 'manual_required' | 'cancelled'; code: ManagedSiteEmailSafeCode }

export type ManagedSiteEmailOutboxItem = {
  id: string; ownerUserId: number | null; projectId: number | null; purpose: ManagedSiteEmailPurpose; idempotencyKey: string
  authorityFingerprint: string; payloadFingerprint: string; contextFingerprint: string; providerConfigurationFingerprint: string
  encryptedPayload: string | null; status: 'queued' | 'processing' | 'reconcile_pending' | 'accepted' | 'cancelled' | 'manual_required'
  attemptCount: number; firstAttemptAt: Date | null; nextAttemptAt: Date; expiresAt: Date; leaseToken: string | null
  leaseExpiresAt: Date | null; safeCode: ManagedSiteEmailSafeCode | null; providerReceiptId: string | null; acceptedAt: Date | null
  createdAt: Date; updatedAt: Date
}
export type ManagedSiteEmailOutboxSafeMetadata = Pick<ManagedSiteEmailOutboxItem, 'id' | 'purpose' | 'status' | 'createdAt' | 'updatedAt' | 'nextAttemptAt' | 'attemptCount' | 'expiresAt' | 'payloadFingerprint' | 'providerConfigurationFingerprint'> & { lastErrorCode: ManagedSiteEmailSafeCode | null }
export type ManagedSiteEmailOutboxClaim = { item: ManagedSiteEmailOutboxItem; leaseToken: string }
export type ManagedSiteEmailOutboxInsert = Pick<ManagedSiteEmailOutboxItem, 'id' | 'ownerUserId' | 'projectId' | 'purpose' | 'idempotencyKey' | 'authorityFingerprint' | 'payloadFingerprint' | 'contextFingerprint' | 'providerConfigurationFingerprint' | 'encryptedPayload' | 'nextAttemptAt' | 'expiresAt'>

/** All transitions compare the current lease token. Implementations must persist state in shared MySQL/TiDB storage. */
export interface ManagedSiteEmailOutboxRepository {
  insertOrGet(input: ManagedSiteEmailOutboxInsert): Promise<ManagedSiteEmailOutboxItem>
  getById(id: string): Promise<ManagedSiteEmailOutboxItem | null>
  listSafeMetadata(input: { ownerUserId: number; projectId?: number; limit: number }): Promise<ManagedSiteEmailOutboxSafeMetadata[]>
  cancelExpired(input: { now: Date; limit: number }): Promise<number>
  claimOne(input: { now: Date; leaseToken: string; leaseExpiresAt: Date; maxAttempts: number; id?: string }): Promise<ManagedSiteEmailOutboxClaim | null>
  beginAttempt(input: { id: string; leaseToken: string; now: Date }): Promise<ManagedSiteEmailOutboxItem | null>
  renew(input: { id: string; leaseToken: string; now: Date; leaseExpiresAt: Date }): Promise<boolean>
  accepted(input: { id: string; leaseToken: string; now: Date; providerReceiptId: string }): Promise<boolean>
  reconciliationComplete(input: { id: string; leaseToken: string; now: Date }): Promise<boolean>
  retry(input: { id: string; leaseToken: string; now: Date; nextAttemptAt: Date; safeCode: ManagedSiteEmailSafeCode }): Promise<boolean>
  finish(input: { id: string; leaseToken: string; status: 'cancelled' | 'manual_required'; now: Date; safeCode: ManagedSiteEmailSafeCode }): Promise<boolean>
}

export type ManagedSiteEmailAuthorityResolution = { current: boolean; afterAccept?: (receiptId: string) => Promise<void> }
export type ManagedSiteEmailAuthorityResolver = (context: ManagedSiteEmailOutboxContext, message: ManagedSiteEmailMessage) => Promise<ManagedSiteEmailAuthorityResolution>
export type ManagedSiteEmailOutboxServiceDependencies = {
  repository: ManagedSiteEmailOutboxRepository
  encryptionSecret: string | undefined
  providerConfigurationFingerprint: string
  transport: ManagedSiteEmailTransport
  resolveAuthority: ManagedSiteEmailAuthorityResolver
  clock?: () => Date
  executionEnabled?: boolean
}
