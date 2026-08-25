import type { GeoFlowRequest, GeoFlowRequestDraft, GeoFlowResponse } from '../../../server/geoflow-integration'
import { buildGeoFlowRequest } from '../../../server/geoflow-integration'
import { deriveExternalArticleKey } from '../../../server/geoflow-integration/lineage'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const HASH_C = 'c'.repeat(64)

export const validRequestDraft: GeoFlowRequestDraft = {
  protocolVersion: 'discoverystack-geoflow-v1',
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  ownerUserId: 7,
  clientId: 11,
  calendarEntryId: 101,
  productionPlanId: 202,
  deliverableId: 303,
  briefId: 404,
  jobId: 505,
  evidenceSnapshotHash: HASH_A,
  briefFingerprint: HASH_B,
  contentType: 'article',
  language: 'en',
  generationMode: 'draft',
  requestedCapabilities: ['knowledge_rag', 'autogeo_optimization', 'human_review'],
  selectedRuleIds: ['direct-answer-first', 'heading-structure'],
  authoritySourceIds: ['source-1', 'source-2'],
  evidenceChunks: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash: HASH_C, reviewedText: 'Approved evidence text.', locator: 'https://example.com/research/chunk-1' }],
  createdAt: '2026-08-25T04:00:00+08:00',
}

function requireRequest(result: ReturnType<typeof buildGeoFlowRequest>): GeoFlowRequest {
  if (!result.ok) throw new Error(`fixture request failed: ${result.reason}`)
  return result.value
}

export const validRequest = requireRequest(buildGeoFlowRequest(validRequestDraft))

export function makeRequest(overrides: Partial<GeoFlowRequestDraft> = {}): GeoFlowRequest {
  return requireRequest(buildGeoFlowRequest({ ...validRequestDraft, ...overrides, evidenceChunks: overrides.evidenceChunks ?? validRequestDraft.evidenceChunks, requestedCapabilities: overrides.requestedCapabilities ?? validRequestDraft.requestedCapabilities, selectedRuleIds: overrides.selectedRuleIds ?? validRequestDraft.selectedRuleIds, authoritySourceIds: overrides.authoritySourceIds ?? validRequestDraft.authoritySourceIds }))
}

export function makeResponse(request: GeoFlowRequest = validRequest, overrides: Partial<GeoFlowResponse> = {}): GeoFlowResponse {
  const externalArticleKey = deriveExternalArticleKey(request)
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    ownerUserId: request.ownerUserId,
    clientId: request.clientId,
    jobId: request.jobId,
    externalProjectKey: 'project-alpha',
    externalTaskKey: 'task-alpha',
    externalJobKey: 'job-alpha',
    externalArticleKey,
    status: 'draft_ready',
    draftIdentity: { externalArticleKey, briefFingerprint: request.briefFingerprint },
    title: 'A verified title',
    summary: 'A verified summary.',
    contentHash: HASH_A,
    evidenceSnapshotHash: request.evidenceSnapshotHash,
    citationBindings: [{ sourceId: 'source-1', artifactId: 'artifact-1', chunkId: 'chunk-1', chunkHash: HASH_C }],
    appliedRuleIds: ['direct-answer-first'],
    providerProvenance: { provider: 'synthetic-provider', model: 'synthetic-model', mode: 'provider', fallbackReason: null },
    limitations: ['Synthetic fixture only.'],
    completedAt: '2026-08-25T04:01:00Z',
    ...overrides,
  }
}

export const validResponse = makeResponse()

export const validEnvelopeInput = {
  request: validRequest,
  bodyHash: HASH_C,
  timestamp: '2026-08-25T04:02:00Z',
  nonce: 'synthetic-nonce-001',
  sender: 'discoverystack-control-plane',
  receiver: 'geoflow-content-engine',
}
