import type {
  ApprovedPublicationInput,
  DeliveryAttemptRecord,
  DeliveryPlanInput,
  DeliveryTargetInput,
} from '../../../server/delivery-automation/types'

export const FIXTURE_NOW = '2026-08-24T00:00:00.000Z'
export const FIXTURE_ORIGIN = 'https://target.example.com'
export const FIXTURE_HASH = 'a'.repeat(64)
export const FIXTURE_HASH_B = 'b'.repeat(64)
export const FIXTURE_KEY = 'c'.repeat(64)

export function makeTarget(overrides: Partial<DeliveryTargetInput> = {}): DeliveryTargetInput {
  return {
    targetId: 'target-1',
    ownerScopeKey: 'owner-1',
    adapter: 'wordpress_rest',
    targetOrigin: FIXTURE_ORIGIN,
    endpointPath: '/wp-json/wp/v2/posts',
    status: 'active',
    serverCredentialConfigured: true,
    allowedContentTypes: ['article/markdown', 'text/markdown'],
    allowedLanguages: ['en', 'zh-Hant'],
    maximumPayloadBytes: 100_000,
    policyVersion: 'delivery-policy-v1',
    ...overrides,
  }
}

export function makePublication(overrides: Partial<ApprovedPublicationInput> = {}): ApprovedPublicationInput {
  return {
    ownerScopeKey: 'owner-1',
    scheduleEntryId: 'schedule-1',
    productionPlanId: 'plan-1',
    jobId: 'job-1',
    draftId: 'draft-1',
    draftVersion: 1,
    draftStage: 'optimized',
    reviewId: 'review-1',
    reviewDecision: 'approved_for_delivery',
    riskGateStatus: 'passed',
    evidenceSnapshotHash: FIXTURE_HASH,
    contentHash: FIXTURE_HASH_B,
    contentType: 'article/markdown',
    language: 'en',
    contentByteLength: 4_096,
    scheduledAt: FIXTURE_NOW,
    scheduleKey: '2026-08-24T00:00:00.000Z:article-1',
    ...overrides,
  }
}

export function makeAttempt(overrides: Partial<DeliveryAttemptRecord> = {}): DeliveryAttemptRecord {
  return {
    attemptNumber: 1,
    state: 'dispatch_planned',
    occurredAt: FIXTURE_NOW,
    idempotencyKey: FIXTURE_KEY,
    ...overrides,
  }
}

export function makePlanInput(overrides: Partial<DeliveryPlanInput> = {}): DeliveryPlanInput {
  return {
    target: makeTarget(),
    publication: makePublication(),
    now: FIXTURE_NOW,
    ...overrides,
  }
}
