import { createError } from 'h3'
import { GOVERNED_AUTOPILOT_POLICY_V4_VERSION, enableOwnerAutopilotPolicy, revokeOwnerAutopilotPolicy, validateOwnerAutopilotPolicyIntegrity, type OwnerAutopilotPolicy } from './autopilot-policy'
import { createContentOperationsRepository, type AutopilotPolicyInsert, type ContentOperationsRepository } from './repository'
import { parseAutopilotPolicyInput, stableFingerprint } from './normalization'
import type { ContentOperationAutopilotPolicyRow } from './types'

function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function listOf(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function numberList(value: unknown): number[] { return Array.isArray(value) ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0) : [] }
function modeOf(value: unknown): 'balanced' | 'aggressive_growth' | 'conservative_brand' { return value === 'aggressive_growth' || value === 'conservative_brand' ? value : 'balanced' }

export function projectAutopilotPolicy(row: ContentOperationAutopilotPolicyRow, targetId: string): OwnerAutopilotPolicy {
  const cadenceDays = row.cadenceDays === 3 || row.cadenceDays === 7 || row.cadenceDays === 15 || row.cadenceDays === 30 ? row.cadenceDays : null
  const maximumRiskLevel = row.maximumRiskLevel === 'low' || row.maximumRiskLevel === 'general' || row.maximumRiskLevel === 'high' ? row.maximumRiskLevel : null
  const allowedTargetIds = listOf(row.allowedTargetIds)
  const allowedProviderModels = listOf(row.allowedProviderModels)
  const storedDestinations = listOf(row.allowedDestinations)
  const storedCadences = numberList(row.allowedCadences)
  const storedRiskClasses = listOf(row.allowedRiskClasses)
  const allowedDestinations = storedDestinations.length ? storedDestinations : [targetId]
  const allowedCadences = storedCadences.length ? storedCadences : [cadenceDays || 3]
  const v4 = row.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION
  const allowedRiskClasses = (v4 ? [] : storedRiskClasses.length ? storedRiskClasses : [maximumRiskLevel]) as Array<'low' | 'general' | 'high'>
  const storedBusinessRiskClasses = listOf(row.allowedBusinessRiskClasses)
  const allowedBusinessRiskClasses = (v4 ? storedBusinessRiskClasses.length ? storedBusinessRiskClasses : storedRiskClasses : []) as Array<'general' | 'medical' | 'legal' | 'financial' | 'political' | 'sensitive_personal_data'>
  const maximumRiskSeverity = row.maximumRiskSeverity === 'low' || row.maximumRiskSeverity === 'moderate' || row.maximumRiskSeverity === 'high' || row.maximumRiskSeverity === 'critical' ? row.maximumRiskSeverity : null
  const evidenceFreshnessHours = row.evidenceFreshnessHours
  const maximumRepairAttempts = row.maximumRepairAttempts ?? 3
  const maximumTopicSubstitutions = row.maximumTopicSubstitutions ?? 2
  const generationBudget = row.generationBudget ?? 0
  const publicationBudget = row.publicationBudget ?? 0
  const entityStrategyProfileId = row.entityStrategyProfileId || `entity-profile-${row.ownerUserId}-${row.clientId}-${row.publicationTargetId}`
  if (!['governed-autopilot-policy-v3', GOVERNED_AUTOPILOT_POLICY_V4_VERSION].includes(row.policyVersion) || !cadenceDays || !maximumRiskLevel || !allowedTargetIds.length || !allowedProviderModels.length || !allowedDestinations.length || !allowedCadences.length || !row.requiredQualityGateVersion?.trim() || typeof evidenceFreshnessHours !== 'number' || !Number.isSafeInteger(evidenceFreshnessHours) || evidenceFreshnessHours < 1 || !targetId.trim() || v4 && (!maximumRiskSeverity || !allowedBusinessRiskClasses.length) || !v4 && !allowedRiskClasses.length) throw new Error('stored autopilot policy is malformed or uses an unsupported version')
  const policy: OwnerAutopilotPolicy = {
    policyId: row.policyId,
    policyVersion: v4 ? GOVERNED_AUTOPILOT_POLICY_V4_VERSION : 'governed-autopilot-policy-v3',
    ownerUserId: row.ownerUserId,
    authorizedByOwnerUserId: row.authorizedByOwnerUserId,
    clientId: row.clientId,
    targetRowId: row.publicationTargetId,
    targetId: targetId.normalize('NFKC').trim(),
    websiteId: row.websiteId || 'legacy-website',
    mode: modeOf(row.mode),
    status: row.status,
    authorizedAt: row.authorizedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() || null,
    allowedContentTypes: listOf(row.allowedContentTypes),
    allowedLanguages: listOf(row.allowedLanguages),
    cadenceDays,
    allowedTargetIds,
    allowedDestinations,
    allowedCadences,
    allowedRiskClasses,
    riskSemanticsVersion: v4 ? 'risk-severity-and-business-class-v1' : null,
    maximumRiskSeverity,
    allowedBusinessRiskClasses,
    entityStrategyProfileId,
    maximumRepairAttempts,
    maximumTopicSubstitutions,
    generationBudget,
    publicationBudget,
    evidenceFreshnessHours,
    maximumRiskLevel,
    requiredQualityGateVersion: row.requiredQualityGateVersion.trim(),
    allowedProviderModels,
    activatedAt: (row.activatedAt || row.authorizedAt).toISOString(),
    requireApprovedForDelivery: row.requireApprovedForDelivery === true,
    requirePassedRiskGate: true,
    configurationFingerprint: row.configurationFingerprint,
  }
  if (!validateOwnerAutopilotPolicyIntegrity(policy)) throw new Error('stored autopilot policy fingerprint or version is invalid')
  return policy
}

