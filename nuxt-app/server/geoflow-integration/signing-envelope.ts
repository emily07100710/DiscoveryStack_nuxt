import type { EnvelopeVerifier, GeoFlowRequest, ReasonCode, SigningEnvelope, ValidationFailure, ValidationResult, ValidationSuccess } from './types'
import { GEOFLOW_PROTOCOL_VERSION } from './types'
import { canonicalizeTimestamp } from './normalization'
import { validateGeoFlowRequest } from './schemas'

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const ENVELOPE_KEYS = ['request', 'bodyHash', 'timestamp', 'nonce', 'sender', 'receiver'] as const
const SIGNING_ENVELOPE_KEYS = ['protocolVersion', 'requestId', 'idempotencyKey', 'requestFingerprint', 'bodyHash', 'timestamp', 'nonce', 'sender', 'receiver', 'canonicalSigningInput'] as const
const READ_FAILED = Symbol('read-failed')
type EnvelopeKey = typeof SIGNING_ENVELOPE_KEYS[number]
type SafeValue = unknown | typeof READ_FAILED

function success<T>(value: T): ValidationSuccess<T> { return { ok: true, value } }
function failure(reason: ReasonCode, path = '$'): ValidationFailure { return { ok: false, reason, issues: [{ path, code: reason }] } }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}
function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean { try { const keys = Object.keys(record); return keys.length === expected.length && keys.every(key => expected.includes(key)) } catch { return false } }
function safeValue(record: Record<string, unknown>, key: string): SafeValue { try { return record[key] } catch { return READ_FAILED } }
function opaque(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && OPAQUE_PATTERN.test(value) ? success(value) : failure('INVALID_INPUT', path) }
function hash(value: unknown, path: string): ValidationResult<string> { return typeof value === 'string' && HASH_PATTERN.test(value) ? success(value) : failure('INVALID_HASH', path) }

function parsePlannerInput(input: unknown): ValidationResult<{ request: GeoFlowRequest; bodyHash: string; timestamp: string; nonce: string; sender: string; receiver: string }> {
  if (!isPlainRecord(input) || !exactKeys(input, ENVELOPE_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const requestValue = safeValue(input, 'request'); const bodyHashValue = safeValue(input, 'bodyHash'); const timestampValue = safeValue(input, 'timestamp'); const nonceValue = safeValue(input, 'nonce'); const senderValue = safeValue(input, 'sender'); const receiverValue = safeValue(input, 'receiver')
  if ([requestValue, bodyHashValue, timestampValue, nonceValue, senderValue, receiverValue].some(value => value === READ_FAILED)) return failure('INVALID_INPUT')
  const request = validateGeoFlowRequest(requestValue); if (!request.ok) return request
  const bodyHash = hash(bodyHashValue, '$.bodyHash'); if (!bodyHash.ok) return bodyHash
  const timestamp = canonicalizeTimestamp(timestampValue, '$.timestamp'); if (!timestamp.ok) return timestamp
  const nonce = opaque(nonceValue, '$.nonce'); if (!nonce.ok) return nonce
  const sender = opaque(senderValue, '$.sender'); if (!sender.ok) return sender
  const receiver = opaque(receiverValue, '$.receiver'); if (!receiver.ok) return receiver
  return success({ request: request.value, bodyHash: bodyHash.value, timestamp: timestamp.value, nonce: nonce.value, sender: sender.value, receiver: receiver.value })
}

export function buildCanonicalSigningInput(input: Pick<SigningEnvelope, 'protocolVersion' | 'requestId' | 'idempotencyKey' | 'requestFingerprint' | 'bodyHash' | 'timestamp' | 'nonce' | 'sender' | 'receiver'>): string {
  return [input.protocolVersion, input.requestId, input.idempotencyKey, input.requestFingerprint, input.bodyHash, input.timestamp, input.nonce, input.sender, input.receiver].join('\n')
}

export function planSigningEnvelope(input: unknown): ValidationResult<SigningEnvelope> {
  const parsed = parsePlannerInput(input); if (!parsed.ok) return parsed
  const { request, bodyHash, timestamp, nonce, sender, receiver } = parsed.value
  const core = { protocolVersion: GEOFLOW_PROTOCOL_VERSION, requestId: request.requestId, idempotencyKey: request.idempotencyKey, requestFingerprint: request.requestFingerprint, bodyHash, timestamp, nonce, sender, receiver }
  return success({ ...core, canonicalSigningInput: buildCanonicalSigningInput(core) })
}

function parseEnvelope(input: unknown): ValidationResult<SigningEnvelope> {
  if (!isPlainRecord(input) || !exactKeys(input, SIGNING_ENVELOPE_KEYS)) return failure(isPlainRecord(input) ? 'UNKNOWN_FIELD' : 'INVALID_INPUT')
  const values = {} as Record<EnvelopeKey, SafeValue>
  for (const key of SIGNING_ENVELOPE_KEYS) { const value = safeValue(input, key); if (value === READ_FAILED) return failure('INVALID_INPUT', `$.${key}`); values[key] = value }
  if (values.protocolVersion !== GEOFLOW_PROTOCOL_VERSION) return failure('INVALID_PROTOCOL_VERSION', '$.protocolVersion')
  const requestId = opaque(values.requestId, '$.requestId'); if (!requestId.ok) return requestId
  const idempotencyKey = opaque(values.idempotencyKey, '$.idempotencyKey'); if (!idempotencyKey.ok) return idempotencyKey
  const requestFingerprint = hash(values.requestFingerprint, '$.requestFingerprint'); if (!requestFingerprint.ok) return requestFingerprint
  const bodyHash = hash(values.bodyHash, '$.bodyHash'); if (!bodyHash.ok) return bodyHash
  const nonce = opaque(values.nonce, '$.nonce'); if (!nonce.ok) return nonce
  const sender = opaque(values.sender, '$.sender'); if (!sender.ok) return sender
  const receiver = opaque(values.receiver, '$.receiver'); if (!receiver.ok) return receiver
  const timestamp = canonicalizeTimestamp(values.timestamp, '$.timestamp'); if (!timestamp.ok) return timestamp
  if (typeof values.canonicalSigningInput !== 'string' || values.canonicalSigningInput.length > 2_000 || values.canonicalSigningInput.includes('\r')) return failure('INVALID_INPUT', '$.canonicalSigningInput')
  const core = { protocolVersion: GEOFLOW_PROTOCOL_VERSION, requestId: requestId.value, idempotencyKey: idempotencyKey.value, requestFingerprint: requestFingerprint.value, bodyHash: bodyHash.value, timestamp: timestamp.value, nonce: nonce.value, sender: sender.value, receiver: receiver.value }
  if (values.canonicalSigningInput !== buildCanonicalSigningInput(core)) return failure('INVALID_INPUT', '$.canonicalSigningInput')
  return success({ ...core, canonicalSigningInput: values.canonicalSigningInput })
}

export function verifySigningEnvelope(input: unknown, signature: unknown, verifier: EnvelopeVerifier): ValidationResult<true> {
  const envelope = parseEnvelope(input)
  if (!envelope.ok) return envelope
  if (typeof signature !== 'string' || !signature || signature.length > 512) return failure('INVALID_INPUT', '$.signature')
  try { return verifier(envelope.value.canonicalSigningInput, signature) ? success(true) : failure('IDENTITY_MISMATCH', '$.signature') } catch { return failure('IDENTITY_MISMATCH', '$.signature') }
}
