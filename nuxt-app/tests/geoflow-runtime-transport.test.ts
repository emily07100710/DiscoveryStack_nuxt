import { describe, expect, it } from 'vitest'
import type { GeoFlowCredentialResolution, GeoFlowFetch, GeoFlowFetchResponse, GeoFlowRequestInit } from '../server/geoflow-runtime'
import {
  classifyGeoFlowTransportFailure,
  executeGeoFlowArticleFetch,
  executeGeoFlowEnqueue,
  executeGeoFlowJobPoll,
  normalizeGeoFlowRuntimeTarget,
  parseGeoFlowRetryAfter,
  planGeoFlowEnqueueRequest,
  retryAllowedForAttempt,
  validateGeoFlowBaseUrl,
  validateGeoFlowCredentialReference,
  validateGeoFlowTaskId,
  validateGeoFlowTransportResult,
  validateGeoFlowTransportText,
} from '../server/geoflow-runtime'
import { deriveExternalArticleKey } from '../server/geoflow-integration'
import {
  ARTICLE_ID,
  BASE_URL,
  BODY_HASH,
  BODY_MARKDOWN,
  CREDENTIAL_REFERENCE,
  IDEMPOTENCY_KEY,
  JOB_ID,
  REQUEST_ID,
  RESPONSE_TIMESTAMP,
  TASK_ID,
  apiResponse,
  articleResponse,
  enqueueResponse,
  jobResponse,
  jsonResponse,
  makeRequest,
  makeTarget,
  responseWithBodyBytes,
  responseWithRawText,
} from './fixtures/geoflow-runtime/fixtures'

let sequence = 0

function freshRequest(overrides: Record<string, unknown> = {}) {
  const id = ++sequence
  return makeRequest({ requestId: `runtime-request-${id}`, idempotencyKey: `runtime-idempotency-${id}`, ...overrides })
}

function responseFor(value: GeoFlowFetchResponse | GeoFlowFetchResponse[], options: { readonly resolver?: (reference: string) => GeoFlowCredentialResolution | Promise<GeoFlowCredentialResolution>; readonly clock?: string } = {}) {
  const responses = Array.isArray(value) ? value : [value]
  const calls: Array<{ url: string; init: GeoFlowRequestInit }> = []
  const resolverCalls: string[] = []
  const sleeps: number[] = []
  let index = 0
  const fetch: GeoFlowFetch = async (url, init) => {
    calls.push({ url, init })
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (!response) throw new Error('missing test response')
    return response
  }
  const dependencies = {
    fetch,
    credentialResolver: async (reference: string) => {
      resolverCalls.push(reference)
      return options.resolver === undefined ? { ok: true as const, value: 'C'.repeat(32) } : options.resolver(reference)
    },
    clock: { now: () => options.clock ?? '2026-08-26T01:02:03Z' },
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds) },
  }
  return { dependencies, calls, resolverCalls, sleeps }
}

function planFor(request = freshRequest(), target = makeTarget()) {
  const planned = planGeoFlowEnqueueRequest(request, target)
  expect(planned.ok).toBe(true)
  if (!planned.ok) throw new Error('test plan failed')
  return { request, target, plan: planned.value }
}

async function enqueueFor(request = freshRequest(), target = makeTarget(), response?: GeoFlowFetchResponse) {
  const planned = planFor(request, target)
  const recorded = responseFor(response ?? enqueueResponse(request, JOB_ID, TASK_ID))
  const result = await executeGeoFlowEnqueue({ request, target }, recorded.dependencies)
  return { ...planned, ...recorded, result }
}

async function pollJobWithMetadata(request = freshRequest(), target = makeTarget(), metadataOverrides: Record<string, unknown> = {}) {
  const enqueued = await enqueueFor(request, target)
  expect(enqueued.result.ok).toBe(true)
  if (!enqueued.result.ok) throw new Error('test enqueue failed')
  const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', target.attempt, metadataOverrides))
  const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
  return { ...enqueued, ...recorded, result }
}

async function completedJobFor(request = freshRequest(), target = makeTarget(), metadataOverrides: Record<string, unknown> = {}) {
  const polled = await pollJobWithMetadata(request, target, metadataOverrides)
  const { result } = polled
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('test poll failed')
  return { ...polled, job: result.value, pollResult: result }
}

async function articleFor(request = freshRequest(), target = makeTarget(), articleOverrides: Record<string, unknown> = {}, metadataOverrides: Record<string, unknown> = {}) {
  const polled = await completedJobFor(request, target, metadataOverrides)
  const recorded = responseFor(articleResponse(request, polled.job.jobId, polled.job.articleId, target.taskId, articleOverrides))
  const result = await executeGeoFlowArticleFetch({ plan: polled.plan, job: polled.job }, recorded.dependencies)
  return { ...polled, ...recorded, result }
}

