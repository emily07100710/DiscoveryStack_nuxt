import { createHash } from 'node:crypto'
import {
  deriveExternalArticleKey,
  validateGeoFlowRequest,
  validateGeoFlowResponse,
  verifyGeoFlowLineage,
} from '../geoflow-integration'
import type { ContentArtifact, GeoFlowRequest, GeoFlowResponse, ValidationResult } from '../geoflow-integration'
import { resolveGeoFlowCredentialForTransport } from './credential-contract'
import { normalizeGeoFlowRuntimeTarget } from './normalization'
import { classifyGeoFlowTransportFailure, parseGeoFlowRetryAfter, retryAllowedForAttempt } from './retry-policy'
import { joinGeoFlowPath } from './target-guard'
import type {
  GeoFlowAdapterDependencies,
  GeoFlowArticleInput,
  GeoFlowArticleResult,
  GeoFlowArticleValue,
  GeoFlowEnqueueInput,
  GeoFlowEnqueuePlan,
  GeoFlowEnqueueResult,
  GeoFlowEnqueueValue,
  GeoFlowFailureClassificationInput,
  GeoFlowJobPollResult,
  GeoFlowJobValue,
  GeoFlowPollInput,
  GeoFlowRuntimeTarget,
  GeoFlowTransportError,
  GeoFlowTransportResult,
  GeoFlowTransportValidationInput,
  GeoFlowTransportValidationResult,
} from './types'
import { validateGeoFlowTransportRequest } from './normalization'

const ENQUEUE_PATH = (taskId: number): string => `/api/v1/tasks/${taskId}/enqueue`
const JOB_PATH = (jobId: number): string => `/api/v1/jobs/${jobId}`
const ARTICLE_PATH = (articleId: number): string => `/api/v1/articles/${articleId}`
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu
const MAX_REMOTE_STATUS_LENGTH = 80
const IN_FLIGHT_ENQUEUES = new Map<string, Promise<GeoFlowEnqueueResult>>()
const ENQUEUE_REPLAYS = new Map<string, GeoFlowEnqueueResult>()
const ENQUEUE_KEY_FINGERPRINTS = new Map<string, string>()
const VERIFIED_PLANS = new WeakSet<object>()
const VERIFIED_ENQUEUES = new WeakSet<object>()
const VERIFIED_JOBS = new WeakSet<object>()

type JsonRecord = Record<string, unknown>

type ParsedResponse = { readonly status: number; readonly headers?: Readonly<Record<string, string | undefined>>; readonly data: JsonRecord }

function failure(code: GeoFlowTransportError['code'], options: Partial<Omit<GeoFlowTransportError, 'code' | 'retryable'>> = {}): GeoFlowTransportResult<never> {
  return { ok: false, error: { code, retryable: false, ...options } }
}

function retryableFailure(error: GeoFlowTransportError): GeoFlowTransportResult<never> {
  return { ok: false, error }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeField(record: JsonRecord, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function attempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10
}

function boundedRemoteStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REMOTE_STATUS_LENGTH ? value : undefined
}

function headerValue(headers: Readonly<Record<string, string | undefined>> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value
  return undefined
}

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

function transportErrorFromThrown(error: unknown): GeoFlowTransportError {
  const isTimeout = error instanceof Error && (error.name === 'AbortError' || /timeout|timed out|abort/i.test(error.message))
  return classifyGeoFlowTransportFailure({ kind: isTimeout ? 'timeout' : 'network' })
}

function ensureClock(dependencies: GeoFlowAdapterDependencies): GeoFlowTransportResult<true> {
  if (!dependencies || typeof dependencies.clock?.now !== 'function') return failure('CLOCK_NOT_CONFIGURED')
  try {
    const value = dependencies.clock.now()
    return typeof value === 'string' && value.length > 0 ? { ok: true, value: true } : failure('CLOCK_NOT_CONFIGURED')
  } catch {
    return failure('CLOCK_NOT_CONFIGURED')
  }
}

function ensureDependencies(dependencies: GeoFlowAdapterDependencies): GeoFlowTransportResult<true> {
  if (!dependencies || typeof dependencies.fetch !== 'function') return failure('FETCH_NOT_CONFIGURED')
  if (typeof dependencies.credentialResolver !== 'function') return failure('CREDENTIAL_RESOLUTION_FAILED')
  return ensureClock(dependencies)
}