function policyProjection(row: ContentOperationAutopilotPolicyRow, targetId: string): OwnerAutopilotPolicy {
  return projectAutopilotPolicy(row, targetId)
}

function insertInput(policy: OwnerAutopilotPolicy): AutopilotPolicyInsert {
  return {
    ownerUserId: policy.ownerUserId,
    clientId: policy.clientId,
    publicationTargetId: policy.targetRowId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    mode: policy.mode,
    websiteId: policy.websiteId,
    authorizedByOwnerUserId: policy.authorizedByOwnerUserId,
    status: policy.status,
    authorizedAt: new Date(policy.authorizedAt),
    expiresAt: new Date(policy.expiresAt),
    revokedAt: policy.revokedAt ? new Date(policy.revokedAt) : null,
    allowedContentTypes: policy.allowedContentTypes,
    allowedLanguages: policy.allowedLanguages,
    cadenceDays: policy.cadenceDays,
    evidenceFreshnessHours: policy.evidenceFreshnessHours,
    maximumRiskLevel: policy.maximumRiskLevel,
    requiredQualityGateVersion: policy.requiredQualityGateVersion,
    allowedTargetIds: policy.allowedTargetIds,
    allowedProviderModels: policy.allowedProviderModels,
    allowedDestinations: policy.allowedDestinations,
    allowedCadences: policy.allowedCadences,
    allowedRiskClasses: policy.allowedRiskClasses,
    riskSemanticsVersion: policy.riskSemanticsVersion,
    maximumRiskSeverity: policy.maximumRiskSeverity,
    allowedBusinessRiskClasses: policy.allowedBusinessRiskClasses,
    entityStrategyProfileId: policy.entityStrategyProfileId,
    maximumRepairAttempts: policy.maximumRepairAttempts,
    maximumTopicSubstitutions: policy.maximumTopicSubstitutions,
    generationBudget: policy.generationBudget,
    publicationBudget: policy.publicationBudget,
    generationBudgetUsed: 0,
    publicationBudgetUsed: 0,
    activatedAt: new Date(policy.activatedAt),
    requireApprovedForDelivery: policy.requireApprovedForDelivery,
    requirePassedRiskGate: true,
    configurationFingerprint: policy.configurationFingerprint,
  }
}