describe('GEOFlow runtime target and credential boundary', () => {
  it('accepts a public HTTPS origin and positive task id', () => {
    expect(validateGeoFlowBaseUrl(BASE_URL)).toEqual({ ok: true, value: BASE_URL })
    expect(validateGeoFlowTaskId(TASK_ID)).toEqual({ ok: true, value: TASK_ID })
  })

  it('rejects an HTTP base URL', () => {
    expect(validateGeoFlowBaseUrl(BASE_URL.replace('https://', 'http://')).ok).toBe(false)
  })

  it('rejects a base URL with credentials', () => {
    expect(validateGeoFlowBaseUrl('https://user:pass@geoflow.routing.discoverystack.dev').ok).toBe(false)
  })

  it('rejects a base URL with a fragment', () => {
    expect(validateGeoFlowBaseUrl(`${BASE_URL}#fragment`).ok).toBe(false)
  })

  it('rejects a base URL with a query', () => {
    expect(validateGeoFlowBaseUrl(`${BASE_URL}?x=1`).ok).toBe(false)
  })

  it('rejects a base URL with a path', () => {
    expect(validateGeoFlowBaseUrl(`${BASE_URL}/api`).ok).toBe(false)
  })

  it('rejects localhost', () => {
    expect(validateGeoFlowBaseUrl('https://localhost').ok).toBe(false)
  })

  it('rejects private IPv4', () => {
    expect(validateGeoFlowBaseUrl('https://192.168.1.10').ok).toBe(false)
  })

  it('rejects loopback IPv6', () => {
    expect(validateGeoFlowBaseUrl('https://[::1]').ok).toBe(false)
  })

  it('rejects IANA special-use domain', () => {
    expect(validateGeoFlowBaseUrl('https://api.example.com').ok).toBe(false)
  })

  it('rejects an IP literal even when globally routable', () => {
    expect(validateGeoFlowBaseUrl('https://203.0.113.20').ok).toBe(false)
  })

  it('rejects a non-positive task id', () => {
    expect(validateGeoFlowTaskId(0).ok).toBe(false)
  })

  it('rejects a fractional task id', () => {
    expect(validateGeoFlowTaskId(1.5).ok).toBe(false)
  })

  it('rejects an unsafe task id', () => {
    expect(validateGeoFlowTaskId(Number.MAX_SAFE_INTEGER + 1).ok).toBe(false)
  })

  it('accepts an opaque credential reference', () => {
    expect(validateGeoFlowCredentialReference(CREDENTIAL_REFERENCE)).toEqual({ ok: true, value: CREDENTIAL_REFERENCE })
  })

  it('rejects a credential value shaped as a reference with whitespace', () => {
    expect(validateGeoFlowCredentialReference('credential reference').ok).toBe(false)
  })

  it('rejects an empty credential reference', () => {
    expect(validateGeoFlowCredentialReference('').ok).toBe(false)
  })

  it('rejects a credential reference with control characters', () => {
    expect(validateGeoFlowCredentialReference('credential\nref').ok).toBe(false)
  })

  it('resolves a credential only through the injected resolver', async () => {
    const request = freshRequest()
    const recorded = responseFor(enqueueResponse(request), { resolver: async (reference) => ({ ok: reference === CREDENTIAL_REFERENCE, value: 'C'.repeat(32) }) })
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget() }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(recorded.resolverCalls).toEqual([CREDENTIAL_REFERENCE])
  })

  it('maps a false credential resolver to a sanitized failure', async () => {
    const request = freshRequest()
    const recorded = responseFor(enqueueResponse(request), { resolver: async () => ({ ok: false }) })
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget() }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } })
  })

  it('maps a throwing credential resolver to a sanitized failure', async () => {
    const request = freshRequest()
    const recorded = responseFor(enqueueResponse(request), { resolver: async () => { throw new Error('private resolver detail') } })
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget() }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } })
  })

  it('maps a rejecting credential resolver to a sanitized failure', async () => {
    const request = freshRequest()
    const recorded = responseFor(enqueueResponse(request), { resolver: async () => Promise.reject(new Error('private resolver detail')) })
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget() }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'CREDENTIAL_RESOLUTION_FAILED', retryable: false } })
  })

  it('never returns the resolved credential', async () => {
    const request = freshRequest()
    const privateValue = 'C'.repeat(32)
    const recorded = responseFor(enqueueResponse(request), { resolver: async () => ({ ok: true, value: privateValue }) })
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget() }, recorded.dependencies)
    expect(JSON.stringify(result)).not.toContain(privateValue)
  })

  it('uses defaults when optional target limits are omitted', () => {
    const result = planGeoFlowEnqueueRequest(freshRequest(), { baseUrl: BASE_URL, taskId: TASK_ID, credentialReference: CREDENTIAL_REFERENCE, attempt: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.target.timeoutMs).toBeGreaterThan(0)
  })

  it('rejects an unknown target option', () => {
    const result = planGeoFlowEnqueueRequest(freshRequest(), { baseUrl: BASE_URL, taskId: TASK_ID, credentialReference: CREDENTIAL_REFERENCE, attempt: 1, unknown: true })
    expect(result).toEqual({ ok: false, error: { code: 'TARGET_INVALID', retryable: false } })
  })

  it('rejects attempt zero at the target boundary', () => {
    expect(normalizeGeoFlowRuntimeTarget({ ...makeTarget(), attempt: 0 }).ok).toBe(false)
  })

  it('accepts attempt ten at the target boundary', () => {
    expect(normalizeGeoFlowRuntimeTarget({ ...makeTarget(), attempt: 10 }).ok).toBe(true)
  })

  it('rejects attempt eleven at the target boundary', () => {
    expect(normalizeGeoFlowRuntimeTarget({ ...makeTarget(), attempt: 11 }).ok).toBe(false)
  })

  it('rejects a missing fetch dependency before any call', async () => {
    const result = await executeGeoFlowEnqueue({ request: freshRequest(), target: makeTarget() }, { credentialResolver: async () => ({ ok: true, value: 'C'.repeat(32) }), clock: { now: () => '2026-08-26T01:02:03Z' } } as never)
    expect(result).toEqual({ ok: false, error: { code: 'FETCH_NOT_CONFIGURED', retryable: false } })
  })

  it('rejects a missing clock dependency', async () => {
    const result = await executeGeoFlowEnqueue({ request: freshRequest(), target: makeTarget() }, { fetch: async () => enqueueResponse(freshRequest()), credentialResolver: async () => ({ ok: true, value: 'C'.repeat(32) }) } as never)
    expect(result).toEqual({ ok: false, error: { code: 'CLOCK_NOT_CONFIGURED', retryable: false } })
  })
})

