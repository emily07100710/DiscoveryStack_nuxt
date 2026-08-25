import { isIP } from 'node:net'
import type { EvidenceChunk, GeoFlowRequest, GeoFlowRequestDraft, ReasonCode, RequestedCapability, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { GEOFLOW_PROTOCOL_VERSION } from './types'

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const CREDENTIAL_QUERY_PATTERN = /(?:pass(?:word)?|secret|token|api[-_]?key|authorization|auth|credential|private[-_]?key|signature|sig)/iu
const MAX_REVIEWED_TEXT_TOTAL = 120_000
const MAX_EVIDENCE_CHUNKS = 50
const MAX_SELECTED_RULES = 30
const MAX_AUTHORITIES = 50
const MAX_LIMITATIONS = 20
const MAX_LIMITATION_LENGTH = 500
const MAX_EXTERNAL_KEY_LENGTH = 160
const MAX_TITLE_LENGTH = 300
const MAX_SUMMARY_LENGTH = 2_000
const READ_FAILED = Symbol('read-failed')

const REQUEST_DRAFT_KEYS = ['protocolVersion', 'requestId', 'idempotencyKey', 'ownerUserId', 'clientId', 'calendarEntryId', 'productionPlanId', 'deliverableId', 'briefId', 'jobId', 'evidenceSnapshotHash', 'briefFingerprint', 'contentType', 'language', 'generationMode', 'requestedCapabilities', 'selectedRuleIds', 'authoritySourceIds', 'evidenceChunks', 'createdAt'] as const
const REQUEST_KEYS = [...REQUEST_DRAFT_KEYS, 'requestFingerprint'] as const
const EVIDENCE_KEYS = ['sourceId', 'artifactId', 'chunkId', 'chunkHash', 'reviewedText', 'locator'] as const

type RequestDraftKey = typeof REQUEST_DRAFT_KEYS[number]

type SafeRecordValue = unknown | typeof READ_FAILED

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function safeValue(record: Record<string, unknown>, key: string): SafeRecordValue { try { return record[key] } catch { return READ_FAILED } }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { try { const keys = Object.keys(value); return keys.length === expected.length && keys.every(key => expected.includes(key)) } catch { return false } }
function normalizeHumanText(value: unknown, maxLength: number, path: string): ValidationResult<string> {
  if (typeof value !== 'string') return failure('INVALID_INPUT', path)
  try { const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' '); if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) return failure(normalized ? 'LIMIT_EXCEEDED' : 'INVALID_INPUT', path); return success(normalized) } catch { return failure('INVALID_INPUT', path) }
}
function normalizeOpaque(value: unknown, maxLength: number, path: string): ValidationResult<string> { return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTERS.test(value) && OPAQUE_PATTERN.test(value) ? success(value) : failure(typeof value === 'string' && value.length > maxLength ? 'LIMIT_EXCEEDED' : 'INVALID_OPAQUE_IDENTIFIER', path) }
function normalizeRequestId(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? success(value) : failure('INVALID_INPUT', path) }
function normalizePositiveInteger(value: unknown, path: string): ValidationResult<number> { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? success(value) : failure('INVALID_INPUT', path) }
function normalizeHash(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && HASH_PATTERN.test(value) ? success(value) : failure('INVALID_HASH', path) }
function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): ValidationResult<T> { return typeof value === 'string' && allowed.includes(value as T) ? success(value as T) : failure('INVALID_INPUT', path) }
function normalizeSetArray(value: unknown, max: number, path: string): ValidationResult<string[]> {
  if (!Array.isArray(value)) return failure('INVALID_INPUT', path)
  if (value.length > max) return failure('LIMIT_EXCEEDED', path)
  const result: string[] = []
  for (let index = 0; index < value.length; index += 1) { const item = normalizeOpaque(value[index], 160, `${path}[${index}]`); if (!item.ok) return item; if (!result.includes(item.value)) result.push(item.value) }
  result.sort()
  return success(result)
}
function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate() }

