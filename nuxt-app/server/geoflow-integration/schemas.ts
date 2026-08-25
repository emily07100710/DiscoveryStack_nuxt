import { createHash } from 'node:crypto'
import type { CitationBinding, ContentArtifact, ContentType, DraftResultResponse, FailureResponse, GeoFlowRequest, GeoFlowResponse, ProgressResponse, ProviderProvenance, ReasonCode, RetryWaitResponse, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { CONTENT_ARTIFACT_SCHEMA_VERSION, DETERMINISTIC_SCAFFOLD_LIMITATION, GEOFLOW_PROTOCOL_VERSION, SIGNING_ALGORITHM, SIGNING_METHOD, SIGNING_PATH } from './types'
import { canonicalRequestFingerprint, briefFingerprintFromDraft, requestFingerprintFromDraft, canonicalizeContractValue } from './fingerprint'
import { canonicalizeTimestamp, normalizeGeoFlowRequest, normalizeGeoFlowRequestDraft, CONTRACT_LIMITS } from './normalization'

const REQUEST_DRAFT_KEYS = ['protocolVersion', 'requestId', 'idempotencyKey', 'ownerUserId', 'clientId', 'calendarEntryId', 'productionPlanId', 'deliverableId', 'briefId', 'jobId', 'brief', 'contentType', 'language', 'generationMode', 'revisionContext', 'requestedCapabilities', 'selectedRuleIds', 'authoritySourceIds', 'evidenceChunks', 'createdAt'] as const
const REQUEST_KEYS = [...REQUEST_DRAFT_KEYS, 'briefFingerprint', 'requestFingerprint'] as const
const RESPONSE_IDENTITY_KEYS = ['protocolVersion', 'requestId', 'idempotencyKey', 'requestFingerprint', 'ownerUserId', 'clientId', 'jobId', 'externalProjectKey', 'externalTaskKey', 'externalJobKey', 'externalArticleKey'] as const
const PROGRESS_KEYS = [...RESPONSE_IDENTITY_KEYS, 'attempt', 'status', 'observedAt', 'limitations', 'retry'] as const
const FAILURE_KEYS = [...RESPONSE_IDENTITY_KEYS, 'attempt', 'status', 'observedAt', 'failure', 'limitations'] as const
const DRAFT_RESULT_KEYS = [...RESPONSE_IDENTITY_KEYS, 'attempt', 'status', 'draftIdentity', 'contentArtifact', 'evidenceSnapshotHash', 'citationBindings', 'appliedRuleIds', 'providerProvenance', 'limitations', 'completedAt'] as const
const DRAFT_IDENTITY_KEYS = ['externalArticleKey', 'briefFingerprint'] as const
const ARTIFACT_KEYS = ['schemaVersion', 'contentType', 'language', 'title', 'summary', 'bodyMarkdown', 'bodyHash'] as const
const CITATION_KEYS = ['sourceId', 'artifactId', 'chunkId', 'chunkHash'] as const
const PROVENANCE_KEYS = ['provider', 'model', 'mode', 'fallbackReason'] as const
const FAILURE_KEYS_INNER = ['code', 'retryable'] as const
const RETRY_KEYS = ['attempt', 'retryAt'] as const
const GEO_STATUSES = ['queued', 'running', 'draft_ready', 'review_required', 'blocked', 'failed', 'retry_wait'] as const
const PROVIDER_MODES = ['provider', 'deterministic_scaffold', 'reference_fallback'] as const
const REASON_CODES = ['INVALID_PROTOCOL_VERSION', 'INVALID_INPUT', 'UNKNOWN_FIELD', 'LIMIT_EXCEEDED', 'INVALID_HASH', 'INVALID_TIMESTAMP', 'INVALID_PUBLIC_URL', 'PRIVATE_OR_SPECIAL_TARGET', 'INVALID_OPAQUE_IDENTIFIER', 'UNKNOWN_STATE', 'REQUEST_FINGERPRINT_MISMATCH', 'IDEMPOTENCY_COLLISION', 'IDENTITY_MISMATCH', 'EVIDENCE_SNAPSHOT_MISMATCH', 'BRIEF_FINGERPRINT_MISMATCH', 'CITATION_OUTSIDE_APPROVED_EVIDENCE', 'APPLIED_RULE_OUTSIDE_SELECTION', 'PROVIDER_PROVENANCE_MISSING', 'INVALID_STATUS_TRANSITION', 'UNTRUSTED_PUBLISHED_RESULT', 'EVIDENCE_CHUNK_HASH_MISMATCH', 'DUPLICATE_EVIDENCE_IDENTITY', 'DUPLICATE_IDENTIFIER', 'REQUIRED_EVIDENCE_MISSING', 'REQUIRED_RULE_MISSING', 'CONTENT_HASH_MISMATCH', 'RESPONSE_TIME_INVALID', 'UNTRUSTED_DELIVERY_STATE', 'SIGNATURE_CONTEXT_MISMATCH', 'SIGNATURE_EXPIRED', 'NONCE_REPLAYED', 'RETRY_ATTEMPT_INVALID', 'CANDIDATE_LINEAGE_MISMATCH'] as const
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const NUL_CHARACTER = /\u0000/u
const READ_FAILED = Symbol('read-failed')

type SafeValue = unknown | typeof READ_FAILED
type Reason = typeof REASON_CODES[number]

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function safeValue(record: Record<string, unknown>, key: string): SafeValue { try { return record[key] } catch { return READ_FAILED } }
function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean { try { const keys = Object.keys(record); return keys.length === expected.length && keys.every(key => expected.includes(key)) } catch { return false } }
function text(value: unknown, max: number, path: string): ValidationResult<string> {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return failure('INVALID_INPUT', path)
  try { const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' '); if (!normalized) return failure('INVALID_INPUT', path); return normalized.length > max ? failure('LIMIT_EXCEEDED', path) : success(normalized) } catch { return failure('INVALID_INPUT', path) }
}
function opaque(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !CONTROL_CHARACTERS.test(value) && OPAQUE_PATTERN.test(value) ? success(value) : failure(typeof value === 'string' && value.length > 160 ? 'LIMIT_EXCEEDED' : 'INVALID_OPAQUE_IDENTIFIER', path) }
function positiveInteger(value: unknown, path: string): ValidationResult<number> { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? success(value) : failure('INVALID_INPUT', path) }
function attempt(value: unknown, path: string): ValidationResult<number> { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 10 ? success(value) : failure('RETRY_ATTEMPT_INVALID', path) }
function hash(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && HASH_PATTERN.test(value) ? success(value) : failure('INVALID_HASH', path) }
function knownReason(value: unknown, path: string): ValidationResult<ReasonCode> { return typeof value === 'string' && REASON_CODES.includes(value as Reason) ? success(value as ReasonCode) : failure('INVALID_INPUT', path) }
function setIds(value: unknown, max: number, path: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return failure('INVALID_INPUT', path)
  if (value.length > max) return failure('LIMIT_EXCEEDED', path)
  const values: string[] = []
  try { for (let index = 0; index < value.length; index += 1) {     const item = opaque(value[index], `${path}[${index}]`); if (!item.ok) return item; if (values.includes(item.value)) return failure('DUPLICATE_IDENTIFIER', `${path}[${index}]`); values.push(item.value) } } catch { return failure('INVALID_INPUT', path) }
  values.sort()
  return success(values)
}
function limitations(value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value)) return failure('INVALID_INPUT', '$.limitations')
  if (value.length > CONTRACT_LIMITS.maxLimitations) return failure('LIMIT_EXCEEDED', '$.limitations')
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) { const item = text(value[index], CONTRACT_LIMITS.maxLimitationLength, `$.limitations[${index}]`); if (!item.ok) return item; result.push(item.value) }
  return success(result)
}
function normalizeResponseIdentity(input: Record<string, unknown>): ValidationResult<Record<string, unknown>> {
  const values = {} as Record<string, SafeValue>
  for (const key of RESPONSE_IDENTITY_KEYS) { const value = safeValue(input, key); if (value === READ_FAILED) return failure('INVALID_INPUT', `$.${key}`); values[key] = value }
  const protocolVersion = values.protocolVersion === GEOFLOW_PROTOCOL_VERSION ? success(GEOFLOW_PROTOCOL_VERSION) : failure('INVALID_PROTOCOL_VERSION', '$.protocolVersion'); if (!protocolVersion.ok) return protocolVersion
  const requestId = opaque(values.requestId, '$.requestId'); if (!requestId.ok) return requestId
  const idempotencyKey = opaque(values.idempotencyKey, '$.idempotencyKey'); if (!idempotencyKey.ok) return idempotencyKey
  const requestFingerprint = hash(values.requestFingerprint, '$.requestFingerprint'); if (!requestFingerprint.ok) return requestFingerprint
  const responseAttempt = attempt(safeValue(input, 'attempt'), '$.attempt'); if (!responseAttempt.ok) return responseAttempt
  const ownerUserId = positiveInteger(values.ownerUserId, '$.ownerUserId'); if (!ownerUserId.ok) return ownerUserId
  const clientId = positiveInteger(values.clientId, '$.clientId'); if (!clientId.ok) return clientId
  const jobId = positiveInteger(values.jobId, '$.jobId'); if (!jobId.ok) return jobId
  const result = { protocolVersion: protocolVersion.value, requestId: requestId.value, idempotencyKey: idempotencyKey.value, requestFingerprint: requestFingerprint.value, ownerUserId: ownerUserId.value, clientId: clientId.value, jobId: jobId.value, attempt: responseAttempt.value } as Record<string, unknown>
  for (const key of ['externalProjectKey', 'externalTaskKey', 'externalJobKey', 'externalArticleKey'] as const) { const item = opaque(values[key], `$.${key}`); if (!item.ok) return item; result[key] = item.value }
  return success(result)
}
function normalizeCitation(value: unknown, index: number): ValidationResult<CitationBinding> {
  if (!isPlainRecord(value) || !exactKeys(value, CITATION_KEYS)) return failure('UNKNOWN_FIELD', `$.citationBindings[${index}]`)
  const source = opaque(safeValue(value, 'sourceId'), `$.citationBindings[${index}].sourceId`); if (!source.ok) return source
  const artifact = opaque(safeValue(value, 'artifactId'), `$.citationBindings[${index}].artifactId`); if (!artifact.ok) return artifact
  const chunk = opaque(safeValue(value, 'chunkId'), `$.citationBindings[${index}].chunkId`); if (!chunk.ok) return chunk
  const chunkHash = hash(safeValue(value, 'chunkHash'), `$.citationBindings[${index}].chunkHash`); if (!chunkHash.ok) return chunkHash
  return success({ sourceId: source.value, artifactId: artifact.value, chunkId: chunk.value, chunkHash: chunkHash.value })
}
function normalizeProvenance(value: unknown): ValidationResult<ProviderProvenance> {
  if (!isPlainRecord(value) || !exactKeys(value, PROVENANCE_KEYS)) return failure('UNKNOWN_FIELD', '$.providerProvenance')
  const provider = text(safeValue(value, 'provider'), 160, '$.providerProvenance.provider'); if (!provider.ok) return provider
  const model = text(safeValue(value, 'model'), 160, '$.providerProvenance.model'); if (!model.ok) return model
  const modeValue = safeValue(value, 'mode'); if (typeof modeValue !== 'string' || !PROVIDER_MODES.includes(modeValue as typeof PROVIDER_MODES[number])) return failure('INVALID_INPUT', '$.providerProvenance.mode')
  const fallbackValue = safeValue(value, 'fallbackReason')
  if (fallbackValue === null) return success({ provider: provider.value, model: model.value, mode: modeValue as ProviderProvenance['mode'], fallbackReason: null })
  const fallbackReason = text(fallbackValue, 500, '$.providerProvenance.fallbackReason'); if (!fallbackReason.ok) return fallbackReason
  return success({ provider: provider.value, model: model.value, mode: modeValue as ProviderProvenance['mode'], fallbackReason: fallbackReason.value })
}
function normalizeDraftIdentity(value: unknown): ValidationResult<{ externalArticleKey: string; briefFingerprint: string }> {
  if (!isPlainRecord(value) || !exactKeys(value, DRAFT_IDENTITY_KEYS)) return failure('UNKNOWN_FIELD', '$.draftIdentity')
  const article = opaque(safeValue(value, 'externalArticleKey'), '$.draftIdentity.externalArticleKey'); if (!article.ok) return article
  const brief = hash(safeValue(value, 'briefFingerprint'), '$.draftIdentity.briefFingerprint'); if (!brief.ok) return brief
  return success({ externalArticleKey: article.value, briefFingerprint: brief.value })
}
function bodyHash(bodyMarkdown: string): string { return createHash('sha256').update(Buffer.from(bodyMarkdown, 'utf8')).digest('hex') }
function normalizeContentArtifact(value: unknown): ValidationResult<ContentArtifact> {
  if (!isPlainRecord(value) || !exactKeys(value, ARTIFACT_KEYS)) return failure('UNKNOWN_FIELD', '$.contentArtifact')
  const schemaVersion = safeValue(value, 'schemaVersion'); if (schemaVersion !== CONTENT_ARTIFACT_SCHEMA_VERSION) return failure('INVALID_INPUT', '$.contentArtifact.schemaVersion')
  const contentType = safeValue(value, 'contentType'); if (contentType !== 'article' && contentType !== 'faq' && contentType !== 'service_page') return failure('INVALID_INPUT', '$.contentArtifact.contentType')
  const language = safeValue(value, 'language'); if (language !== 'zh-hant' && language !== 'en') return failure('INVALID_INPUT', '$.contentArtifact.language')
  const title = text(safeValue(value, 'title'), 300, '$.contentArtifact.title'); if (!title.ok) return title
  const summary = text(safeValue(value, 'summary'), 2_000, '$.contentArtifact.summary'); if (!summary.ok) return summary
  const bodyMarkdownValue = safeValue(value, 'bodyMarkdown'); if (typeof bodyMarkdownValue !== 'string' || !bodyMarkdownValue || NUL_CHARACTER.test(bodyMarkdownValue) || Buffer.byteLength(bodyMarkdownValue, 'utf8') > CONTRACT_LIMITS.maxBodyMarkdownBytes) return failure(typeof bodyMarkdownValue === 'string' && Buffer.byteLength(bodyMarkdownValue, 'utf8') > CONTRACT_LIMITS.maxBodyMarkdownBytes ? 'LIMIT_EXCEEDED' : 'INVALID_INPUT', '$.contentArtifact.bodyMarkdown')
  const suppliedHash = hash(safeValue(value, 'bodyHash'), '$.contentArtifact.bodyHash'); if (!suppliedHash.ok) return suppliedHash
  const computedHash = bodyHash(bodyMarkdownValue)
  if (suppliedHash.value !== computedHash) return failure('CONTENT_HASH_MISMATCH', '$.contentArtifact.bodyHash')
  return success({ schemaVersion: CONTENT_ARTIFACT_SCHEMA_VERSION, contentType, language, title: title.value, summary: summary.value, bodyMarkdown: bodyMarkdownValue, bodyHash: computedHash })
}
function normalizeFailure(value: unknown): ValidationResult<{ code: ReasonCode; retryable: boolean }> {
  if (!isPlainRecord(value) || !exactKeys(value, FAILURE_KEYS_INNER)) return failure('UNKNOWN_FIELD', '$.failure')
  const code = knownReason(safeValue(value, 'code'), '$.failure.code'); if (!code.ok) return code
  const retryable = safeValue(value, 'retryable'); if (typeof retryable !== 'boolean') return failure('INVALID_INPUT', '$.failure.retryable')
  return success({ code: code.value, retryable })
}
function normalizeRetry(value: unknown): ValidationResult<{ attempt: number; retryAt: string }> {
  if (!isPlainRecord(value) || !exactKeys(value, RETRY_KEYS)) return failure('UNKNOWN_FIELD', '$.retry')
  const retryAttempt = attempt(safeValue(value, 'attempt'), '$.retry.attempt'); if (!retryAttempt.ok) return retryAttempt
  const retryAt = canonicalizeTimestamp(safeValue(value, 'retryAt'), '$.retry.retryAt'); if (!retryAt.ok) return retryAt
  return success({ attempt: retryAttempt.value, retryAt: retryAt.value })
}

