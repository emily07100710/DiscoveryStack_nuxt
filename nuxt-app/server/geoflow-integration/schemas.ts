import type { CitationBinding, GeoFlowRequest, GeoFlowResponse, ProviderProvenance, ReasonCode, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { GEOFLOW_PROTOCOL_VERSION } from './types'
import { canonicalRequestFingerprint, requestFingerprintFromDraft } from './fingerprint'
import { canonicalizeTimestamp, normalizeGeoFlowRequest, normalizeGeoFlowRequestDraft, CONTRACT_LIMITS } from './normalization'

const RESPONSE_KEYS = ['protocolVersion', 'requestId', 'idempotencyKey', 'requestFingerprint', 'ownerUserId', 'clientId', 'jobId', 'externalProjectKey', 'externalTaskKey', 'externalJobKey', 'externalArticleKey', 'status', 'draftIdentity', 'title', 'summary', 'contentHash', 'evidenceSnapshotHash', 'citationBindings', 'appliedRuleIds', 'providerProvenance', 'limitations', 'completedAt'] as const
const DRAFT_IDENTITY_KEYS = ['externalArticleKey', 'briefFingerprint'] as const
const CITATION_KEYS = ['sourceId', 'artifactId', 'chunkId', 'chunkHash'] as const
const PROVENANCE_KEYS = ['provider', 'model', 'mode', 'fallbackReason'] as const
const GEO_STATUSES = ['queued', 'running', 'draft_ready', 'review_required', 'approved', 'publishing', 'published', 'blocked', 'failed', 'retry_wait'] as const
const PROVIDER_MODES = ['provider', 'deterministic_scaffold', 'reference_fallback'] as const
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const READ_FAILED = Symbol('read-failed')

type ResponseKey = typeof RESPONSE_KEYS[number]
type SafeValue = unknown | typeof READ_FAILED

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function safeValue(record: Record<string, unknown>, key: string): SafeValue { try { return record[key] } catch { return READ_FAILED } }
function readKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, SafeValue> | null {
  const values: Record<string, SafeValue> = {}
  for (const key of keys) { const value = safeValue(record, key); if (value === READ_FAILED) return null; values[key] = value }
  return values
}
function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean { try { const keys = Object.keys(record); return keys.length === expected.length && keys.every(key => expected.includes(key)) } catch { return false } }
function text(value: unknown, max: number, path: string): ValidationResult<string> {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return failure('INVALID_INPUT', path)
  try { const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' '); return normalized.length > 0 && normalized.length <= max ? success(normalized) : failure(normalized ? 'LIMIT_EXCEEDED' : 'INVALID_INPUT', path) } catch { return failure('INVALID_INPUT', path) }
}
function opaque(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && value.length > 0 && value.length <= 160 && !CONTROL_CHARACTERS.test(value) && OPAQUE_PATTERN.test(value) ? success(value) : failure(typeof value === 'string' && value.length > 160 ? 'LIMIT_EXCEEDED' : 'INVALID_OPAQUE_IDENTIFIER', path) }
function positiveInteger(value: unknown, path: string): ValidationResult<number> { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? success(value) : failure('INVALID_INPUT', path) }
function hash(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && HASH_PATTERN.test(value) ? success(value) : failure('INVALID_HASH', path) }
function setIds(value: unknown, max: number, path: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return failure('INVALID_INPUT', path)
  if (value.length > max) return failure('LIMIT_EXCEEDED', path)
  const values: string[] = []
  for (let index = 0; index < value.length; index += 1) { const item = opaque(value[index], `${path}[${index}]`); if (!item.ok) return item; if (!values.includes(item.value)) values.push(item.value) }
  values.sort()
  return success(values)
}

export function buildGeoFlowRequest(input: unknown): ValidationResult<GeoFlowRequest> {
  const normalized = normalizeGeoFlowRequestDraft(input)
  if (!normalized.ok) return normalized
  return success({ ...normalized.value, requestFingerprint: requestFingerprintFromDraft(normalized.value) })
}