export function canonicalizeTimestamp(value: unknown, path = '$.createdAt'): ValidationResult<string> {
  if (typeof value !== 'string') return failure('INVALID_TIMESTAMP', path)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) return failure('INVALID_TIMESTAMP', path)
  const yearPart = match[1] ?? ''; const monthPart = match[2] ?? ''; const dayPart = match[3] ?? ''; const hourPart = match[4] ?? ''; const minutePart = match[5] ?? ''; const secondPart = match[6] ?? ''; const offset = match[8] ?? ''
  const year = Number(yearPart); const month = Number(monthPart); const day = Number(dayPart); const hour = Number(hourPart); const minute = Number(minutePart); const second = Number(secondPart)
  if (!offset || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))) return failure('INVALID_TIMESTAMP', path)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? success(new Date(parsed).toISOString()) : failure('INVALID_TIMESTAMP', path)
}

function normalizeIPv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/u.test(part))) return false
  const octets = parts.map(Number); const [a = -1, b = -1, c = -1] = octets
  if (octets.some(octet => octet > 255)) return false
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || c === 51)) || (a === 203 && b === 0 && c === 113) || a >= 224
}
function normalizeIPv6(hostname: string): boolean {
  const host = hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase()
  if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') || /^(?:2001:0?db8:|2001:0{3,4}:|2001:0002:|2001:0010:|2001:0020:|2001:0030:)/u.test(host)) return true
  if (host.startsWith('::ffff:')) { const tail = host.slice(7); if (isIP(tail) === 4) return normalizeIPv4(tail); if (/^(?:c0a8|0a00|7f00):/u.test(tail)) return true }
  return false
}

export function validatePublicHttpsUrl(value: unknown, path = '$.locator'): ValidationResult<string> {
  if (typeof value !== 'string' || value.length > 2048 || CONTROL_CHARACTERS.test(value)) return failure('INVALID_PUBLIC_URL', path)
  let url: URL
  try { url = new URL(value) } catch { return failure('INVALID_PUBLIC_URL', path) }
  const hostname = url.hostname.toLowerCase(); const ipHost = hostname.replace(/^\[/u, '').replace(/\]$/u, ''); const ipKind = isIP(ipHost)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost') || hostname === 'local' || hostname === 'internal' || hostname === 'onion' || hostname.endsWith('.onion') || CREDENTIAL_QUERY_PATTERN.test(url.search)) return failure('INVALID_PUBLIC_URL', path)
  if (ipKind === 4 && normalizeIPv4(ipHost)) return failure('PRIVATE_OR_SPECIAL_TARGET', path)
  if (ipKind === 6 && normalizeIPv6(ipHost)) return failure('PRIVATE_OR_SPECIAL_TARGET', path)
  if (ipKind === 0 && !hostname.includes('.')) return failure('INVALID_PUBLIC_URL', path)
  return success(url.toString())
}

function normalizeEvidenceChunk(value: unknown, index: number): ValidationResult<EvidenceChunk> {
  if (!isPlainRecord(value) || !exactKeys(value, EVIDENCE_KEYS)) return failure('UNKNOWN_FIELD', `$.evidenceChunks[${index}]`)
  const sourceId = safeValue(value, 'sourceId'); const artifactId = safeValue(value, 'artifactId'); const chunkId = safeValue(value, 'chunkId'); const chunkHash = safeValue(value, 'chunkHash'); const reviewedText = safeValue(value, 'reviewedText'); const locator = safeValue(value, 'locator')
  if ([sourceId, artifactId, chunkId, chunkHash, reviewedText, locator].some(item => item === READ_FAILED)) return failure('INVALID_INPUT', `$.evidenceChunks[${index}]`)
  const normalizedSource = normalizeOpaque(sourceId, MAX_EXTERNAL_KEY_LENGTH, `$.evidenceChunks[${index}].sourceId`); if (!normalizedSource.ok) return normalizedSource
  const normalizedArtifact = normalizeOpaque(artifactId, MAX_EXTERNAL_KEY_LENGTH, `$.evidenceChunks[${index}].artifactId`); if (!normalizedArtifact.ok) return normalizedArtifact
  const normalizedChunk = normalizeOpaque(chunkId, MAX_EXTERNAL_KEY_LENGTH, `$.evidenceChunks[${index}].chunkId`); if (!normalizedChunk.ok) return normalizedChunk
  const normalizedHash = normalizeHash(chunkHash, `$.evidenceChunks[${index}].chunkHash`); if (!normalizedHash.ok) return normalizedHash
  const normalizedText = normalizeHumanText(reviewedText, 12_000, `$.evidenceChunks[${index}].reviewedText`); if (!normalizedText.ok) return normalizedText
  const normalizedLocator = validatePublicHttpsUrl(locator, `$.evidenceChunks[${index}].locator`); if (!normalizedLocator.ok) return normalizedLocator
  return success({ sourceId: normalizedSource.value, artifactId: normalizedArtifact.value, chunkId: normalizedChunk.value, chunkHash: normalizedHash.value, reviewedText: normalizedText.value, locator: normalizedLocator.value })
}