function planFromInputs(requestInput: unknown, targetInput: unknown): GeoFlowTransportResult<GeoFlowEnqueuePlan> {
  const requestResult = validateGeoFlowTransportRequest(requestInput)
  if (!requestResult.ok) return requestResult
  const targetResult = normalizeGeoFlowRuntimeTarget(targetInput)
  if (!targetResult.ok) return targetResult
  const request = requestResult.value
  const target = targetResult.value
  const path = ENQUEUE_PATH(target.taskId)
  const bodyValue = {
    request_id: request.requestId,
    request_fingerprint: request.requestFingerprint,
    idempotency_key: request.idempotencyKey,
    project_identity: {
      owner_user_id: request.ownerUserId,
      client_id: request.clientId,
      production_plan_id: request.productionPlanId,
    },
    calendar_entry_identity: {
      calendar_entry_id: request.calendarEntryId,
      brief_id: request.briefId,
    },
    deliverable_identity: {
      deliverable_id: request.deliverableId,
      discovery_stack_job_id: request.jobId,
    },
    task_id: target.taskId,
    job_type: 'generate_article',
    evidence_snapshot_hash: request.evidenceSnapshotHash,
    brief_fingerprint: request.briefFingerprint,
    selected_rule_ids: request.selectedRuleIds,
    requested_capabilities: request.requestedCapabilities,
    attempt: target.attempt,
    generation_mode: request.generationMode,
    revision_context: request.revisionContext,
    brief: request.brief,
    content_type: request.contentType,
    language: request.language,
    authority_source_ids: request.authoritySourceIds,
  }
  const body = JSON.stringify(bodyValue)
  const plan: GeoFlowEnqueuePlan = {
    kind: 'enqueue_plan',
    request,
    target,
    method: 'POST',
    path,
    url: joinGeoFlowPath(target.baseUrl, path),
    body,
    bodyHash: sha256Text(body),
    headerNames: ['Accept', 'Authorization', 'Content-Type', 'X-Idempotency-Key', 'X-Request-Id'],
  }
  deepFreeze(plan)
  VERIFIED_PLANS.add(plan)
  return { ok: true, value: plan }
}

export function planGeoFlowEnqueueRequest(requestInput: unknown, targetInput: unknown): GeoFlowTransportResult<GeoFlowEnqueuePlan> {
  return planFromInputs(requestInput, targetInput)
}

function credentialHeaders(token: string, request: GeoFlowRequest): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Idempotency-Key': request.idempotencyKey,
    'X-Request-Id': request.requestId,
  }
}

function getHeaders(token: string, request: GeoFlowRequest): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Idempotency-Key': request.idempotencyKey,
    'X-Request-Id': request.requestId,
  }
}

async function readBoundedResponseText(response: { readonly status: number; readonly headers?: Readonly<Record<string, string | undefined>>; readonly text: () => Promise<string> }, maximumBytes: number): Promise<GeoFlowTransportResult<string>> {
  const contentLength = headerValue(response.headers, 'content-length')
  if (contentLength !== undefined && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) return failure('RESPONSE_TOO_LARGE', { httpStatus: response.status })
  try {
    const text = await response.text()
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maximumBytes) return failure('RESPONSE_TOO_LARGE', { httpStatus: response.status })
    return { ok: true, value: text }
  } catch {
    return failure('RESPONSE_MALFORMED', { httpStatus: response.status })
  }
}

async function readJsonResponse(response: { readonly status: number; readonly headers?: Readonly<Record<string, string | undefined>>; readonly text: () => Promise<string> }, maximumBytes: number): Promise<GeoFlowTransportResult<ParsedResponse>> {
  if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) return failure('RESPONSE_MALFORMED')
  const contentType = headerValue(response.headers, 'content-type')
  if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) return failure('RESPONSE_CONTENT_TYPE_INVALID', { httpStatus: response.status })
  const body = await readBoundedResponseText(response, maximumBytes)
  if (!body.ok) return body
  try {
    const parsed: unknown = JSON.parse(body.value)
    if (!isRecord(parsed)) return failure('RESPONSE_MALFORMED', { httpStatus: response.status })
    return { ok: true, value: { status: response.status, headers: response.headers, data: parsed } }
  } catch {
    return failure('RESPONSE_MALFORMED', { httpStatus: response.status })
  }
}

