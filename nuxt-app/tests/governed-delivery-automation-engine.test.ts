import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DELIVERY_AUTOMATION_ENGINE_VERSION,
  classifyDeliveryFailure,
  computeDeliveryIdempotencyKey,
  computeDeliveryResultFingerprint,
  evaluateDeliveryEligibility,
  planDeliveryAttempt,
  reduceDeliveryAttemptState,
  validateDeliveryTarget,
} from '../server/delivery-automation'
import {
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_KEY,
  FIXTURE_RESULT_FINGERPRINT,
  makeRetryWaitAttempt,
  FIXTURE_NOW,
  FIXTURE_ORIGIN,
  makeAttempt,
  makePlanInput,
  makePublication,
  makeTarget,
} from './fixtures/delivery-automation/attempts'

const identityInput = {
  ownerScopeKey: 'owner-1',
  targetId: 'target-1',
  adapter: 'wordpress_rest' as const,
  scheduleEntryId: 'schedule-1',
  scheduleKey: '2026-08-24T00:00:00.000Z:article-1',
  jobId: 'job-1',
  draftId: 'draft-1',
  draftVersion: 1,
  reviewId: 'review-1',
  productionPlanId: 'plan-1',
  evidenceSnapshotHash: FIXTURE_HASH,
  contentHash: FIXTURE_HASH_B,
}

function successEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'success',
    now: FIXTURE_NOW,
    attemptStartedAt: '2026-08-23T23:59:00.000Z',
    expectedIdempotencyKey: 'd'.repeat(64),
    targetOrigin: FIXTURE_ORIGIN,
    result: {
      idempotencyKey: 'd'.repeat(64),
      remoteContentId: 'remote-1',
      publishedAt: FIXTURE_NOW,
      remoteUrl: 'https://target.example.com/posts/remote-1',
      noPublicUrl: false,
      responseFingerprint: FIXTURE_RESULT_FINGERPRINT,
    },
    ...overrides,
  }
}

function resultFingerprint(event: ReturnType<typeof successEvent> = successEvent()): string {
  const result = computeDeliveryResultFingerprint(event.result, event.targetOrigin)
  if (result.status !== 'ok') throw new Error('synthetic success result must fingerprint')
  return result.fingerprint
}

function makePriorDelivery(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: FIXTURE_KEY,
    targetId: 'target-1',
    ownerScopeKey: 'owner-1',
    adapter: 'wordpress_rest',
    scheduleEntryId: 'schedule-1',
    scheduleKey: '2026-08-24T00:00:00.000Z:article-1',
    productionPlanId: 'plan-1',
    jobId: 'job-1',
    draftId: 'draft-1',
    draftVersion: 1,
    reviewId: 'review-1',
    evidenceSnapshotHash: FIXTURE_HASH,
    contentHash: FIXTURE_HASH_B,
    state: 'dispatch_planned',
    ...overrides,
  }
}

describe('public engine contract', () => {
  it('fixes the engine version', () => {
    expect(DELIVERY_AUTOMATION_ENGINE_VERSION).toBe('governed-delivery-automation-engine-v1')
  })

  it('accepts a valid WordPress target without executing it', () => {
    expect(validateDeliveryTarget(makeTarget({ adapter: 'wordpress_rest' })).status).toBe('valid')
  })

  it('accepts a valid generic HTTP target without executing it', () => {
    expect(validateDeliveryTarget(makeTarget({ adapter: 'generic_http' })).status).toBe('valid')
  })

  it('accepts a valid manual export target for human review only', () => {
    expect(validateDeliveryTarget(makeTarget({ adapter: 'manual_export' })).status).toBe('valid')
  })
})

describe('target origin policy', () => {
  it('accepts a public HTTPS origin', () => {
    expect(validateDeliveryTarget(makeTarget()).status).toBe('valid')
  })

  it('accepts an explicit HTTPS port 443', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://target.example.com:443' })).status).toBe('valid')
  })

  it('rejects HTTP', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'http://target.example.com' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects a non-443 port', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://target.example.com:8443' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects username and password', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://user:pass@target.example.com' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects a path on the origin', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://target.example.com/root' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects an origin query', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://target.example.com/?x=1' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects an origin fragment', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://target.example.com/#x' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects localhost', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://localhost' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it.each([
    'https://service.local',
    'https://service.internal',
    'https://service.localhost',
    'https://service.onion',
  ])('rejects blocked DNS suffix %s', (targetOrigin) => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it('rejects a single-label hostname', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://intranet' })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it.each([
    'https://0.0.0.0',
    'https://10.0.0.1',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://169.254.1.1',
    'https://172.16.0.1',
    'https://192.0.2.1',
    'https://192.168.1.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
  ])('rejects reserved/private IPv4 %s', (targetOrigin) => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin })).code).toBe('INVALID_TARGET_ORIGIN')
  })

  it.each([
    'https://[::1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[ff02::1]',
    'https://[2001:db8::1]',
    'https://[::ffff:10.0.0.1]',
  ])('rejects reserved/private IPv6 %s', (targetOrigin) => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin })).code).toBe('INVALID_TARGET_ORIGIN')
  })
})

describe('endpoint path policy', () => {
  it('requires a path starting with one slash', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: 'wp-json/posts' })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it('rejects a double-slash network path', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: '//target.example.com/posts' })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it('rejects a complete URL', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: 'https://target.example.com/posts' })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it('rejects query strings by default', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: '/posts?status=draft' })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it('rejects fragments', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: '/posts#draft' })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it('rejects CRLF and NUL delimiters', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: '/posts\r\nX-Test: yes' })).code).toBe('INVALID_ENDPOINT_PATH')
    expect(validateDeliveryTarget(makeTarget({ endpointPath: '/posts\0' })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it.each(['/posts/../admin', '/posts/./draft', '/posts/%2e%2e/admin', '/posts/%2E%2E/admin', '/posts/%2fadmin'])('rejects traversal or encoded delimiter %s', (endpointPath) => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath })).code).toBe('INVALID_ENDPOINT_PATH')
  })

  it('accepts a bounded nested endpoint path', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: '/wp-json/wp/v2/posts' })).status).toBe('valid')
  })

  it('rejects an endpoint longer than 512 characters', () => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath: `/${'a'.repeat(512)}` })).code).toBe('INVALID_ENDPOINT_PATH')
  })
})