export async function enableOwnerAutopilot(ownerUserId: number, clientId: number, value: unknown, repository?: ContentOperationsRepository, authorizationNow = new Date()) {
  const db = repository || createContentOperationsRepository()
  const input = parseAutopilotPolicyInput(value)
  const client = await db.findClient(ownerUserId, clientId)
  if (!client || client.status !== 'active') notFound('Content operation client was not found for this owner.')
  const targets = (await db.listPublicationTargets(ownerUserId)).filter(target => target.clientId === clientId && target.status === 'active')
  const target = input.targetRowId ? targets.find(candidate => candidate.id === input.targetRowId) : targets.find(candidate => candidate.activeSlot === 1) || targets[0]
  if (!target || target.status !== 'active') notFound('An active publication target is required before enabling autopilot.')
  if (!target.executionEnabled) conflict('Publication target execution must be explicitly enabled before enabling autopilot.')
  const allowedTargetIds = input.allowedTargetIds?.length ? input.allowedTargetIds : [target.targetId]
  if (allowedTargetIds.some(targetId => !targets.some(candidate => candidate.targetId === targetId))) conflict('Autopilot allowedTargetIds must belong to active targets of this owner client.')
  const v4BusinessClasses = input.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION ? input.allowedBusinessRiskClasses || input.allowedRiskClasses?.filter((value): value is 'general' | 'medical' | 'legal' | 'financial' | 'political' | 'sensitive_personal_data' => ['general', 'medical', 'legal', 'financial', 'political', 'sensitive_personal_data'].includes(value)) : undefined
  const v3RiskClasses = input.policyVersion === GOVERNED_AUTOPILOT_POLICY_V4_VERSION ? undefined : input.allowedRiskClasses?.filter((value): value is 'low' | 'general' | 'high' => ['low', 'general', 'high'].includes(value))
  const policy = enableOwnerAutopilotPolicy({ policyVersion: input.policyVersion, ownerUserId, clientId, targetRowId: target.id, targetId: target.targetId, websiteId: input.websiteId || target.websiteId || undefined, mode: input.mode, authorizedByOwnerUserId: ownerUserId, authorizedAt: authorizationNow.toISOString(), expiresAt: input.expiresAt, allowedContentTypes: input.allowedContentTypes, allowedLanguages: input.allowedLanguages, cadenceDays: input.cadenceDays ?? (client.defaultCadenceDays as 3 | 7 | 15 | 30), allowedTargetIds, allowedDestinations: input.allowedDestinations?.length ? input.allowedDestinations : [target.targetId], allowedCadences: input.allowedCadences?.length ? input.allowedCadences : [input.cadenceDays ?? (client.defaultCadenceDays as 3 | 7 | 15 | 30)], allowedRiskClasses: v3RiskClasses, maximumRiskSeverity: input.maximumRiskSeverity, allowedBusinessRiskClasses: v4BusinessClasses, entityStrategyProfileId: input.entityStrategyProfileId, maximumRepairAttempts: input.maximumRepairAttempts, maximumTopicSubstitutions: input.maximumTopicSubstitutions, generationBudget: input.generationBudget, publicationBudget: input.publicationBudget, evidenceFreshnessHours: input.evidenceFreshnessHours, maximumRiskLevel: input.maximumRiskLevel, requiredQualityGateVersion: input.requiredQualityGateVersion, allowedProviderModels: input.allowedProviderModels, requireApprovedForDelivery: input.requireApprovedForDelivery })
  const existing = await db.findAutopilotPolicy(ownerUserId, clientId, target.id)
  if (existing && existing.status !== 'revoked') conflict('An autopilot policy already exists for this owner target; revoke it before creating a new authorization.')
  if (existing && existing.status === 'revoked') conflict('A revoked autopilot policy is terminal; create a new publication target before re-authorizing.')
  try {
    const stored = await db.transaction(async transaction => {
      const row = await transaction.insertAutopilotPolicy(insertInput(policy))
      await transaction.appendEvent({ ownerUserId, clientId, calendarId: null, entryId: null, runId: null, eventType: 'autopilot_policy_enabled', fromStatus: null, toStatus: row.status, eventFingerprint: stableFingerprint({ event: 'autopilot_policy_enabled', policyId: row.policyId, configurationFingerprint: row.configurationFingerprint }),         metadata: { policyId: row.policyId, policyVersion: row.policyVersion, mode: row.mode, websiteId: row.websiteId, clientId: row.clientId, publicationTargetId: row.publicationTargetId, status: row.status, authorizedAt: row.authorizedAt, expiresAt: row.expiresAt, activatedAt: row.activatedAt, cadenceDays: row.cadenceDays, evidenceFreshnessHours: row.evidenceFreshnessHours, maximumRiskLevel: row.maximumRiskLevel, requiredQualityGateVersion: row.requiredQualityGateVersion, allowedTargetIds: listOf(row.allowedTargetIds), allowedProviderModels: listOf(row.allowedProviderModels), allowedDestinations: listOf(row.allowedDestinations), allowedCadences: numberList(row.allowedCadences), allowedRiskClasses: listOf(row.allowedRiskClasses), entityStrategyProfileId: row.entityStrategyProfileId, maximumRepairAttempts: row.maximumRepairAttempts, maximumTopicSubstitutions: row.maximumTopicSubstitutions, generationBudget: row.generationBudget, publicationBudget: row.publicationBudget, requireApprovedForDelivery: row.requireApprovedForDelivery } })
      return row
    })
    return { policy: policyProjection(stored, target.targetId), replayed: false }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code?: unknown }).code) === 'ER_DUP_ENTRY') conflict('An autopilot policy already exists for this owner target.')
    throw error
  }
}

