import { createHash } from 'node:crypto'
import { buildGeoFlowRequest, GEOFLOW_PROTOCOL_VERSION } from '../../../server/geoflow-integration'
import type { GeoFlowRequest, ValidationResult } from '../../../server/geoflow-integration'
import { normalizeGeoFlowRuntimeTarget } from '../../../server/geoflow-runtime'
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
export const BODY_MARKDOWN = '# Runtime transport test\n\nThis is the verified base draft body.'
export const BODY_HASH = sha256Text(BODY_MARKDOWN)
export const CREDENTIAL_REFERENCE = 'geoflow-production-main'
export const RESPONSE_TIMESTAMP = '2026-08-26T01:03:03.000Z'
export const ARTICLE_CREATED_AT = '2026-08-26T01:03:03.000Z'
export const ARTICLE_UPDATED_AT = '2026-08-26T01:03:04.000Z'

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
      goals: ['Generate a base draft'],
      constraints: ['Preserve approved facts'],
    },
    contentType: 'article',
    language: 'en',
    generationMode: 'draft',
    revisionContext: null,
    requestedCapabilities: ['prompt_pack'],
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
  const result = normalizeGeoFlowRuntimeTarget(input)
  if (!result.ok) throw new Error(`fixture target failed: ${result.error.code}`)
  return result.value
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }): GeoFlowFetchResponse {
  return {
    status,
    headers,
    text: async () => JSON.stringify(data),
  }
}

function envelope(request: GeoFlowRequest, data: Record<string, unknown>, timestamp = RESPONSE_TIMESTAMP, requestId = request.requestId): Record<string, unknown> {
  return {
    success: true,
    data,
    error: null,
    meta: {
      request_id: requestId,
      timestamp,
    },
  }
}

function payloadFromRequest(request: GeoFlowRequest, attempt = 1): Record<string, unknown> {
  return {
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
    attempt,
    external_article_key: `article-${request.calendarEntryId}-${request.deliverableId}`,
  }
}

function resultMetadata(request: GeoFlowRequest, attempt = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    request_id: request.requestId,
    request_fingerprint: request.requestFingerprint,
    brief_fingerprint: request.briefFingerprint,
    evidence_snapshot_hash: request.evidenceSnapshotHash,
    external_article_key: `article-${request.calendarEntryId}-${request.deliverableId}`,
    attempt,
    content_hash: BODY_HASH,
    requested_rule_ids: request.selectedRuleIds,
    autogeo_execution: false,
    citation_bindings: [],
    applied_rule_ids: [],
    provider_provenance: {
      provider: 'deterministic_scaffold',
      model: 'none',
      mode: 'deterministic_scaffold',
      fallback_reason: null,
    },
    limitations: ['No external provider generation was executed.', 'Human review is required.', 'AutoGEO optimization has not been executed; this is a base draft.'],
    completed_at: RESPONSE_TIMESTAMP,
  }
  Object.assign(metadata, overrides)
  return metadata
}

export function apiResponse(request: GeoFlowRequest, data: Record<string, unknown>, timestamp = RESPONSE_TIMESTAMP, requestId = request.requestId): GeoFlowFetchResponse {
  return jsonResponse(envelope(request, data, timestamp, requestId))
}

export function enqueueResponse(request: GeoFlowRequest, jobId = JOB_ID, taskId = TASK_ID, status = 'pending', timestamp = RESPONSE_TIMESTAMP): GeoFlowFetchResponse {
  return jsonResponse(envelope(request, { task_id: taskId, job_id: jobId, status }, timestamp))
}

export function jobResponse(request: GeoFlowRequest, jobId = JOB_ID, articleId: number | null = ARTICLE_ID, taskId = TASK_ID, status = 'completed', attempt = 1, metadataOverrides: Record<string, unknown> = {}): GeoFlowFetchResponse {
  const payload = payloadFromRequest(request, attempt)
  const result = resultMetadata(request, attempt, metadataOverrides)
  const meta = {
    job_type: 'discoverystack_generate_article_v1',
    payload,
    attempt_count: attempt,
    max_attempts: 3,
    available_at: '2026-08-26T01:02:03',
    worker_id: 'fixture-worker',
    result: { discoverystack_generation_v1: result },
  }
  return jsonResponse(envelope(request, {
    id: jobId,
    task_id: taskId,
    job_type: 'discoverystack_generate_article_v1',
    status,
    attempt_count: attempt,
    max_attempts: 3,
    payload,
    task_run_summary: {
      article_id: articleId,
      status,
      error_message: '',
      meta,
    },
  }))
}

export function articleResponse(request: GeoFlowRequest, _jobId = JOB_ID, articleId = ARTICLE_ID, taskId = TASK_ID, overrides: Record<string, unknown> = {}): GeoFlowFetchResponse {
  const data: Record<string, unknown> = {
    id: articleId,
    title: request.brief.title,
    slug: 'runtime-transport-test',
    content: BODY_MARKDOWN,
    excerpt: 'This is the verified base draft body.',
    keywords: '',
    meta_description: 'This is the verified base draft body.',
    status: 'draft',
    review_status: 'pending',
    task_id: taskId,
    task_name: 'Runtime transport task',
    author_id: 7,
    author_name: 'GEOFlow',
    category_id: 8,
    category_name: 'Runtime',
    published_at: null,
    created_at: ARTICLE_CREATED_AT,
    updated_at: ARTICLE_UPDATED_AT,
    images: [],
  }
  Object.assign(data, overrides)
  return jsonResponse(envelope(request, data))
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
