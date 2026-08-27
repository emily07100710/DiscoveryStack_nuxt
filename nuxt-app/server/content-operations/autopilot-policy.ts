import { createHash } from 'node:crypto'
import type { ContentOperationCalendarEntryRow } from './types'
import type { AutopilotMode, AutopilotRiskClass } from './balanced-autopilot'

export const GOVERNED_AUTOPILOT_POLICY_VERSION = 'governed-autopilot-policy-v3' as const

export type AutopilotPolicyStatus = 'enabled' | 'paused' | 'revoked'
export type AutopilotRiskLevel = 'low' | 'general' | 'high'
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
  | 'AUTOPILOT_CADENCE_NOT_ALLOWED'
  | 'AUTOPILOT_EVIDENCE_NOT_APPROVED'
  | 'AUTOPILOT_EVIDENCE_FRESHNESS_UNKNOWN'
  | 'AUTOPILOT_EVIDENCE_STALE'
  | 'AUTOPILOT_PROVIDER_NOT_ALLOWED'
  | 'AUTOPILOT_PROVIDER_PROVENANCE_INCOMPLETE'
  | 'AUTOPILOT_QUALITY_GATE_REQUIRED'
  | 'AUTOPILOT_RISK_GATE_REQUIRED'
  | 'AUTOPILOT_RISK_LEVEL_NOT_ALLOWED'
  | 'AUTOPILOT_UNSUPPORTED_FACTUAL_CLAIM'
  | 'AUTOPILOT_HASH_MISMATCH'
  | 'AUTOPILOT_REVIEW_REQUIRED'
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
  readonly websiteId: string
  readonly mode: AutopilotMode
  readonly status: AutopilotPolicyStatus
  readonly authorizedAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly allowedContentTypes: readonly string[]
  readonly allowedLanguages: readonly string[]
  readonly cadenceDays: 3 | 7 | 15 | 30
  readonly allowedTargetIds: readonly string[]
  readonly allowedDestinations: readonly string[]
  readonly allowedCadences: readonly number[]
  readonly allowedRiskClasses: readonly AutopilotRiskClass[]
  readonly entityStrategyProfileId: string
  readonly maximumRepairAttempts: number
  readonly maximumTopicSubstitutions: number
  readonly generationBudget: number
  readonly publicationBudget: number
  readonly evidenceFreshnessHours: number
  readonly maximumRiskLevel: AutopilotRiskLevel
  readonly requiredQualityGateVersion: string
  readonly allowedProviderModels: readonly string[]
  readonly activatedAt: string
  readonly requireApprovedForDelivery: boolean
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
  readonly entryCadenceDays?: number
  readonly reviewDecision: string | null
  readonly riskGateStatus: string | null
  readonly riskLevel?: AutopilotRiskLevel | string | null
  readonly qualityGateVersion?: string | null
  readonly evidenceApproved?: boolean
  readonly evidenceCapturedAt?: string | null
  readonly providerExecution?: boolean
  readonly providerModel?: string | null
  readonly providerProvenanceComplete?: boolean
  readonly unsupportedFactualClaim?: boolean
  readonly contentHashMatchesDraft?: boolean
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

export type CanonicalAutopilotPolicyConfiguration = {
  policyVersion: typeof GOVERNED_AUTOPILOT_POLICY_VERSION
  ownerUserId: number
  authorizedByOwnerUserId: number
  clientId: number
  targetRowId: number
  targetId: string
  websiteId: string
  mode: AutopilotMode
  authorizedAt: string
  expiresAt: string
  activatedAt: string
  allowedContentTypes: string[]
  allowedLanguages: string[]
  cadenceDays: 3 | 7 | 15 | 30
  allowedTargetIds: string[]
  allowedDestinations: string[]
  allowedCadences: number[]
  allowedRiskClasses: AutopilotRiskClass[]
  entityStrategyProfileId: string
  maximumRepairAttempts: number
  maximumTopicSubstitutions: number
  generationBudget: number
  publicationBudget: number
  evidenceFreshnessHours: number
  maximumRiskLevel: AutopilotRiskLevel
  requiredQualityGateVersion: string
  allowedProviderModels: string[]
  requireApprovedForDelivery: boolean
  requirePassedRiskGate: true
}