export function normalizeGeoFlowRequestDraft(input: unknown): ValidationResult<GeoFlowRequestDraft> {
  if (!isPlainRecord(input)) return failure('INVALID_INPUT')
  if (!exactKeys(input, REQUEST_DRAFT_KEYS)) return failure('UNKNOWN_FIELD')
  const values = {} as Record<RequestDraftKey, SafeRecordValue>
  for (const key of REQUEST_DRAFT_KEYS) values[key] = safeValue(input, key)
  if (Object.values(values).some(value => value === READ_FAILED)) return failure('INVALID_INPUT')
  const protocolVersion = values.protocolVersion === GEOFLOW_PROTOCOL_VERSION ? success(GEOFLOW_PROTOCOL_VERSION) : failure('INVALID_PROTOCOL_VERSION', '$.protocolVersion'); if (!protocolVersion.ok) return protocolVersion
  const requestId = normalizeRequestId(values.requestId, '$.requestId'); if (!requestId.ok) return requestId
  const idempotencyKey = normalizeRequestId(values.idempotencyKey, '$.idempotencyKey'); if (!idempotencyKey.ok) return idempotencyKey
  const ownerUserId = normalizePositiveInteger(values.ownerUserId, '$.ownerUserId'); if (!ownerUserId.ok) return ownerUserId
  const clientId = normalizePositiveInteger(values.clientId, '$.clientId'); if (!clientId.ok) return clientId
  const calendarEntryId = normalizePositiveInteger(values.calendarEntryId, '$.calendarEntryId'); if (!calendarEntryId.ok) return calendarEntryId
  const productionPlanId = normalizePositiveInteger(values.productionPlanId, '$.productionPlanId'); if (!productionPlanId.ok) return productionPlanId
  const deliverableId = normalizePositiveInteger(values.deliverableId, '$.deliverableId'); if (!deliverableId.ok) return deliverableId
  const briefId = normalizePositiveInteger(values.briefId, '$.briefId'); if (!briefId.ok) return briefId
  const jobId = normalizePositiveInteger(values.jobId, '$.jobId'); if (!jobId.ok) return jobId
  const evidenceSnapshotHash = normalizeHash(values.evidenceSnapshotHash, '$.evidenceSnapshotHash'); if (!evidenceSnapshotHash.ok) return evidenceSnapshotHash
  const briefFingerprint = normalizeHash(values.briefFingerprint, '$.briefFingerprint'); if (!briefFingerprint.ok) return briefFingerprint
  const contentType = normalizeEnum(values.contentType, ['article', 'faq', 'service_page'] as const, '$.contentType'); if (!contentType.ok) return contentType
  const language = normalizeEnum(values.language, ['zh-hant', 'en'] as const, '$.language'); if (!language.ok) return language
  const generationMode = normalizeEnum(values.generationMode, ['draft', 'revision'] as const, '$.generationMode'); if (!generationMode.ok) return generationMode
  const requestedCapabilities = normalizeSetArray(values.requestedCapabilities, 10, '$.requestedCapabilities'); if (!requestedCapabilities.ok) return requestedCapabilities
  const allowedCapabilities = new Set(['knowledge_rag', 'prompt_pack', 'qwen_generation', 'autogeo_optimization', 'human_review', 'publication'])
  if (requestedCapabilities.value.some(item => !allowedCapabilities.has(item))) return failure('INVALID_INPUT', '$.requestedCapabilities')
  const selectedRuleIds = normalizeSetArray(values.selectedRuleIds, MAX_SELECTED_RULES, '$.selectedRuleIds'); if (!selectedRuleIds.ok) return selectedRuleIds
  const authoritySourceIds = normalizeSetArray(values.authoritySourceIds, MAX_AUTHORITIES, '$.authoritySourceIds'); if (!authoritySourceIds.ok) return authoritySourceIds
  if (!Array.isArray(values.evidenceChunks)) return failure('INVALID_INPUT', '$.evidenceChunks')
  if (values.evidenceChunks.length > MAX_EVIDENCE_CHUNKS) return failure('LIMIT_EXCEEDED', '$.evidenceChunks')
  const evidenceChunks: EvidenceChunk[] = []; let reviewedTextTotal = 0
  for (let index = 0; index < values.evidenceChunks.length; index += 1) { const chunk = normalizeEvidenceChunk(values.evidenceChunks[index], index); if (!chunk.ok) return chunk; if (!authoritySourceIds.value.includes(chunk.value.sourceId)) return failure('CITATION_OUTSIDE_APPROVED_EVIDENCE', `$.evidenceChunks[${index}].sourceId`); evidenceChunks.push(chunk.value); reviewedTextTotal += chunk.value.reviewedText.length; if (reviewedTextTotal > MAX_REVIEWED_TEXT_TOTAL) return failure('LIMIT_EXCEEDED', '$.evidenceChunks.reviewedText') }
  const createdAt = canonicalizeTimestamp(values.createdAt); if (!createdAt.ok) return createdAt
  return success({ protocolVersion: protocolVersion.value, requestId: requestId.value, idempotencyKey: idempotencyKey.value, ownerUserId: ownerUserId.value, clientId: clientId.value, calendarEntryId: calendarEntryId.value, productionPlanId: productionPlanId.value, deliverableId: deliverableId.value, briefId: briefId.value, jobId: jobId.value, evidenceSnapshotHash: evidenceSnapshotHash.value, briefFingerprint: briefFingerprint.value, contentType: contentType.value, language: language.value, generationMode: generationMode.value, requestedCapabilities: requestedCapabilities.value as RequestedCapability[], selectedRuleIds: selectedRuleIds.value, authoritySourceIds: authoritySourceIds.value, evidenceChunks, createdAt: createdAt.value })
}

