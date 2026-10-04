import type { weeklyContentConfigs, weeklyContentInvitations, weeklyContentBindings, weeklyContentReviewRequests, weeklyContentConsents, weeklyContentOutbox, weeklyContentWebhookInbox } from '../database/schema'
import type { ContentOperationClientRow, ContentOperationPublicationTargetRow, ContentOperationAutopilotPolicyRow } from '../content-operations/types'
export type WeeklyConfig = typeof weeklyContentConfigs.$inferSelect
export type LineBindingInvitation = typeof weeklyContentInvitations.$inferSelect
export type PrivateLineBinding = typeof weeklyContentBindings.$inferSelect
export type WeeklyReviewRequest = typeof weeklyContentReviewRequests.$inferSelect
export type WeeklyConsent = typeof weeklyContentConsents.$inferSelect
export type WeeklyOutbox = typeof weeklyContentOutbox.$inferSelect
export type WeeklyWebhookInbox = typeof weeklyContentWebhookInbox.$inferSelect
export type WeeklyDecision = 'approved' | 'changes_requested'
export type WeeklyDraft = { client: ContentOperationClientRow; entryId: number; entryStatus: string; jobId: number; draftId: number; draftVersion: number; contentType: string; language: string; title: string; body: string; contentHash: string; evidenceSnapshotHash: string; riskGateStatus: string; machineAuthorizationValid: boolean; target: ContentOperationPublicationTargetRow; policy: ContentOperationAutopilotPolicyRow | null }
export type WeeklyPublicReview = { requestId: string; title: string; body: string; status: WeeklyReviewRequest['status']; expiresAt: string; contentHash: string; canRespond: boolean }
export type WeeklyOwnerConfig = { clientId: number; status: WeeklyConfig['status']; publicationTargetId: number; cadenceDays: number; reviewTtlHours: number; lineBound: boolean; requireCustomerApproval: true; configurationFingerprint: string }