export function validateGeoFlowRequest(input: unknown): ValidationResult<GeoFlowRequest> {
  const normalized = normalizeGeoFlowRequest(input)
  if (!normalized.ok) return normalized
  const { requestFingerprint, ...draft } = normalized.value
  const expected = requestFingerprintFromDraft(draft)
  return expected === requestFingerprint ? success(normalized.value) : failure('REQUEST_FINGERPRINT_MISMATCH', '$.requestFingerprint')
}

function normalizeCitation(value: unknown, index: number): ValidationResult<CitationBinding> {
  if (!isPlainRecord(value) || !exactKeys(value, CITATION_KEYS)) return failure('UNKNOWN_FIELD', `$.citationBindings[${index}]`)
  const values = readKeys(value, CITATION_KEYS); if (!values) return failure('INVALID_INPUT', `$.citationBindings[${index}]`)
  const source = opaque(values.sourceId, `$.citationBindings[${index}].sourceId`); if (!source.ok) return source
  const artifact = opaque(values.artifactId, `$.citationBindings[${index}].artifactId`); if (!artifact.ok) return artifact
  const chunk = opaque(values.chunkId, `$.citationBindings[${index}].chunkId`); if (!chunk.ok) return chunk
  const chunkHashResult = hash(values.chunkHash, `$.citationBindings[${index}].chunkHash`); if (!chunkHashResult.ok) return chunkHashResult
  return success({ sourceId: source.value, artifactId: artifact.value, chunkId: chunk.value, chunkHash: chunkHashResult.value })
}

function normalizeProvenance(value: unknown): ValidationResult<ProviderProvenance> {
  if (!isPlainRecord(value) || !exactKeys(value, PROVENANCE_KEYS)) return failure('UNKNOWN_FIELD', '$.providerProvenance')
  const values = readKeys(value, PROVENANCE_KEYS); if (!values) return failure('INVALID_INPUT', '$.providerProvenance')
  const provider = text(values.provider, 160, '$.providerProvenance.provider'); if (!provider.ok) return provider
  const model = text(values.model, 160, '$.providerProvenance.model'); if (!model.ok) return model
  if (typeof values.mode !== 'string' || !PROVIDER_MODES.includes(values.mode as typeof PROVIDER_MODES[number])) return failure('INVALID_INPUT', '$.providerProvenance.mode')
  if (values.fallbackReason === null) return success({ provider: provider.value, model: model.value, mode: values.mode as ProviderProvenance['mode'], fallbackReason: null })
  const fallbackReason = text(values.fallbackReason, 500, '$.providerProvenance.fallbackReason'); if (!fallbackReason.ok) return fallbackReason
  return success({ provider: provider.value, model: model.value, mode: values.mode as ProviderProvenance['mode'], fallbackReason: fallbackReason.value })
}