export function buildGeoFlowRequest(input: unknown): ValidationResult<GeoFlowRequest> {
  const normalized = normalizeGeoFlowRequestDraft(input); if (!normalized.ok) return normalized
  const briefFingerprint = briefFingerprintFromDraft(normalized.value)
  return success({ ...normalized.value, briefFingerprint, requestFingerprint: requestFingerprintFromDraft(normalized.value) })
}
export function validateGeoFlowRequest(input: unknown): ValidationResult<GeoFlowRequest> {
  const normalized = normalizeGeoFlowRequest(input); if (!normalized.ok) return normalized
  const expectedBriefFingerprint = briefFingerprintFromDraft(normalized.value)
  if (normalized.value.briefFingerprint !== expectedBriefFingerprint) return failure('BRIEF_FINGERPRINT_MISMATCH', '$.briefFingerprint')
  const { briefFingerprint: _storedBriefFingerprint, requestFingerprint: _storedRequestFingerprint, ...draft } = normalized.value
  const expectedRequestFingerprint = requestFingerprintFromDraft(draft)
  return expectedRequestFingerprint === normalized.value.requestFingerprint ? success({ ...normalized.value, briefFingerprint: expectedBriefFingerprint, requestFingerprint: expectedRequestFingerprint }) : failure('REQUEST_FINGERPRINT_MISMATCH', '$.requestFingerprint')
}

