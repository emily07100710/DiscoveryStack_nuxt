import { createError } from 'h3'
import { enableOwnerAutopilotPolicy, revokeOwnerAutopilotPolicy, type OwnerAutopilotPolicy } from './autopilot-policy'
import { createContentOperationsRepository, type AutopilotPolicyInsert, type ContentOperationsRepository } from './repository'
import { parseAutopilotPolicyInput, stableFingerprint } from './normalization'
import type { ContentOperationAutopilotPolicyRow } from './types'

function notFound(message: string): never { throw createError({ statusCode: 404, statusMessage: message }) }
function conflict(message: string): never { throw createError({ statusCode: 409, statusMessage: message }) }

function listOf(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }

export function projectAutopilotPolicy(row: ContentOperationAutopilotPolicyRow, targetId: string): OwnerAutopilotPolicy {
  return {
    policyId: row.policyId,
    policyVersion: row.policyVersion as OwnerAutopilotPolicy['policyVersion'],
    ownerUserId: row.ownerUserId,
    authorizedByOwnerUserId: row.authorizedByOwnerUserId,
    clientId: row.clientId,
    targetRowId: row.publicationTargetId,
    targetId,
    status: row.status,
    authorizedAt: row.authorizedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() || null,
    allowedContentTypes: listOf(row.allowedContentTypes),
    allowedLanguages: listOf(row.allowedLanguages),
    requireApprovedForDelivery: row.requireApprovedForDelivery as true,
    requirePassedRiskGate: row.requirePassedRiskGate as true,
    configurationFingerprint: row.configurationFingerprint,
  }
}

function policyProjection(row: ContentOperationAutopilotPolicyRow, targetId: string) {
  return { policyId: row.policyId, policyVersion: row.policyVersion, ownerUserId: row.ownerUserId, clientId: row.clientId, targetRowId: row.publicationTargetId, targetId, status: row.status, authorizedByOwnerUserId: row.authorizedByOwnerUserId, authorizedAt: row.authorizedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt, allowedContentTypes: listOf(row.allowedContentTypes), allowedLanguages: listOf(row.allowedLanguages), requireApprovedForDelivery: true, requirePassedRiskGate: true, configurationFingerprint: row.configurationFingerprint }
}

function insertInput(policy: OwnerAutopilotPolicy): AutopilotPolicyInsert {
  return {
    ownerUserId: policy.ownerUserId,
    clientId: policy.clientId,
    publicationTargetId: policy.targetRowId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    authorizedByOwnerUserId: policy.authorizedByOwnerUserId,
    status: policy.status,
    authorizedAt: new Date(policy.authorizedAt),
    expiresAt: new Date(policy.expiresAt),
    revokedAt: policy.revokedAt ? new Date(policy.revokedAt) : null,
    allowedContentTypes: policy.allowedContentTypes,
    allowedLanguages: policy.allowedLanguages,
    requireApprovedForDelivery: true,
    requirePassedRiskGate: true,
    configurationFingerprint: policy.configurationFingerprint,
  }
}

export async function enableOwnerAutopilot(ownerUserId: number, clientId: number, value: unknown, repository?: ContentOperationsRepository, authorizationNow = new Date()) {
  const db = repository || createContentOperationsRepository()
  const input = parseAutopilotPolicyInput(value)
  const client = await db.findClient(ownerUserId, clientId)
  if (!client || client.status !== 'active') notFound('Content operation client was not found for this owner.')
  const target = await db.findActivePublicationTarget(ownerUserId, clientId)
  if (!target || target.status !== 'active') notFound('An active publication target is required before enabling autopilot.')
  if (!target.executionEnabled) conflict('Publication target execution must be explicitly enabled before enabling autopilot.')
  const policy = enableOwnerAutopilotPolicy({ ownerUserId, clientId, targetRowId: target.id, targetId: target.targetId, authorizedByOwnerUserId: ownerUserId, authorizedAt: authorizationNow.toISOString(), expiresAt: input.expiresAt, allowedContentTypes: input.allowedContentTypes, allowedLanguages: input.allowedLanguages })
  const existing = await db.findAutopilotPolicy(ownerUserId, clientId, target.id)
  if (existing && existing.status !== 'revoked') conflict('An autopilot policy already exists for this owner target; revoke it before creating a new authorization.')
  if (existing && existing.status === 'revoked') conflict('A revoked autopilot policy is terminal; create a new publication target before re-authorizing.')
  try {
    const stored = await db.transaction(async transaction => {
      const row = await transaction.insertAutopilotPolicy(insertInput(policy))
      await transaction.appendEvent({ ownerUserId, clientId, calendarId: null, entryId: null, runId: null, eventType: 'autopilot_policy_enabled', fromStatus: null, toStatus: row.status, eventFingerprint: stableFingerprint({ event: 'autopilot_policy_enabled', policyId: row.policyId, configurationFingerprint: row.configurationFingerprint }), metadata: { policyId: row.policyId, policyVersion: row.policyVersion, clientId: row.clientId, publicationTargetId: row.publicationTargetId, status: row.status, authorizedAt: row.authorizedAt, expiresAt: row.expiresAt, allowedContentTypes: listOf(row.allowedContentTypes), allowedLanguages: listOf(row.allowedLanguages) } })
      return row
    })
    return { policy: policyProjection(stored, target.targetId), replayed: false }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && String((error as { code?: unknown }).code) === 'ER_DUP_ENTRY') conflict('An autopilot policy already exists for this owner target.')
    throw error
  }
}

export async function revokeOwnerAutopilot(ownerUserId: number, clientId: number, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const target = (await db.listPublicationTargets(ownerUserId)).find(candidate => candidate.clientId === clientId && candidate.status !== 'revoked') || (await db.listPublicationTargets(ownerUserId)).find(candidate => candidate.clientId === clientId)
  if (!target) notFound('A publication target was not found for this owner client.')
  const existing = await db.findAutopilotPolicy(ownerUserId, clientId, target.id)
  if (!existing) notFound('An autopilot policy was not found for this owner target.')
  if (existing.status === 'revoked') return { policy: policyProjection(existing, target.targetId), replayed: true }
  const revokedAt = new Date()
  const revoked = await db.transaction(async transaction => {
    const row = await transaction.revokeAutopilotPolicy(ownerUserId, existing.policyId, revokedAt)
    if (!row) notFound('Autopilot policy disappeared before revocation.')
    await transaction.appendEvent({ ownerUserId, clientId, calendarId: null, entryId: null, runId: null, eventType: 'autopilot_policy_revoked', fromStatus: existing.status, toStatus: row.status, eventFingerprint: stableFingerprint({ event: 'autopilot_policy_revoked', policyId: row.policyId, revokedAt: revokedAt.toISOString() }), metadata: { policyId: row.policyId, policyVersion: row.policyVersion, clientId: row.clientId, publicationTargetId: row.publicationTargetId, status: row.status, revokedAt: row.revokedAt } })
    return row
  })
  return { policy: policyProjection(revoked, target.targetId), replayed: false }
}

export async function getOwnerAutopilotPolicy(ownerUserId: number, clientId: number, repository?: ContentOperationsRepository) {
  const db = repository || createContentOperationsRepository()
  const targets = await db.listPublicationTargets(ownerUserId)
  const target = targets.find(candidate => candidate.clientId === clientId && candidate.status !== 'revoked') || targets.find(candidate => candidate.clientId === clientId)
  if (!target) return { policy: null }
  const row = await db.findAutopilotPolicy(ownerUserId, clientId, target.id)
  return { policy: row ? policyProjection(row, target.targetId) : null }
}
