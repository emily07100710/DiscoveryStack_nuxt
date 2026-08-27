import { createHash } from 'node:crypto'
import {
  deriveExternalArticleKey,
  validateGeoFlowRequest,
  validateGeoFlowResponse,
  verifyGeoFlowLineage,
} from '../geoflow-integration'
import type { ContentArtifact, GeoFlowRequest, GeoFlowResponse, ValidationResult } from '../geoflow-integration'
import { resolveGeoFlowCredentialForTransport } from './credential-contract'
import { normalizeGeoFlowRuntimeTarget, validateGeoFlowTransportRequest } from './normalization'
import { classifyGeoFlowTransportFailure, parseGeoFlowRetryAfter, retryAllowedForAttempt } from './retry-policy'
import { joinGeoFlowPath } from './target-guard'
import type {
  GeoFlowAdapterDependencies,
  GeoFlowArticleInput,
  GeoFlowArticleResult,
  GeoFlowEnqueueInput,
  GeoFlowEnqueuePlan,
  GeoFlowEnqueueResult,
  GeoFlowEnqueueValue,
  GeoFlowFailureClassificationInput,
  GeoFlowFetchResponse,
  GeoFlowJobPollResult,
  GeoFlowJobResultMetadata,
  GeoFlowJobValue,
  GeoFlowRuntimeTarget,
  GeoFlowTransportError,
  GeoFlowTransportResult,
  GeoFlowTransportValidationInput,
  GeoFlowTransportValidationResult,
} from './types'

const ENQUEUE_PATH = (taskId: number): string => `/api/v1/tasks/${taskId}/enqueue`
const JOB_PATH = (jobId: number): string => `/api/v1/jobs/${jobId}`
const ARTICLE_PATH = (articleId: number): string => `/api/v1/articles/${articleId}`
const DISCOVERY_STACK_JOB_TYPE = 'discoverystack_generate_article_v1'
const AUTO_GEO_NOT_EXECUTED_LIMITATION = 'AutoGEO optimization has not been executed; this is a base draft.'
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const MAX_REMOTE_STATUS_LENGTH = 80
const CLOCK_SKEW_MS = 5 * 60 * 1_000
const MAX_REPLAY_ENTRIES = 1024
const REPLAY_TTL_MS = 15 * 60 * 1_000
const IN_FLIGHT_ENQUEUES = new Map<string, Promise<GeoFlowEnqueueResult>>()
type ReplayRecord = { readonly result: GeoFlowEnqueueResult; readonly expiresAtMs: number }
type TargetBindingRecord = { readonly targetFingerprint: string; readonly expiresAtMs: number }
const ENQUEUE_REPLAYS = new Map<string, ReplayRecord>()
const ENQUEUE_KEY_FINGERPRINTS = new Map<string, { readonly requestFingerprint: string; readonly expiresAtMs: number }>()
const ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS = new Map<string, TargetBindingRecord>()
const VERIFIED_PLANS = new WeakSet<object>()
const VERIFIED_ENQUEUES = new WeakSet<object>()
const VERIFIED_JOBS = new WeakSet<object>()

const JOB_PAYLOAD_KEYS = [
  'protocol_version', 'request_id', 'request_fingerprint', 'idempotency_key', 'owner_user_id', 'client_id',
  'calendar_entry_id', 'production_plan_id', 'deliverable_id', 'brief_id', 'discovery_stack_job_id',
  'evidence_snapshot_hash', 'brief_fingerprint', 'brief', 'content_type', 'language', 'generation_mode',
  'revision_context', 'requested_capabilities', 'selected_rule_ids', 'authority_source_ids', 'evidence_chunks',
  'created_at', 'attempt', 'external_article_key',
] as const
const JOB_RESULT_KEYS = [
  'request_id', 'request_fingerprint', 'brief_fingerprint', 'evidence_snapshot_hash', 'external_article_key',
  'requested_rule_ids', 'autogeo_execution',
  'attempt', 'content_hash', 'citation_bindings', 'applied_rule_ids', 'provider_provenance', 'limitations', 'completed_at',
] as const
const CITATION_KEYS = ['marker', 'source_id', 'artifact_id', 'chunk_id', 'chunk_hash'] as const
const PROVIDER_KEYS = ['provider', 'model', 'mode', 'fallback_reason'] as const
const INVENTED_JOB_FIELDS = ['job_id', 'request_id', 'request_fingerprint', 'attempt', 'article_id'] as const
const INVENTED_ARTICLE_FIELDS = [
  'body_hash', 'brief_fingerprint', 'evidence_snapshot_hash', 'provider_provenance', 'citation_bindings',
  'applied_rule_ids', 'request_fingerprint', 'job_id', 'article_id', 'external_article_key',
] as const

type JsonRecord = Record<string, unknown>
type ParsedResponse = { readonly status: number; readonly headers?: Readonly<Record<string, string | undefined>>; readonly data: JsonRecord }
type JobContext = { readonly payloadRequest: GeoFlowRequest; readonly articleId: number | null; readonly status: string; readonly summary: JsonRecord }

function failure(code: GeoFlowTransportError['code'], options: Partial<Omit<GeoFlowTransportError, 'code' | 'retryable'>> = {}): GeoFlowTransportResult<never> {
  return { ok: false, error: { code, retryable: false, ...options } }
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

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function attempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10
}

function boundedRemoteStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REMOTE_STATUS_LENGTH ? value : undefined
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
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

function hasExactKeys(record: JsonRecord, expected: readonly string[]): boolean {
  try {
    const keys = Object.keys(record).sort()
    return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
  } catch {
    return false
  }
}