function responseRequestId(envelope: JsonRecord, data: JsonRecord): unknown {
  const top = safeField(envelope, 'request_id')
  const nested = safeField(data, 'request_id')
  if (top !== undefined && nested !== undefined && top !== nested) return '__mismatch__'
  return top ?? nested
}

function successEnvelope(parsed: ParsedResponse, request: GeoFlowRequest): GeoFlowTransportResult<JsonRecord> {
  if (parsed.status < 200 || parsed.status > 299) return { ok: false, error: classifyGeoFlowTransportFailure({ status: parsed.status, retryAfter: headerValue(undefined, 'retry-after') }) }
  if (safeField(parsed.data, 'success') !== true) return failure('RESPONSE_ENVELOPE_INVALID', { httpStatus: parsed.status })
  const data = safeField(parsed.data, 'data')
  if (!isRecord(data)) return failure('RESPONSE_ENVELOPE_INVALID', { httpStatus: parsed.status })
  const requestId = responseRequestId(parsed.data, data)
  if (requestId === '__mismatch__') return failure('REQUEST_ID_MISMATCH', { httpStatus: parsed.status })
  if (requestId !== request.requestId) return failure('REQUEST_ID_MISMATCH', { httpStatus: parsed.status })
  return { ok: true, value: data }
}

function statusError(parsed: ParsedResponse, maximumRetryAfterSeconds: number): GeoFlowTransportResult<never> {
  const retryAfterHeader = headerValue(parsed.headers, 'retry-after')
  const retryAfter = parseGeoFlowRetryAfter(retryAfterHeader, maximumRetryAfterSeconds)
  if (parsed.status === 429 && !retryAfter.ok) return failure('RETRY_AFTER_INVALID', { httpStatus: parsed.status })
  const classificationInput: GeoFlowFailureClassificationInput = { status: parsed.status, ...(retryAfterHeader === undefined ? {} : { retryAfter: retryAfterHeader }) }
  const error = classifyGeoFlowTransportFailure(classificationInput)
  if (parsed.status === 429 && retryAfter.ok && retryAfter.seconds !== undefined) return { ok: false, error: { ...error, retryAfterSeconds: retryAfter.seconds } }
  return { ok: false, error }
}

async function callJson(
  url: string,
  init: { readonly method: 'GET' | 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs: number },
  dependencies: GeoFlowAdapterDependencies,
  maximumBytes: number,
  maximumRetryAfterSeconds: number,
): Promise<GeoFlowTransportResult<ParsedResponse>> {
  try {
    const response = await dependencies.fetch(url, { ...init, redirect: 'manual' })
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) return failure('RESPONSE_MALFORMED')
    if (response.status >= 300 && response.status <= 399) return { ok: false, error: classifyGeoFlowTransportFailure({ status: response.status }) }
    if (response.status < 200 || response.status > 299) {
      const bounded = await readBoundedResponseText(response, maximumBytes)
      if (!bounded.ok) return bounded
      return statusError({ status: response.status, headers: response.headers, data: {} }, maximumRetryAfterSeconds)
    }
    return readJsonResponse(response, maximumBytes)
  } catch (error) {
    return { ok: false, error: transportErrorFromThrown(error) }
  }
}

async function callWithRetries(
  url: string,
  init: { readonly method: 'GET' | 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs: number },
  target: GeoFlowRuntimeTarget,
  dependencies: GeoFlowAdapterDependencies,
): Promise<GeoFlowTransportResult<ParsedResponse>> {
  let transportAttempt = 1
  while (true) {
    const response = await callJson(url, init, dependencies, target.maxResponseBodyBytes, target.maxRetryAfterSeconds)
    if (response.ok) return response
    if (!retryAllowedForAttempt(transportAttempt, response.error, target.maxAttempts)) return response
    const waitMilliseconds = response.error.retryAfterSeconds === undefined ? target.pollIntervalMs : response.error.retryAfterSeconds * 1_000
    await sleepFunction(dependencies)(waitMilliseconds)
    transportAttempt += 1
  }
}