describe('GEOFlow enqueue planning and execution', () => {
  it('plans the fixed enqueue POST route', () => {
    const request = freshRequest()
    const result = planGeoFlowEnqueueRequest(request, makeTarget())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.method).toBe('POST')
      expect(result.value.path).toBe(`/api/v1/tasks/${TASK_ID}/enqueue`)
      expect(result.value.url).toBe(`${BASE_URL}/api/v1/tasks/${TASK_ID}/enqueue`)
    }
  })

  it('includes the required request fingerprint in body', () => {
    const planned = planFor()
    expect(JSON.parse(planned.plan.body).request_fingerprint).toBe(planned.request.requestFingerprint)
  })

  it('includes project identity in body', () => {
    const planned = planFor()
    expect(JSON.parse(planned.plan.body)).toMatchObject({ owner_user_id: 7, client_id: 8, production_plan_id: 10 })
  })

  it('includes calendar entry identity in body', () => {
    const planned = planFor()
    expect(JSON.parse(planned.plan.body)).toMatchObject({ calendar_entry_id: 9, brief_id: 12 })
  })

  it('includes deliverable identity in body', () => {
    const planned = planFor()
    expect(JSON.parse(planned.plan.body)).toMatchObject({ deliverable_id: 11, discovery_stack_job_id: 13 })
  })

  it('includes evidence snapshot and brief fingerprint in body', () => {
    const planned = planFor()
    const body = JSON.parse(planned.plan.body)
    expect(body.evidence_snapshot_hash).toBe(planned.request.evidenceSnapshotHash)
    expect(body.brief_fingerprint).toBe(planned.request.briefFingerprint)
  })

  it('includes selected rules and capabilities in body', () => {
    const planned = planFor()
    const body = JSON.parse(planned.plan.body)
    expect(body.selected_rule_ids).toEqual(planned.request.selectedRuleIds)
    expect(body.requested_capabilities).toEqual(planned.request.requestedCapabilities)
  })

  it('keeps target task in the route and attempt in the canonical body', () => {
    const planned = planFor(freshRequest(), makeTarget({ attempt: 10 }))
    const body = JSON.parse(planned.plan.body)
    expect(planned.plan.path).toBe(`/api/v1/tasks/${TASK_ID}/enqueue`)
    expect(body.task_id).toBeUndefined()
    expect(body.attempt).toBe(10)
  })

  it('fixes the enqueue job type to the DiscoveryStack generation job', () => {
    const planned = planFor()
    expect(JSON.parse(planned.plan.body).job_type).toBe('discoverystack_generate_article_v1')
  })

  it('does not include credential material in plan body', () => {
    const planned = planFor()
    expect(planned.plan.body).not.toContain('C'.repeat(32))
    expect(planned.plan.body).not.toContain('Authorization')
  })

  it('does not include credential material in plan result', () => {
    const planned = planFor()
    expect(JSON.stringify(planned.plan)).not.toContain('C'.repeat(32))
  })

  it('computes a stable plan body hash', () => {
    const first = planFor().plan
    const second = planGeoFlowEnqueueRequest(first.request, first.target)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value.bodyHash).toBe(first.bodyHash)
  })

  it('accepts a successful enqueue envelope', async () => {
    const flow = await enqueueFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.jobId).toBe(JOB_ID)
  })

  it('sends POST and manual redirect mode', async () => {
    const flow = await enqueueFor()
    expect(flow.calls).toHaveLength(1)
    expect(flow.calls[0]?.init.method).toBe('POST')
    expect(flow.calls[0]?.init.redirect).toBe('manual')
  })

  it('sends the fixed enqueue path', async () => {
    const flow = await enqueueFor()
    expect(flow.calls[0]?.url).toBe(`${BASE_URL}/api/v1/tasks/${TASK_ID}/enqueue`)
  })

  it('sends X-Idempotency-Key', async () => {
    const flow = await enqueueFor()
    expect(flow.calls[0]?.init.headers['X-Idempotency-Key']).toBe(flow.request.idempotencyKey)
  })

  it('sends X-Request-Id', async () => {
    const flow = await enqueueFor()
    expect(flow.calls[0]?.init.headers['X-Request-Id']).toBe(flow.request.requestId)
  })

  it('sends an Authorization header only at fetch boundary', async () => {
    const flow = await enqueueFor()
    expect(flow.calls[0]?.init.headers.Authorization).toBe(`Bearer ${'C'.repeat(32)}`)
    expect(JSON.stringify(flow.result)).not.toContain('C'.repeat(32))
  })

  it('sends application/json content type', async () => {
    const flow = await enqueueFor()
    expect(flow.calls[0]?.init.headers['Content-Type']).toBe('application/json')
  })

  it('sends the exact planned body', async () => {
    const flow = await enqueueFor()
    expect(flow.calls[0]?.init.body).toBe(flow.plan.body)
  })

  it('rejects a stale request fingerprint before fetch', async () => {
    const request = freshRequest()
    const stale = { ...request, requestFingerprint: 'a'.repeat(64) }
    const recorded = responseFor(enqueueResponse(request))
    const result = await executeGeoFlowEnqueue({ request: stale, target: makeTarget() }, recorded.dependencies)
    expect(result.ok).toBe(false)
    expect(recorded.calls).toHaveLength(0)
  })

  it('rejects a missing task id in enqueue response', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), apiResponse(request, { job_id: JOB_ID }))
    expect(result.result).toEqual({ ok: false, error: { code: 'TASK_ID_MISSING', retryable: false } })
  })

  it('rejects a wrong task id in enqueue response', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), enqueueResponse(request, JOB_ID, TASK_ID + 1))
    expect(result.result).toEqual({ ok: false, error: { code: 'TASK_ID_MISMATCH', retryable: false } })
  })

  it('rejects a missing job id in enqueue response', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), apiResponse(request, { task_id: TASK_ID }))
    expect(result.result).toEqual({ ok: false, error: { code: 'JOB_ID_MISSING', retryable: false } })
  })

  it('rejects a wrong request id in enqueue response', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), apiResponse(request, { task_id: TASK_ID, job_id: JOB_ID }, undefined, 'other-request'))
    expect(result.result).toEqual({ ok: false, error: { code: 'REQUEST_ID_MISMATCH', retryable: false, httpStatus: 200 } })
  })

  it('rejects request id disagreement across top-level data and meta', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), jsonResponse({
      success: true,
      request_id: 'top-level-wrong',
      data: { request_id: request.requestId, task_id: TASK_ID, job_id: JOB_ID },
      error: null,
      meta: { request_id: request.requestId, timestamp: RESPONSE_TIMESTAMP },
    }))
    expect(result.result).toEqual({ ok: false, error: { code: 'REQUEST_ID_MISMATCH', retryable: false, httpStatus: 200 } })
  })

  it('passes an AbortSignal to the injected fetch boundary', async () => {
    const request = freshRequest()
    const target = makeTarget()
    const recorded = responseFor(enqueueResponse(request))
    const result = await executeGeoFlowEnqueue({ request, target }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(recorded.calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects a non-success envelope', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), jsonResponse({ success: false, data: { request_id: request.requestId, task_id: TASK_ID, job_id: JOB_ID } }))
    expect(result.result).toEqual({ ok: false, error: { code: 'RESPONSE_ENVELOPE_INVALID', retryable: false, httpStatus: 200 } })
  })

  it('rejects an envelope without data object', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), jsonResponse({ success: true, data: null }))
    expect(result.result).toEqual({ ok: false, error: { code: 'RESPONSE_ENVELOPE_INVALID', retryable: false, httpStatus: 200 } })
  })

  it('rejects wrong content type', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), responseWithRawText('{"success":true}', 200, { 'content-type': 'text/html' }))
    expect(result.result).toEqual({ ok: false, error: { code: 'RESPONSE_CONTENT_TYPE_INVALID', retryable: false, httpStatus: 200 } })
  })

  it('rejects malformed JSON', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), responseWithRawText('{bad-json'))
    expect(result.result).toEqual({ ok: false, error: { code: 'RESPONSE_MALFORMED', retryable: false, httpStatus: 200 } })
  })

  it('rejects an oversized response before JSON parsing', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget({ maxResponseBodyBytes: 4 }), responseWithBodyBytes(5))
    expect(result.result).toEqual({ ok: false, error: { code: 'RESPONSE_TOO_LARGE', retryable: false, httpStatus: 200 } })
  })

  it('blocks a 3xx redirect without following it', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget(), jsonResponse({}, 302, { location: `${BASE_URL}/else` }))
    expect(result.result).toEqual({ ok: false, error: { code: 'REDIRECT_BLOCKED', retryable: false, httpStatus: 302 } })
    expect(result.calls).toHaveLength(1)
  })

  it('classifies 401 as permanent unauthorized', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget(), jsonResponse({}, 401))
    expect(result.result).toEqual({ ok: false, error: { code: 'REMOTE_UNAUTHORIZED', retryable: false, httpStatus: 401 } })
  })

  it('classifies 403 as permanent unauthorized', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget(), jsonResponse({}, 403))
    expect(result.result).toEqual({ ok: false, error: { code: 'REMOTE_UNAUTHORIZED', retryable: false, httpStatus: 403 } })
  })

  it('classifies 404 as permanent not found', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget(), jsonResponse({}, 404))
    expect(result.result).toEqual({ ok: false, error: { code: 'REMOTE_NOT_FOUND', retryable: false, httpStatus: 404 } })
  })

  it('classifies 409 as permanent conflict', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget(), jsonResponse({}, 409))
    expect(result.result).toEqual({ ok: false, error: { code: 'REMOTE_CONFLICT', retryable: false, httpStatus: 409 } })
  })

  it('classifies 422 as permanent unprocessable', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget(), jsonResponse({}, 422))
    expect(result.result).toEqual({ ok: false, error: { code: 'REMOTE_UNPROCESSABLE', retryable: false, httpStatus: 422 } })
  })

  it('retries 429 with bounded Retry-After', async () => {
    const request = freshRequest()
    const recorded = responseFor([jsonResponse({}, 429, { 'retry-after': '2' }), enqueueResponse(request)])
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 2 }) }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(recorded.calls).toHaveLength(2)
    expect(recorded.sleeps).toEqual([2_000])
  })

  it('rejects an unbounded Retry-After', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget({ maxRetryAfterSeconds: 60 }), jsonResponse({}, 429, { 'retry-after': '61' }))
    expect(result.result).toEqual({ ok: false, error: { code: 'RETRY_AFTER_INVALID', retryable: false, httpStatus: 429 } })
  })

  it('retries a 500 within max attempts', async () => {
    const request = freshRequest()
    const recorded = responseFor([jsonResponse({}, 500), enqueueResponse(request)])
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 2 }) }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(recorded.calls).toHaveLength(2)
  })

  it('retries a 502 within max attempts', async () => {
    const request = freshRequest()
    const recorded = responseFor([jsonResponse({}, 502), enqueueResponse(request)])
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 2 }) }, recorded.dependencies)
    expect(result.ok).toBe(true)
  })

  it('retries a 503 within max attempts', async () => {
    const request = freshRequest()
    const recorded = responseFor([jsonResponse({}, 503), enqueueResponse(request)])
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 2 }) }, recorded.dependencies)
    expect(result.ok).toBe(true)
  })

  it('retries a 504 within max attempts', async () => {
    const request = freshRequest()
    const recorded = responseFor([jsonResponse({}, 504), enqueueResponse(request)])
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 2 }) }, recorded.dependencies)
    expect(result.ok).toBe(true)
  })

  it('stops retrying after max attempts', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget({ maxAttempts: 2 }), jsonResponse({}, 503))
    expect(result.result).toEqual({ ok: false, error: { code: 'REMOTE_SERVER_ERROR', retryable: true, httpStatus: 503 } })
    expect(result.calls).toHaveLength(2)
  })

  it('maps a thrown timeout to retryable timeout', async () => {
    const request = freshRequest()
    const recorded = responseFor(enqueueResponse(request))
    recorded.dependencies.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }) }
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 1 }) }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'TRANSPORT_TIMEOUT', retryable: true } })
  })

  it('maps a thrown network error to retryable network failure', async () => {
    const request = freshRequest()
    const recorded = responseFor(enqueueResponse(request))
    recorded.dependencies.fetch = async () => { throw new Error('socket unavailable') }
    const result = await executeGeoFlowEnqueue({ request, target: makeTarget({ maxAttempts: 1 }) }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'NETWORK_FAILURE', retryable: true } })
  })

  it('does not retry 401', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget({ maxAttempts: 3 }), jsonResponse({}, 401))
    expect(result.calls).toHaveLength(1)
  })

  it('does not retry 409', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget({ maxAttempts: 3 }), jsonResponse({}, 409))
    expect(result.calls).toHaveLength(1)
  })

  it('does not retry malformed response', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget({ maxAttempts: 3 }), responseWithRawText('{bad'))
    expect(result.calls).toHaveLength(1)
  })

  it('does not retry response identity mismatch', async () => {
    const request = freshRequest()
    const result = await enqueueFor(request, makeTarget({ maxAttempts: 3 }), enqueueResponse(request, JOB_ID, TASK_ID + 1))
    expect(result.calls).toHaveLength(1)
  })

  it('does not expose remote error body', async () => {
    const result = await enqueueFor(freshRequest(), makeTarget(), responseWithRawText('private remote error details', 500, { 'content-type': 'text/plain' }))
    expect(JSON.stringify(result.result)).not.toContain('private remote error details')
  })
})