function pruneEnqueueState(nowMs: number): void {
  for (const [key, record] of ENQUEUE_REPLAYS) if (record.expiresAtMs <= nowMs) ENQUEUE_REPLAYS.delete(key)
  for (const [key, record] of ENQUEUE_KEY_FINGERPRINTS) if (record.expiresAtMs <= nowMs) ENQUEUE_KEY_FINGERPRINTS.delete(key)
  for (const [key, record] of ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS) if (record.expiresAtMs <= nowMs) ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS.delete(key)
  while (ENQUEUE_REPLAYS.size > MAX_REPLAY_ENTRIES) {
    const oldest = ENQUEUE_REPLAYS.keys().next().value
    if (typeof oldest !== 'string') break
    ENQUEUE_REPLAYS.delete(oldest)
  }
  while (ENQUEUE_KEY_FINGERPRINTS.size > MAX_REPLAY_ENTRIES) {
    const oldest = ENQUEUE_KEY_FINGERPRINTS.keys().next().value
    if (typeof oldest !== 'string') break
    ENQUEUE_KEY_FINGERPRINTS.delete(oldest)
  }
  while (ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS.size > MAX_REPLAY_ENTRIES) {
    const oldest = ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS.keys().next().value
    if (typeof oldest !== 'string') break
    ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS.delete(oldest)
  }
}

function transportErrorFromThrown(error: unknown): GeoFlowTransportError {
  const isTimeout = error instanceof Error && (error.name === 'AbortError' || /timeout|timed out|abort/i.test(error.message))
  return classifyGeoFlowTransportFailure({ kind: isTimeout ? 'timeout' : 'network' })
}

function clockMilliseconds(dependencies: GeoFlowAdapterDependencies): GeoFlowTransportResult<number> {
  if (!dependencies || typeof dependencies.clock?.now !== 'function') return failure('CLOCK_NOT_CONFIGURED')
  try {
    const value = dependencies.clock.now()
    const milliseconds = typeof value === 'string' && value.length > 0 ? Date.parse(value) : Number.NaN
    return Number.isFinite(milliseconds) ? { ok: true, value: milliseconds } : failure('CLOCK_NOT_CONFIGURED')
  } catch {
    return failure('CLOCK_NOT_CONFIGURED')
  }
}

