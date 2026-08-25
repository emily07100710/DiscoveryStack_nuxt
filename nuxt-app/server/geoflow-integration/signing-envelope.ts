import { createHash } from 'node:crypto'
import type { GeoFlowRequest, NonceFreshnessVerifier, ReasonCode, SigningEnvelope, SignatureVerifier, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { GEOFLOW_PROTOCOL_VERSION, SIGNING_ALGORITHM, SIGNING_METHOD, SIGNING_PATH } from './types'
import { canonicalizeTimestamp, normalizeNonce, normalizeOpaqueIdentifier, normalizeHashValue } from './normalization'
import { canonicalizeContractValue } from './fingerprint'
import { validateGeoFlowRequest } from './schemas'

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u
const PLANNER_KEYS = ['request', 'timestamp', 'nonce', 'sender', 'receiver', 'keyId'] as const
const ENVELOPE_KEYS = ['algorithm', 'method', 'path', 'protocolVersion', 'requestId', 'idempotencyKey', 'requestFingerprint', 'bodyHash', 'timestamp', 'nonce', 'sender', 'receiver', 'keyId', 'canonicalSigningInput'] as const
const CONTEXT_KEYS = ['request', 'verificationTime', 'maxClockSkewSeconds', 'expectedSender', 'expectedReceiver', 'expectedKeyId', 'nonceFreshnessVerifier', 'signatureVerifier'] as const
const READ_FAILED = Symbol('read-failed')

type SafeValue = unknown | typeof READ_FAILED

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean { try { const keys = Object.keys(record); return keys.length === expected.length && keys.every(key => expected.includes(key)) } catch { return false } }
function safeValue(record: Record<string, unknown>, key: string): SafeValue { try { return record[key] } catch { return READ_FAILED } }
function hash(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && HASH_PATTERN.test(value) ? success(value) : failure('INVALID_HASH', path) }
function bodyHash(request: unknown): ValidationResult<string> {
  const canonical = canonicalizeContractValue(request); if (!canonical.ok) return canonical
  return success(createHash('sha256').update(Buffer.from(canonical.value, 'utf8')).digest('hex'))
}
function parsePlannerInput(input: unknown): ValidationResult<{ request: GeoFlowRequest; timestamp: string; nonce: string; sender: string; receiver: string; keyId: string }> {
  if (!isPlainRecord(input) || !exactKeys(input, PLANNER_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const request = safeValue(input, 'request'); const timestamp = safeValue(input, 'timestamp'); const nonce = safeValue(input, 'nonce'); const sender = safeValue(input, 'sender'); const receiver = safeValue(input, 'receiver'); const keyId = safeValue(input, 'keyId')
  if ([request, timestamp, nonce, sender, receiver, keyId].some(value => value === READ_FAILED)) return failure('INVALID_INPUT')
  const timestampValue = canonicalizeTimestamp(timestamp, '$.timestamp'); if (!timestampValue.ok) return timestampValue
  const nonceValue = normalizeNonce(nonce); if (!nonceValue.ok) return nonceValue
  const senderValue = normalizeOpaqueIdentifier(sender, '$.sender'); if (!senderValue.ok) return senderValue
  const receiverValue = normalizeOpaqueIdentifier(receiver, '$.receiver'); if (!receiverValue.ok) return receiverValue
  const keyIdValue = normalizeOpaqueIdentifier(keyId, '$.keyId'); if (!keyIdValue.ok) return keyIdValue
  const validatedRequest = validateGeoFlowRequest(request); if (!validatedRequest.ok) return validatedRequest
  return success({ request: validatedRequest.value, timestamp: timestampValue.value, nonce: nonceValue.value, sender: senderValue.value, receiver: receiverValue.value, keyId: keyIdValue.value })
}

export function buildCanonicalSigningInput(input: Pick<SigningEnvelope, 'algorithm' | 'method' | 'path' | 'protocolVersion' | 'requestId' | 'idempotencyKey' | 'requestFingerprint' | 'bodyHash' | 'timestamp' | 'nonce' | 'sender' | 'receiver' | 'keyId'>): string {
  return [input.algorithm, input.method, input.path, input.protocolVersion, input.requestId, input.idempotencyKey, input.requestFingerprint, input.bodyHash, input.timestamp, input.nonce, input.sender, input.receiver, input.keyId].join('\n')
}

export function planSigningEnvelope(input: unknown): ValidationResult<SigningEnvelope> {
  const parsed = parsePlannerInput(input); if (!parsed.ok) return parsed
  const computedBodyHash = bodyHash(parsed.value.request); if (!computedBodyHash.ok) return computedBodyHash
  const request = parsed.value.request
  const core = { algorithm: SIGNING_ALGORITHM, method: SIGNING_METHOD, path: SIGNING_PATH, protocolVersion: GEOFLOW_PROTOCOL_VERSION, requestId: request.requestId, idempotencyKey: request.idempotencyKey, requestFingerprint: request.requestFingerprint, bodyHash: computedBodyHash.value, timestamp: parsed.value.timestamp, nonce: parsed.value.nonce, sender: parsed.value.sender, receiver: parsed.value.receiver, keyId: parsed.value.keyId }
  return success({ ...core, canonicalSigningInput: buildCanonicalSigningInput(core) })
}

function parseEnvelope(input: unknown): ValidationResult<SigningEnvelope> {
  if (!isPlainRecord(input) || !exactKeys(input, ENVELOPE_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const values = {} as Record<string, SafeValue>
  for (const key of ENVELOPE_KEYS) { const value = safeValue(input, key); if (value === READ_FAILED) return failure('INVALID_INPUT', `$.${key}`); values[key] = value }
  if (values.algorithm !== SIGNING_ALGORITHM || values.method !== SIGNING_METHOD || values.path !== SIGNING_PATH) return failure('SIGNATURE_CONTEXT_MISMATCH', '$')
  if (values.protocolVersion !== GEOFLOW_PROTOCOL_VERSION) return failure('INVALID_PROTOCOL_VERSION', '$.protocolVersion')
  const requestId = normalizeOpaqueIdentifier(values.requestId, '$.requestId'); if (!requestId.ok) return requestId
  const idempotencyKey = normalizeOpaqueIdentifier(values.idempotencyKey, '$.idempotencyKey'); if (!idempotencyKey.ok) return idempotencyKey
  const requestFingerprint = normalizeHashValue(values.requestFingerprint, '$.requestFingerprint'); if (!requestFingerprint.ok) return requestFingerprint
  const bodyHashValue = normalizeHashValue(values.bodyHash, '$.bodyHash'); if (!bodyHashValue.ok) return bodyHashValue
  const timestamp = canonicalizeTimestamp(values.timestamp, '$.timestamp'); if (!timestamp.ok) return timestamp
  const nonce = normalizeNonce(values.nonce); if (!nonce.ok) return nonce
  const sender = normalizeOpaqueIdentifier(values.sender, '$.sender'); if (!sender.ok) return sender
  const receiver = normalizeOpaqueIdentifier(values.receiver, '$.receiver'); if (!receiver.ok) return receiver
  const keyId = normalizeOpaqueIdentifier(values.keyId, '$.keyId'); if (!keyId.ok) return keyId
  if (typeof values.canonicalSigningInput !== 'string' || values.canonicalSigningInput.length > 4_000 || values.canonicalSigningInput.includes('\r')) return failure('INVALID_INPUT', '$.canonicalSigningInput')
  const core = { algorithm: SIGNING_ALGORITHM, method: SIGNING_METHOD, path: SIGNING_PATH, protocolVersion: GEOFLOW_PROTOCOL_VERSION, requestId: requestId.value, idempotencyKey: idempotencyKey.value, requestFingerprint: requestFingerprint.value, bodyHash: bodyHashValue.value, timestamp: timestamp.value, nonce: nonce.value, sender: sender.value, receiver: receiver.value, keyId: keyId.value }
  if (values.canonicalSigningInput !== buildCanonicalSigningInput(core)) return failure('SIGNATURE_CONTEXT_MISMATCH', '$.canonicalSigningInput')
  return success({ ...core, canonicalSigningInput: values.canonicalSigningInput })
}

function parseContext(input: unknown): ValidationResult<{ request: GeoFlowRequest; verificationTime: string; maxClockSkewSeconds: number; expectedSender: string; expectedReceiver: string; expectedKeyId: string; nonceFreshnessVerifier: NonceFreshnessVerifier; signatureVerifier: SignatureVerifier }> {
  if (!isPlainRecord(input) || !exactKeys(input, CONTEXT_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const request = safeValue(input, 'request'); const verificationTime = safeValue(input, 'verificationTime'); const maxClockSkewSeconds = safeValue(input, 'maxClockSkewSeconds'); const expectedSender = safeValue(input, 'expectedSender'); const expectedReceiver = safeValue(input, 'expectedReceiver'); const expectedKeyId = safeValue(input, 'expectedKeyId'); const nonceFreshnessVerifier = safeValue(input, 'nonceFreshnessVerifier'); const signatureVerifier = safeValue(input, 'signatureVerifier')
  if ([request, verificationTime, maxClockSkewSeconds, expectedSender, expectedReceiver, expectedKeyId, nonceFreshnessVerifier, signatureVerifier].some(value => value === READ_FAILED)) return failure('INVALID_INPUT')
  const timestamp = canonicalizeTimestamp(verificationTime, '$.verificationTime'); if (!timestamp.ok) return timestamp
  if (typeof maxClockSkewSeconds !== 'number' || !Number.isSafeInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 1 || maxClockSkewSeconds > 300) return failure('INVALID_INPUT', '$.maxClockSkewSeconds')
  const sender = normalizeOpaqueIdentifier(expectedSender, '$.expectedSender'); if (!sender.ok) return sender
  const receiver = normalizeOpaqueIdentifier(expectedReceiver, '$.expectedReceiver'); if (!receiver.ok) return receiver
  const keyId = normalizeOpaqueIdentifier(expectedKeyId, '$.expectedKeyId'); if (!keyId.ok) return keyId
  if (typeof nonceFreshnessVerifier !== 'function' || typeof signatureVerifier !== 'function') return failure('INVALID_INPUT', '$.verifier')
  const requestResult = validateGeoFlowRequest(request); if (!requestResult.ok) return requestResult
  return success({ request: requestResult.value, verificationTime: timestamp.value, maxClockSkewSeconds, expectedSender: sender.value, expectedReceiver: receiver.value, expectedKeyId: keyId.value, nonceFreshnessVerifier: nonceFreshnessVerifier as NonceFreshnessVerifier, signatureVerifier: signatureVerifier as SignatureVerifier })
}

export function verifySigningEnvelope(input: unknown, signature: unknown, context: unknown): ValidationResult<true> {
  const envelope = parseEnvelope(input); if (!envelope.ok) return envelope
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) return failure('INVALID_INPUT', '$.signature')
  const parsedContext = parseContext(context); if (!parsedContext.ok) return parsedContext
  const request = parsedContext.value.request
  if (envelope.value.protocolVersion !== request.protocolVersion || envelope.value.requestId !== request.requestId || envelope.value.idempotencyKey !== request.idempotencyKey || envelope.value.requestFingerprint !== request.requestFingerprint) return failure('SIGNATURE_CONTEXT_MISMATCH', '$')
  if (envelope.value.sender !== parsedContext.value.expectedSender || envelope.value.receiver !== parsedContext.value.expectedReceiver || envelope.value.keyId !== parsedContext.value.expectedKeyId) return failure('SIGNATURE_CONTEXT_MISMATCH', '$')
  const computedBodyHash = bodyHash(parsedContext.value.request); if (!computedBodyHash.ok) return computedBodyHash
  if (computedBodyHash.value !== envelope.value.bodyHash) return failure('CONTENT_HASH_MISMATCH', '$.bodyHash')
  const difference = Math.abs(Date.parse(envelope.value.timestamp) - Date.parse(parsedContext.value.verificationTime))
  if (!Number.isFinite(difference) || difference > parsedContext.value.maxClockSkewSeconds * 1000) return failure('SIGNATURE_EXPIRED', '$.timestamp')
  try { if (!parsedContext.value.nonceFreshnessVerifier(envelope.value.nonce)) return failure('NONCE_REPLAYED', '$.nonce') } catch { return failure('NONCE_REPLAYED', '$.nonce') }
  try { return parsedContext.value.signatureVerifier(envelope.value.canonicalSigningInput, signature) ? success(true) : failure('IDENTITY_MISMATCH', '$.signature') } catch { return failure('IDENTITY_MISMATCH', '$.signature') }
}