export function normalizeGeoFlowRequest(input: unknown): ValidationResult<GeoFlowRequest> {
  if (!isPlainRecord(input) || !exactKeys(input, REQUEST_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const draftInput = {} as Record<RequestDraftKey, unknown>
  for (const key of REQUEST_DRAFT_KEYS) { const value = safeValue(input, key); if (value === READ_FAILED) return failure('INVALID_INPUT', `$.${key}`); draftInput[key] = value }
  const draft = normalizeGeoFlowRequestDraft(draftInput); if (!draft.ok) return draft
  const requestFingerprint = safeValue(input, 'requestFingerprint'); if (requestFingerprint === READ_FAILED) return failure('INVALID_INPUT', '$.requestFingerprint')
  const fingerprint = normalizeHash(requestFingerprint, '$.requestFingerprint'); if (!fingerprint.ok) return fingerprint
  return success({ ...draft.value, requestFingerprint: fingerprint.value })
}

export const CONTRACT_LIMITS = { maxTitleLength: MAX_TITLE_LENGTH, maxSummaryLength: MAX_SUMMARY_LENGTH, maxLimitations: MAX_LIMITATIONS, maxLimitationLength: MAX_LIMITATION_LENGTH, maxSelectedRuleIds: MAX_SELECTED_RULES, maxAuthoritySourceIds: MAX_AUTHORITIES, maxEvidenceChunks: MAX_EVIDENCE_CHUNKS, maxReviewedTextPerChunk: 12_000, maxReviewedTextTotal: MAX_REVIEWED_TEXT_TOTAL, maxCitationBindings: 100 } as const