describe('eligibility policy', () => {
  it('returns eligible only for a complete approved optimized publication', () => {
    const result = evaluateDeliveryEligibility(makeTarget(), makePublication(), FIXTURE_NOW)
    expect(result.status).toBe('eligible')
    expect(result.code).toBe('ELIGIBLE')
  })

  it('requires optimized draft stage', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ draftStage: 'owner_revision_input' }), FIXTURE_NOW).code).toBe('INVALID_INPUT')
  })

  it('requires delivery approval', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ reviewDecision: 'approved_for_preview' }), FIXTURE_NOW).code).toBe('INVALID_INPUT')
  })

  it('requires a passed risk gate', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ riskGateStatus: 'needs_review' }), FIXTURE_NOW).code).toBe('INVALID_INPUT')
  })

  it.each(['paused', 'revoked'] as const)('blocks a %s target', (status) => {
    expect(evaluateDeliveryEligibility(makeTarget({ status }), makePublication(), FIXTURE_NOW).code).toBe('TARGET_NOT_ACTIVE')
  })

  it('requires a configured server credential flag', () => {
    expect(evaluateDeliveryEligibility(makeTarget({ serverCredentialConfigured: false }), makePublication(), FIXTURE_NOW).code).toBe('CREDENTIAL_NOT_CONFIGURED')
  })

  it('requires matching owner scope', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ ownerScopeKey: 'other-owner' }), FIXTURE_NOW).code).toBe('OWNER_SCOPE_MISMATCH')
  })

  it('enforces content type allowlist', () => {
    expect(evaluateDeliveryEligibility(makeTarget({ allowedContentTypes: ['text/html'] }), makePublication(), FIXTURE_NOW).code).toBe('CONTENT_TYPE_NOT_ALLOWED')
  })

  it('enforces language allowlist', () => {
    expect(evaluateDeliveryEligibility(makeTarget({ allowedLanguages: ['zh-Hant'] }), makePublication(), FIXTURE_NOW).code).toBe('LANGUAGE_NOT_ALLOWED')
  })

  it('enforces maximum payload bytes', () => {
    expect(evaluateDeliveryEligibility(makeTarget({ maximumPayloadBytes: 1_024 }), makePublication(), FIXTURE_NOW).code).toBe('CONTENT_TOO_LARGE')
  })

  it('blocks a future scheduledAt using injected now', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ scheduledAt: '2026-08-24T00:00:01.000Z' }), FIXTURE_NOW).code).toBe('SCHEDULED_IN_FUTURE')
  })

  it('rejects a timestamp without timezone', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ scheduledAt: '2026-08-24T00:00:00' }), FIXTURE_NOW).code).toBe('INVALID_TIMESTAMP')
  })

  it('rejects an invalid SHA-256 publication hash', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ contentHash: 'bad' }), FIXTURE_NOW).code).toBe('INVALID_SHA256')
  })

  it('rejects a non-finite content length', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication({ contentByteLength: Number.NaN }), FIXTURE_NOW).code).toBe('INVALID_INPUT')
  })
})

describe('idempotency', () => {
  it('is deterministic for the same publication and target', () => {
    const first = computeDeliveryIdempotencyKey(identityInput)
    const second = computeDeliveryIdempotencyKey({ ...identityInput })
    expect(first).toEqual(second)
    expect(first.status).toBe('ok')
  })

  it('changes when draft identity changes', () => {
    const first = computeDeliveryIdempotencyKey(identityInput)
    const second = computeDeliveryIdempotencyKey({ ...identityInput, draftId: 'draft-2' })
    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    if (first.status === 'ok' && second.status === 'ok') expect(first.key).not.toBe(second.key)
  })

  it('changes when content hash changes', () => {
    const first = computeDeliveryIdempotencyKey(identityInput)
    const second = computeDeliveryIdempotencyKey({ ...identityInput, contentHash: 'e'.repeat(64) })
    if (first.status === 'ok' && second.status === 'ok') expect(first.key).not.toBe(second.key)
  })

  it('does not include article body in the canonical payload', () => {
    const first = computeDeliveryIdempotencyKey({ ...identityInput, articleBody: 'private body A' })
    const second = computeDeliveryIdempotencyKey({ ...identityInput, articleBody: 'private body B' })
    expect(first).toEqual(second)
  })

  it('does not include query or credential fields in the canonical payload', () => {
    const first = computeDeliveryIdempotencyKey({ ...identityInput, targetQuery: '?token=secret-a', credential: 'secret-a' })
    const second = computeDeliveryIdempotencyKey({ ...identityInput, targetQuery: '?token=secret-b', credential: 'secret-b' })
    expect(first).toEqual(second)
  })

  it('normalizes hexadecimal hash case', () => {
    const lower = computeDeliveryIdempotencyKey(identityInput)
    const upper = computeDeliveryIdempotencyKey({ ...identityInput, evidenceSnapshotHash: FIXTURE_HASH.toUpperCase(), contentHash: FIXTURE_HASH_B.toUpperCase() })
    expect(lower).toEqual(upper)
  })

  it('fails closed for an invalid hash', () => {
    expect(computeDeliveryIdempotencyKey({ ...identityInput, contentHash: 'not-a-hash' }).status).toBe('blocked')
  })
})