export function normalizeGeoFlowResponse(input: unknown): ValidationResult<GeoFlowResponse> {
  if (!isPlainRecord(input)) return failure('INVALID_INPUT')
  const statusValue = safeValue(input, 'status')
  if (statusValue === 'queued' || statusValue === 'running') {
    if (!exactKeys(input, PROGRESS_KEYS)) return failure('UNKNOWN_FIELD')
    const identity = normalizeResponseIdentity(input); if (!identity.ok) return identity
    const observedAt = canonicalizeTimestamp(safeValue(input, 'observedAt'), '$.observedAt'); if (!observedAt.ok) return observedAt
    const limitationValues = limitations(safeValue(input, 'limitations')); if (!limitationValues.ok) return limitationValues
    if (safeValue(input, 'retry') !== null) return failure('INVALID_INPUT', '$.retry')
    return success({ ...identity.value, status: statusValue, observedAt: observedAt.value, limitations: limitationValues.value, retry: null } as ProgressResponse)
  }
  if (statusValue === 'retry_wait') {
    if (!exactKeys(input, PROGRESS_KEYS)) return failure('UNKNOWN_FIELD')
    const identity = normalizeResponseIdentity(input); if (!identity.ok) return identity
    const observedAt = canonicalizeTimestamp(safeValue(input, 'observedAt'), '$.observedAt'); if (!observedAt.ok) return observedAt
    const retry = normalizeRetry(safeValue(input, 'retry')); if (!retry.ok) return retry
    if (retry.value.attempt !== identity.value.attempt) return failure('RETRY_ATTEMPT_INVALID', '$.retry.attempt')
    const limitationValues = limitations(safeValue(input, 'limitations')); if (!limitationValues.ok) return limitationValues
    return success({ ...identity.value, status: 'retry_wait', observedAt: observedAt.value, retry: retry.value, limitations: limitationValues.value } as RetryWaitResponse)
  }
  if (statusValue === 'blocked' || statusValue === 'failed') {
    if (!exactKeys(input, FAILURE_KEYS)) return failure('UNKNOWN_FIELD')
    const identity = normalizeResponseIdentity(input); if (!identity.ok) return identity
    const observedAt = canonicalizeTimestamp(safeValue(input, 'observedAt'), '$.observedAt'); if (!observedAt.ok) return observedAt
    const failureResult = normalizeFailure(safeValue(input, 'failure')); if (!failureResult.ok) return failureResult
    const limitationValues = limitations(safeValue(input, 'limitations')); if (!limitationValues.ok) return limitationValues
    return success({ ...identity.value, status: statusValue, observedAt: observedAt.value, failure: failureResult.value, limitations: limitationValues.value } as FailureResponse)
  }
  if (statusValue === 'draft_ready' || statusValue === 'review_required') {
    if (!exactKeys(input, DRAFT_RESULT_KEYS)) return failure('UNKNOWN_FIELD')
    const identity = normalizeResponseIdentity(input); if (!identity.ok) return identity
    const draftIdentity = normalizeDraftIdentity(safeValue(input, 'draftIdentity')); if (!draftIdentity.ok) return draftIdentity
    const contentArtifact = normalizeContentArtifact(safeValue(input, 'contentArtifact')); if (!contentArtifact.ok) return contentArtifact
    const evidenceSnapshotHash = hash(safeValue(input, 'evidenceSnapshotHash'), '$.evidenceSnapshotHash'); if (!evidenceSnapshotHash.ok) return evidenceSnapshotHash
    const citationValue = safeValue(input, 'citationBindings'); if (!Array.isArray(citationValue)) return failure('INVALID_INPUT', '$.citationBindings')
    if (citationValue.length > CONTRACT_LIMITS.maxCitationBindings) return failure('LIMIT_EXCEEDED', '$.citationBindings')
    const citationBindings: CitationBinding[] = []
    const citationIdentities = new Set<string>()
    for (let index = 0; index < citationValue.length; index += 1) {
      const citation = normalizeCitation(citationValue[index], index); if (!citation.ok) return citation
      const identity = `${citation.value.sourceId}\u0000${citation.value.artifactId}\u0000${citation.value.chunkId}\u0000${citation.value.chunkHash}`
      if (citationIdentities.has(identity)) return failure('DUPLICATE_EVIDENCE_IDENTITY', `$.citationBindings[${index}]`)
      citationIdentities.add(identity)
      citationBindings.push(citation.value)
    }
    const appliedRuleIds = setIds(safeValue(input, 'appliedRuleIds'), CONTRACT_LIMITS.maxSelectedRuleIds, '$.appliedRuleIds'); if (!appliedRuleIds.ok) return appliedRuleIds
    const providerProvenance = normalizeProvenance(safeValue(input, 'providerProvenance')); if (!providerProvenance.ok) return providerProvenance
    const limitationValues = limitations(safeValue(input, 'limitations')); if (!limitationValues.ok) return limitationValues
    const completedAt = canonicalizeTimestamp(safeValue(input, 'completedAt'), '$.completedAt'); if (!completedAt.ok) return completedAt
    return success({ ...identity.value, status: statusValue, draftIdentity: draftIdentity.value, contentArtifact: contentArtifact.value, evidenceSnapshotHash: evidenceSnapshotHash.value, citationBindings, appliedRuleIds: appliedRuleIds.value, providerProvenance: providerProvenance.value, limitations: limitationValues.value, completedAt: completedAt.value } as DraftResultResponse)
  }
  return failure('UNKNOWN_STATE', '$.status')
}