export function normalizeGeoFlowResponse(input: unknown): ValidationResult<GeoFlowResponse> {
  if (!isPlainRecord(input)) return failure('INVALID_INPUT')
  if (!exactKeys(input, RESPONSE_KEYS)) return failure('UNKNOWN_FIELD')
  const values = readKeys(input, RESPONSE_KEYS); if (!values) return failure('INVALID_INPUT')
  const protocolVersion = values.protocolVersion === GEOFLOW_PROTOCOL_VERSION ? success(GEOFLOW_PROTOCOL_VERSION) : failure('INVALID_PROTOCOL_VERSION', '$.protocolVersion'); if (!protocolVersion.ok) return protocolVersion
  const requestId = opaque(values.requestId, '$.requestId'); if (!requestId.ok) return requestId
  const idempotencyKey = opaque(values.idempotencyKey, '$.idempotencyKey'); if (!idempotencyKey.ok) return idempotencyKey
  const requestFingerprint = hash(values.requestFingerprint, '$.requestFingerprint'); if (!requestFingerprint.ok) return requestFingerprint
  const ownerUserId = positiveInteger(values.ownerUserId, '$.ownerUserId'); if (!ownerUserId.ok) return ownerUserId
  const clientId = positiveInteger(values.clientId, '$.clientId'); if (!clientId.ok) return clientId
  const jobId = positiveInteger(values.jobId, '$.jobId'); if (!jobId.ok) return jobId
  const externalKeys = {} as Record<'externalProjectKey' | 'externalTaskKey' | 'externalJobKey' | 'externalArticleKey', string>
  for (const key of ['externalProjectKey', 'externalTaskKey', 'externalJobKey', 'externalArticleKey'] as const) { const item = opaque(values[key], `$.${key}`); if (!item.ok) return item; externalKeys[key] = item.value }
  const status = typeof values.status === 'string' && GEO_STATUSES.includes(values.status as typeof GEO_STATUSES[number]) ? values.status as typeof GEO_STATUSES[number] : null
  if (!status) return failure('UNKNOWN_STATE', '$.status')
  if (!isPlainRecord(values.draftIdentity) || !exactKeys(values.draftIdentity, DRAFT_IDENTITY_KEYS)) return failure('UNKNOWN_FIELD', '$.draftIdentity')
  const identityValues = readKeys(values.draftIdentity, DRAFT_IDENTITY_KEYS); if (!identityValues) return failure('INVALID_INPUT', '$.draftIdentity')
  const identityArticle = opaque(identityValues.externalArticleKey, '$.draftIdentity.externalArticleKey'); if (!identityArticle.ok) return identityArticle
  const identityBrief = hash(identityValues.briefFingerprint, '$.draftIdentity.briefFingerprint'); if (!identityBrief.ok) return identityBrief
  const title = text(values.title, CONTRACT_LIMITS.maxTitleLength, '$.title'); if (!title.ok) return title
  const summary = text(values.summary, CONTRACT_LIMITS.maxSummaryLength, '$.summary'); if (!summary.ok) return summary
  const contentHash = hash(values.contentHash, '$.contentHash'); if (!contentHash.ok) return contentHash
  const evidenceSnapshotHash = hash(values.evidenceSnapshotHash, '$.evidenceSnapshotHash'); if (!evidenceSnapshotHash.ok) return evidenceSnapshotHash
  if (!Array.isArray(values.citationBindings)) return failure('INVALID_INPUT', '$.citationBindings')
  if (values.citationBindings.length > CONTRACT_LIMITS.maxCitationBindings) return failure('LIMIT_EXCEEDED', '$.citationBindings')
  const citationBindings: CitationBinding[] = []
  for (let index = 0; index < values.citationBindings.length; index += 1) { const citation = normalizeCitation(values.citationBindings[index], index); if (!citation.ok) return citation; citationBindings.push(citation.value) }
  const appliedRuleIds = setIds(values.appliedRuleIds, CONTRACT_LIMITS.maxSelectedRuleIds, '$.appliedRuleIds'); if (!appliedRuleIds.ok) return appliedRuleIds
  if (!Array.isArray(values.limitations)) return failure('INVALID_INPUT', '$.limitations')
  if (values.limitations.length > CONTRACT_LIMITS.maxLimitations) return failure('LIMIT_EXCEEDED', '$.limitations')
  const limitations: string[] = []
  for (let index = 0; index < values.limitations.length; index += 1) { const item = text(values.limitations[index], CONTRACT_LIMITS.maxLimitationLength, `$.limitations[${index}]`); if (!item.ok) return item; limitations.push(item.value) }
  const providerProvenance = normalizeProvenance(values.providerProvenance); if (!providerProvenance.ok) return providerProvenance
  const completedAt = canonicalizeTimestamp(values.completedAt, '$.completedAt'); if (!completedAt.ok) return completedAt
  return success({ protocolVersion: protocolVersion.value, requestId: requestId.value, idempotencyKey: idempotencyKey.value, requestFingerprint: requestFingerprint.value, ownerUserId: ownerUserId.value, clientId: clientId.value, jobId: jobId.value, externalProjectKey: externalKeys.externalProjectKey, externalTaskKey: externalKeys.externalTaskKey, externalJobKey: externalKeys.externalJobKey, externalArticleKey: externalKeys.externalArticleKey, status, draftIdentity: { externalArticleKey: identityArticle.value, briefFingerprint: identityBrief.value }, title: title.value, summary: summary.value, contentHash: contentHash.value, evidenceSnapshotHash: evidenceSnapshotHash.value, citationBindings, appliedRuleIds: appliedRuleIds.value, providerProvenance: providerProvenance.value, limitations, completedAt: completedAt.value })
}

