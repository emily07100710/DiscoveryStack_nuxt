import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DELIVERY_AUTOMATION_ENGINE_VERSION,
  classifyDeliveryFailure,
  computeDeliveryIdempotencyKey,
  evaluateDeliveryEligibility,
  planDeliveryAttempt,
  reduceDeliveryAttemptState,
  validateDeliveryTarget,
} from '../server/delivery-automation'
import {
  FIXTURE_HASH,
  FIXTURE_HASH_B,
  FIXTURE_KEY,
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
  evidenceSnapshotHash: FIXTURE_HASH,
  contentHash: FIXTURE_HASH_B,
}

function successEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'success',
    expectedIdempotencyKey: 'd'.repeat(64),
    targetOrigin: FIXTURE_ORIGIN,
    result: {
      idempotencyKey: 'd'.repeat(64),
      remoteContentId: 'remote-1',
      publishedAt: FIXTURE_NOW,
      remoteUrl: 'https://target.example.com/posts/remote-1',
      noPublicUrl: false,
      responseFingerprint: 'fingerprint-1',
    },
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
    const result = planDeliveryAttempt(makePlanInput({ attempts: [makeAttempt()] }))
    expect(result.status).toBe('dispatch_planned')
    if (result.status === 'dispatch_planned') expect(result.command.attemptNumber).toBe(2)
  })

  it('blocks after the fifth attempt', () => {
    const attempts = Array.from({ length: 5 }, (_, index) => makeAttempt({ attemptNumber: index + 1 }))
    expect(planDeliveryAttempt(makePlanInput({ attempts })).code).toBe('ATTEMPT_CAP_REACHED')
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
      expect(planDeliveryAttempt(makePlanInput({ priorDeliveries: [{ idempotencyKey: keyResult.key, targetId: 'target-1', ownerScopeKey: 'owner-1', draftId: 'draft-1', contentHash: FIXTURE_HASH_B, reviewId: 'review-1', state: 'dispatch_planned' }] })).code).toBe('DUPLICATE_PUBLICATION')
    }
  })

  it('blocks an idempotency identity collision', () => {
    const keyResult = computeDeliveryIdempotencyKey(identityInput)
    expect(keyResult.status).toBe('ok')
    if (keyResult.status === 'ok') {
      expect(planDeliveryAttempt(makePlanInput({ priorDeliveries: [{ idempotencyKey: keyResult.key, targetId: 'target-1', ownerScopeKey: 'owner-1', draftId: 'draft-1', contentHash: 'e'.repeat(64), reviewId: 'review-1', state: 'dispatch_planned' }] })).code).toBe('IDEMPOTENCY_COLLISION')
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

  it('moves retry_wait back to dispatch_planned only on retry_due', () => {
    expect(reduceDeliveryAttemptState('retry_wait', { type: 'retry_due' })).toMatchObject({ status: 'ok', state: 'dispatch_planned' })
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
    const event = successEvent({ result: { idempotencyKey: 'd'.repeat(64), remoteContentId: 'remote-1', publishedAt: FIXTURE_NOW, noPublicUrl: true, responseFingerprint: 'fingerprint-1' } })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'ok', state: 'delivered' })
  })

  it('rejects HTTP 2xx-style results without remote content identity', () => {
    const event = successEvent({ result: { idempotencyKey: 'd'.repeat(64), publishedAt: FIXTURE_NOW, remoteUrl: 'https://target.example.com/posts/remote-1', noPublicUrl: false, responseFingerprint: 'fingerprint-1' } })
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

  it('allows an idempotent replay with the same remote identity', () => {
    expect(reduceDeliveryAttemptState('delivered', successEvent({ priorRemoteContentId: 'remote-1' }))).toMatchObject({ status: 'ok', state: 'delivered', remoteContentId: 'remote-1' })
  })

  it('blocks a different remote identity for the same key', () => {
    const event = successEvent({ priorRemoteContentId: 'remote-2' })
    expect(reduceDeliveryAttemptState('dispatch_planned', event)).toMatchObject({ status: 'blocked', code: 'REMOTE_IDENTITY_COLLISION' })
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
  for (const marker of ['fetch(', '$fetch', 'ofetch', 'axios', 'XMLHttpRequest', 'http.request', 'https.request', 'node:net', 'node:dns', 'node:http', 'node:https', 'child_process', 'process.env', 'Authorization', 'Bearer', 'Cookie']) {
    expect(source, `implementation contains forbidden marker: ${marker}`).not.toContain(marker)
  }
})

void FIXTURE_KEY
void makePublication