function ensureDependencies(dependencies: GeoFlowAdapterDependencies): GeoFlowTransportResult<true> {
  if (!dependencies || typeof dependencies.fetch !== 'function') return failure('FETCH_NOT_CONFIGURED')
  if (typeof dependencies.credentialResolver !== 'function') return failure('CREDENTIAL_RESOLUTION_FAILED')
  if (typeof dependencies.clock?.now !== 'function') return failure('CLOCK_NOT_CONFIGURED')
  return { ok: true, value: true }
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
    protocol_version: request.protocolVersion,
    request_id: request.requestId,
    request_fingerprint: request.requestFingerprint,
    idempotency_key: request.idempotencyKey,
    owner_user_id: request.ownerUserId,
    client_id: request.clientId,
    calendar_entry_id: request.calendarEntryId,
    production_plan_id: request.productionPlanId,
    deliverable_id: request.deliverableId,
    brief_id: request.briefId,
    discovery_stack_job_id: request.jobId,
    evidence_snapshot_hash: request.evidenceSnapshotHash,
    brief_fingerprint: request.briefFingerprint,
    brief: request.brief,
    content_type: request.contentType,
    language: request.language,
    generation_mode: request.generationMode,
    revision_context: request.revisionContext,
    requested_capabilities: request.requestedCapabilities,
    selected_rule_ids: request.selectedRuleIds,
    authority_source_ids: request.authoritySourceIds,
    evidence_chunks: request.evidenceChunks.map((chunk) => ({
      source_id: chunk.sourceId,
      artifact_id: chunk.artifactId,
      chunk_id: chunk.chunkId,
      chunk_hash: chunk.chunkHash,
      reviewed_text: chunk.reviewedText,
      locator: chunk.locator,
    })),
    created_at: request.createdAt,
    attempt: target.attempt,
    external_article_key: deriveExternalArticleKey(request),
    job_type: DISCOVERY_STACK_JOB_TYPE,
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

async function readBoundedResponseText(response: GeoFlowFetchResponse, maximumBytes: number): Promise<GeoFlowTransportResult<string>> {
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

async function readJsonResponse(response: GeoFlowFetchResponse, maximumBytes: number): Promise<GeoFlowTransportResult<ParsedResponse>> {
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

function responseRequestId(envelope: JsonRecord, data: JsonRecord, meta: JsonRecord): unknown {
  const values = [safeField(envelope, 'request_id'), safeField(data, 'request_id'), safeField(meta, 'request_id')].filter((value): value is string => value !== undefined)
  if (values.some((value) => typeof value !== 'string') || new Set(values).size > 1) return '__mismatch__'
  return values[0]
}

function responseTimestamp(meta: JsonRecord, request: GeoFlowRequest, nowMs: number): GeoFlowTransportResult<true> {
  const timestamp = safeField(meta, 'timestamp')
  if (typeof timestamp !== 'string') return failure('RESPONSE_ENVELOPE_INVALID')
  const timestampMs = Date.parse(timestamp)
  const requestMs = Date.parse(request.createdAt)
  if (!Number.isFinite(timestampMs) || !Number.isFinite(requestMs) || timestampMs < requestMs || timestampMs > nowMs + CLOCK_SKEW_MS) return failure('REQUEST_TIME_INVALID')
  return { ok: true, value: true }
}

function successEnvelope(parsed: ParsedResponse, request: GeoFlowRequest, nowMs: number): GeoFlowTransportResult<JsonRecord> {
  if (parsed.status < 200 || parsed.status > 299) return { ok: false, error: classifyGeoFlowTransportFailure({ status: parsed.status }) }
  if (safeField(parsed.data, 'success') !== true || safeField(parsed.data, 'error') !== null) return failure('RESPONSE_ENVELOPE_INVALID', { httpStatus: parsed.status })
  const data = safeField(parsed.data, 'data')
  const meta = safeField(parsed.data, 'meta')
  if (!isRecord(data) || !isRecord(meta)) return failure('RESPONSE_ENVELOPE_INVALID', { httpStatus: parsed.status })
  const requestId = responseRequestId(parsed.data, data, meta)
  if (requestId === '__mismatch__') return failure('REQUEST_ID_MISMATCH', { httpStatus: parsed.status })
  if (typeof requestId !== 'string') return failure('REMOTE_REQUEST_ID_MISSING', { httpStatus: parsed.status })
  if (requestId !== request.requestId) return failure('REQUEST_ID_MISMATCH', { httpStatus: parsed.status })
  const timestampResult = responseTimestamp(meta, request, nowMs)
  if (!timestampResult.ok) return timestampResult
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

type CallInit = { readonly method: 'GET' | 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs: number }

async function callJson(
  url: string,
  init: CallInit,
  dependencies: GeoFlowAdapterDependencies,
  maximumBytes: number,
  maximumRetryAfterSeconds: number,
): Promise<GeoFlowTransportResult<ParsedResponse>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    const response = await dependencies.fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) return failure('RESPONSE_MALFORMED')
    if (response.status >= 300 && response.status <= 399) return { ok: false, error: { code: 'REDIRECT_BLOCKED', retryable: false, httpStatus: response.status } }
    if (response.status < 200 || response.status > 299) {
      const bounded = await readBoundedResponseText(response, maximumBytes)
      if (!bounded.ok) return bounded
      return statusError({ status: response.status, headers: response.headers, data: {} }, maximumRetryAfterSeconds)
    }
    return readJsonResponse(response, maximumBytes)
  } catch (error) {
    return { ok: false, error: transportErrorFromThrown(error) }
  } finally {
    clearTimeout(timeout)
  }
}

async function waitFor(dependencies: GeoFlowAdapterDependencies, milliseconds: number): Promise<GeoFlowTransportResult<true>> {
  if (milliseconds <= 0) return { ok: true, value: true }
  if (typeof dependencies.sleep !== 'function') return failure('SLEEP_NOT_CONFIGURED')
  try {
    await dependencies.sleep(milliseconds)
    return { ok: true, value: true }
  } catch {
    return failure('NETWORK_FAILURE')
  }
}

async function callWithRetries(
  url: string,
  init: CallInit,
  target: GeoFlowRuntimeTarget,
  dependencies: GeoFlowAdapterDependencies,
): Promise<GeoFlowTransportResult<ParsedResponse>> {
  let transportAttempt = 1
  while (true) {
    const response = await callJson(url, init, dependencies, target.maxResponseBodyBytes, target.maxRetryAfterSeconds)
    if (response.ok) return response
    if (!retryAllowedForAttempt(transportAttempt, response.error, target.maxAttempts)) return response
    const waitMilliseconds = response.error.retryAfterSeconds === undefined ? target.pollIntervalMs : response.error.retryAfterSeconds * 1_000
    const waited = await waitFor(dependencies, waitMilliseconds)
    if (!waited.ok) return waited
    transportAttempt += 1
  }
}

function enqueueValueFromData(data: JsonRecord, plan: GeoFlowEnqueuePlan): GeoFlowTransportResult<GeoFlowEnqueueValue> {
  const taskId = safeField(data, 'task_id')
  const jobId = safeField(data, 'job_id')
  const status = boundedRemoteStatus(safeField(data, 'status'))
  if (!positiveInteger(taskId)) return failure('TASK_ID_MISSING')
  if (taskId !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (!positiveInteger(jobId)) return failure('JOB_ID_MISSING')
  if (!status) return failure('STATUS_INVALID')
  const value: GeoFlowEnqueueValue = {
    kind: 'enqueued',
    requestFingerprint: plan.request.requestFingerprint,
    requestId: plan.request.requestId,
    targetFingerprint: plan.target.targetFingerprint,
    taskId,
    jobId,
    attempt: plan.target.attempt,
    remoteRequestId: plan.request.requestId,
    remoteStatus: status,
  }
  deepFreeze(value)
  VERIFIED_ENQUEUES.add(value)
  return { ok: true, value }
}

async function performEnqueue(plan: GeoFlowEnqueuePlan, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowEnqueueResult> {
  const credential = await resolveGeoFlowCredentialForTransport(plan.target.credentialReference, dependencies.credentialResolver, plan.target.baseUrl)
  if (!credential.ok) return failure(credential.error.code)
  const response = await callWithRetries(
    plan.url,
    { method: 'POST', headers: credentialHeaders(credential.token, plan.request), body: plan.body, timeoutMs: plan.target.timeoutMs },
    plan.target,
    dependencies,
  )
  if (!response.ok) return response
  const nowMs = clockMilliseconds(dependencies)
  if (!nowMs.ok) return nowMs
  const envelope = successEnvelope(response.value, plan.request, nowMs.value)
  if (!envelope.ok) return envelope
  return enqueueValueFromData(envelope.value, plan)
}

export async function executeGeoFlowEnqueue(input: GeoFlowEnqueueInput, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowEnqueueResult> {
  const plan = planFromInputs(input?.request, input?.target)
  if (!plan.ok) return plan
  const dependencyCheck = ensureDependencies(dependencies)
  if (!dependencyCheck.ok) return dependencyCheck
  const nowMs = clockMilliseconds(dependencies)
  if (!nowMs.ok) return nowMs
  pruneEnqueueState(nowMs.value)
  const requestKey = `${plan.value.target.targetFingerprint}\u0000${plan.value.request.idempotencyKey}`
  const globalBindingKey = `${plan.value.request.idempotencyKey}\u0000${plan.value.request.requestFingerprint}`
  const pairKey = `${requestKey}\u0000${plan.value.request.requestFingerprint}`
  const targetBinding = ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS.get(globalBindingKey)
  if (targetBinding !== undefined && targetBinding.targetFingerprint !== plan.value.target.targetFingerprint) return failure('IDEMPOTENCY_COLLISION')
  const existingFingerprint = ENQUEUE_KEY_FINGERPRINTS.get(requestKey)
  if (existingFingerprint !== undefined && existingFingerprint.requestFingerprint !== plan.value.request.requestFingerprint) return failure('IDEMPOTENCY_COLLISION')
  const replay = ENQUEUE_REPLAYS.get(pairKey)
  if (replay) return replay.result
  const existing = IN_FLIGHT_ENQUEUES.get(pairKey)
  if (existing) return existing
  const expiresAtMs = nowMs.value + REPLAY_TTL_MS
  ENQUEUE_IDEMPOTENCY_TARGET_BINDINGS.set(globalBindingKey, { targetFingerprint: plan.value.target.targetFingerprint, expiresAtMs })
  ENQUEUE_KEY_FINGERPRINTS.set(requestKey, { requestFingerprint: plan.value.request.requestFingerprint, expiresAtMs })
  const promise = performEnqueue(plan.value, dependencies).then((result) => {
    if (result.ok) {
      ENQUEUE_REPLAYS.set(pairKey, { result, expiresAtMs })
      pruneEnqueueState(nowMs.value)
    }
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
  if (!isRecord(value) || safeField(value, 'kind') !== 'enqueued' || !VERIFIED_ENQUEUES.has(value)) return failure('RESULT_INVALID')
  if (safeField(value, 'requestFingerprint') !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (safeField(value, 'requestId') !== plan.request.requestId) return failure('REQUEST_ID_MISMATCH')
  if (safeField(value, 'targetFingerprint') !== plan.target.targetFingerprint) return failure('IDENTITY_MISMATCH')
  if (safeField(value, 'taskId') !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (!positiveInteger(safeField(value, 'jobId'))) return failure('JOB_ID_MISSING')
  if (!attempt(safeField(value, 'attempt')) || safeField(value, 'attempt') !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  return { ok: true, value: value as unknown as GeoFlowEnqueueValue }
}

function isTerminalJobStatus(status: string): boolean {
  return ['completed', 'succeeded', 'success', 'draft_ready', 'review_required', 'ready', 'candidate'].includes(status.toLowerCase())
}

function isFailedJobStatus(status: string): boolean {
  return ['failed', 'blocked', 'cancelled', 'canceled'].includes(status.toLowerCase())
}

function requestInputFromPayload(payload: JsonRecord): unknown {
  if (!hasExactKeys(payload, JOB_PAYLOAD_KEYS)) return undefined
  const brief = safeField(payload, 'brief')
  const revision = safeField(payload, 'revision_context')
  const evidence = safeField(payload, 'evidence_chunks')
  if (!isRecord(brief) || !Array.isArray(evidence)) return undefined
  const revisionContext = revision === null ? null : isRecord(revision) ? {
    parentDraftId: safeField(revision, 'parent_draft_id'),
    parentContentHash: safeField(revision, 'parent_content_hash'),
    changeRequestReviewId: safeField(revision, 'change_request_review_id'),
    instructions: safeField(revision, 'instructions'),
  } : revision
  return {
    protocolVersion: safeField(payload, 'protocol_version'),
    requestId: safeField(payload, 'request_id'),
    requestFingerprint: safeField(payload, 'request_fingerprint'),
    briefFingerprint: safeField(payload, 'brief_fingerprint'),
    idempotencyKey: safeField(payload, 'idempotency_key'),
    ownerUserId: safeField(payload, 'owner_user_id'),
    clientId: safeField(payload, 'client_id'),
    calendarEntryId: safeField(payload, 'calendar_entry_id'),
    productionPlanId: safeField(payload, 'production_plan_id'),
    deliverableId: safeField(payload, 'deliverable_id'),
    briefId: safeField(payload, 'brief_id'),
    jobId: safeField(payload, 'discovery_stack_job_id'),
    evidenceSnapshotHash: safeField(payload, 'evidence_snapshot_hash'),
    brief: {
      title: safeField(brief, 'title'),
      audience: safeField(brief, 'audience'),
      goals: safeField(brief, 'goals'),
      constraints: safeField(brief, 'constraints'),
    },
    contentType: safeField(payload, 'content_type'),
    language: safeField(payload, 'language'),
    generationMode: safeField(payload, 'generation_mode'),
    revisionContext,
    requestedCapabilities: safeField(payload, 'requested_capabilities'),
    selectedRuleIds: safeField(payload, 'selected_rule_ids'),
    authoritySourceIds: safeField(payload, 'authority_source_ids'),
    evidenceChunks: evidence.map((item) => isRecord(item) ? {
      sourceId: safeField(item, 'source_id'),
      artifactId: safeField(item, 'artifact_id'),
      chunkId: safeField(item, 'chunk_id'),
      chunkHash: safeField(item, 'chunk_hash'),
      reviewedText: safeField(item, 'reviewed_text'),
      locator: safeField(item, 'locator'),
    } : item),
    createdAt: safeField(payload, 'created_at'),
  }
}

function validatedPayloadRequest(data: JsonRecord, plan: GeoFlowEnqueuePlan): GeoFlowTransportResult<GeoFlowRequest> {
  for (const key of INVENTED_JOB_FIELDS) if (Object.prototype.hasOwnProperty.call(data, key)) return failure('RESULT_INVALID')
  const payload = safeField(data, 'payload')
  if (!isRecord(payload)) return failure('RESULT_INVALID')
  const requestResult = validateGeoFlowRequest(requestInputFromPayload(payload))
  if (!requestResult.ok) {
    if (requestResult.reason === 'REQUEST_FINGERPRINT_MISMATCH') return failure('REQUEST_FINGERPRINT_MISMATCH')
    return failure('RESULT_INVALID', { contractReason: requestResult.reason })
  }
  const request = requestResult.value
  if (request.requestId !== plan.request.requestId) return failure('REQUEST_ID_MISMATCH')
  if (request.requestFingerprint !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (request.idempotencyKey !== plan.request.idempotencyKey) return failure('IDENTITY_MISMATCH')
  if (request.jobId !== plan.request.jobId) return failure('IDENTITY_MISMATCH')
  if (request.evidenceSnapshotHash !== plan.request.evidenceSnapshotHash) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (request.briefFingerprint !== plan.request.briefFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (safeField(payload, 'attempt') !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  if (safeField(payload, 'external_article_key') !== deriveExternalArticleKey(plan.request)) return failure('ARTICLE_ID_MISMATCH')
  return { ok: true, value: request }
}

function validateJobIdentity(data: JsonRecord, plan: GeoFlowEnqueuePlan, enqueue: GeoFlowEnqueueValue): GeoFlowTransportResult<JobContext> {
  if (safeField(data, 'id') !== enqueue.jobId) return failure('JOB_ID_MISMATCH')
  if (safeField(data, 'task_id') !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (safeField(data, 'job_type') !== DISCOVERY_STACK_JOB_TYPE) return failure('RESULT_INVALID')
  const status = boundedRemoteStatus(safeField(data, 'status'))
  if (!status) return failure('STATUS_INVALID')
  const payloadRequest = validatedPayloadRequest(data, plan)
  if (!payloadRequest.ok) return payloadRequest
  const summary = safeField(data, 'task_run_summary')
  if (!isRecord(summary)) return failure('RESULT_INVALID')
  const rawArticleId = safeField(summary, 'article_id')
  const articleId = rawArticleId === null ? null : positiveInteger(rawArticleId) ? rawArticleId : null
  if (rawArticleId !== null && articleId === null) return failure('ARTICLE_ID_MISSING')
  return { ok: true, value: { payloadRequest: payloadRequest.value, articleId, status, summary } }
}

function asString(record: JsonRecord, key: string): string | undefined {
  const value = safeField(record, key)
  return typeof value === 'string' ? value : undefined
}

function stringArray(record: JsonRecord, key: string): string[] | undefined {
  const value = safeField(record, key)
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined
}

function parseResultMetadata(context: JobContext, plan: GeoFlowEnqueuePlan, nowMs: number): GeoFlowTransportResult<GeoFlowJobResultMetadata> {
  const meta = safeField(context.summary, 'meta')
  if (!isRecord(meta)) return failure('RESULT_INVALID')
  const result = safeField(meta, 'result')
  if (!isRecord(result)) return failure('RESULT_INVALID')
  const raw = safeField(result, 'discoverystack_generation_v1')
  if (!isRecord(raw) || !hasExactKeys(raw, JOB_RESULT_KEYS)) return failure('RESULT_INVALID')
  const requestId = asString(raw, 'request_id')
  const requestFingerprint = asString(raw, 'request_fingerprint')
  const briefFingerprint = asString(raw, 'brief_fingerprint')
  const evidenceSnapshotHash = asString(raw, 'evidence_snapshot_hash')
  const externalArticleKey = asString(raw, 'external_article_key')
  const contentHash = asString(raw, 'content_hash')
  const completedAt = asString(raw, 'completed_at')
  const requestedRuleIds = stringArray(raw, 'requested_rule_ids')
  const appliedRuleIds = stringArray(raw, 'applied_rule_ids')
  const autogeoExecution = safeField(raw, 'autogeo_execution')
  const limitations = stringArray(raw, 'limitations')
  const attemptValue = safeField(raw, 'attempt')
  const citationsRaw = safeField(raw, 'citation_bindings')
  const providerRaw = safeField(raw, 'provider_provenance')
  if (!requestId || !requestFingerprint || !briefFingerprint || !evidenceSnapshotHash || !externalArticleKey || !contentHash || !completedAt || !requestedRuleIds || !appliedRuleIds || typeof autogeoExecution !== 'boolean' || !limitations || !attempt(attemptValue) || !Array.isArray(citationsRaw) || !isRecord(providerRaw)) return failure('RESULT_INVALID')
  if (!HASH_PATTERN.test(contentHash) || !HASH_PATTERN.test(requestFingerprint) || !HASH_PATTERN.test(briefFingerprint) || !HASH_PATTERN.test(evidenceSnapshotHash)) return failure('RESULT_INVALID')
  if (requestId !== plan.request.requestId || requestFingerprint !== plan.request.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (briefFingerprint !== plan.request.briefFingerprint || evidenceSnapshotHash !== plan.request.evidenceSnapshotHash) return failure('REQUEST_FINGERPRINT_MISMATCH')
  if (externalArticleKey !== deriveExternalArticleKey(plan.request)) return failure('ARTICLE_ID_MISMATCH')
  if (attemptValue !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  const completedMs = Date.parse(completedAt)
  const requestMs = Date.parse(plan.request.createdAt)
  if (!Number.isFinite(completedMs) || !Number.isFinite(requestMs) || completedMs < requestMs || completedMs > nowMs + CLOCK_SKEW_MS) return failure('REQUEST_TIME_INVALID')
  if (JSON.stringify(requestedRuleIds) !== JSON.stringify(plan.request.selectedRuleIds)) return failure('RESULT_INVALID')
  // DS transport is the base-generation boundary. AutoGEO runs in the isolated
  // optimization stage and must never be represented as executed by this response.
  if (autogeoExecution !== false || appliedRuleIds.length !== 0 || !limitations.includes(AUTO_GEO_NOT_EXECUTED_LIMITATION)) return failure('RESULT_INVALID')

  const evidenceByIdentity = new Set(plan.request.evidenceChunks.map((chunk) => `${chunk.sourceId}\u0000${chunk.artifactId}\u0000${chunk.chunkId}\u0000${chunk.chunkHash}`))
  const citationBindings: GeoFlowJobResultMetadata['citationBindings'][number][] = []
  for (const [index, item] of citationsRaw.entries()) {
    if (!isRecord(item) || !hasExactKeys(item, CITATION_KEYS)) return failure('RESULT_INVALID')
    const marker = asString(item, 'marker')
    const sourceId = asString(item, 'source_id')
    const artifactId = asString(item, 'artifact_id')
    const chunkId = asString(item, 'chunk_id')
    const chunkHash = asString(item, 'chunk_hash')
    if (!marker || !sourceId || !artifactId || !chunkId || !chunkHash || !/^\[E[1-9][0-9]*\]$/u.test(marker)) return failure('RESULT_INVALID')
    const markerNumber = Number(marker.slice(2, -1))
    const expectedChunk = plan.request.evidenceChunks[markerNumber - 1]
    if (!expectedChunk || `${sourceId}\u0000${artifactId}\u0000${chunkId}\u0000${chunkHash}` !== `${expectedChunk.sourceId}\u0000${expectedChunk.artifactId}\u0000${expectedChunk.chunkId}\u0000${expectedChunk.chunkHash}` || !evidenceByIdentity.has(`${sourceId}\u0000${artifactId}\u0000${chunkId}\u0000${chunkHash}`)) return failure('RESULT_INVALID', { contractReason: 'CITATION_OUTSIDE_APPROVED_EVIDENCE' })
    if (citationBindings.some((existing) => existing.marker === marker)) return failure('RESULT_INVALID')
    citationBindings.push({ marker, sourceId, artifactId, chunkId, chunkHash })
    if (index > 100) return failure('RESULT_INVALID')
  }

  if (!hasExactKeys(providerRaw, PROVIDER_KEYS)) return failure('RESULT_INVALID')
  const provider = asString(providerRaw, 'provider')
  const model = asString(providerRaw, 'model')
  const mode = asString(providerRaw, 'mode')
  const fallback = safeField(providerRaw, 'fallback_reason')
  if (!provider || !model || !mode || !['provider', 'deterministic_scaffold', 'reference_fallback'].includes(mode) || (fallback !== null && typeof fallback !== 'string')) return failure('RESULT_INVALID')
  const metadata: GeoFlowJobResultMetadata = {
    requestId,
    requestFingerprint,
    briefFingerprint,
    evidenceSnapshotHash,
    externalArticleKey,
    attempt: attemptValue,
    contentHash,
    requestedRuleIds,
    autogeoExecution,
    citationBindings,
    appliedRuleIds,
    providerProvenance: { provider, model, mode: mode as GeoFlowJobResultMetadata['providerProvenance']['mode'], fallbackReason: fallback as string | null },
    limitations,
    completedAt,
  }
  return { ok: true, value: metadata }
}

function jobValueFromData(data: JsonRecord, plan: GeoFlowEnqueuePlan, enqueue: GeoFlowEnqueueValue, nowMs: number): GeoFlowTransportResult<GeoFlowJobValue> {
  const identity = validateJobIdentity(data, plan, enqueue)
  if (!identity.ok) return identity
  if (identity.value.articleId === null) return failure('ARTICLE_ID_MISSING')
  const metadata = parseResultMetadata(identity.value, plan, nowMs)
  if (!metadata.ok) return metadata
  const value: GeoFlowJobValue = {
    kind: 'job_completed',
    requestFingerprint: plan.request.requestFingerprint,
    requestId: plan.request.requestId,
    targetFingerprint: plan.target.targetFingerprint,
    taskId: plan.target.taskId,
    jobId: enqueue.jobId,
    articleId: identity.value.articleId,
    attempt: plan.target.attempt,
    remoteRequestId: plan.request.requestId,
    remoteStatus: identity.value.status,
    resultMetadata: metadata.value,
  }
  deepFreeze(value)
  VERIFIED_JOBS.add(value)
  return { ok: true, value }
}

async function performJobPoll(plan: GeoFlowEnqueuePlan, enqueue: GeoFlowEnqueueValue, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowJobPollResult> {
  if (!VERIFIED_ENQUEUES.has(enqueue)) return failure('RESULT_INVALID')
  const validatedEnqueue = validateEnqueueValue(enqueue, plan)
  if (!validatedEnqueue.ok) return validatedEnqueue
  const dependencyCheck = ensureDependencies(dependencies)
  if (!dependencyCheck.ok) return dependencyCheck
  if (plan.target.pollIntervalMs > 0 && typeof dependencies.sleep !== 'function') return failure('SLEEP_NOT_CONFIGURED')
  const credential = await resolveGeoFlowCredentialForTransport(plan.target.credentialReference, dependencies.credentialResolver, plan.target.baseUrl)
  if (!credential.ok) return failure(credential.error.code)
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
        const waitMilliseconds = response.error.retryAfterSeconds === undefined ? plan.target.pollIntervalMs : response.error.retryAfterSeconds * 1_000
        const waited = await waitFor(dependencies, waitMilliseconds)
        if (!waited.ok) return waited
        transportAttempt += 1
        continue
      }
      return response
    }
    transportAttempt = 1
    const nowMs = clockMilliseconds(dependencies)
    if (!nowMs.ok) return nowMs
    const envelope = successEnvelope(response.value, plan.request, nowMs.value)
    if (!envelope.ok) return envelope
    const status = boundedRemoteStatus(safeField(envelope.value, 'status'))
    if (!status) return failure('STATUS_INVALID')
    if (isFailedJobStatus(status)) return failure('REMOTE_REJECTED')
    if (isTerminalJobStatus(status)) return jobValueFromData(envelope.value, plan, enqueue, nowMs.value)
    const waited = await waitFor(dependencies, plan.target.pollIntervalMs)
    if (!waited.ok) return waited
  }
  return failure('POLL_LIMIT_EXCEEDED')
}

export async function executeGeoFlowJobPoll(input: { readonly plan: GeoFlowEnqueuePlan; readonly enqueue: GeoFlowEnqueueValue }, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowJobPollResult> {
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
  if (safeField(value, 'targetFingerprint') !== plan.target.targetFingerprint) return failure('IDENTITY_MISMATCH')
  if (safeField(value, 'taskId') !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (!positiveInteger(safeField(value, 'jobId'))) return failure('JOB_ID_MISSING')
  if (!positiveInteger(safeField(value, 'articleId'))) return failure('ARTICLE_ID_MISSING')
  if (!attempt(safeField(value, 'attempt')) || safeField(value, 'attempt') !== plan.target.attempt) return failure('ATTEMPT_MISMATCH')
  if (!isRecord(safeField(value, 'resultMetadata'))) return failure('RESULT_INVALID')
  return { ok: true, value: value as unknown as GeoFlowJobValue }
}

function candidateStatus(status: unknown, reviewStatus: unknown): GeoFlowTransportResult<'draft_ready' | 'review_required'> {
  const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : ''
  const normalizedReviewStatus = typeof reviewStatus === 'string' ? reviewStatus.toLowerCase() : ''
  if (['approved', 'published', 'delivered', 'publishing', 'ready_to_publish'].includes(normalizedStatus) || ['approved', 'published', 'delivered'].includes(normalizedReviewStatus)) return failure('PUBLICATION_STATE_REJECTED')
  if (normalizedStatus !== 'draft' || !['pending', 'review_pending', 'needs_review'].includes(normalizedReviewStatus)) return failure('RESULT_INVALID')
  return { ok: true, value: normalizedReviewStatus === 'pending' ? 'draft_ready' : 'review_required' }
}

function candidateResponseFromData(data: JsonRecord, plan: GeoFlowEnqueuePlan, job: GeoFlowJobValue): GeoFlowTransportResult<GeoFlowResponse> {
  for (const key of INVENTED_ARTICLE_FIELDS) if (Object.prototype.hasOwnProperty.call(data, key)) return failure('RESULT_INVALID')
  const articleId = safeField(data, 'id')
  const taskId = safeField(data, 'task_id')
  const title = safeField(data, 'title')
  const bodyMarkdown = safeField(data, 'content')
  const summary = safeField(data, 'excerpt')
  const candidateStatusResult = candidateStatus(safeField(data, 'status'), safeField(data, 'review_status'))
  if (!candidateStatusResult.ok) return candidateStatusResult
  const status = plan.request.requestedCapabilities.includes('human_review') ? 'review_required' : candidateStatusResult.value
  const createdAt = safeField(data, 'created_at')
  const updatedAt = safeField(data, 'updated_at')
  if (!positiveInteger(articleId) || articleId !== job.articleId) return failure('ARTICLE_ID_MISMATCH')
  if (taskId !== plan.target.taskId) return failure('TASK_ID_MISMATCH')
  if (typeof title !== 'string' || title !== plan.request.brief.title || typeof bodyMarkdown !== 'string' || typeof summary !== 'string' || !status || typeof createdAt !== 'string' || typeof updatedAt !== 'string') return failure('RESULT_INVALID')
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) return failure('RESULT_INVALID')
  const bodyHash = sha256Text(bodyMarkdown)
  if (bodyHash !== job.resultMetadata.contentHash) return failure('CONTENT_HASH_MISMATCH')
  const citationBindings = job.resultMetadata.citationBindings.map((citation) => {
    if (!bodyMarkdown.includes(citation.marker)) return undefined
    return { sourceId: citation.sourceId, artifactId: citation.artifactId, chunkId: citation.chunkId, chunkHash: citation.chunkHash }
  })
  if (citationBindings.some((citation) => citation === undefined)) return failure('RESULT_INVALID')
  const contentArtifact: ContentArtifact = {
    schemaVersion: 'geoflow-content-artifact-v1',
    contentType: plan.request.contentType,
    language: plan.request.language,
    title,
    summary,
    bodyMarkdown,
    bodyHash,
  }
  if (!job.resultMetadata.autogeoExecution) {
    const baseResponse: GeoFlowResponse = {
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
      externalArticleKey: job.resultMetadata.externalArticleKey,
      attempt: job.resultMetadata.attempt,
      status,
      draftIdentity: { externalArticleKey: job.resultMetadata.externalArticleKey, briefFingerprint: job.resultMetadata.briefFingerprint },
      contentArtifact,
      evidenceSnapshotHash: job.resultMetadata.evidenceSnapshotHash,
      citationBindings: citationBindings as Array<{ sourceId: string; artifactId: string; chunkId: string; chunkHash: string }>,
      appliedRuleIds: [],
      providerProvenance: { ...job.resultMetadata.providerProvenance },
      limitations: [...job.resultMetadata.limitations],
      completedAt: job.resultMetadata.completedAt,
    }
    const validatedBase = validateGeoFlowResponse(baseResponse, plan.request)
    if (!validatedBase.ok) return failure('RESULT_INVALID', { contractReason: validatedBase.reason })
    const baseLineage = verifyGeoFlowLineage(plan.request, validatedBase.value)
    if (!baseLineage.ok) return failure('RESULT_INVALID', { contractReason: baseLineage.reason })
    return { ok: true, value: validatedBase.value }
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
    externalArticleKey: job.resultMetadata.externalArticleKey,
    attempt: job.resultMetadata.attempt,
    status,
    draftIdentity: { externalArticleKey: job.resultMetadata.externalArticleKey, briefFingerprint: job.resultMetadata.briefFingerprint },
    contentArtifact,
    evidenceSnapshotHash: job.resultMetadata.evidenceSnapshotHash,
    citationBindings: citationBindings as Array<{ sourceId: string; artifactId: string; chunkId: string; chunkHash: string }>,
    appliedRuleIds: [...job.resultMetadata.appliedRuleIds],
    providerProvenance: { ...job.resultMetadata.providerProvenance },
    limitations: [...job.resultMetadata.limitations],
    completedAt: job.resultMetadata.completedAt,
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
  const credential = await resolveGeoFlowCredentialForTransport(plan.target.credentialReference, dependencies.credentialResolver, plan.target.baseUrl)
  if (!credential.ok) return failure(credential.error.code)
  const response = await callWithRetries(
    joinGeoFlowPath(plan.target.baseUrl, ARTICLE_PATH(job.articleId)),
    { method: 'GET', headers: getHeaders(credential.token, plan.request), timeoutMs: plan.target.timeoutMs },
    plan.target,
    dependencies,
  )
  if (!response.ok) return response
  const nowMs = clockMilliseconds(dependencies)
  if (!nowMs.ok) return nowMs
  const envelope = successEnvelope(response.value, plan.request, nowMs.value)
  if (!envelope.ok) return envelope
  const candidate = candidateResponseFromData(envelope.value, plan, job)
  if (!candidate.ok) return candidate
  const value = {
    kind: job.resultMetadata.autogeoExecution ? 'article_candidate' as const : 'article_base_draft' as const,
    requestFingerprint: plan.request.requestFingerprint,
    requestId: plan.request.requestId,
    targetFingerprint: plan.target.targetFingerprint,
    taskId: plan.target.taskId,
    jobId: job.jobId,
    articleId: job.articleId,
    attempt: plan.target.attempt,
    response: candidate.value,
  }
  deepFreeze(value)
  return { ok: true, value }
}

export async function executeGeoFlowArticleFetch(input: GeoFlowArticleInput, dependencies: GeoFlowAdapterDependencies): Promise<GeoFlowArticleResult> {
  if (!isRecord(input)) return failure('RESULT_INVALID')
  const plan = safeField(input, 'plan')
  const job = safeField(input, 'job')
  if (!isRecord(plan) || safeField(plan, 'kind') !== 'enqueue_plan' || !VERIFIED_PLANS.has(plan)) return failure('RESULT_INVALID')
  if (!isRecord(job) || !VERIFIED_JOBS.has(job)) return failure('RESULT_INVALID')
  return performArticleFetch(plan as unknown as GeoFlowEnqueuePlan, job as unknown as GeoFlowJobValue, dependencies)
}

export function validateGeoFlowTransportResult(input: GeoFlowTransportValidationInput): GeoFlowTransportValidationResult {
  if (!isRecord(input)) return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$', code: 'INVALID_INPUT' }] }
  const requestResult = validateGeoFlowRequest(safeField(input, 'request'))
  if (!requestResult.ok) return requestResult
  const plan = safeField(input, 'plan')
  if (plan !== undefined) {
    if (!isRecord(plan) || safeField(plan, 'kind') !== 'enqueue_plan' || !VERIFIED_PLANS.has(plan)) return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$.plan', code: 'INVALID_INPUT' }] }
    const planRequest = safeField(plan, 'request')
    if (!isRecord(planRequest) || safeField(planRequest, 'requestFingerprint') !== requestResult.value.requestFingerprint) return { ok: false, reason: 'REQUEST_FINGERPRINT_MISMATCH', issues: [{ path: '$.plan.request.requestFingerprint', code: 'REQUEST_FINGERPRINT_MISMATCH' }] }
  }
  const result = safeField(input, 'result')
  const resultKind = isRecord(result) ? safeField(result, 'kind') : undefined
  if (!isRecord(result) || (resultKind !== 'article_candidate' && resultKind !== 'article_base_draft')) return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$.result', code: 'INVALID_INPUT' }] }
  const response = safeField(result, 'response')
  const responseResult = validateGeoFlowResponse(response, requestResult.value)
  if (!responseResult.ok) return responseResult
  const lineage = verifyGeoFlowLineage(requestResult.value, responseResult.value)
  if (!lineage.ok) return lineage
  if (safeField(result, 'requestFingerprint') !== requestResult.value.requestFingerprint) return { ok: false, reason: 'REQUEST_FINGERPRINT_MISMATCH', issues: [{ path: '$.result.requestFingerprint', code: 'REQUEST_FINGERPRINT_MISMATCH' }] }
  const resultTargetFingerprint = safeField(result, 'targetFingerprint')
  if (typeof resultTargetFingerprint !== 'string' || !HASH_PATTERN.test(resultTargetFingerprint)) return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$.result.targetFingerprint', code: 'INVALID_INPUT' }] }
  if (plan !== undefined && isRecord(plan)) {
    const planTarget = safeField(plan, 'target')
    const planTargetFingerprint = isRecord(planTarget) ? safeField(planTarget, 'targetFingerprint') : undefined
    if (resultTargetFingerprint !== planTargetFingerprint) return { ok: false, reason: 'IDENTITY_MISMATCH', issues: [{ path: '$.result.targetFingerprint', code: 'IDENTITY_MISMATCH' }] }
  }
  if (resultKind !== 'article_base_draft') return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$.result.kind', code: 'INVALID_INPUT' }] }
  if (requestResult.value.requestedCapabilities.includes('autogeo_optimization')) return { ok: false, reason: 'REQUIRED_RULE_MISSING', issues: [{ path: '$.request.requestedCapabilities', code: 'REQUIRED_RULE_MISSING' }] }
  if (!('appliedRuleIds' in responseResult.value) || responseResult.value.appliedRuleIds.length !== 0) return { ok: false, reason: 'APPLIED_RULE_OUTSIDE_SELECTION', issues: [{ path: '$.result.response.appliedRuleIds', code: 'APPLIED_RULE_OUTSIDE_SELECTION' }] }
  if (!responseResult.value.limitations.includes(AUTO_GEO_NOT_EXECUTED_LIMITATION)) return { ok: false, reason: 'INVALID_INPUT', issues: [{ path: '$.result.response.limitations', code: 'INVALID_INPUT' }] }
  return responseResult
}