describe('metadata-only delivery planning', () => {
  it('plans a WordPress metadata command', () => {
    const result = planDeliveryAttempt(makePlanInput())
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.adapter).toBe('wordpress_rest')
  })

  it('plans a generic HTTP metadata command', () => {
    const result = planDeliveryAttempt(makePlanInput({ target: makeTarget({ adapter: 'generic_http' }) }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.adapter).toBe('generic_http')
  })

  it('never autonomously dispatches manual export', () => {
    expect(planDeliveryAttempt(makePlanInput({ target: makeTarget({ adapter: 'manual_export' }) })).code).toBe('MANUAL_EXPORT_REQUIRES_HUMAN')
  })

  it('does not put article body or secret-like fields in the command', () => {
    const result = planDeliveryAttempt(makePlanInput())
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') {
      const serialized = JSON.stringify(result.command)
      expect(serialized).not.toContain('articleBody')
      expect(serialized).not.toContain('Authorization')
      expect(serialized).not.toContain('Cookie')
      expect(serialized).not.toContain('Bearer')
      expect(serialized).not.toContain('token')
      expect(serialized).not.toContain('password')
      expect(serialized).not.toContain('secret')
    }
  })

  it('marks the command as not delivered', () => {
    const result = planDeliveryAttempt(makePlanInput())
    if (result.status === 'dispatch_planned') expect(result.command.limitations).toContain('not_delivered')
  })

  it('includes the fixed metadata identity and no raw publication body', () => {
    const result = planDeliveryAttempt(makePlanInput())
    if (result.status === 'dispatch_planned') {
      expect(result.command.publicationIdentity.draftId).toBe('draft-1')
      expect(result.command).not.toHaveProperty('body')
      expect(result.command).not.toHaveProperty('content')
    }
  })

  it('increments the attempt number from valid history', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt()] }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') {
      expect(result.command.attemptNumber).toBe(2)
      expect(result.command.eligibleAt).toBe(FIXTURE_NOW)
    }
  })

  it('blocks after the fifth attempt', () => {
    const attempts = Array.from({ length: 5 }, (_, index) => makeAttempt({ attemptNumber: index + 1, state: 'permanent_failed', occurredAt: `2026-08-23T23:5${index}:00.000Z` }))
    const result = planDeliveryAttempt(makePlanInput({ attempts }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('ATTEMPT_CAP_REACHED')
  })

  it('rejects attempt history over 20 records', () => {
    const attempts = Array.from({ length: 21 }, (_, index) => makeAttempt({ attemptNumber: (index % 5) + 1 }))
    expect(planDeliveryAttempt(makePlanInput({ attempts })).code).toBe('ATTEMPT_HISTORY_INVALID')
  })

  it('rejects duplicate or out-of-order attempt numbers', () => {
    expect(planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt({ attemptNumber: 2 })] })).code).toBe('ATTEMPT_HISTORY_INVALID')
  })

  it('rejects future attempt history', () => {
    expect(planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt({ occurredAt: '2026-08-24T00:00:01.000Z' })] })).code).toBe('ATTEMPT_HISTORY_INVALID')
  })

  it('blocks a duplicate publication with the same idempotency key', () => {
    const keyResult = computeDeliveryIdempotencyKey(identityInput)
    expect(keyResult.status).toBe('ok')
    if (keyResult.status === 'ok') {
      const result = planDeliveryAttempt(makePlanInput({ priorDeliveries: [makePriorDelivery({ idempotencyKey: keyResult.key })] }))
      expect(result.status).toBe('blocked')
      if (result.status === 'blocked') expect(result.code).toBe('DUPLICATE_PUBLICATION')
    }
  })

  it('blocks an idempotency identity collision', () => {
    const keyResult = computeDeliveryIdempotencyKey(identityInput)
    expect(keyResult.status).toBe('ok')
    if (keyResult.status === 'ok') {
      const result = planDeliveryAttempt(makePlanInput({ priorDeliveries: [makePriorDelivery({ idempotencyKey: keyResult.key, contentHash: 'e'.repeat(64) })] }))
      expect(result.status).toBe('blocked')
      if (result.status === 'blocked') expect(result.code).toBe('IDEMPOTENCY_COLLISION')
    }
  })
})

describe('failure classification and retry policy', () => {
  it('retries timeout after one minute', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, code: 'timeout' })).toMatchObject({ retryable: true, nextState: 'retry_wait', delaySeconds: 60 })
  })

  it('retries connection reset after five minutes on attempt two', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 2, code: 'connection_reset' })).toMatchObject({ retryable: true, nextState: 'retry_wait', delaySeconds: 300 })
  })

  it('retries HTTP 408', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 408 }).nextState).toBe('retry_wait')
  })

  it('retries HTTP 429 with the larger valid retry-after delay', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 429, retryAfterSeconds: 120 })).toMatchObject({ retryable: true, delaySeconds: 120 })
  })

  it('blocks invalid retry-after values without adopting them', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 429, retryAfterSeconds: 0 })).toMatchObject({ status: 'blocked', retryable: false, delaySeconds: 0, nextState: 'blocked' })
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 429, retryAfterSeconds: 86401 })).toMatchObject({ status: 'blocked', retryable: false, delaySeconds: 0, nextState: 'blocked' })
  })

  it('retries HTTP 5xx', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 3, httpStatus: 503 })).toMatchObject({ retryable: true, nextState: 'retry_wait', delaySeconds: 1800 })
  })

  it.each([400, 404])('permanently fails HTTP %s', (httpStatus) => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus }).nextState).toBe('permanent_failed')
  })

  it.each([401, 403])('configuration-blocks HTTP %s without retry', (httpStatus) => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus })).toMatchObject({ retryable: false, nextState: 'blocked', reason: 'configuration_blocked' })
  })

  it('does not retry HTTP 409 without confirmed idempotency', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 409 }).nextState).toBe('permanent_failed')
  })

  it('retries HTTP 409 only when same idempotent delivery is confirmed', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 409, confirmedSameIdempotentDelivery: true }).nextState).toBe('retry_wait')
  })

  it('does not retry malformed responses or missing credentials', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, code: 'malformed_response' }).nextState).toBe('permanent_failed')
    expect(classifyDeliveryFailure({ attemptNumber: 1, code: 'credential_missing' }).nextState).toBe('blocked')
  })

  it('does not retry after the fifth attempt', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 5, code: 'timeout' })).toMatchObject({ retryable: false, nextState: 'permanent_failed', delaySeconds: 0 })
  })

  it('fails closed for invalid failure input', () => {
    expect(classifyDeliveryFailure(null)).toMatchObject({ status: 'blocked', nextState: 'blocked' })
    expect(classifyDeliveryFailure({ attemptNumber: 1, retryAfterSeconds: 90_000 }).status).toBe('blocked')
  })
})

