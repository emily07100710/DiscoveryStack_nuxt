import { createHash } from 'node:crypto'
import type { ContentOperationCalendarEntryRow } from './types'

export const GOVERNED_AUTOPILOT_POLICY_VERSION = 'governed-autopilot-policy-v1' as const

export type AutopilotPolicyStatus = 'enabled' | 'paused' | 'revoked'
export type AutopilotDecisionCode =
  | 'AUTOPILOT_ALLOWED'
  | 'AUTOPILOT_NOT_AUTHORIZED'
  | 'AUTOPILOT_OWNER_SCOPE_MISMATCH'
  | 'AUTOPILOT_CLIENT_SCOPE_MISMATCH'
  | 'AUTOPILOT_TARGET_SCOPE_MISMATCH'
  | 'AUTOPILOT_POLICY_PAUSED'
  | 'AUTOPILOT_POLICY_REVOKED'
  | 'AUTOPILOT_POLICY_EXPIRED'
  | 'AUTOPILOT_POLICY_NOT_YET_ACTIVE'
  | 'AUTOPILOT_EXECUTION_DISABLED'
  | 'AUTOPILOT_CONTENT_TYPE_NOT_ALLOWED'
  | 'AUTOPILOT_LANGUAGE_NOT_ALLOWED'
  | 'AUTOPILOT_REVIEW_REQUIRED'
  | 'AUTOPILOT_RISK_GATE_REQUIRED'
  | 'AUTOPILOT_ENTRY_NOT_READY'
  | 'AUTOPILOT_POLICY_INVALID'

export type OwnerAutopilotPolicy = {
  readonly policyId: string
  readonly policyVersion: typeof GOVERNED_AUTOPILOT_POLICY_VERSION
  readonly ownerUserId: number
  readonly authorizedByOwnerUserId: number
  readonly clientId: number
  readonly targetRowId: number
  readonly targetId: string
  readonly status: AutopilotPolicyStatus
  readonly authorizedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly allowedContentTypes: readonly string[]
  readonly allowedLanguages: readonly string[]
  readonly requireApprovedForDelivery: true
  readonly requirePassedRiskGate: true
  readonly configurationFingerprint: string
}

export type AutopilotEvaluationInput = {
  readonly policy: OwnerAutopilotPolicy | null | undefined
  readonly ownerUserId: number
  readonly clientId: number
  readonly targetRowId: number
  readonly targetId: string
  readonly targetStatus: 'active' | 'paused' | 'revoked'
  readonly targetExecutionEnabled: boolean
  readonly entry: Pick<ContentOperationCalendarEntryRow, 'status' | 'contentType' | 'language'>
  readonly reviewDecision: string | null
  readonly riskGateStatus: string | null
  readonly now: Date
}

export type AutopilotEvaluation = {
  readonly allowed: boolean
  readonly code: AutopilotDecisionCode
  readonly reasons: readonly string[]
}

function normalizedList(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.normalize('NFKC').trim().toLowerCase()).filter(Boolean))].sort()
}

function strictIso(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('timestamp is invalid')
  return new Date(timestamp).toISOString()
}

function policyFingerprint(input: Omit<OwnerAutopilotPolicy, 'configurationFingerprint'>): string {
  const canonical = JSON.stringify({ ...input, allowedContentTypes: normalizedList(input.allowedContentTypes), allowedLanguages: normalizedList(input.allowedLanguages) })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function opaquePolicyId(ownerUserId: number, clientId: number, targetRowId: number, fingerprint: string): string {
  return `autopilot-${createHash('sha256').update(`${ownerUserId}:${clientId}:${targetRowId}:${fingerprint}`, 'utf8').digest('hex').slice(0, 32)}`
}

export function enableOwnerAutopilotPolicy(input: {
  ownerUserId: number
  clientId: number
  targetRowId: number
  targetId: string
  authorizedByOwnerUserId: number
  authorizedAt: string
  expiresAt: string
  allowedContentTypes: readonly string[]
  allowedLanguages: readonly string[]
}): OwnerAutopilotPolicy {
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1 || input.authorizedByOwnerUserId !== input.ownerUserId) throw new Error('owner authorization must be self-authorized')
  if (!Number.isSafeInteger(input.clientId) || input.clientId < 1 || !Number.isSafeInteger(input.targetRowId) || input.targetRowId < 1 || !input.targetId.trim()) throw new Error('autopilot scope is invalid')
  const authorizedAt = strictIso(input.authorizedAt)
  const expiresAt = strictIso(input.expiresAt)
  if (Date.parse(expiresAt) <= Date.parse(authorizedAt)) throw new Error('autopilot policy must expire after authorization')
  const allowedContentTypes = normalizedList(input.allowedContentTypes)
  const allowedLanguages = normalizedList(input.allowedLanguages)
  if (!allowedContentTypes.length || !allowedLanguages.length) throw new Error('autopilot policy allowlists must not be empty')
  const base: Omit<OwnerAutopilotPolicy, 'configurationFingerprint'> = {
    policyId: 'pending',
    policyVersion: GOVERNED_AUTOPILOT_POLICY_VERSION,
    ownerUserId: input.ownerUserId,
    authorizedByOwnerUserId: input.authorizedByOwnerUserId,
    clientId: input.clientId,
    targetRowId: input.targetRowId,
    targetId: input.targetId.normalize('NFKC').trim(),
    status: 'enabled',
    authorizedAt,
    expiresAt,
    revokedAt: null,
    allowedContentTypes,
    allowedLanguages,
    requireApprovedForDelivery: true,
    requirePassedRiskGate: true,
  }
  const configurationFingerprint = policyFingerprint(base)
  return { ...base, policyId: opaquePolicyId(input.ownerUserId, input.clientId, input.targetRowId, configurationFingerprint), configurationFingerprint }
}