describe('GEOFlow job polling and lineage', () => {
  it('polls the fixed job GET route', async () => {
    const flow = await completedJobFor()
    expect(flow.calls[0]?.url).toBe(`${BASE_URL}/api/v1/jobs/${flow.job.jobId}`)
    expect(flow.calls[0]?.init.method).toBe('GET')
  })

  it('polls with manual redirect mode', async () => {
    const flow = await completedJobFor()
    expect(flow.calls[0]?.init.redirect).toBe('manual')
  })

  it('returns completed job article id', async () => {
    const flow = await completedJobFor()
    expect(flow.job.articleId).toBe(ARTICLE_ID)
  })

  it('binds job task identity to target task', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID + 1, 'completed', 1))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'TASK_ID_MISMATCH', retryable: false } })
  })

  it('binds job identity to enqueue job', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId + 1, ARTICLE_ID, TASK_ID, 'completed', 1))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'JOB_ID_MISMATCH', retryable: false } })
  })

  it('binds job request fingerprint', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const response = jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1)
    const original = await response.text()
    const tampered = original.replace(request.requestFingerprint, 'a'.repeat(64))
    const recorded = responseFor(responseWithRawText(tampered))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'REQUEST_FINGERPRINT_MISMATCH', retryable: false } })
  })

  it('binds job attempt to target attempt', async () => {
    const request = freshRequest()
    const target = makeTarget({ attempt: 2 })
    const enqueued = await enqueueFor(request, target)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'ATTEMPT_MISMATCH', retryable: false } })
  })

  it('requires article id in completed job', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, null, TASK_ID, 'completed', 1))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'ARTICLE_ID_MISSING', retryable: false } })
  })

  it('does not fetch article while job is pending', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, null, TASK_ID, 'queued', 1))
    const pendingPlanResult = planGeoFlowEnqueueRequest(request, makeTarget({ maxPolls: 1 }))
    expect(pendingPlanResult.ok).toBe(true)
    if (!pendingPlanResult.ok) throw new Error('pending plan failed')
    const result = await executeGeoFlowJobPoll({ plan: pendingPlanResult.value, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'POLL_LIMIT_EXCEEDED', retryable: false } })
    expect(recorded.calls).toHaveLength(1)
  })

  it('waits between pending job polls', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor([
      jobResponse(request, enqueued.result.value.jobId, null, TASK_ID, 'running', 1),
      jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1),
    ])
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(recorded.sleeps).toEqual([])
  })

  it('requires injected sleep when polling interval is positive', async () => {
    const request = freshRequest()
    const target = makeTarget({ pollIntervalMs: 10, maxPolls: 1 })
    const enqueued = await enqueueFor(request, target)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const dependencies = responseFor(jobResponse(request, enqueued.result.value.jobId, null, TASK_ID, 'running', 1)).dependencies
    delete (dependencies as { sleep?: unknown }).sleep
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'SLEEP_NOT_CONFIGURED', retryable: false } })
  })

  it('retries a transient job poll server error', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor([jsonResponse({}, 503), jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1)])
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(recorded.calls).toHaveLength(2)
  })

  it('retries a transient job poll timeout', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1))
    let calls = 0
    const jobId = enqueued.result.value.jobId
    recorded.dependencies.fetch = async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('timeout'), { name: 'AbortError' }); return jobResponse(request, jobId, ARTICLE_ID, TASK_ID, 'completed', 1) }
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('stops job retries at bounded attempts', async () => {
    const request = freshRequest()
    const target = makeTarget({ maxAttempts: 2 })
    const enqueued = await enqueueFor(request, target)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jsonResponse({}, 503))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'REMOTE_SERVER_ERROR', retryable: true, httpStatus: 503 } })
    expect(recorded.calls).toHaveLength(2)
  })

  it('rejects a failed job status without article fetch', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const recorded = responseFor(jobResponse(request, enqueued.result.value.jobId, null, TASK_ID, 'failed', 1))
    const result = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'REMOTE_REJECTED', retryable: false } })
  })

  it('rejects a fake unverified enqueue object', async () => {
    const request = freshRequest()
    const planned = planFor(request)
    const result = await executeGeoFlowJobPoll({ plan: planned.plan, enqueue: { kind: 'enqueued', requestFingerprint: request.requestFingerprint, requestId: request.requestId, taskId: TASK_ID, jobId: JOB_ID, attempt: 1, remoteRequestId: request.requestId, remoteStatus: 'accepted' } }, responseFor(jobResponse(request)).dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })

  it('rejects a fake unverified plan', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const clonedPlan = { ...enqueued.plan }
    const result = await executeGeoFlowJobPoll({ plan: clonedPlan, enqueue: enqueued.result.value }, responseFor(jobResponse(request)).dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })
})

