import { buildGeoFlowRequest } from '../../../server/geoflow-integration'
import type { ContentArtifact, DraftResultResponse, FailureResponse, GeoFlowRequest, GeoFlowRequestDraft, GeoFlowResponse, ProgressResponse, RetryWaitResponse } from '../../../server/geoflow-integration/types'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const HASH_C = 'c'.repeat(64)
export const CHUNK_HASH = 'cbe970333048d6ff92532ef409bd259e4fa592841602bc1425b98600f4e1a2eb'
export const BODY_HASH = 'cd83ad5a62590c6d6faa88b366dd43250164b53f613d14a3411fa80813c47c7d'
export const BODY_MARKDOWN = 'Body content with exact\nmarkdown.'

export const validRequestDraft: GeoFlowRequestDraft = {
  protocolVersion: 'discoverystack-geoflow-v1', requestId: 'req-001', idempotencyKey: 'idem-001', ownerUserId: 7, clientId: 11, calendarEntryId: 101, productionPlanId: 202, deliverableId: 303, briefId: 404, jobId: 505,
  brief: { title: '  NFKC  Article   Title  ', audience: 'Content operators', goals: ['Answer the question', 'Support review'], constraints: ['Use approved evidence', 'Keep the answer precise'] },
  evidenceSnapshotHash: HASH_A,
  contentType: 'article', language: 'en', generationMode: 'draft', revisionContext: null,
  requestedCapabilities: ['knowledge_rag', 'autogeo_optimization', 'human_review'], selectedRuleIds: ['direct-answer-first', 'heading-structure'], authoritySourceIds: ['source-1'],
  evidenceChunks: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash: CHUNK_HASH, reviewedText: 'Approved evidence text.', locator: 'https://example.com/research/chunk-1' }], createdAt: '2026-08-25T04:00:00+08:00',
}
function requireRequest(result: ReturnType<typeof buildGeoFlowRequest>): GeoFlowRequest { if (!result.ok) throw new Error(`fixture request failed: ${result.reason}`); return result.value }
export const validRequest = requireRequest(buildGeoFlowRequest(validRequestDraft))
export function makeRequest(overrides: Partial<GeoFlowRequestDraft> = {}): GeoFlowRequest { return requireRequest(buildGeoFlowRequest({ ...validRequestDraft, ...overrides })) }
export const validRevisionDraft: GeoFlowRequestDraft = { ...validRequestDraft, generationMode: 'revision', revisionContext: { parentDraftId: 606, parentContentHash: HASH_A, changeRequestReviewId: 707, instructions: 'Add the missing comparison and preserve approved evidence.' } }
export const validContentArtifact: ContentArtifact = { schemaVersion: 'geoflow-content-artifact-v1', contentType: 'article', language: 'en', title: 'Article Title', summary: 'A concise content summary.', bodyMarkdown: BODY_MARKDOWN, bodyHash: BODY_HASH }

export function makeProgressResponse(request: GeoFlowRequest = validRequest, status: 'queued' | 'running' = 'running'): ProgressResponse { return { protocolVersion: request.protocolVersion, requestId: request.requestId, idempotencyKey: request.idempotencyKey, requestFingerprint: request.requestFingerprint, ownerUserId: request.ownerUserId, clientId: request.clientId, jobId: request.jobId, externalProjectKey: 'project-1', externalTaskKey: 'task-1', externalJobKey: 'job-1', externalArticleKey: `article-${request.calendarEntryId}-${request.deliverableId}`, status, observedAt: '2026-08-25T04:01:00.000Z', limitations: [], retry: null } }
export function makeRetryResponse(request: GeoFlowRequest = validRequest): RetryWaitResponse { return { ...makeProgressResponse(request, 'running'), status: 'retry_wait', retry: { attempt: 1, retryAt: '2026-08-25T04:05:00.000Z' } } }
export function makeFailureResponse(request: GeoFlowRequest = validRequest, status: 'blocked' | 'failed' = 'failed'): FailureResponse { return { protocolVersion: request.protocolVersion, requestId: request.requestId, idempotencyKey: request.idempotencyKey, requestFingerprint: request.requestFingerprint, ownerUserId: request.ownerUserId, clientId: request.clientId, jobId: request.jobId, externalProjectKey: 'project-1', externalTaskKey: 'task-1', externalJobKey: 'job-1', externalArticleKey: `article-${request.calendarEntryId}-${request.deliverableId}`, status, observedAt: '2026-08-25T04:01:00.000Z', failure: { code: 'INVALID_INPUT', retryable: false }, limitations: ['Candidate generation did not complete.'] } }
export function makeDraftResponse(request: GeoFlowRequest = validRequest, overrides: Partial<DraftResultResponse> = {}): DraftResultResponse { const articleKey = `article-${request.calendarEntryId}-${request.deliverableId}`; return { protocolVersion: request.protocolVersion, requestId: request.requestId, idempotencyKey: request.idempotencyKey, requestFingerprint: request.requestFingerprint, ownerUserId: request.ownerUserId, clientId: request.clientId, jobId: request.jobId, externalProjectKey: 'project-1', externalTaskKey: 'task-1', externalJobKey: 'job-1', externalArticleKey: articleKey, status: 'review_required', draftIdentity: { externalArticleKey: articleKey, briefFingerprint: request.briefFingerprint }, contentArtifact: { ...validContentArtifact, contentType: request.contentType, language: request.language }, evidenceSnapshotHash: request.evidenceSnapshotHash, citationBindings: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash: CHUNK_HASH }], appliedRuleIds: [...request.selectedRuleIds], providerProvenance: { provider: 'deterministic_scaffold', model: 'none', mode: 'deterministic_scaffold', fallbackReason: null }, limitations: ['No external provider generation was executed.'], completedAt: '2026-08-25T04:01:00.000Z', ...overrides } }
export const validResponse: DraftResultResponse = makeDraftResponse()
export type { DraftResultResponse, FailureResponse, GeoFlowRequest, GeoFlowRequestDraft, GeoFlowResponse, ProgressResponse, RetryWaitResponse }
export const validEnvelopeInput = { request: validRequest, timestamp: '2026-08-25T04:02:00Z', nonce: 'N'.repeat(32), sender: 'discoverystack-control-plane', receiver: 'geoflow-content-engine', keyId: 'key-1' }