function enqueueValueFromData(data: JsonRecord, plan: GeoFlowEnqueuePlan): GeoFlowTransportResult<GeoFlowEnqueueValue> {
  const taskId = safeField(data, 'task_id')
  const jobId = safeField(data, 'job_id')
  if (!positiveInteger(taskId)) return failure('TASK_ID_MISSING')
  if (taskId !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (!positiveInteger(jobId)) return failure('JOB_ID_MISSING')
  const remoteRequestId = safeField(data, 'request_id')
  if (remoteRequestId !== undefined && remoteRequestId !== plan.request.requestId) return failure('REQUEST_ID_MISMATCH')
  const remoteStatus = boundedRemoteStatus(safeField(data, 'status')) ?? 'accepted'
  const value: GeoFlowEnqueueValue = {
    kind: 'enqueued',
    requestFingerprint: plan.request.requestFingerprint,
    requestId: plan.request.requestId,
    taskId,
    jobId,
    attempt: plan.target.attempt,
    remoteRequestId: plan.request.requestId,
    remoteStatus,
  }
  deepFreeze(value)
  VERIFIED_ENQUEUES.add(value)
  return { ok: true, value }
}

async function performEnqueue(plan: GeoFlowEnqueuePlan, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowEnqueueResult> {
  const credential = await resolveGeoFlowCredentialForTransport(plan.target.credentialReference, dependencies.credentialResolver)
  if (!credential.ok) return credential.error.code === 'CREDENTIAL_REFERENCE_INVALID' ? failure('CREDENTIAL_REFERENCE_INVALID') : failure('CREDENTIAL_RESOLUTION_FAILED')
  const response = await callWithRetries(
    plan.url,
    { method: 'POST', headers: credentialHeaders(credential.token, plan.request), body: plan.body, timeoutMs: plan.target.timeoutMs },
    plan.target,
    dependencies,
  )
  if (!response.ok) return response
  const envelope = successEnvelope(response.value, plan.request)
  if (!envelope.ok) return envelope
  return enqueueValueFromData(envelope.value, plan)
}

export async function executeGeoFlowEnqueue(input: GeoFlowEnqueueInput, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowEnqueueResult> {
  const plan = planFromInputs(input?.request, input?.target)
  if (!plan.ok) return plan
  const dependencyCheck = ensureDependencies(dependencies)
  if (!dependencyCheck.ok) return dependencyCheck
  const requestKey = plan.value.request.idempotencyKey
  const pairKey = `${requestKey}\u0000${plan.value.request.requestFingerprint}`
  const existingFingerprint = ENQUEUE_KEY_FINGERPRINTS.get(requestKey)
  if (existingFingerprint !== undefined && existingFingerprint !== plan.value.request.requestFingerprint) return failure('IDEMPOTENCY_COLLISION')
  const replay = ENQUEUE_REPLAYS.get(pairKey)
  if (replay) return replay
  const existing = IN_FLIGHT_ENQUEUES.get(pairKey)
  if (existing) return existing
  ENQUEUE_KEY_FINGERPRINTS.set(requestKey, plan.value.request.requestFingerprint)
  const promise = performEnqueue(plan.value, dependencies).then((result) => {
    if (result.ok) ENQUEUE_REPLAYS.set(pairKey, result)
    return result
  })
  IN_FLIGHT_ENQUEUES.set(pairKey, promise)
  try {
    return await promise
  } finally {
    if (IN_FLIGHT_ENQUEUES.get(pairKey) === promise) IN_FLIGHT_ENQUEUES.delete(pairKey)
  }
}

function validateEnqueueValue(value: unknown, plan: GeoFlowEnqueuePlan): GeoFlowTransportResult<GeoFlowEnqueueValue> {
  if (!isRecord(value) || safeField(value, 'kind') !== 'enqueued') return failure('RESULT_INVALID')
  if (safeField(value, 'requestFingerprint') !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (safeField(value, 'requestId') !== plan.request.requestId) return failure('REQUEST_ID_MISMATCH')
  if (safeField(value, 'taskId') !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (!positiveInteger(safeField(value, 'jobId'))) return failure('JOB_ID_MISSING')
  if (!attempt(safeField(value, 'attempt')) || safeField(value, 'attempt') !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  return { ok: true, value: value as unknown as GeoFlowEnqueueValue }
}

function sleepFunction(dependencies: GeoFlowAdapterDependencies): (milliseconds: number) => Promise<void> {
  return dependencies.sleep ?? (async () => undefined)
}

function statusFromJob(data: JsonRecord): string | undefined {
  return boundedRemoteStatus(safeField(data, 'status'))
}

function validateJobIdentity(data: JsonRecord, plan: GeoFlowEnqueuePlan, enqueue: GeoFlowEnqueueValue): GeoFlowTransportResult<true> {
  if (safeField(data, 'task_id') !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (safeField(data, 'job_id') !== enqueue.jobId) return failure('JOB_ID_MISMATCH')
  const requestId = safeField(data, 'request_id')
  if (requestId !== undefined && requestId !== plan.request.requestId) return failure('REQUEST_ID_MISMATCH')
  const requestFingerprint = safeField(data, 'request_fingerprint')
  if (requestFingerprint !== undefined && requestFingerprint !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  const responseAttempt = safeField(data, 'attempt')
  if (!attempt(responseAttempt) || responseAttempt !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  return { ok: true, value: true }
}

function jobValueFromData(data: JsonRecord, plan: GeoFlowEnqueuePlan, enqueue: GeoFlowEnqueueValue): GeoFlowTransportResult<GeoFlowJobValue> {
  const identity = validateJobIdentity(data, plan, enqueue)
  if (!identity.ok) return identity
  const articleId = safeField(data, 'article_id')
  if (!positiveInteger(articleId)) return failure('ARTICLE_ID_MISSING')
  const remoteStatus = statusFromJob(data)
  if (!remoteStatus) return failure('STATUS_INVALID')
  const value: GeoFlowJobValue = {
    kind: 'job_completed',
    requestFingerprint: plan.request.requestFingerprint,
    requestId: plan.request.requestId,
    taskId: plan.target.taskId,
    jobId: enqueue.jobId,
    articleId,
    attempt: plan.target.attempt,
    remoteRequestId: plan.request.requestId,
    remoteStatus,
  }
  deepFreeze(value)
  VERIFIED_JOBS.add(value)
  return { ok: true, value }
}

function isTerminalJobStatus(status: string): boolean {
  return ['completed', 'succeeded', 'success', 'draft_ready', 'review_required', 'ready', 'candidate'].includes(status.toLowerCase())
}

function isFailedJobStatus(status: string): boolean {
  return ['failed', 'blocked', 'cancelled', 'canceled'].includes(status.toLowerCase())
}

async function performJobPoll(plan: GeoFlowEnqueuePlan, enqueue: GeoFlowEnqueueValue, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowJobPollResult> {
  if (!isRecord(enqueue) || !VERIFIED_ENQUEUES.has(enqueue)) return failure('RESULT_INVALID')
  const validatedEnqueue = validateEnqueueValue(enqueue, plan)
  if (!validatedEnqueue.ok) return validatedEnqueue
  const dependencyCheck = ensureDependencies(dependencies)
  if (!dependencyCheck.ok) return dependencyCheck
  const credential = await resolveGeoFlowCredentialForTransport(plan.target.credentialReference, dependencies.credentialResolver)
  if (!credential.ok) return failure('CREDENTIAL_RESOLUTION_FAILED')
  let transportAttempt = 1
  let pollCount = 0
  while (pollCount < plan.target.maxPolls) {
    pollCount += 1
    const response = await callJson(
      joinGeoFlowPath(plan.target.baseUrl, JOB_PATH(enqueue.jobId)),
      { method: 'GET', headers: getHeaders(credential.token, plan.request), timeoutMs: plan.target.timeoutMs },
      dependencies,
      plan.target.maxResponseBodyBytes,
      plan.target.maxRetryAfterSeconds,
    )
    if (!response.ok) {
      if (retryAllowedForAttempt(transportAttempt, response.error, plan.target.maxAttempts)) {
        const waitSeconds = response.error.retryAfterSeconds
        await sleepFunction(dependencies)(waitSeconds === undefined ? plan.target.pollIntervalMs : waitSeconds * 1_000)
        transportAttempt += 1
        continue
      }
      return retryableFailure(response.error)
    }
    transportAttempt = 1
    const envelope = successEnvelope(response.value, plan.request)
    if (!envelope.ok) return envelope
    const status = statusFromJob(envelope.value)
    if (!status) return failure('STATUS_INVALID')
    if (isFailedJobStatus(status)) return failure('REMOTE_REJECTED')
    if (isTerminalJobStatus(status)) return jobValueFromData(envelope.value, plan, enqueue)
    await sleepFunction(dependencies)(plan.target.pollIntervalMs)
  }
  return failure('POLL_LIMIT_EXCEEDED')
}

export async function executeGeoFlowJobPoll(input: GeoFlowPollInput, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowJobPollResult> {
  if (!isRecord(input)) return failure('RESULT_INVALID')
  const plan = safeField(input, 'plan')
  const enqueue = safeField(input, 'enqueue')
  if (!isRecord(plan) || safeField(plan, 'kind') !== 'enqueue_plan' || !VERIFIED_PLANS.has(plan)) return failure('RESULT_INVALID')
  if (!isRecord(enqueue) || !VERIFIED_ENQUEUES.has(enqueue)) return failure('RESULT_INVALID')
  return performJobPoll(plan as unknown as GeoFlowEnqueuePlan, enqueue as unknown as GeoFlowEnqueueValue, dependencies)
}

function validateJobValue(value: unknown, plan: GeoFlowEnqueuePlan): GeoFlowTransportResult<GeoFlowJobValue> {
  if (!isRecord(value) || !VERIFIED_JOBS.has(value) || safeField(value, 'kind') !== 'job_completed') return failure('RESULT_INVALID')
  if (safeField(value, 'requestFingerprint') !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (safeField(value, 'requestId') !== plan.request.requestId) return failure('REQUEST_ID_MISMATCH')
  if (safeField(value, 'taskId') !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (!positiveInteger(safeField(value, 'jobId'))) return failure('JOB_ID_MISSING')
  if (!positiveInteger(safeField(value, 'articleId'))) return failure('ARTICLE_ID_MISSING')
  if (!attempt(safeField(value, 'attempt')) || safeField(value, 'attempt') !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  return { ok: true, value: value as unknown as GeoFlowJobValue }
}

function asString(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = safeField(record, key)
    if (typeof value === 'string') return value
  }
  return undefined
}

function asStringArray(record: JsonRecord, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = safeField(record, key)
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[]
  }
  return undefined
}

function mapCitation(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined
  const sourceId = asString(value, 'sourceId', 'source_id')
  const artifactId = asString(value, 'artifactId', 'artifact_id')
  const chunkId = asString(value, 'chunkId', 'chunk_id')
  const chunkHash = asString(value, 'chunkHash', 'chunk_hash')
  return sourceId && artifactId && chunkId && chunkHash ? { sourceId, artifactId, chunkId, chunkHash } : undefined
}

function candidateStatus(value: unknown): 'draft_ready' | 'review_required' | undefined {
  if (typeof value !== 'string') return undefined
  const status = value.toLowerCase()
  if (['approved', 'published', 'delivered', 'publishing', 'ready_to_publish'].includes(status)) return undefined
  if (['review_required', 'needs_review', 'candidate_review'].includes(status)) return 'review_required'
  if (['candidate', 'draft', 'draft_ready', 'completed', 'succeeded', 'success'].includes(status)) return 'draft_ready'
  return undefined
}

function candidateResponseFromData(data: JsonRecord, plan: GeoFlowEnqueuePlan, job: GeoFlowJobValue): GeoFlowTransportResult<GeoFlowResponse> {
  const identity = validateJobIdentity(data, plan, {
    kind: 'enqueued',
    requestFingerprint: plan.request.requestFingerprint,
    requestId: plan.request.requestId,
    taskId: plan.target.taskId,
    jobId: job.jobId,
    attempt: plan.target.attempt,
    remoteRequestId: plan.request.requestId,
    remoteStatus: job.remoteStatus,
  })
  if (!identity.ok) return identity
  if (safeField(data, 'article_id') !== job.articleId) return failure('ARTICLE_ID_MISMATCH')
  const remoteFingerprint = safeField(data, 'request_fingerprint')
  if (remoteFingerprint !== undefined && remoteFingerprint !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  const remoteProjectId = safeField(data, 'project_id')
  if (remoteProjectId !== undefined && remoteProjectId !== plan.request.productionPlanId) return failure('IDENTITY_MISMATCH')
  const remoteTaskId = safeField(data, 'task_id')
  if (remoteTaskId !== undefined && remoteTaskId !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  const externalArticleKey = deriveExternalArticleKey(plan.request)
  const remoteArticleKey = asString(data, 'external_article_key', 'externalArticleKey', 'article_key')
  if (remoteArticleKey !== undefined && remoteArticleKey !== externalArticleKey) return failure('ARTICLE_ID_MISMATCH')
  const status = candidateStatus(safeField(data, 'status'))
  if (safeField(data, 'status') !== undefined && !status) return failure('PUBLICATION_STATE_REJECTED')
  if (!status) return failure('STATUS_INVALID')
  const bodyMarkdown = asString(data, 'body_markdown', 'bodyMarkdown', 'content', 'body')
  const title = asString(data, 'title')
  const summary = asString(data, 'summary', 'excerpt')
  const suppliedBodyHash = asString(data, 'body_hash', 'bodyHash', 'content_hash', 'contentHash')
  const evidenceSnapshotHash = asString(data, 'evidence_snapshot_hash', 'evidenceSnapshotHash')
  const briefFingerprint = asString(data, 'brief_fingerprint', 'briefFingerprint')
  const completedAt = asString(data, 'completed_at', 'completedAt')
  const appliedRuleIds = asStringArray(data, 'applied_rule_ids', 'appliedRuleIds')
  const limitations = asStringArray(data, 'limitations')
  if (!bodyMarkdown || !title || !summary || !suppliedBodyHash || !evidenceSnapshotHash || !briefFingerprint || !completedAt || !appliedRuleIds || !limitations) return failure('RESULT_INVALID')
  const computedBodyHash = sha256Text(bodyMarkdown)
  if (suppliedBodyHash !== computedBodyHash) return failure('CONTENT_HASH_MISMATCH')
  if (evidenceSnapshotHash !== plan.request.evidenceSnapshotHash) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (briefFingerprint !== plan.request.briefFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  const citationInput = safeField(data, 'citation_bindings') ?? safeField(data, 'citationBindings')
  if (!Array.isArray(citationInput)) return failure('RESULT_INVALID')
  const citationBindings = citationInput.map(mapCitation)
  if (citationBindings.some((item) => item === undefined)) return failure('RESULT_INVALID')
  const provider = safeField(data, 'provider_provenance') ?? safeField(data, 'providerProvenance')
  if (!isRecord(provider)) return failure('RESULT_INVALID')
  const providerName = asString(provider, 'provider')
  const model = asString(provider, 'model')
  const mode = asString(provider, 'mode')
  const fallbackReason = safeField(provider, 'fallbackReason') ?? safeField(provider, 'fallback_reason')
  if (!providerName || !model || !mode || (fallbackReason !== null && typeof fallbackReason !== 'string')) return failure('RESULT_INVALID')
  const contentArtifact: ContentArtifact = {
    schemaVersion: 'geoflow-content-artifact-v1',
    contentType: plan.request.contentType,
    language: plan.request.language,
    title,
    summary,
    bodyMarkdown,
    bodyHash: computedBodyHash,
  }
  const response: GeoFlowResponse = {
    protocolVersion: plan.request.protocolVersion,
    requestId: plan.request.requestId,
    idempotencyKey: plan.request.idempotencyKey,
    requestFingerprint: plan.request.requestFingerprint,
    ownerUserId: plan.request.ownerUserId,
    clientId: plan.request.clientId,
    jobId: plan.request.jobId,
    externalProjectKey: `project-${plan.request.productionPlanId}`,
    externalTaskKey: `task-${plan.target.taskId}`,
    externalJobKey: `job-${job.jobId}`,
    externalArticleKey,
    attempt: plan.target.attempt,
    status,
    draftIdentity: { externalArticleKey, briefFingerprint },
    contentArtifact,
    evidenceSnapshotHash,
    citationBindings: citationBindings as Array<{ sourceId: string; artifactId: string; chunkId: string; chunkHash: string }>,
    appliedRuleIds,
    providerProvenance: {
      provider: providerName,
      model,
      mode: mode as 'provider' | 'deterministic_scaffold' | 'reference_fallback',
      fallbackReason: fallbackReason as string | null,
    },
    limitations,
    completedAt,
  }
  const validated = validateGeoFlowResponse(response, plan.request)
  if (!validated.ok) return failure('RESULT_INVALID', { contractReason: validated.reason })
  const lineage = verifyGeoFlowLineage(plan.request, validated.value)
  if (!lineage.ok) return failure('RESULT_INVALID', { contractReason: lineage.reason })
  return { ok: true, value: validated.value }
}

async function performArticleFetch(plan: GeoFlowEnqueuePlan, job: GeoFlowJobValue, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowArticleResult> {
  const validatedJob = validateJobValue(job, plan)
  if (!validatedJob.ok) return validatedJob
  if (!isTerminalJobStatus(job.remoteStatus)) return failure('ARTICLE_NOT_READY')
  const dependencyCheck = ensureDependencies(dependencies)
  if (!dependencyCheck.ok) return dependencyCheck
  const credential = await resolveGeoFlowCredentialForTransport(plan.target.credentialReference, dependencies.credentialResolver)
  if (!credential.ok) return failure('CREDENTIAL_RESOLUTION_FAILED')
  const response = await callWithRetries(
    joinGeoFlowPath(plan.target.baseUrl, ARTICLE_PATH(job.articleId)),
    { method: 'GET', headers: getHeaders(credential.token, plan.request), timeoutMs: plan.target.timeoutMs },
    plan.target,
    dependencies,
  )
  if (!response.ok) return response
  const envelope = successEnvelope(response.value, plan.request)
  if (!envelope.ok) return envelope
  const candidate = candidateResponseFromData(envelope.value, plan, job)
  if (!candidate.ok) return candidate
  return {
    ok: true,
    value: {
      kind: 'article_candidate',
      requestFingerprint: plan.request.requestFingerprint,
      requestId: plan.request.requestId,
      taskId: plan.target.taskId,
      jobId: job.jobId,
      articleId: job.articleId,
      attempt: plan.target.attempt,
      response: candidate.value,
    },
  }
}

export async function executeGeoFlowArticleFetch(input: GeoFlowArticleInput, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowArticleResult> {
  if (!isRecord(input)) return failure('RESULT_INVALID')
  const plan = safeField(input, 'plan')
  const job = safeField(input, 'job')
  if (!isRecord(plan) || safeField(plan, 'kind') !== 'enqueue_plan' || !VERIFIED_PLANS.has(plan)) return failure('RESULT_INVALID')
  if (!isRecord(job) || !VERIFIED_JOBS.has(job)) return failure('RESULT_INVALID')
  return performArticleFetch(plan as unknown as GeoFlowEnqueuePlan, job as GeoFlowJobValue, dependencies)
}

export function validateGeoFlowTransportResult(input: GeoFlowTransportValidationInput): GeoFlowTransportValidationResult {
  if (!isRecord(input)) return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$', code: 'INVALID_INPUT' }] }
  const requestResult = validateGeoFlowRequest(safeField(input, 'request'))
  if (!requestResult.ok) return requestResult
  const result = safeField(input, 'result')
  if (!isRecord(result) || safeField(result, 'kind') !== 'article_candidate') return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$.result', code: 'INVALID_INPUT' }] }
  const response = safeField(result, 'response')
  const responseResult = validateGeoFlowResponse(response, requestResult.value)
  if (!responseResult.ok) return responseResult
  const lineage = verifyGeoFlowLineage(requestResult.value, responseResult.value)
  if (!lineage.ok) return lineage
  if (safeField(result, 'requestFingerprint') !== requestResult.value.requestFingerprint) return { ok: false, reason: 'REQUEST_FINGERPRINT_MISMATCH', issues: [{ path: '$.result.requestFingerprint', code: 'REQUEST_FINGERPRINT_MISMATCH' }] }
  return responseResult
}