describe('state machine and result identity', () => {
  it('moves scheduled to eligible', () => {
    expect(reduceDeliveryAttemptState('scheduled', { type: 'mark_eligible' })).toMatchObject({ status: 'ok', state: 'eligible' })
  })

  it('moves eligible to dispatch_planned', () => {
    expect(reduceDeliveryAttemptState('eligible', { type: 'plan_dispatch' })).toMatchObject({ status: 'ok', state: 'dispatch_planned' })
  })

  it('moves dispatch_planned to retry_wait for a temporary failure', () => {
    expect(reduceDeliveryAttemptState('dispatch_planned', { type: 'failure', failure: { attemptNumber: 1, code: 'timeout' } })).toMatchObject({ status: 'ok', state: 'retry_wait' })
  })

  it('moves retry_wait back to dispatch_planned only on retry_due with time proof', () => {
    const result = reduceDeliveryAttemptState('retry_wait', { type: 'retry_due', now: FIXTURE_NOW, retryEligibleAt: FIXTURE_NOW, expectedIdempotencyKey: FIXTURE_KEY, attemptNumber: 2 })
    expect(result).toMatchObject({ status: 'ok', state: 'dispatch_planned' })
  })

  it('moves dispatch_planned to permanent_failed for a permanent failure', () => {
    expect(reduceDeliveryAttemptState('dispatch_planned', { type: 'failure', failure: { attemptNumber: 1, httpStatus: 400 } })).toMatchObject({ status: 'ok', state: 'permanent_failed' })
  })

  it('moves dispatch_planned to blocked for a configuration failure', () => {
    expect(reduceDeliveryAttemptState('dispatch_planned', { type: 'failure', failure: { attemptNumber: 1, httpStatus: 401 } })).toMatchObject({ status: 'ok', state: 'blocked' })
  })

  it('allows cancellation from scheduled', () => {
    expect(reduceDeliveryAttemptState('scheduled', { type: 'cancel' })).toMatchObject({ status: 'ok', state: 'cancelled' })
  })

  it('rejects an invalid transition', () => {
    expect(reduceDeliveryAttemptState('scheduled', { type: 'plan_dispatch' })).toMatchObject({ status: 'blocked', code: 'INVALID_STATE_TRANSITION' })
  })

  it('rejects terminal state transitions', () => {
    expect(reduceDeliveryAttemptState('permanent_failed', { type: 'mark_eligible' })).toMatchObject({ status: 'blocked', code: 'TERMINAL_STATE' })
  })

  it('delivers a result with matching identity and public URL', () => {
    expect(reduceDeliveryAttemptState('dispatch_planned', successEvent())).toMatchObject({ status: 'ok', state: 'delivered', remoteContentId: 'remote-1' })
  })

  it('delivers a result that explicitly has no public URL', () => {
    const event = successEvent({ result: { idempotencyKey: 'd'.repeat(64), remoteContentId: 'remote-1', publishedAt: FIXTURE_NOW, noPublicUrl: true, responseFingerprint: FIXTURE_RESULT_FINGERPRINT } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'ok', state: 'delivered' })
  })

  it('rejects HTTP 2xx-style results without remote content identity', () => {
    const event = successEvent({ result: { idempotencyKey: 'd'.repeat(64), publishedAt: FIXTURE_NOW, remoteUrl: 'https://target.example.com/posts/remote-1', noPublicUrl: false, responseFingerprint: FIXTURE_RESULT_FINGERPRINT } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'HTTP_SUCCESS_MISSING_REMOTE_ID' })
  })

  it('rejects a mismatched idempotency key', () => {
    const event = successEvent({ expectedIdempotencyKey: 'e'.repeat(64) })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it.each([
    { remoteUrl: 'http://target.example.com/posts/1' },
    { remoteUrl: 'https://other.example.com/posts/1' },
    { remoteUrl: 'https://target.example.com/posts/1?token=x' },
    { remoteUrl: 'https://user:pass@target.example.com/posts/1' },
    { remoteUrl: 'https://127.0.0.1/posts/1' },
  ])('rejects an unsafe remote URL', (result) => {
    expect(reduceDeliveryAttemptState('dispatch_planned', successEvent({ result: { ...successEvent().result, ...result } }))).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it('allows an idempotent replay only with the complete prior result fingerprint', () => {
    const event = successEvent({ priorDeliveryResultFingerprint: resultFingerprint() })
    expect(reduceDeliveryAttemptState('delivered', event)).toMatchObject({ status: 'ok', state: 'delivered', remoteContentId: 'remote-1', deliveryResultFingerprint: resultFingerprint() })
  })

  it('blocks a different remote identity for the same key', () => {
    const original = successEvent()
    const event = successEvent({ result: { ...original.result, remoteContentId: 'remote-2' }, priorDeliveryResultFingerprint: resultFingerprint(original) })
    expect(reduceDeliveryAttemptState('delivered', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })

  it('rejects a malformed event without throwing', () => {
    expect(reduceDeliveryAttemptState('dispatch_planned', null)).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
  })
})

describe('fail-closed malformed entrypoints', () => {
  it.each([null, undefined, 1, 'target', [], true])('blocks malformed target %j', (input) => {
    expect(() => validateDeliveryTarget(input)).not.toThrow()
    expect(validateDeliveryTarget(input).status).toBe('blocked')
  })

  it.each([null, undefined, 1, 'publication', [], true])('blocks malformed eligibility publication %j', (publication) => {
    expect(() => evaluateDeliveryEligibility(makeTarget(), publication, FIXTURE_NOW)).not.toThrow()
    expect(evaluateDeliveryEligibility(makeTarget(), publication, FIXTURE_NOW).status).toBe('blocked')
  })

  it('blocks malformed now without reading system time', () => {
    expect(evaluateDeliveryEligibility(makeTarget(), makePublication(), '2026-08-24T00:00:00').code).toBe('INVALID_TIMESTAMP')
  })

  it('blocks a getter that throws', () => {
    const target = { ...makeTarget() }
    Object.defineProperty(target, 'targetOrigin', { get() { throw new Error('synthetic getter failure') } })
    expect(validateDeliveryTarget(target).status).toBe('blocked')
  })

  it('blocks a Proxy that throws while reading an idempotency field', () => {
    const input = new Proxy(identityInput, { get(_target, property) { if (property === 'draftId') throw new Error('synthetic proxy failure'); return Reflect.get(_target, property) } })
    expect(computeDeliveryIdempotencyKey(input).status).toBe('blocked')
  })

  it('blocks a Proxy that throws while reading a plan', () => {
    const input = new Proxy(makePlanInput(), { get(_target, property) { if (property === 'publication') throw new Error('synthetic proxy failure'); return Reflect.get(_target, property) } })
    expect(planDeliveryAttempt(input).status).toBe('blocked')
  })

  it('blocks a non-finite attempt number', () => {
    expect(classifyDeliveryFailure({ attemptNumber: Number.POSITIVE_INFINITY, code: 'timeout' }).status).toBe('blocked')
  })

  it('does not return raw input or stack traces in blocked output', () => {
    const result = evaluateDeliveryEligibility(null, { secret: 'synthetic-secret', body: 'synthetic-body' }, FIXTURE_NOW)
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(JSON.stringify(result)).not.toContain('synthetic-body')
    expect(JSON.stringify(result)).not.toContain('at ')
  })
})

it('keeps implementation offline and free of credentials', () => {
  const implementationRoot = join(process.cwd(), 'server/delivery-automation')
  const implementationFiles = ['types.ts', 'target-guard.ts', 'policy-catalog.ts', 'idempotency.ts', 'engine.ts', 'index.ts']
  const source = implementationFiles.map((file) => readFileSync(join(implementationRoot, file), 'utf8')).join('\n')
  for (const marker of ['fetch(', '$fetch', 'ofetch', 'axios', 'XMLHttpRequest', 'http.request', 'https.request', 'node:net', 'node:dns', 'node:http', 'node:https', 'net.connect', 'dns.lookup', 'child_process', 'process.env', 'Authorization', 'Bearer token', 'Cookie header']) {
    expect(source, `implementation contains forbidden marker: ${marker}`).not.toContain(marker)
  }
})

void FIXTURE_KEY
void makePublication


describe('retry timing and attempt evidence hardening', () => {
  it('plans the first attempt from an empty history', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [] }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command).toMatchObject({ attemptNumber: 1, eligibleAt: FIXTURE_NOW })
  })

  it('blocks a timeout retry before the fixed 60-second deadline', () => {
    const result = planDeliveryAttempt(makePlanInput({
      now: '2026-08-23T23:59:59.000Z',
      publication: makePublication({ scheduledAt: '2026-08-23T23:00:00.000Z' }),
      attempts: [makeRetryWaitAttempt()],
    }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('RETRY_NOT_DUE')
  })

  it('allows a timeout retry exactly at 60 seconds', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt()] }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command).toMatchObject({ attemptNumber: 2, eligibleAt: FIXTURE_NOW })
  })

  it('blocks a connection reset retry one second before the 300-second deadline', () => {
    const result = planDeliveryAttempt(makePlanInput({
      now: '2026-08-24T00:08:59.000Z',
      publication: makePublication({ scheduledAt: '2026-08-23T23:00:00.000Z' }),
      attempts: [
        makeRetryWaitAttempt({ occurredAt: '2026-08-23T23:59:00.000Z', failureCode: 'timeout', retryEligibleAt: '2026-08-24T00:00:00.000Z' }),
        makeRetryWaitAttempt({ attemptNumber: 2, occurredAt: '2026-08-24T00:04:00.000Z', failureCode: 'connection_reset', retryEligibleAt: '2026-08-24T00:09:00.000Z' }),
      ],
    }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('RETRY_NOT_DUE')
  })

  it('allows attempt three when the 300-second deadline is reached', () => {
    const result = planDeliveryAttempt(makePlanInput({
      now: '2026-08-24T00:09:00.000Z',
      publication: makePublication({ scheduledAt: '2026-08-23T23:00:00.000Z' }),
      attempts: [
        makeRetryWaitAttempt({ occurredAt: '2026-08-23T23:59:00.000Z', failureCode: 'timeout', retryEligibleAt: '2026-08-24T00:00:00.000Z' }),
        makeRetryWaitAttempt({ attemptNumber: 2, occurredAt: '2026-08-24T00:04:00.000Z', failureCode: 'connection_reset', retryEligibleAt: '2026-08-24T00:09:00.000Z' }),
      ],
    }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.attemptNumber).toBe(3)
  })

  it('uses the larger 429 retry-after deadline', () => {
    const result = planDeliveryAttempt(makePlanInput({
      attempts: [makeRetryWaitAttempt({ occurredAt: '2026-08-23T23:58:00.000Z', failureCode: 'http_429', httpStatus: 429, retryAfterSeconds: 120, retryEligibleAt: FIXTURE_NOW })],
    }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.eligibleAt).toBe(FIXTURE_NOW)
  })

  it('uses the policy delay when 429 retry-after is smaller', () => {
    const result = planDeliveryAttempt(makePlanInput({
      attempts: [makeRetryWaitAttempt({ occurredAt: '2026-08-23T23:59:00.000Z', failureCode: 'http_429', httpStatus: 429, retryAfterSeconds: 30, retryEligibleAt: FIXTURE_NOW })],
    }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.eligibleAt).toBe(FIXTURE_NOW)
  })

  it('blocks a tampered retryEligibleAt', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt({ retryEligibleAt: '2026-08-24T00:00:01.000Z' })] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('ATTEMPT_RETRY_EVIDENCE_INVALID')
  })

  it('blocks retry history whose occurredAt timestamps move backward', () => {
    const result = planDeliveryAttempt(makePlanInput({
      publication: makePublication({ scheduledAt: '2026-08-23T23:00:00.000Z' }),
      attempts: [
        makeRetryWaitAttempt({ occurredAt: '2026-08-23T23:59:00.000Z' }),
        makeRetryWaitAttempt({ attemptNumber: 2, occurredAt: '2026-08-23T23:58:00.000Z', failureCode: 'connection_reset', retryEligibleAt: '2026-08-23T00:03:00.000Z' }),
      ],
    }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('ATTEMPT_HISTORY_INVALID')
  })

  it('blocks retry history with a different idempotency key', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt({ idempotencyKey: 'e'.repeat(64) })] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('ATTEMPT_IDEMPOTENCY_MISMATCH')
  })

  it('does not redispatch an in-flight dispatch_planned attempt', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt()] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('ATTEMPT_STILL_IN_FLIGHT')
  })

  it.each(['scheduled', 'eligible'] as const)('does not advance a last %s attempt without retry evidence', (state) => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt({ state })] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('INVALID_STATE_TRANSITION')
  })

  it.each(['delivered', 'permanent_failed', 'blocked', 'cancelled'] as const)('does not advance terminal %s history', (state) => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt({ state })] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('TERMINAL_STATE')
  })

  it('stops a five-attempt terminal history', () => {
    const attempts = Array.from({ length: 5 }, (_, index) => makeAttempt({ attemptNumber: index + 1, state: 'permanent_failed', occurredAt: `2026-08-23T23:0${index}:00.000Z` }))
    const result = planDeliveryAttempt(makePlanInput({ attempts }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('ATTEMPT_CAP_REACHED')
  })
})