describe('GEOFlow article candidate transport and validation', () => {
  it('fetches only the fixed article GET route', async () => {
    const flow = await articleFor()
    expect(flow.calls[0]?.url).toBe(`${BASE_URL}/api/v1/articles/${flow.job.articleId}`)
    expect(flow.calls[0]?.init.method).toBe('GET')
  })

  it('uses manual redirects for article fetch', async () => {
    const flow = await articleFor()
    expect(flow.calls[0]?.init.redirect).toBe('manual')
  })

  it('returns a candidate response', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.response.status).toBe('draft_ready')
  })

  it('preserves candidate body Unicode and exact hash', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) {
      expect(['draft_ready', 'review_required']).toContain(flow.result.value.response.status)
      if (flow.result.value.response.status === 'draft_ready' || flow.result.value.response.status === 'review_required') {
        expect(flow.result.value.response.contentArtifact.bodyMarkdown).toBe(BODY_MARKDOWN)
        expect(flow.result.value.response.contentArtifact.bodyHash).toBe(BODY_HASH)
      }
    }
  })

  it('binds candidate request fingerprint', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.requestFingerprint).toBe(flow.request.requestFingerprint)
  })

  it('binds candidate task identity', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.taskId).toBe(TASK_ID)
  })

  it('binds candidate job identity', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.jobId).toBe(flow.job.jobId)
  })

  it('binds candidate article identity from verified job only', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.articleId).toBe(flow.job.articleId)
  })

  it('derives the external article key from server identities', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.response.externalArticleKey).toBe(deriveExternalArticleKey(flow.request))
  })

  it('keeps candidate requires-human-review semantics in response', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.response.status).toBe('draft_ready')
  })

  it('rejects approved article state', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { status: 'approved' })
    expect(flow.result).toEqual({ ok: false, error: { code: 'PUBLICATION_STATE_REJECTED', retryable: false } })
  })

  it('rejects published article state', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { status: 'published' })
    expect(flow.result).toEqual({ ok: false, error: { code: 'PUBLICATION_STATE_REJECTED', retryable: false } })
  })

  it('rejects delivered article state', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { status: 'delivered' })
    expect(flow.result).toEqual({ ok: false, error: { code: 'PUBLICATION_STATE_REJECTED', retryable: false } })
  })

  it('accepts review-required article state', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { review_status: 'review_pending' })
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) expect(flow.result.value.response.status).toBe('review_required')
  })

  it('rejects a wrong article id', async () => {
    const request = freshRequest()
    const flow = await articleFor(request, makeTarget(), { id: ARTICLE_ID + 1 })
    expect(flow.result).toEqual({ ok: false, error: { code: 'ARTICLE_ID_MISMATCH', retryable: false } })
  })

  it('rejects a wrong article key in verified job metadata', async () => {
    const flow = await pollJobWithMetadata(freshRequest(), makeTarget(), { external_article_key: 'article-wrong' })
    expect(flow.result).toEqual({ ok: false, error: { code: 'ARTICLE_ID_MISMATCH', retryable: false } })
  })

  it('rejects a wrong evidence snapshot hash in verified job metadata', async () => {
    const flow = await pollJobWithMetadata(freshRequest(), makeTarget(), { evidence_snapshot_hash: 'a'.repeat(64) })
    expect(flow.result).toEqual({ ok: false, error: { code: 'REQUEST_FINGERPRINT_MISMATCH', retryable: false } })
  })

  it('rejects a wrong brief fingerprint in verified job metadata', async () => {
    const flow = await pollJobWithMetadata(freshRequest(), makeTarget(), { brief_fingerprint: 'a'.repeat(64) })
    expect(flow.result).toEqual({ ok: false, error: { code: 'REQUEST_FINGERPRINT_MISMATCH', retryable: false } })
  })

  it('rejects a wrong body hash', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), {}, { content_hash: 'a'.repeat(64) })
    expect(flow.result).toEqual({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH', retryable: false } })
  })

  it('rejects an invalid provider provenance', async () => {
    const flow = await pollJobWithMetadata(freshRequest(), makeTarget(), { provider_provenance: { provider: 'unknown', model: 'unknown', mode: 'unknown', fallback_reason: null } })
    expect(flow.result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })

  it('rejects an article response without body', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { content: '' })
    expect(flow.result).toEqual({ ok: false, error: { code: 'CONTENT_HASH_MISMATCH', retryable: false } })
  })

  it('rejects an article response without completed time', async () => {
    const flow = await pollJobWithMetadata(freshRequest(), makeTarget(), { completed_at: undefined })
    expect(flow.result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })

  it('rejects a wrong task identity in article response', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { task_id: TASK_ID + 1 })
    expect(flow.result).toEqual({ ok: false, error: { code: 'TASK_ID_MISMATCH', retryable: false } })
  })

  it('rejects invented job identity in article response', async () => {
    const flow = await articleFor(freshRequest(), makeTarget(), { job_id: JOB_ID + 1 })
    expect(flow.result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })

  it('rejects article fetch for an unverified fake plan', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (!flow.result.ok) throw new Error('article flow failed')
    const clonedPlan = { ...flow.plan }
    const result = await executeGeoFlowArticleFetch({ plan: clonedPlan, job: flow.job }, responseFor(articleResponse(flow.request)).dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })

  it('rejects article fetch for an unverified fake job', async () => {
    const flow = await articleFor()
    const result = await executeGeoFlowArticleFetch({ plan: flow.plan, job: { ...flow.job } }, responseFor(articleResponse(flow.request)).dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
  })

  it('does not call review route', async () => {
    const flow = await articleFor()
    expect(flow.calls.some((call) => /\/review(?:\?|\/|$)/u.test(call.url))).toBe(false)
  })

  it('does not call publish route', async () => {
    const flow = await articleFor()
    expect(flow.calls.some((call) => /\/publish(?:\?|\/|$)/u.test(call.url))).toBe(false)
  })

  it('uses only three generation routes across the full flow', async () => {
    const request = freshRequest()
    const target = makeTarget()
    const enqueued = await enqueueFor(request, target)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const jobRecorded = responseFor(jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1))
    const job = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, jobRecorded.dependencies)
    expect(job.ok).toBe(true)
    if (!job.ok) throw new Error('poll failed')
    const articleRecorded = responseFor(articleResponse(request, job.value.jobId, job.value.articleId, TASK_ID))
    await executeGeoFlowArticleFetch({ plan: enqueued.plan, job: job.value }, articleRecorded.dependencies)
    const paths = [enqueued.calls[0]?.url, jobRecorded.calls[0]?.url, articleRecorded.calls[0]?.url]
    expect(paths).toEqual([`${BASE_URL}/api/v1/tasks/${TASK_ID}/enqueue`, `${BASE_URL}/api/v1/jobs/${JOB_ID}`, `${BASE_URL}/api/v1/articles/${ARTICLE_ID}`])
  })

  it('validates a successful article transport result through the public validator', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) {
      const validated = validateGeoFlowTransportResult({ request: flow.request, plan: flow.plan, result: flow.result.value })
      expect(validated.ok).toBe(true)
    }
  })

  it('rejects a tampered article transport fingerprint', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) {
      const validated = validateGeoFlowTransportResult({ request: flow.request, result: { ...flow.result.value, requestFingerprint: 'a'.repeat(64) } })
      expect(validated).toEqual({ ok: false, reason: 'REQUEST_FINGERPRINT_MISMATCH', issues: [{ path: '$.result.requestFingerprint', code: 'REQUEST_FINGERPRINT_MISMATCH' }] })
    }
  })

  it('rejects an article transport result for a different request', async () => {
    const flow = await articleFor()
    expect(flow.result.ok).toBe(true)
    if (flow.result.ok) {
      const other = freshRequest()
      const validated = validateGeoFlowTransportResult({ request: other, result: flow.result.value })
      expect(validated.ok).toBe(false)
    }
  })
})

