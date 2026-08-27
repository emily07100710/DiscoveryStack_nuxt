import { validateGeoFlowRequest } from '../geoflow-integration'
import type { GeoFlowRequest, ReasonCode, ValidationResult } from '../geoflow-integration'
import { validateGeoFlowAttempt } from './retry-policy'
import { deriveGeoFlowTargetFingerprint, validateGeoFlowBaseUrl, validateGeoFlowTaskId } from './target-guard'
import { validateGeoFlowCredentialReference } from './credential-contract'
import type { GeoFlowRuntimeTarget, GeoFlowRuntimeTargetInput, GeoFlowTransportResult } from './types'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_POLLS = 20
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 300
const MAX_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024
const MAX_POLLS = 100
const MAX_POLL_INTERVAL_MS = 60_000
const MAX_RETRY_AFTER_SECONDS = 3_600
const TARGET_KEYS = ['baseUrl', 'taskId', 'credentialReference', 'attempt', 'timeoutMs', 'maxResponseBodyBytes', 'maxAttempts', 'maxPolls', 'pollIntervalMs', 'maxRetryAfterSeconds', 'targetFingerprint'] as const
const REQUIRED_TARGET_KEYS = ['baseUrl', 'taskId', 'credentialReference', 'attempt'] as const
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function failure(code: 'TARGET_INVALID' | 'TASK_ID_INVALID' | 'ATTEMPT_INVALID' | 'CREDENTIAL_REFERENCE_INVALID' | 'REQUEST_INVALID', contractReason?: ReasonCode): GeoFlowTransportResult<never> {
  return { ok: false, error: { code, retryable: false, ...(contractReason === undefined ? {} : { contractReason }) } }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function safeValue(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key]
  } catch {
    return undefined
  }
}

function hasExactTargetKeys(record: Record<string, unknown>): boolean {
  try {
    const keys = Object.keys(record)
    return keys.every((key) => (TARGET_KEYS as readonly string[]).includes(key)) && REQUIRED_TARGET_KEYS.every((key) => keys.includes(key))
  } catch {
    return false
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): GeoFlowTransportResult<number> {
  if (value === undefined) return { ok: true, value: fallback }
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) return { ok: false, error: { code: 'TARGET_INVALID', retryable: false } }
  return { ok: true, value: value as number }
}

export function normalizeGeoFlowRuntimeTarget(input: unknown): GeoFlowTransportResult<GeoFlowRuntimeTarget> {
  if (!isPlainRecord(input) || !hasExactTargetKeys(input)) return failure('TARGET_INVALID')
  const baseUrl = validateGeoFlowBaseUrl(safeValue(input, 'baseUrl')); if (!baseUrl.ok) return baseUrl
  const taskId = validateGeoFlowTaskId(safeValue(input, 'taskId')); if (!taskId.ok) return taskId
  const credentialReference = validateGeoFlowCredentialReference(safeValue(input, 'credentialReference')); if (!credentialReference.ok) return credentialReference
  const attempt = validateGeoFlowAttempt(safeValue(input, 'attempt')); if (!attempt.ok) return attempt
  const timeoutMs = boundedInteger(safeValue(input, 'timeoutMs'), DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS); if (!timeoutMs.ok) return timeoutMs
  const maxResponseBodyBytes = boundedInteger(safeValue(input, 'maxResponseBodyBytes'), DEFAULT_MAX_RESPONSE_BODY_BYTES, 1, MAX_RESPONSE_BODY_BYTES); if (!maxResponseBodyBytes.ok) return maxResponseBodyBytes
  const maxAttempts = boundedInteger(safeValue(input, 'maxAttempts'), DEFAULT_MAX_ATTEMPTS, 1, 10); if (!maxAttempts.ok) return maxAttempts
  const maxPolls = boundedInteger(safeValue(input, 'maxPolls'), DEFAULT_MAX_POLLS, 1, MAX_POLLS); if (!maxPolls.ok) return maxPolls
  const pollIntervalMs = boundedInteger(safeValue(input, 'pollIntervalMs'), DEFAULT_POLL_INTERVAL_MS, 0, MAX_POLL_INTERVAL_MS); if (!pollIntervalMs.ok) return pollIntervalMs
  const maxRetryAfterSeconds = boundedInteger(safeValue(input, 'maxRetryAfterSeconds'), DEFAULT_MAX_RETRY_AFTER_SECONDS, 0, MAX_RETRY_AFTER_SECONDS); if (!maxRetryAfterSeconds.ok) return maxRetryAfterSeconds
  const normalizedTarget = {
    baseUrl: baseUrl.value,
    taskId: taskId.value,
    credentialReference: credentialReference.value,
    attempt: attempt.value,
    timeoutMs: timeoutMs.value,
    maxResponseBodyBytes: maxResponseBodyBytes.value,
    maxAttempts: maxAttempts.value,
    maxPolls: maxPolls.value,
    pollIntervalMs: pollIntervalMs.value,
    maxRetryAfterSeconds: maxRetryAfterSeconds.value,
  }
  const targetFingerprint = deriveGeoFlowTargetFingerprint(normalizedTarget)
  const suppliedFingerprint = safeValue(input, 'targetFingerprint')
  if (suppliedFingerprint !== undefined && (typeof suppliedFingerprint !== 'string' || suppliedFingerprint !== targetFingerprint)) return failure('TARGET_INVALID')
  return {
    ok: true,
    value: {
      ...normalizedTarget,
      targetFingerprint,
    },
  }
}

export function validateGeoFlowTransportRequest(input: unknown): GeoFlowTransportResult<GeoFlowRequest> {
  const result: ValidationResult<GeoFlowRequest> = validateGeoFlowRequest(input)
  if (result.ok) {
    if (result.value.requestedCapabilities.includes('autogeo_optimization')) return failure('REQUEST_INVALID', 'REQUIRED_RULE_MISSING')
    return result
  }
  return failure('REQUEST_INVALID', result.reason)
}

export function validateGeoFlowRuntimeTargetInput(input: unknown): GeoFlowTransportResult<GeoFlowRuntimeTarget> {
  return normalizeGeoFlowRuntimeTarget(input as GeoFlowRuntimeTargetInput)
}

export function validateGeoFlowTransportText(value: unknown, maximumBytes: number): GeoFlowTransportResult<string> {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return { ok: false, error: { code: 'RESPONSE_MALFORMED', retryable: false } }
  try {
    const bytes = new TextEncoder().encode(value).byteLength
    return bytes <= maximumBytes ? { ok: true, value } : { ok: false, error: { code: 'RESPONSE_TOO_LARGE', retryable: false } }
  } catch {
    return { ok: false, error: { code: 'RESPONSE_MALFORMED', retryable: false } }
  }
}