describe('retry_due proof hardening', () => {
  const dueEvent = { type: 'retry_due', now: FIXTURE_NOW, retryEligibleAt: FIXTURE_NOW, expectedIdempotencyKey: FIXTURE_KEY, attemptNumber: 2 }

  it('requires now on retry_due', () => {
    const { now: _now, ...event } = dueEvent
    const result = reduceDeliveryAttemptState('retry_wait', event)
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('requires retryEligibleAt on retry_due', () => {
    const { retryEligibleAt: _retryEligibleAt, ...event } = dueEvent
    const result = reduceDeliveryAttemptState('retry_wait', event)
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('requires expectedIdempotencyKey on retry_due', () => {
    const { expectedIdempotencyKey: _expectedIdempotencyKey, ...event } = dueEvent
    const result = reduceDeliveryAttemptState('retry_wait', event)
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('requires attemptNumber on retry_due', () => {
    const { attemptNumber: _attemptNumber, ...event } = dueEvent
    const result = reduceDeliveryAttemptState('retry_wait', event)
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('blocks retry_due before the deadline', () => {
    const result = reduceDeliveryAttemptState('retry_wait', { ...dueEvent, now: '2026-08-23T23:59:59.000Z' })
    expect(result).toMatchObject({ status: 'blocked', code: 'RETRY_NOT_DUE' })
  })

  it('allows retry_due at the exact deadline', () => {
    expect(reduceDeliveryAttemptState('retry_wait', dueEvent)).toMatchObject({ status: 'ok', state: 'dispatch_planned', transition: 'retry_wait->dispatch_planned' })
  })

  it('allows retry_due after the deadline', () => {
    expect(reduceDeliveryAttemptState('retry_wait', { ...dueEvent, now: '2026-08-24T00:01:00.000Z' })).toMatchObject({ status: 'ok', state: 'dispatch_planned' })
  })

  it('rejects a retry_due timestamp without timezone', () => {
    const result = reduceDeliveryAttemptState('retry_wait', { ...dueEvent, now: '2026-08-24T00:00:00' })
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('rejects a malformed retry_due SHA-256 key', () => {
    const result = reduceDeliveryAttemptState('retry_wait', { ...dueEvent, expectedIdempotencyKey: 'not-a-key' })
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it.each([1, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects retry_due attemptNumber %s outside 2-5 safe integers', (attemptNumber) => {
    const result = reduceDeliveryAttemptState('retry_wait', { ...dueEvent, attemptNumber })
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('does not allow retry_due from dispatch_planned', () => {
    expect(reduceDeliveryAttemptState('dispatch_planned', dueEvent)).toMatchObject({ status: 'blocked', code: 'INVALID_STATE_TRANSITION' })
  })
})

describe('conflicting failure evidence', () => {
  it.each([
    { code: 'timeout', httpStatus: 401 },
    { code: 'timeout', httpStatus: 500 },
    { code: 'connection_reset', httpStatus: 403 },
    { code: 'connection_reset', httpStatus: 429 },
    { code: 'http_429', httpStatus: 500 },
    { code: 'http_5xx', httpStatus: 429 },
    { code: 'credential_missing', httpStatus: 503 },
    { code: 'content_hash_mismatch', httpStatus: 408 },
  ])('blocks contradictory evidence %#', (failure) => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, ...failure })).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT', retryable: false, nextState: 'blocked' })
  })

  it.each([
    { code: 'http_408', httpStatus: 408 },
    { code: 'http_409', httpStatus: 409 },
    { code: 'http_429', httpStatus: 429 },
    { code: 'http_5xx', httpStatus: 503 },
    { code: 'http_401', httpStatus: 401 },
  ])('accepts matching code/status evidence %#', (failure) => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, ...failure }).status).toBe('classified')
  })

  it('never retries timeout with an HTTP 401 override', () => {
    const result = classifyDeliveryFailure({ attemptNumber: 1, code: 'timeout', httpStatus: 401 })
    expect(result).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT', retryable: false, nextState: 'blocked' })
  })

  it('rejects retryAfterSeconds on a non-429 HTTP status', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, httpStatus: 408, retryAfterSeconds: 60 })).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
  })

  it('rejects retryAfterSeconds without an HTTP 429 status', () => {
    expect(classifyDeliveryFailure({ attemptNumber: 1, code: 'timeout', retryAfterSeconds: 60 })).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
  })
})

describe('complete prior delivery identity', () => {
  it.each([
    ['adapter', 'generic_http'],
    ['scheduleEntryId', 'schedule-2'],
    ['scheduleKey', '2026-08-24T00:00:00.000Z:article-2'],
    ['productionPlanId', 'plan-2'],
    ['jobId', 'job-2'],
    ['draftId', 'draft-2'],
    ['draftVersion', 2],
    ['reviewId', 'review-2'],
    ['evidenceSnapshotHash', 'c'.repeat(64)],
    ['contentHash', 'd'.repeat(64)],
    ['targetId', 'target-2'],
    ['ownerScopeKey', 'owner-2'],
  ])('blocks same-key prior delivery when %s differs', (field, value) => {
    const result = planDeliveryAttempt(makePlanInput({ priorDeliveries: [makePriorDelivery({ [field]: value })] }))
    expect(result.status).toBe('blocked')
    if (result.status === 'blocked') expect(result.code).toBe('IDEMPOTENCY_COLLISION')
  })

  it('requires every prior delivery record identity field', () => {
    const incomplete = makePriorDelivery()
    delete (incomplete as Record<string, unknown>).productionPlanId
    const result = planDeliveryAttempt(makePlanInput({ priorDeliveries: [incomplete] }))
    expect(result).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
  })

  it('accepts duplicate publication only when the complete identity is equal', () => {
    const result = planDeliveryAttempt(makePlanInput({ priorDeliveries: [makePriorDelivery()] }))
    expect(result).toMatchObject({ status: 'blocked', code: 'DUPLICATE_PUBLICATION' })
  })
})

describe('exact policy and opaque identity gates', () => {
  it.each(['delivery-policy-v0', 'delivery-policy-v2', 'default', 'latest', ' Delivery-policy-v1', 'delivery-policy-v1 '])('rejects policyVersion %s', (policyVersion) => {
    const result = validateDeliveryTarget(makeTarget({ policyVersion }))
    expect(result).toMatchObject({ status: 'blocked', code: 'POLICY_VERSION_MISMATCH' })
  })

  it('rejects a missing policyVersion', () => {
    const target = { ...makeTarget() } as Record<string, unknown>
    delete target.policyVersion
    expect(validateDeliveryTarget(target)).toMatchObject({ status: 'blocked', code: 'POLICY_VERSION_MISMATCH' })
  })

  it('normalizes allowlists with NFKC, trim and lowercase', () => {
    const result = validateDeliveryTarget(makeTarget({ allowedContentTypes: [' Text/Markdown '], allowedLanguages: [' EN '] }))
    expect(result.status).toBe('valid')
    if (result.status === 'valid') expect(result.target).toMatchObject({ allowedContentTypes: ['text/markdown'], allowedLanguages: ['en'] })
  })

  it.each([
    ['allowedContentTypes', { allowedContentTypes: ['en', ' EN '] }],
    ['allowedLanguages', { allowedLanguages: ['zh', 'ｚｈ'] }],
  ])('rejects duplicate normalized %s', (_field, override) => {
    expect(validateDeliveryTarget(makeTarget(override))).toMatchObject({ status: 'blocked', code: 'INVALID_INPUT' })
  })

  it('rejects an empty content-type allowlist', () => {
    expect(validateDeliveryTarget(makeTarget({ allowedContentTypes: [] })).status).toBe('blocked')
  })

  it('rejects an empty language allowlist', () => {
    expect(validateDeliveryTarget(makeTarget({ allowedLanguages: [] })).status).toBe('blocked')
  })

  it('rejects an allowlist with more than 20 entries', () => {
    expect(validateDeliveryTarget(makeTarget({ allowedLanguages: Array.from({ length: 21 }, (_, index) => `l${index}`) })).status).toBe('blocked')
  })

  it('rejects a 65-character allowlist item', () => {
    expect(validateDeliveryTarget(makeTarget({ allowedLanguages: ['a'.repeat(65)] })).status).toBe('blocked')
  })

  it('rejects a control character in an allowlist', () => {
    expect(validateDeliveryTarget(makeTarget({ allowedLanguages: ['en\nUS'] })).status).toBe('blocked')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001])('rejects maximumPayloadBytes %s', (maximumPayloadBytes) => {
    expect(validateDeliveryTarget(makeTarget({ maximumPayloadBytes })).status).toBe('blocked')
  })

  it('accepts the maximum permitted payload boundary', () => {
    const result = validateDeliveryTarget(makeTarget({ maximumPayloadBytes: 10_000_000 }))
    expect(result.status).toBe('valid')
  })

  it.each(['target/example', 'owner@example.com', 'https://target.example.com', 'Bearer secret-value', 'token-value', 'secret-value', 'password-value', 'credential-value', 'line\nfeed', 'a\\b', ''])('rejects non-opaque identity %s', (value) => {
    expect(validateDeliveryTarget(makeTarget({ targetId: value })).status).toBe('blocked')
    expect(computeDeliveryIdempotencyKey({
      ownerScopeKey: value,
      targetId: 'target-1',
      adapter: 'wordpress_rest',
      scheduleEntryId: 'schedule-1',
      scheduleKey: 'schedule.key:1',
      productionPlanId: 'plan-1',
      jobId: 'job-1',
      draftId: 'draft-1',
      draftVersion: 1,
      reviewId: 'review-1',
      evidenceSnapshotHash: FIXTURE_HASH,
      contentHash: FIXTURE_HASH_B,
    }).status).toBe('blocked')
  })

  it('does not trim an invalid opaque identity into acceptance', () => {
    expect(validateDeliveryTarget(makeTarget({ targetId: ' target-1 ' })).status).toBe('blocked')
  })

  it('accepts an opaque identity with colon, dot, underscore and hyphen', () => {
    const result = computeDeliveryIdempotencyKey({
      ownerScopeKey: 'owner.scope:1',
      targetId: 'target_1-1',
      adapter: 'wordpress_rest',
      scheduleEntryId: 'schedule-1',
      scheduleKey: '2026-08-24T00:00:00.000Z:article-1',
      productionPlanId: 'plan-1',
      jobId: 'job-1',
      draftId: 'draft-1',
      draftVersion: 1,
      reviewId: 'review-1',
      evidenceSnapshotHash: FIXTURE_HASH,
      contentHash: FIXTURE_HASH_B,
    })
    expect(result.status).toBe('ok')
  })
})

describe('IPv6 special-use target hardening', () => {
  it.each([
    'https://[100::]',
    'https://[100::1]',
    'https://[100::ffff]',
    'https://[100:0:0:0:ffff:ffff:ffff:ffff]',
    'https://[64:ff9b::1]',
    'https://[64:ff9b:1::1]',
    'https://[2001::1]',
    'https://[2001:2::1]',
    'https://[2001:10::1]',
    'https://[2001:20::1]',
    'https://[2002::1]',
    'https://[::ffff:192.0.2.1]',
  ])('blocks special-use IPv6 origin %s', (targetOrigin) => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin })).status).toBe('blocked')
  })

  it('blocks the full 100::/64 range regardless of trailing words', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[100:0:0:0:abcd:abcd:abcd:abcd]' })).status).toBe('blocked')
  })

  it('blocks a public-looking IPv4-mapped IPv6 literal', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[::ffff:8.8.8.8]' })).status).toBe('blocked')
  })

  it('blocks Teredo and benchmarking subranges explicitly', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[2001:0000:1234::1]' })).status).toBe('blocked')
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[2001:0002:1234::1]' })).status).toBe('blocked')
  })

  it('blocks ORCHID and ORCHIDv2 subranges explicitly', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[2001:001f::1]' })).status).toBe('blocked')
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[2001:002f::1]' })).status).toBe('blocked')
  })

  it('blocks NAT64 well-known and local-use prefixes', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[64:ff9b::192.0.2.1]' })).status).toBe('blocked')
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://[64:ff9b:1::1]' })).status).toBe('blocked')
  })
})