export async function revokeOwnerAutopilot(ownerUserId: number, clientId: number, repository?: ContentOperationsRepository, revokeNow = new Date()) {
  const db = repository || createContentOperationsRepository()
  const client = await db.findClient(ownerUserId, clientId)
  if (!client) notFound('Content operation client was not found for this owner.')
  const targets = (await db.listPublicationTargets(ownerUserId)).filter(target => target.clientId === clientId)
  const targetById = new Map(targets.map(target => [target.id, target]))
  const policies = await db.listAutopilotPolicies(ownerUserId, clientId)
  if (!policies.length) notFound('No autopilot policy was found for this owner client.')
  const projections = policies.map(row => {
    const target = targetById.get(row.publicationTargetId)
    if (!target) conflict('Autopilot policy target is not owner-scoped to this client.')
    return { row, targetId: target.targetId, policy: policyProjection(row, target.targetId) }
  })
  const active = projections.filter(item => item.row.status === 'enabled' || item.row.status === 'paused')
  const alreadyRevokedPolicies = projections.filter(item => item.row.status === 'revoked').map(item => item.policy)
  if (!active.length) {
    return { policy: alreadyRevokedPolicies[0]!, revokedPolicies: [], alreadyRevokedPolicies, revokedCount: 0, replayed: true }
  }
  if (!Number.isFinite(revokeNow.getTime())) throw createError({ statusCode: 422, statusMessage: 'Autopilot revoke time is invalid.' })
  const revokedAt = new Date(revokeNow.getTime())
  const revokedRows = await db.transaction(async transaction => {
    const rows: ContentOperationAutopilotPolicyRow[] = []
    for (const item of active) {
      const row = await transaction.revokeAutopilotPolicy(ownerUserId, item.row.policyId, revokedAt)
      if (!row) throw createError({ statusCode: 409, statusMessage: 'Autopilot policy disappeared before client-wide revocation completed.' })
      await transaction.appendEvent({ ownerUserId, clientId, calendarId: null, entryId: null, runId: null, eventType: 'autopilot_policy_revoked', fromStatus: item.row.status, toStatus: row.status, eventFingerprint: stableFingerprint({ event: 'autopilot_policy_revoked', policyId: row.policyId, revokedAt: revokedAt.toISOString() }), metadata: { policyId: row.policyId, policyVersion: row.policyVersion, clientId: row.clientId, publicationTargetId: row.publicationTargetId, status: row.status, revokedAt: row.revokedAt, revokeScope: 'client-wide' } })
      rows.push(row)
    }
    return rows
  })
  const revokedPolicies = revokedRows.map(row => {
    const target = targetById.get(row.publicationTargetId)
    if (!target) throw createError({ statusCode: 409, statusMessage: 'Revoked autopilot policy target is no longer owner-scoped.' })
    return policyProjection(row, target.targetId)
  })
  return { policy: revokedPolicies[0] || alreadyRevokedPolicies[0]!, revokedPolicies, alreadyRevokedPolicies, revokedCount: revokedPolicies.length, replayed: false }
}

export async function getOwnerAutopilotPolicy(ownerUserId: number, clientId: number, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const targets = (await db.listPublicationTargets(ownerUserId)).filter(target => target.clientId === clientId)
  const targetById = new Map(targets.map(target => [target.id, target]))
  const rows = await db.listAutopilotPolicies(ownerUserId, clientId)
  const policies = rows.map(row => {
    const target = targetById.get(row.publicationTargetId)
    if (!target) conflict('Autopilot policy target is not owner-scoped to this client.')
    return policyProjection(row, target.targetId)
  })
  const policy = policies.find(item => item.status !== 'revoked') || policies[0] || null
  return { policy, policies, activePolicies: policies.filter(item => item.status === 'enabled' || item.status === 'paused'), revokedPolicies: policies.filter(item => item.status === 'revoked'), policyCount: policies.length }
}