export function revokeOwnerAutopilotPolicy(policy: OwnerAutopilotPolicy, ownerUserId: number, revokedAt: string): OwnerAutopilotPolicy {
  if (policy.ownerUserId !== ownerUserId || policy.authorizedByOwnerUserId !== ownerUserId) throw new Error('only the authorized owner may revoke autopilot')
  const timestamp = strictIso(revokedAt)
  if (Date.parse(timestamp) < Date.parse(policy.authorizedAt)) throw new Error('revocation cannot predate authorization')
  const next: Omit<OwnerAutopilotPolicy, 'configurationFingerprint'> = { ...policy, status: 'revoked', revokedAt: timestamp }
  return { ...next, configurationFingerprint: policy.configurationFingerprint }
}

export function evaluateOwnerAutopilotPolicy(input: AutopilotEvaluationInput): AutopilotEvaluation {
  const policy = input.policy
  if (!policy) return { allowed: false, code: 'AUTOPILOT_NOT_AUTHORIZED', reasons: ['scheduler publication requires an explicit owner-enabled autopilot policy'] }
  if (policy.policyVersion !== GOVERNED_AUTOPILOT_POLICY_VERSION || !policy.configurationFingerprint || policy.policyId !== opaquePolicyId(policy.ownerUserId, policy.clientId, policy.targetRowId, policy.configurationFingerprint)) return { allowed: false, code: 'AUTOPILOT_POLICY_INVALID', reasons: ['autopilot policy fingerprint or version is invalid'] }
  if (policy.ownerUserId !== input.ownerUserId || policy.authorizedByOwnerUserId !== input.ownerUserId) return { allowed: false, code: 'AUTOPILOT_OWNER_SCOPE_MISMATCH', reasons: ['autopilot policy is not authorized by this owner'] }
  if (policy.clientId !== input.clientId) return { allowed: false, code: 'AUTOPILOT_CLIENT_SCOPE_MISMATCH', reasons: ['autopilot policy is bound to a different client'] }
  if (policy.targetRowId !== input.targetRowId || policy.targetId !== input.targetId) return { allowed: false, code: 'AUTOPILOT_TARGET_SCOPE_MISMATCH', reasons: ['autopilot policy is bound to a different publication target'] }
  if (policy.status === 'revoked' || policy.revokedAt) return { allowed: false, code: 'AUTOPILOT_POLICY_REVOKED', reasons: ['autopilot was explicitly revoked and cannot be implicitly re-enabled'] }
  if (policy.status === 'paused') return { allowed: false, code: 'AUTOPILOT_POLICY_PAUSED', reasons: ['autopilot policy is paused'] }
  const now = input.now.getTime()
  if (!Number.isFinite(now)) return { allowed: false, code: 'AUTOPILOT_POLICY_INVALID', reasons: ['injected scheduler time is invalid'] }
  if (now < Date.parse(policy.authorizedAt)) return { allowed: false, code: 'AUTOPILOT_POLICY_NOT_YET_ACTIVE', reasons: ['autopilot authorization is not active yet'] }
  if (now >= Date.parse(policy.expiresAt)) return { allowed: false, code: 'AUTOPILOT_POLICY_EXPIRED', reasons: ['autopilot authorization has expired'] }
  if (input.targetStatus !== 'active') return { allowed: false, code: 'AUTOPILOT_EXECUTION_DISABLED', reasons: ['publication target is not active'] }
  if (!input.targetExecutionEnabled) return { allowed: false, code: 'AUTOPILOT_EXECUTION_DISABLED', reasons: ['publication target execution is disabled'] }
  if (!normalizedList(policy.allowedContentTypes).includes(input.entry.contentType.normalize('NFKC').trim().toLowerCase())) return { allowed: false, code: 'AUTOPILOT_CONTENT_TYPE_NOT_ALLOWED', reasons: ['content type is outside the owner autopilot allowlist'] }
  if (!normalizedList(policy.allowedLanguages).includes(input.entry.language.normalize('NFKC').trim().toLowerCase())) return { allowed: false, code: 'AUTOPILOT_LANGUAGE_NOT_ALLOWED', reasons: ['language is outside the owner autopilot allowlist'] }
  if (input.entry.status !== 'ready_to_publish' && input.entry.status !== 'publishing') return { allowed: false, code: 'AUTOPILOT_ENTRY_NOT_READY', reasons: ['entry is not in a publication-ready durable state'] }
  if (policy.requireApprovedForDelivery && input.reviewDecision !== 'approved_for_delivery') return { allowed: false, code: 'AUTOPILOT_REVIEW_REQUIRED', reasons: ['owner approved_for_delivery review is required'] }
  if (policy.requirePassedRiskGate && input.riskGateStatus !== 'passed') return { allowed: false, code: 'AUTOPILOT_RISK_GATE_REQUIRED', reasons: ['passed risk gate is required'] }
  return { allowed: true, code: 'AUTOPILOT_ALLOWED', reasons: ['owner-scoped governed autopilot policy is active for this exact target and lineage stage'] }
}