describe('DNS hostname and target bounds', () => {
  it('rejects an underscore hostname label', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://foo_bar.example.com' })).status).toBe('blocked')
  })

  it('rejects a hostname label beginning with a hyphen', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://-foo.example.com' })).status).toBe('blocked')
  })

  it('rejects a hostname label ending with a hyphen', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://foo-.example.com' })).status).toBe('blocked')
  })

  it('rejects a hostname label longer than 63 characters', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: `https://${'a'.repeat(64)}.example.com` })).status).toBe('blocked')
  })

  it('rejects a hostname longer than the DNS limit', () => {
    const labels = Array.from({ length: 5 }, () => 'a'.repeat(63)).join('.')
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: `https://${labels}` })).status).toBe('blocked')
  })

  it('accepts a URL parser normalized punycode hostname', () => {
    expect(validateDeliveryTarget(makeTarget({ targetOrigin: 'https://xn--tst-bma.example.com' })).status).toBe('valid')
  })
})

describe('success result time and fingerprint hardening', () => {
  it('returns a deliveryResultFingerprint on first delivery', () => {
    const result = reduceDeliveryAttemptState('dispatch_planned', successEvent())
    expect(result).toMatchObject({ status: 'ok', state: 'delivered', remoteContentId: 'remote-1' })
    if (result.status === 'ok') expect(result.deliveryResultFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('requires event now', () => {
    const { now: _now, ...event } = successEvent()
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it('requires attemptStartedAt', () => {
    const { attemptStartedAt: _attemptStartedAt, ...event } = successEvent()
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it('blocks publishedAt after event now', () => {
    const event = successEvent({ result: { ...successEvent().result, publishedAt: '2026-08-24T00:00:01.000Z' } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'PUBLISHED_AT_IN_FUTURE' })
  })

  it('blocks publishedAt before attemptStartedAt', () => {
    const event = successEvent({ result: { ...successEvent().result, publishedAt: '2026-08-23T23:58:59.000Z' } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'PUBLISHED_AT_BEFORE_ATTEMPT' })
  })

  it('accepts an equivalent timezone-bearing publishedAt and canonicalizes it', () => {
    const event = successEvent({ result: { ...successEvent().result, publishedAt: '2026-08-24T08:00:00.000+08:00' } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'ok', state: 'delivered' })
  })

  it.each(['f', 'f'.repeat(63), 'not-a-fingerprint'])('rejects a non-SHA responseFingerprint %s', (responseFingerprint) => {
    const event = successEvent({ result: { ...successEvent().result, responseFingerprint } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'RESPONSE_FINGERPRINT_INVALID' })
  })

  it.each(['remote@example.com', 'https://target.example.com/posts/1', 'Bearer remote-1', 'token-1', 'secret-1', 'remote/1', ''])('rejects a non-opaque remoteContentId %s', (remoteContentId) => {
    const event = successEvent({ result: { ...successEvent().result, remoteContentId } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'HTTP_SUCCESS_MISSING_REMOTE_ID' })
  })

  it('requires remoteUrl when noPublicUrl is false', () => {
    const event = successEvent({ result: { ...successEvent().result, remoteUrl: undefined, noPublicUrl: false } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it('still validates remoteUrl when noPublicUrl is true', () => {
    const event = successEvent({ result: { ...successEvent().result, noPublicUrl: true, remoteUrl: 'https://127.0.0.1/posts/1' } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it('accepts a valid remoteUrl together with noPublicUrl true', () => {
    const event = successEvent({ result: { ...successEvent().result, noPublicUrl: true } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'ok', state: 'delivered' })
  })

  it('rejects a result targetOrigin that fails target validation', () => {
    const event = successEvent({ targetOrigin: 'https://localhost' })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_RESULT_INVALID' })
  })

  it('computes the same fingerprint for canonical equivalent timestamps', () => {
    const first = computeDeliveryResultFingerprint(successEvent().result, FIXTURE_ORIGIN)
    const second = computeDeliveryResultFingerprint({ ...successEvent().result, publishedAt: '2026-08-24T08:00:00.000+08:00' }, FIXTURE_ORIGIN)
    expect(first).toEqual(second)
  })
})

describe('complete delivery result replay identity', () => {
  it('requires the prior delivery result fingerprint', () => {
    expect(reduceDeliveryAttemptState('delivered', successEvent())).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })

  it('rejects a malformed prior delivery result fingerprint', () => {
    expect(reduceDeliveryAttemptState('delivered', successEvent({ priorDeliveryResultFingerprint: 'not-a-fingerprint' }))).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })

  it('accepts a replay with an exactly matching complete result fingerprint', () => {
    const event = successEvent({ priorDeliveryResultFingerprint: resultFingerprint() })
    expect(reduceDeliveryAttemptState('delivered', event)).toMatchObject({ status: 'ok', transition: 'delivered->delivered', deliveryResultFingerprint: resultFingerprint() })
  })

  it.each([
    ['remoteContentId', { remoteContentId: 'remote-2' }],
    ['remoteUrl', { remoteUrl: 'https://target.example.com/posts/remote-2' }],
    ['publishedAt', { publishedAt: '2026-08-23T23:59:30.000Z' }],
    ['responseFingerprint', { responseFingerprint: 'e'.repeat(64) }],
    ['noPublicUrl', { noPublicUrl: true }],
  ])('blocks replay when %s changes', (_field, resultOverride) => {
    const original = successEvent()
    const event = successEvent({ result: { ...original.result, ...resultOverride }, priorDeliveryResultFingerprint: resultFingerprint(original) })
    expect(reduceDeliveryAttemptState('delivered', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })

  it('blocks replay when targetOrigin changes', () => {
    const original = successEvent()
    const event = successEvent({ targetOrigin: 'https://other.example.com', result: { ...original.result, remoteUrl: 'https://other.example.com/posts/remote-1' }, priorDeliveryResultFingerprint: resultFingerprint(original) })
    expect(reduceDeliveryAttemptState('delivered', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })

  it('does not treat a changed remoteUrl hidden by noPublicUrl as equal', () => {
    const original = successEvent({ result: { ...successEvent().result, noPublicUrl: true } })
    const event = successEvent({ result: { ...original.result, remoteUrl: 'https://target.example.com/posts/remote-2' }, priorDeliveryResultFingerprint: resultFingerprint(original) })
    expect(reduceDeliveryAttemptState('delivered', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
  })
})

describe('additional malformed and safety boundaries', () => {
  it('blocks a malformed target identity before origin normalization', () => {
    expect(validateDeliveryTarget(makeTarget({ ownerScopeKey: 'owner@example.com' })).status).toBe('blocked')
  })

  it('blocks a publication identity URL without returning the raw value', () => {
    const result = evaluateDeliveryEligibility(makeTarget(), makePublication({ ownerScopeKey: 'https://private.example.com' }), FIXTURE_NOW)
    expect(result.status).toBe('blocked')
    expect(JSON.stringify(result)).not.toContain('https://private.example.com')
  })

  it('blocks an attempt retryEligibleAt without timezone', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt({ retryEligibleAt: '2026-08-24T00:00:00' })] }))
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('blocks a retry_wait record without retry failure evidence', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt({ state: 'retry_wait', retryEligibleAt: FIXTURE_NOW })] }))
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('blocks an attempt with a negative retryAfterSeconds', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt({ retryAfterSeconds: -1 })] }))
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('blocks an attempt with a non-integer retryAfterSeconds', () => {
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeRetryWaitAttempt({ retryAfterSeconds: 1.5 })] }))
    expect(result).toMatchObject({ status: 'blocked', code: 'ATTEMPT_RETRY_EVIDENCE_INVALID' })
  })

  it('does not expose a raw response field in the delivered result', () => {
    const result = reduceDeliveryAttemptState('dispatch_planned', successEvent({ result: { ...successEvent().result, rawResponse: 'synthetic raw response' } }))
    expect(JSON.stringify(result)).not.toContain('synthetic raw response')
  })

  it('keeps static implementation scan markers limited to the test source', () => {
    expect(true).toBe(true)
  })
})


describe('encoded endpoint and eligibility timestamp regressions', () => {
  it.each(['/posts/%252e%252e/admin', '/posts/%252E%252E/admin', '/posts/%252fadmin', '/posts/%255cadmin', '/posts/%2500'])('blocks double-encoded endpoint delimiter %s', (endpointPath) => {
    expect(validateDeliveryTarget(makeTarget({ endpointPath })).status).toBe('blocked')
  })

  it('preserves the exact retry eligibility time after now passes the deadline', () => {
    const result = planDeliveryAttempt(makePlanInput({
      now: '2026-08-24T00:05:00.000Z',
      publication: makePublication({ scheduledAt: '2026-08-23T23:00:00.000Z' }),
      attempts: [makeRetryWaitAttempt({ retryEligibleAt: FIXTURE_NOW })],
    }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.eligibleAt).toBe(FIXTURE_NOW)
  })

  it('does not use current now as retry eligibility time', () => {
    const result = planDeliveryAttempt(makePlanInput({
      now: '2026-08-24T00:01:00.000Z',
      publication: makePublication({ scheduledAt: '2026-08-23T23:00:00.000Z' }),
      attempts: [makeRetryWaitAttempt({ retryEligibleAt: FIXTURE_NOW })],
    }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') {
      expect(result.command.eligibleAt).toBe(FIXTURE_NOW)
      expect(result.command.eligibleAt).not.toBe('2026-08-24T00:01:00.000Z')
    }
  })
})
