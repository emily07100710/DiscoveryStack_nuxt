import { createHash } from 'node:crypto'
import { buildGeoFlowRequest, GEOFLOW_PROTOCOL_VERSION } from '../../../server/geoflow-integration'
import type { GeoFlowRequest, ValidationResult } from '../../../server/geoflow-integration'
import type { GeoFlowFetchResponse, GeoFlowRuntimeTarget } from '../../../server/geoflow-runtime'

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

export const BASE_URL = 'https://geoflow.routing.discoverystack.dev'
export const TASK_ID = 42
export const JOB_ID = 314
export const ARTICLE_ID = 2718
export const REQUEST_ID = 'request-runtime-1'
export const IDEMPOTENCY_KEY = 'idempotency-runtime-1'
export const SNAPSHOT_HASH = sha256Text('runtime-snapshot-v1')
export const BODY_MARKDOWN = '# 候選文章\n\n這是既有候選正文。'
export const BODY_HASH = sha256Text(BODY_MARKDOWN)
export const CREDENTIAL_REFERENCE = 'geoflow-production-main'

export function makeRequest(overrides: Record<string, unknown> = {}): GeoFlowRequest {
  const input: Record<string, unknown> = {
    protocolVersion: GEOFLOW_PROTOCOL_VERSION,
    requestId: REQUEST_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    ownerUserId: 7,
    clientId: 8,
    calendarEntryId: 9,
    productionPlanId: 10,
    deliverableId: 11,
    briefId: 12,
    jobId: 13,
    evidenceSnapshotHash: SNAPSHOT_HASH,
    brief: {
      title: 'Runtime transport test',
      audience: 'Reviewers',
      goals: ['Generate a candidate'],
      constraints: ['Preserve approved facts'],
    },
    contentType: 'article',
    language: 'en',
    generationMode: 'draft',
    revisionContext: null,
    requestedCapabilities: ['autogeo_optimization'],
    selectedRuleIds: ['direct-answer-first'],
    authoritySourceIds: ['source-1'],
    evidenceChunks: [
      {
        sourceId: 'source-1',
        artifactId: 'artifact-1',
        chunkId: 'chunk-1',
        chunkHash: sha256Text('Approved fact text.'),
        reviewedText: 'Approved fact text.',
        locator: 'https://evidence.routing.discoverystack.dev/source-1',
      },
    ],
    createdAt: '2026-08-26T01:02:03Z',
  }
  Object.assign(input, overrides)
  const result: ValidationResult<GeoFlowRequest> = buildGeoFlowRequest(input)
  if (!result.ok) throw new Error(`fixture request failed: ${result.reason}`)
  return result.value
}

export function makeTarget(overrides: Record<string, unknown> = {}): GeoFlowRuntimeTarget {
  const input: Record<string, unknown> = {
    baseUrl: BASE_URL,
    taskId: TASK_ID,
    credentialReference: CREDENTIAL_REFERENCE,
    attempt: 1,
    timeoutMs: 5_000,
    maxResponseBodyBytes: 64_000,
    maxAttempts: 3,
    maxPolls: 5,
    pollIntervalMs: 0,
    maxRetryAfterSeconds: 60,
  }
  Object.assign(input, overrides)
  const result = planTarget(input)
  if (!result.ok) throw new Error(`fixture target failed: ${result.error.code}`)
  return result.value
}

function planTarget(input: Record<string, unknown>): { ok: true; value: GeoFlowRuntimeTarget } | { ok: false; error: { code: string } } {
  if (typeof input.baseUrl !== 'string' || typeof input.taskId !== 'number' || typeof input.credentialReference !== 'string' || typeof input.attempt !== 'number') return { ok: false, error: { code: 'TARGET_INVALID' } }
  return {
    ok: true,
    value: {
      baseUrl: input.baseUrl,
      taskId: input.taskId,
      credentialReference: input.credentialReference,
      attempt: input.attempt,
      timeoutMs: input.timeoutMs as number,
      maxResponseBodyBytes: input.maxResponseBodyBytes as number,
      maxAttempts: input.maxAttempts as number,
      maxPolls: input.maxPolls as number,
      pollIntervalMs: input.pollIntervalMs as number,
      maxRetryAfterSeconds: input.maxRetryAfterSeconds as number,
    },
  }
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }): GeoFlowFetchResponse {
  return {
    status,
    headers,
    text: async () => JSON.stringify(data),
  }
}

export function enqueueResponse(request: GeoFlowRequest, jobId = JOB_ID, taskId = TASK_ID, status = 'queued'): GeoFlowFetchResponse {
  return jsonResponse({ success: true, data: { request_id: request.requestId, task_id: taskId, job_id: jobId, status } })
}

export function jobResponse(request: GeoFlowRequest, jobId = JOB_ID, articleId = ARTICLE_ID, taskId = TASK_ID, status = 'completed', attempt = 1): GeoFlowFetchResponse {
  return jsonResponse({ success: true, data: { request_id: request.requestId, request_fingerprint: request.requestFingerprint, task_id: taskId, job_id: jobId, article_id: articleId, status, attempt } })
}

export function articleResponse(request: GeoFlowRequest, jobId = JOB_ID, articleId = ARTICLE_ID, taskId = TASK_ID, overrides: Record<string, unknown> = {}): GeoFlowFetchResponse {
  const data: Record<string, unknown> = {
    request_id: request.requestId,
    request_fingerprint: request.requestFingerprint,
    task_id: taskId,
    job_id: jobId,
    article_id: articleId,
    status: 'candidate',
    external_article_key: `article-${request.calendarEntryId}-${request.deliverableId}`,
    brief_fingerprint: request.briefFingerprint,
    evidence_snapshot_hash: request.evidenceSnapshotHash,
    body_markdown: BODY_MARKDOWN,
    body_hash: BODY_HASH,
    title: 'Runtime candidate',
    summary: 'Candidate summary.',
    citation_bindings: [],
    applied_rule_ids: request.selectedRuleIds,
    provider_provenance: {
      provider: 'deterministic_scaffold',
      model: 'none',
      mode: 'deterministic_scaffold',
      fallback_reason: null,
    },
    limitations: ['No external provider generation was executed.', 'Human review is required.'],
    completed_at: '2026-08-26T01:03:03Z',
    attempt: 1,
  }
  Object.assign(data, overrides)
  return jsonResponse({ success: true, data })
}

export function responseWithRawText(text: string, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }): GeoFlowFetchResponse {
  return { status, headers, text: async () => text }
}

export function responseWithBodyBytes(bytes: number, status = 200): GeoFlowFetchResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(bytes) },
    text: async () => 'x',
  }
}