export function responseFingerprint(input: unknown): ValidationResult<string> {
  const normalized = normalizeGeoFlowResponse(input); if (!normalized.ok) return normalized
  const canonical = canonicalizeContractValue(normalized.value); if (!canonical.ok) return canonical
  return success(createHash('sha256').update(Buffer.from(canonical.value, 'utf8')).digest('hex'))
}

export function validateGeoFlowResponse(input: unknown, requestInput: unknown): ValidationResult<GeoFlowResponse> {
  const request = validateGeoFlowRequest(requestInput); if (!request.ok) return request
  const normalized = normalizeGeoFlowResponse(input); if (!normalized.ok) return normalized
  const response = normalized.value
  if (response.protocolVersion !== request.value.protocolVersion || response.requestId !== request.value.requestId || response.idempotencyKey !== request.value.idempotencyKey || response.requestFingerprint !== request.value.requestFingerprint || response.ownerUserId !== request.value.ownerUserId || response.clientId !== request.value.clientId || response.jobId !== request.value.jobId) return failure('IDENTITY_MISMATCH', '$')
  const expectedArticleKey = `article-${request.value.calendarEntryId}-${request.value.deliverableId}`
  if (response.externalArticleKey !== expectedArticleKey) return failure('IDENTITY_MISMATCH', '$.externalArticleKey')
  const responseEventTime = 'observedAt' in response ? response.observedAt : response.completedAt
  if (Date.parse(responseEventTime) < Date.parse(request.value.createdAt)) return failure('RESPONSE_TIME_INVALID', 'observedAt' in response ? '$.observedAt' : '$.completedAt')
  if (response.status === 'retry_wait' && Date.parse(response.retry.retryAt) <= Date.parse(response.observedAt)) return failure('RESPONSE_TIME_INVALID', '$.retry.retryAt')
  if (response.status === 'blocked' && response.failure.retryable) return failure('INVALID_INPUT', '$.failure.retryable')
  if (response.status === 'queued' || response.status === 'running' || response.status === 'retry_wait') return success(response)
  if (response.status === 'blocked' || response.status === 'failed') return success(response)
  if (response.status !== 'draft_ready' && response.status !== 'review_required') return failure('UNTRUSTED_DELIVERY_STATE', '$.status')
  if (response.draftIdentity.briefFingerprint !== request.value.briefFingerprint) return failure('BRIEF_FINGERPRINT_MISMATCH', '$.draftIdentity.briefFingerprint')
  if (response.evidenceSnapshotHash !== request.value.evidenceSnapshotHash) return failure('EVIDENCE_SNAPSHOT_MISMATCH', '$.evidenceSnapshotHash')
  if (response.draftIdentity.externalArticleKey !== expectedArticleKey) return failure('IDENTITY_MISMATCH', '$.externalArticleKey')
  if (response.contentArtifact.contentType !== request.value.contentType || response.contentArtifact.language !== request.value.language) return failure('IDENTITY_MISMATCH', '$.contentArtifact')
  if (Date.parse(response.completedAt) < Date.parse(request.value.createdAt)) return failure('RESPONSE_TIME_INVALID', '$.completedAt')
  if (request.value.requestedCapabilities.includes('knowledge_rag')) {
    if (response.citationBindings.length === 0) return failure('REQUIRED_EVIDENCE_MISSING', '$.citationBindings')
    const allowedChunks = new Set(request.value.evidenceChunks.map(chunk => `${chunk.sourceId}\u0000${chunk.artifactId}\u0000${chunk.chunkId}\u0000${chunk.chunkHash}`))
    for (const citation of response.citationBindings) if (!allowedChunks.has(`${citation.sourceId}\u0000${citation.artifactId}\u0000${citation.chunkId}\u0000${citation.chunkHash}`)) return failure('CITATION_OUTSIDE_APPROVED_EVIDENCE', '$.citationBindings')
  }
  if (request.value.requestedCapabilities.includes('autogeo_optimization')) {
    if (response.appliedRuleIds.length === 0) return failure('REQUIRED_RULE_MISSING', '$.appliedRuleIds')
    if (JSON.stringify(response.appliedRuleIds) !== JSON.stringify(request.value.selectedRuleIds)) return failure('APPLIED_RULE_OUTSIDE_SELECTION', '$.appliedRuleIds')
  }
  const provider = response.providerProvenance
  if (request.value.requestedCapabilities.includes('qwen_generation')) {
    if (provider.mode !== 'provider' || !/^(?:qwen|bailian|dashscope|model-studio)(?:[-_.][A-Za-z0-9._:-]+)*$/iu.test(provider.provider)) return failure('PROVIDER_PROVENANCE_MISSING', '$.providerProvenance')
  }
  if (provider.mode === 'deterministic_scaffold') {
    if (provider.provider !== 'deterministic_scaffold' || provider.model !== 'none' || !response.limitations.includes(DETERMINISTIC_SCAFFOLD_LIMITATION)) return failure('PROVIDER_PROVENANCE_MISSING', '$.providerProvenance')
  }
  if (provider.mode === 'reference_fallback') {
    if (provider.provider !== 'reference_fallback' || provider.model !== 'none' || !provider.fallbackReason) return failure('PROVIDER_PROVENANCE_MISSING', '$.providerProvenance')
  }
  return success(response)
}

export function validateResponseForRequest(response: unknown, requestInput: unknown): ValidationResult<GeoFlowResponse> { return validateGeoFlowResponse(response, requestInput) }
export function expectedRequestFingerprint(input: unknown): ValidationResult<string> { return canonicalRequestFingerprint(input) }
export { SIGNING_ALGORITHM, SIGNING_METHOD, SIGNING_PATH }
export type { GeoFlowRequestDraft } from './types'