describe('GEOFlow retry, idempotency, and result helpers', () => {
  it('classifies timeout as retryable', () => {
    expect(classifyGeoFlowTransportFailure({ kind: 'timeout' })).toEqual({ code: 'TRANSPORT_TIMEOUT', retryable: true })
  })

  it('classifies network failure as retryable', () => {
    expect(classifyGeoFlowTransportFailure({ kind: 'network' })).toEqual({ code: 'NETWORK_FAILURE', retryable: true })
  })

  it('classifies malformed response as permanent', () => {
    expect(classifyGeoFlowTransportFailure({ kind: 'malformed' })).toEqual({ code: 'RESPONSE_MALFORMED', retryable: false })
  })

  it('classifies identity failure as permanent', () => {
    expect(classifyGeoFlowTransportFailure({ kind: 'identity' })).toEqual({ code: 'RESULT_INVALID', retryable: false })
  })

  it('classifies content hash failure as permanent', () => {
    expect(classifyGeoFlowTransportFailure({ kind: 'hash' })).toEqual({ code: 'CONTENT_HASH_MISMATCH', retryable: false })
  })

  it('classifies 503 as retryable', () => {
    expect(classifyGeoFlowTransportFailure({ status: 503 })).toEqual({ code: 'REMOTE_SERVER_ERROR', retryable: true, httpStatus: 503 })
  })

  it('classifies 422 as non-retryable', () => {
    expect(classifyGeoFlowTransportFailure({ status: 422 })).toEqual({ code: 'REMOTE_UNPROCESSABLE', retryable: false, httpStatus: 422 })
  })

  it('parses a bounded Retry-After', () => {
    expect(parseGeoFlowRetryAfter('12', 60)).toEqual({ ok: true, seconds: 12 })
  })

  it('rejects a non-numeric Retry-After', () => {
    expect(parseGeoFlowRetryAfter('tomorrow', 60)).toEqual({ ok: false, code: 'RETRY_AFTER_INVALID' })
  })

  it('rejects a Retry-After over the bound', () => {
    expect(parseGeoFlowRetryAfter('61', 60)).toEqual({ ok: false, code: 'RETRY_AFTER_INVALID' })
  })

  it('accepts a missing Retry-After', () => {
    expect(parseGeoFlowRetryAfter(undefined, 60)).toEqual({ ok: true, seconds: undefined })
  })

  it('allows retry before the maximum attempt', () => {
    expect(retryAllowedForAttempt(1, { code: 'REMOTE_SERVER_ERROR', retryable: true }, 3)).toBe(true)
  })

  it('disallows retry at the maximum attempt', () => {
    expect(retryAllowedForAttempt(3, { code: 'REMOTE_SERVER_ERROR', retryable: true }, 3)).toBe(false)
  })

  it('disallows retry for permanent error', () => {
    expect(retryAllowedForAttempt(1, { code: 'REMOTE_UNAUTHORIZED', retryable: false }, 3)).toBe(false)
  })

  it('rejects oversized transport text', () => {
    expect(validateGeoFlowTransportText('12345', 4)).toEqual({ ok: false, error: { code: 'RESPONSE_TOO_LARGE', retryable: false } })
  })

  it('accepts bounded Unicode transport text', () => {
    expect(validateGeoFlowTransportText('候選', 10).ok).toBe(true)
  })

  it('rejects NUL transport text', () => {
    expect(validateGeoFlowTransportText('a\u0000b', 10)).toEqual({ ok: false, error: { code: 'RESPONSE_MALFORMED', retryable: false } })
  })

  it('replays the same idempotency pair without a second call', async () => {
    const request = freshRequest()
    const target = makeTarget()
    const recorded = responseFor(enqueueResponse(request))
    const first = await executeGeoFlowEnqueue({ request, target }, recorded.dependencies)
    const second = await executeGeoFlowEnqueue({ request, target }, recorded.dependencies)
    expect(first).toEqual(second)
    expect(recorded.calls).toHaveLength(1)
  })

  it('rejects the same idempotency key with a different request fingerprint', async () => {
    const target = makeTarget()
    const firstRequest = freshRequest({ idempotencyKey: 'shared-runtime-idempotency' })
    const secondRequest = freshRequest({ idempotencyKey: 'shared-runtime-idempotency' })
    const recorded = responseFor(enqueueResponse(firstRequest))
    const first = await executeGeoFlowEnqueue({ request: firstRequest, target }, recorded.dependencies)
    const second = await executeGeoFlowEnqueue({ request: secondRequest, target }, recorded.dependencies)
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, error: { code: 'IDEMPOTENCY_COLLISION', retryable: false } })
    expect(recorded.calls).toHaveLength(1)
  })

  it('coalesces concurrent duplicate enqueue calls', async () => {
    const request = freshRequest()
    const target = makeTarget()
    const calls: GeoFlowRequestInit[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const dependencies = {
      fetch: async (_url: string, init: GeoFlowRequestInit) => {
        calls.push(init)
        await gate
        return enqueueResponse(request)
      },
      credentialResolver: async () => ({ ok: true as const, value: 'C'.repeat(32) }),
      clock: { now: () => '2026-08-26T01:02:03Z' },
    }
    const firstPromise = executeGeoFlowEnqueue({ request, target }, dependencies)
    const secondPromise = executeGeoFlowEnqueue({ request, target }, dependencies)
    release?.()
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(first).toEqual(second)
    expect(calls).toHaveLength(1)
  })

  it('does not include credential in collision error', async () => {
    const target = makeTarget()
    const firstRequest = freshRequest({ idempotencyKey: 'secret-collision-key' })
    const secondRequest = freshRequest({ idempotencyKey: 'secret-collision-key' })
    const recorded = responseFor(enqueueResponse(firstRequest))
    await executeGeoFlowEnqueue({ request: firstRequest, target }, recorded.dependencies)
    const result = await executeGeoFlowEnqueue({ request: secondRequest, target }, recorded.dependencies)
    expect(JSON.stringify(result)).not.toContain('C'.repeat(32))
  })

  it('rejects an article fetch before remote call when job is not terminal', async () => {
    const request = freshRequest()
    const enqueued = await enqueueFor(request)
    expect(enqueued.result.ok).toBe(true)
    if (!enqueued.result.ok) throw new Error('enqueue failed')
    const pendingJob = await executeGeoFlowJobPoll({ plan: enqueued.plan, enqueue: enqueued.result.value }, responseFor(jobResponse(request, enqueued.result.value.jobId, ARTICLE_ID, TASK_ID, 'completed', 1)).dependencies)
    expect(pendingJob.ok).toBe(true)
    if (!pendingJob.ok) throw new Error('poll failed')
    const pending = { ...pendingJob.value, remoteStatus: 'queued' }
    const recorded = responseFor(articleResponse(request, pending.jobId, pending.articleId, TASK_ID))
    const result = await executeGeoFlowArticleFetch({ plan: enqueued.plan, job: pending }, recorded.dependencies)
    expect(result).toEqual({ ok: false, error: { code: 'RESULT_INVALID', retryable: false } })
    expect(recorded.calls).toHaveLength(0)
  })
})
