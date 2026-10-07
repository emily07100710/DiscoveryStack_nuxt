import type { ManagedSiteEmailOutboxSafeMetadata } from '../email-outbox/types'

export type EmailManualReviewReason = 'reviewed_no_resend' | 'handled_outside_platform'
export type EmailManualReviewSnapshot = Pick<ManagedSiteEmailOutboxSafeMetadata, 'id' | 'purpose' | 'status' | 'updatedAt' | 'expiresAt' | 'attemptCount' | 'lastErrorCode'>
export type EmailManualReviewCommand = { itemId: string; expectedVersion: string; requestId: string; reason: EmailManualReviewReason; confirmNoResend: true }
export type EmailManualReviewRecord = { outboxId: string; ownerUserId: number; requestId: string; outboxVersion: string; reason: EmailManualReviewReason; closedAt: Date }
export type EmailManualReviewProjection = {
  manualReviewStatus: 'not_required' | 'disabled' | 'open' | 'closed_no_resend'
  manualReviewVersion: string | null
  manualReviewReason: EmailManualReviewReason | null
  manualReviewClosedAt: string | null
}
export type EmailManualReviewCloseResult =
  | { status: 'recorded' | 'replayed'; record: EmailManualReviewRecord }
  | { status: 'not_found' | 'not_eligible' | 'conflict' }

export interface EmailManualReviewRepository {
  close(input: { ownerUserId: number; command: EmailManualReviewCommand; closedAt: Date }): Promise<EmailManualReviewCloseResult>
  listOwnerReviews(input: { ownerUserId: number; outboxIds: string[] }): Promise<EmailManualReviewRecord[]>
}