export function buildCanonicalAutopilotPolicyConfiguration(policy: OwnerAutopilotPolicy): CanonicalAutopilotPolicyConfiguration {
  if (policy.policyVersion !== GOVERNED_AUTOPILOT_POLICY_VERSION) throw new Error('autopilot policy version is invalid')
  if (![policy.ownerUserId, policy.authorizedByOwnerUserId, policy.clientId, policy.targetRowId].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('autopilot policy identity is invalid')
  const targetId = policy.targetId.normalize('NFKC').trim()
  const websiteId = policy.websiteId.normalize('NFKC').trim()
  if (!targetId || !websiteId || !['balanced', 'aggressive_growth', 'conservative_brand'].includes(policy.mode) || !validCadence(policy.cadenceDays) || !validRiskLevel(policy.maximumRiskLevel) || !Number.isSafeInteger(policy.evidenceFreshnessHours) || policy.evidenceFreshnessHours < 1 || policy.evidenceFreshnessHours > 24 * 365 || !policy.requiredQualityGateVersion.trim() || policy.requirePassedRiskGate !== true) throw new Error('autopilot policy bounds are invalid')
  if (![policy.maximumRepairAttempts, policy.maximumTopicSubstitutions, policy.generationBudget, policy.publicationBudget].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error('autopilot policy budgets are invalid')
  const authorizedAt = strictIso(policy.authorizedAt)
  const expiresAt = strictIso(policy.expiresAt)
  const activatedAt = strictIso(policy.activatedAt)
  if (Date.parse(expiresAt) <= Date.parse(authorizedAt) || Date.parse(activatedAt) < Date.parse(authorizedAt)) throw new Error('autopilot policy timestamps are invalid')
  const allowedContentTypes = normalizedList(policy.allowedContentTypes)
  const allowedLanguages = normalizedList(policy.allowedLanguages)
  const allowedTargetIds = normalizedList(policy.allowedTargetIds)
  const allowedDestinations = normalizedList(policy.allowedDestinations)
  const allowedCadences = [...new Set(policy.allowedCadences.filter(value => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b)
  const allowedRiskClasses = [...new Set(policy.allowedRiskClasses)].sort()
  const allowedProviderModels = normalizedList(policy.allowedProviderModels)
  if (!allowedContentTypes.length || !allowedLanguages.length || !allowedTargetIds.length || !allowedProviderModels.length || !allowedDestinations.length || !allowedCadences.length || !allowedRiskClasses.length || !allowedTargetIds.includes(targetId.toLowerCase()) || !allowedCadences.includes(policy.cadenceDays) || !allowedRiskClasses.includes(policy.maximumRiskLevel)) throw new Error('autopilot policy allowlists are invalid')
  if (!policy.entityStrategyProfileId.trim()) throw new Error('autopilot entity strategy profile is required')
  return { policyVersion: GOVERNED_AUTOPILOT_POLICY_VERSION, ownerUserId: policy.ownerUserId, authorizedByOwnerUserId: policy.authorizedByOwnerUserId, clientId: policy.clientId, targetRowId: policy.targetRowId, targetId, websiteId, mode: policy.mode, authorizedAt, expiresAt, activatedAt, allowedContentTypes, allowedLanguages, cadenceDays: policy.cadenceDays, allowedTargetIds, allowedDestinations, allowedCadences, allowedRiskClasses, entityStrategyProfileId: policy.entityStrategyProfileId.trim(), maximumRepairAttempts: policy.maximumRepairAttempts, maximumTopicSubstitutions: policy.maximumTopicSubstitutions, generationBudget: policy.generationBudget, publicationBudget: policy.publicationBudget, evidenceFreshnessHours: policy.evidenceFreshnessHours, maximumRiskLevel: policy.maximumRiskLevel, requiredQualityGateVersion: policy.requiredQualityGateVersion.trim(), allowedProviderModels, requireApprovedForDelivery: policy.requireApprovedForDelivery === true, requirePassedRiskGate: true }
}

export function computeAutopilotConfigurationFingerprint(configuration: CanonicalAutopilotPolicyConfiguration): string {
  return createHash('sha256').update(JSON.stringify(configuration), 'utf8').digest('hex')
}

export function validateOwnerAutopilotPolicyIntegrity(policy: OwnerAutopilotPolicy): boolean {
  try {
    const configuration = buildCanonicalAutopilotPolicyConfiguration(policy)
    return policy.configurationFingerprint === computeAutopilotConfigurationFingerprint(configuration) && policy.policyId === opaquePolicyId(configuration.ownerUserId, configuration.clientId, configuration.targetRowId, policy.configurationFingerprint)
  } catch {
    return false
  }
}

function opaquePolicyId(ownerUserId: number, clientId: number, targetRowId: number, fingerprint: string): string {
  return `autopilot-${createHash('sha256').update(`${ownerUserId}:${clientId}:${targetRowId}:${fingerprint}`, 'utf8').digest('hex').slice(0, 32)}`
}

function validCadence(value: unknown): value is 3 | 7 | 15 | 30 { return value === 3 || value === 7 || value === 15 || value === 30 }
function validRiskLevel(value: unknown): value is AutopilotRiskLevel { return value === 'low' || value === 'general' || value === 'high' }

export function enableOwnerAutopilotPolicy(input: {
  ownerUserId: number
  clientId: number
  targetRowId: number
  targetId: string
  websiteId?: string
  mode?: AutopilotMode
  authorizedByOwnerUserId: number
  authorizedAt: string
  expiresAt: string
  allowedContentTypes: readonly string[]
  allowedLanguages: readonly string[]
  cadenceDays?: 3 | 7 | 15 | 30
  allowedTargetIds?: readonly string[]
  allowedDestinations?: readonly string[]
  allowedCadences?: readonly number[]
  allowedRiskClasses?: readonly AutopilotRiskClass[]
  entityStrategyProfileId?: string
  maximumRepairAttempts?: number
  maximumTopicSubstitutions?: number
  generationBudget?: number
  publicationBudget?: number
  evidenceFreshnessHours?: number
  maximumRiskLevel?: AutopilotRiskLevel
  requiredQualityGateVersion?: string
  allowedProviderModels?: readonly string[]
  requireApprovedForDelivery?: boolean
}): OwnerAutopilotPolicy {
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1 || input.authorizedByOwnerUserId !== input.ownerUserId) throw new Error('owner authorization must be self-authorized')
  if (!Number.isSafeInteger(input.clientId) || input.clientId < 1 || !Number.isSafeInteger(input.targetRowId) || input.targetRowId < 1 || !input.targetId.trim()) throw new Error('autopilot scope is invalid')
  const authorizedAt = strictIso(input.authorizedAt)
  const expiresAt = strictIso(input.expiresAt)
  if (Date.parse(expiresAt) <= Date.parse(authorizedAt)) throw new Error('autopilot policy must expire after authorization')
  const allowedContentTypes = normalizedList(input.allowedContentTypes)
  const allowedLanguages = normalizedList(input.allowedLanguages)
  const cadenceDays = input.cadenceDays ?? 3
  const allowedTargetIds = normalizedList(input.allowedTargetIds?.length ? input.allowedTargetIds : [input.targetId])
  const allowedDestinations = normalizedList(input.allowedDestinations?.length ? input.allowedDestinations : [input.targetId])
  const allowedCadences = [...new Set(input.allowedCadences?.length ? input.allowedCadences : [cadenceDays])].filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b)
  const evidenceFreshnessHours = input.evidenceFreshnessHours ?? 720
  const maximumRiskLevel = input.maximumRiskLevel ?? 'general'
  const allowedRiskClasses: AutopilotRiskClass[] = [...new Set(input.allowedRiskClasses?.length ? input.allowedRiskClasses : maximumRiskLevel === 'low' ? ['low'] : maximumRiskLevel === 'high' ? ['low', 'general', 'high'] : ['low', 'general'])].filter((value): value is AutopilotRiskClass => validRiskLevel(value))
  const entityStrategyProfileId = input.entityStrategyProfileId?.trim() || `entity-profile-${input.ownerUserId}-${input.clientId}-${input.targetRowId}`
  const maximumRepairAttempts = input.maximumRepairAttempts ?? 3
  const maximumTopicSubstitutions = input.maximumTopicSubstitutions ?? 2
  const generationBudget = input.generationBudget ?? 0
  const publicationBudget = input.publicationBudget ?? 0
  const requiredQualityGateVersion = input.requiredQualityGateVersion?.trim() || 'content-risk-gate-v1'
  const allowedProviderModels = normalizedList(input.allowedProviderModels?.length ? input.allowedProviderModels : ['bailian:qwen-plus'])
  if (!allowedContentTypes.length || !allowedLanguages.length || !allowedTargetIds.length || !allowedDestinations.length || !allowedCadences.length || !allowedRiskClasses.length || !allowedProviderModels.length) throw new Error('autopilot policy allowlists must not be empty')
  if (!validCadence(cadenceDays) || !allowedCadences.includes(cadenceDays) || !Number.isSafeInteger(evidenceFreshnessHours) || evidenceFreshnessHours < 1 || evidenceFreshnessHours > 24 * 365 || !validRiskLevel(maximumRiskLevel) || !Number.isSafeInteger(maximumRepairAttempts) || maximumRepairAttempts < 1 || maximumRepairAttempts > 3 || !Number.isSafeInteger(maximumTopicSubstitutions) || maximumTopicSubstitutions < 0 || maximumTopicSubstitutions > 2 || ![generationBudget, publicationBudget].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw new Error('autopilot policy bounds are invalid')
  const activatedAt = authorizedAt
  const base: Omit<OwnerAutopilotPolicy, 'configurationFingerprint'> = {
    policyId: 'pending',
    policyVersion: GOVERNED_AUTOPILOT_POLICY_VERSION,
    ownerUserId: input.ownerUserId,
    authorizedByOwnerUserId: input.authorizedByOwnerUserId,
    clientId: input.clientId,
    targetRowId: input.targetRowId,
    targetId: input.targetId.normalize('NFKC').trim(),
    websiteId: input.websiteId?.normalize('NFKC').trim() || `website-${input.ownerUserId}-${input.clientId}`,
    mode: input.mode || 'balanced',
    status: 'enabled',
    authorizedAt,
    expiresAt,
    revokedAt: null,
    allowedContentTypes,
    allowedLanguages,
    cadenceDays,
    allowedTargetIds,
    allowedDestinations,
    allowedCadences,
    allowedRiskClasses,
    entityStrategyProfileId,
    maximumRepairAttempts,
    maximumTopicSubstitutions,
    generationBudget,
    publicationBudget,
    evidenceFreshnessHours,
    maximumRiskLevel,
    requiredQualityGateVersion,
    allowedProviderModels,
    activatedAt,
    requireApprovedForDelivery: input.requireApprovedForDelivery === true,
    requirePassedRiskGate: true,
  }
  const configurationFingerprint = computeAutopilotConfigurationFingerprint(buildCanonicalAutopilotPolicyConfiguration({ ...base, configurationFingerprint: '' }))
  const policyId = opaquePolicyId(input.ownerUserId, input.clientId, input.targetRowId, configurationFingerprint)
  return { ...base, policyId, configurationFingerprint }
}

export function revokeOwnerAutopilotPolicy(policy: OwnerAutopilotPolicy, ownerUserId: number, revokedAt: string): OwnerAutopilotPolicy {
  if (policy.ownerUserId !== ownerUserId || policy.authorizedByOwnerUserId !== ownerUserId) throw new Error('only the authorized owner may revoke autopilot')
  const timestamp = strictIso(revokedAt)
  if (Date.parse(timestamp) < Date.parse(policy.authorizedAt)) throw new Error('revocation cannot predate authorization')
  return { ...policy, status: 'revoked', revokedAt: timestamp, configurationFingerprint: policy.configurationFingerprint }
}

function deny(code: AutopilotDecisionCode, reason: string): AutopilotEvaluation { return { allowed: false, code, reasons: [reason] } }

export function evaluateOwnerAutopilotPolicy(input: AutopilotEvaluationInput): AutopilotEvaluation {
  const policy = input.policy
  if (!policy) return deny('AUTOPILOT_NOT_AUTHORIZED', 'scheduler publication requires an explicit owner-enabled autopilot policy')
  if (!validateOwnerAutopilotPolicyIntegrity(policy)) return deny('AUTOPILOT_POLICY_INVALID', 'autopilot policy fingerprint or version is invalid')
  if (policy.ownerUserId !== input.ownerUserId || policy.authorizedByOwnerUserId !== input.ownerUserId) return deny('AUTOPILOT_OWNER_SCOPE_MISMATCH', 'autopilot policy is not authorized by this owner')
  if (policy.clientId !== input.clientId) return deny('AUTOPILOT_CLIENT_SCOPE_MISMATCH', 'autopilot policy is bound to a different client')
  if (policy.targetRowId !== input.targetRowId || !normalizedList(policy.allowedTargetIds).includes(input.targetId.normalize('NFKC').trim().toLowerCase())) return deny('AUTOPILOT_TARGET_SCOPE_MISMATCH', 'autopilot policy does not allow this exact target row')
  if (policy.status === 'revoked' || policy.revokedAt) return deny('AUTOPILOT_POLICY_REVOKED', 'autopilot was explicitly revoked and cannot be implicitly re-enabled')
  if (policy.status === 'paused') return deny('AUTOPILOT_POLICY_PAUSED', 'autopilot policy is paused')
  const now = input.now.getTime()
  if (!Number.isFinite(now)) return deny('AUTOPILOT_POLICY_INVALID', 'injected scheduler time is invalid')
  if (now < Date.parse(policy.activatedAt)) return deny('AUTOPILOT_POLICY_NOT_YET_ACTIVE', 'autopilot authorization is not active yet')
  if (now >= Date.parse(policy.expiresAt)) return deny('AUTOPILOT_POLICY_EXPIRED', 'autopilot authorization has expired')
  if (input.targetStatus !== 'active' || !input.targetExecutionEnabled) return deny('AUTOPILOT_EXECUTION_DISABLED', 'publication target is not active and execution-enabled')
  if (!normalizedList(policy.allowedContentTypes).includes(input.entry.contentType.normalize('NFKC').trim().toLowerCase())) return deny('AUTOPILOT_CONTENT_TYPE_NOT_ALLOWED', 'content type is outside the owner autopilot allowlist')
  if (!normalizedList(policy.allowedLanguages).includes(input.entry.language.normalize('NFKC').trim().toLowerCase())) return deny('AUTOPILOT_LANGUAGE_NOT_ALLOWED', 'language is outside the owner autopilot allowlist')
  if (input.entryCadenceDays !== undefined && input.entryCadenceDays !== policy.cadenceDays) return deny('AUTOPILOT_CADENCE_NOT_ALLOWED', 'entry cadence does not match the owner autopilot policy')
  if (input.entry.status !== 'ready_to_publish' && input.entry.status !== 'publishing') return deny('AUTOPILOT_ENTRY_NOT_READY', 'entry is not in a publication-ready durable state')
  if (input.evidenceApproved !== true) return deny('AUTOPILOT_EVIDENCE_NOT_APPROVED', 'evidence approval is required for governed autopilot')
  if (!input.evidenceCapturedAt) return deny('AUTOPILOT_EVIDENCE_FRESHNESS_UNKNOWN', 'evidence freshness timestamp is missing')
  const evidenceAge = now - Date.parse(input.evidenceCapturedAt)
  if (!Number.isFinite(evidenceAge) || evidenceAge < 0) return deny('AUTOPILOT_EVIDENCE_FRESHNESS_UNKNOWN', 'evidence freshness timestamp is invalid or in the future')
  if (evidenceAge > policy.evidenceFreshnessHours * 60 * 60 * 1000) return deny('AUTOPILOT_EVIDENCE_STALE', 'evidence snapshot is older than the governed freshness window')
  if (input.providerExecution !== true || input.providerProvenanceComplete !== true || !input.providerModel) return deny('AUTOPILOT_PROVIDER_PROVENANCE_INCOMPLETE', 'governed autopilot requires complete provider/model provenance')
  if (!normalizedList(policy.allowedProviderModels).includes(input.providerModel.normalize('NFKC').trim().toLowerCase())) return deny('AUTOPILOT_PROVIDER_NOT_ALLOWED', 'provider/model is outside the owner autopilot allowlist')
  if (input.qualityGateVersion !== policy.requiredQualityGateVersion) return deny('AUTOPILOT_QUALITY_GATE_REQUIRED', 'required quality gate version did not pass')
  if (input.riskGateStatus !== 'passed') return deny('AUTOPILOT_RISK_GATE_REQUIRED', 'passed risk gate is required')
  if (!validRiskLevel(input.riskLevel)) return deny('AUTOPILOT_RISK_LEVEL_NOT_ALLOWED', 'candidate risk level is missing or malformed')
  const riskRank: Record<AutopilotRiskLevel, number> = { low: 0, general: 1, high: 2 }
  if (riskRank[input.riskLevel] > riskRank[policy.maximumRiskLevel]) return deny('AUTOPILOT_RISK_LEVEL_NOT_ALLOWED', 'candidate risk level exceeds the governed maximum')
  if (input.unsupportedFactualClaim === true) return deny('AUTOPILOT_UNSUPPORTED_FACTUAL_CLAIM', 'unsupported factual claims require human handling')
  if (input.contentHashMatchesDraft !== true) return deny('AUTOPILOT_HASH_MISMATCH', 'content hash does not match the persisted optimized draft')
  if (policy.requireApprovedForDelivery && input.reviewDecision !== 'approved_for_delivery') return deny('AUTOPILOT_REVIEW_REQUIRED', 'owner approved_for_delivery review is required by this policy')
  if (policy.requirePassedRiskGate && input.riskGateStatus !== 'passed') return deny('AUTOPILOT_RISK_GATE_REQUIRED', 'passed risk gate is required')
  return { allowed: true, code: 'AUTOPILOT_ALLOWED', reasons: ['owner-scoped governed autopilot policy is active for this exact target, evidence, provider, quality, risk, and hash lineage'] }
}