export function validateGeoFlowResponse(input: unknown, requestInput: unknown): ValidationResult<GeoFlowResponse> {
  const request = validateGeoFlowRequest(requestInput)
  if (!request.ok) return request
  const normalized = normalizeGeoFlowResponse(input)
  if (!normalized.ok) return normalized
  const response = normalized.value
  if (response.protocolVersion !== request.value.protocolVersion || response.requestId !== request.value.requestId || response.idempotencyKey !== request.value.idempotencyKey || response.requestFingerprint !== request.value.requestFingerprint) return failure('REQUEST_FINGERPRINT_MISMATCH', '$')
  if (response.ownerUserId !== request.value.ownerUserId || response.clientId !== request.value.clientId || response.jobId !== request.value.jobId) return failure('IDENTITY_MISMATCH', '$')
  if (response.evidenceSnapshotHash !== request.value.evidenceSnapshotHash) return failure('EVIDENCE_SNAPSHOT_MISMATCH', '$.evidenceSnapshotHash')
  if (response.draftIdentity.briefFingerprint !== request.value.briefFingerprint) return failure('BRIEF_FINGERPRINT_MISMATCH', '$.draftIdentity.briefFingerprint')
  const expectedArticleKey = `article-${request.value.calendarEntryId}-${request.value.deliverableId}`
  if (response.externalArticleKey !== expectedArticleKey || response.draftIdentity.externalArticleKey !== expectedArticleKey) return failure(response.status === 'published' ? 'UNTRUSTED_PUBLISHED_RESULT' : 'IDENTITY_MISMATCH', '$.externalArticleKey')
  const allowedChunks = new Set(request.value.evidenceChunks.map(chunk => `${chunk.sourceId}\\u0000${chunk.artifactId}\\u0000${chunk.chunkId}\\u0000${chunk.chunkHash}`))
  for (const citation of response.citationBindings) if (!allowedChunks.has(`${citation.sourceId}\\u0000${citation.artifactId}\\u0000${citation.chunkId}\\u0000${citation.chunkHash}`)) return failure('CITATION_OUTSIDE_APPROVED_EVIDENCE', '$.citationBindings')
  const selected = new Set(request.value.selectedRuleIds)
  if (response.appliedRuleIds.some(ruleId => !selected.has(ruleId))) return failure('APPLIED_RULE_OUTSIDE_SELECTION', '$.appliedRuleIds')
  const provider = response.providerProvenance
  if (!provider.provider || !provider.model || (provider.mode === 'reference_fallback' && !provider.fallbackReason)) return failure('PROVIDER_PROVENANCE_MISSING', '$.providerProvenance')
  return success(response)
}

export function validateResponseForRequest(response: unknown, requestInput: unknown): ValidationResult<GeoFlowResponse> {
  return validateGeoFlowResponse(response, requestInput)
}

export function expectedRequestFingerprint(input: unknown): ValidationResult<string> { return canonicalRequestFingerprint(input) }
export type { GeoFlowRequestDraft } from './types'
