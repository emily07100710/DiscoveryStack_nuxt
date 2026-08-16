import { and, desc, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../database'
import { auditRuns, auditTrainingExamples, auditWorkspaces, users } from '../database/schema'

export function requireAuditDatabase() {
  const database = getDatabase()
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Private Audit Lab is temporarily unavailable.' })
  return database
}

export async function getOwnerDatabaseUserId(openId: string) {
  const database = requireAuditDatabase()
  const [user] = await database.select({ id: users.id }).from(users).where(eq(users.openId, openId)).limit(1)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Owner account has not completed private administration sign-in.' })
  return user.id
}

export async function listOwnerAuditWorkspaces(ownerUserId: number) {
  const database = requireAuditDatabase()
  return database.select({
    id: auditWorkspaces.id,
    displayName: auditWorkspaces.displayName,
    targetDomain: auditWorkspaces.targetDomain,
    language: auditWorkspaces.language,
    publicAuditAuthorization: auditWorkspaces.publicAuditAuthorization,
    trainingConsent: auditWorkspaces.trainingConsent,
    consentRevokedAt: auditWorkspaces.consentRevokedAt,
    createdAt: auditWorkspaces.createdAt,
  }).from(auditWorkspaces).where(and(eq(auditWorkspaces.ownerUserId, ownerUserId), isNull(auditWorkspaces.deletedAt))).orderBy(desc(auditWorkspaces.createdAt))
}

export async function createOwnerAuditWorkspace(input: { ownerUserId: number, displayName: string, targetDomain: string, language: 'en' | 'zh-hant', publicAuditAuthorization: true, trainingConsent: boolean }) {
  const database = requireAuditDatabase()
  const result = await database.insert(auditWorkspaces).values(input)
  return { id: Number(result[0].insertId) }
}

export async function createManualAuditRun(input: { workspaceId: number, ownerUserId: number, requestedUrl: string, scopePolicy: object, analyzerVersion: string }) {
  const database = requireAuditDatabase()
  const [workspace] = await database.select({ id: auditWorkspaces.id }).from(auditWorkspaces).where(and(eq(auditWorkspaces.id, input.workspaceId), eq(auditWorkspaces.ownerUserId, input.ownerUserId), isNull(auditWorkspaces.deletedAt))).limit(1)
  if (!workspace) throw createError({ statusCode: 404, statusMessage: 'Audit workspace was not found.' })
  const result = await database.insert(auditRuns).values({ workspaceId: input.workspaceId, provider: 'manual', status: 'queued', requestedUrl: input.requestedUrl, scopePolicy: input.scopePolicy, analyzerVersion: input.analyzerVersion })
  return { id: Number(result[0].insertId), status: 'queued' as const }
}

export async function getOwnerTrainingReadiness(ownerUserId: number) {
  const database = requireAuditDatabase()
  const rows = await database.select({ labelStage: auditTrainingExamples.labelStage }).from(auditTrainingExamples)
    .innerJoin(auditWorkspaces, eq(auditTrainingExamples.workspaceId, auditWorkspaces.id))
    .where(and(eq(auditWorkspaces.ownerUserId, ownerUserId), eq(auditTrainingExamples.trainingConsent, true), isNull(auditTrainingExamples.consentRevokedAt), eq(auditTrainingExamples.datasetStatus, 'candidate'), eq(auditTrainingExamples.qualityCheckStatus, 'passed')))
  const stageCounts = rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.labelStage]: (counts[row.labelStage] || 0) + 1 }), {})
  return { consentedCandidates: rows.length, stageCounts }
}

export async function listConsentTrainingCandidates(ownerUserId: number, limit: number) {
  const database = requireAuditDatabase()
  return database.select({ id: auditTrainingExamples.id, auditRunId: auditTrainingExamples.auditRunId, labelStage: auditTrainingExamples.labelStage, labelDecision: auditTrainingExamples.labelDecision, featureVector: auditTrainingExamples.featureVector })
    .from(auditTrainingExamples)
    .innerJoin(auditWorkspaces, eq(auditTrainingExamples.workspaceId, auditWorkspaces.id))
    .where(and(eq(auditWorkspaces.ownerUserId, ownerUserId), eq(auditTrainingExamples.trainingConsent, true), isNull(auditTrainingExamples.consentRevokedAt), eq(auditTrainingExamples.datasetStatus, 'candidate'), eq(auditTrainingExamples.qualityCheckStatus, 'passed')))
    .orderBy(desc(auditTrainingExamples.createdAt)).limit(limit)
}

/** Revocation is immediate and irreversible for the current dataset version: candidates remain auditable but cannot be selected for modelling. */
export async function revokeWorkspaceTrainingConsent(input: { ownerUserId: number, workspaceId: number }) {
  const database = requireAuditDatabase()
  const [workspace] = await database.select({ id: auditWorkspaces.id }).from(auditWorkspaces).where(and(eq(auditWorkspaces.id, input.workspaceId), eq(auditWorkspaces.ownerUserId, input.ownerUserId), isNull(auditWorkspaces.deletedAt))).limit(1)
  if (!workspace) throw createError({ statusCode: 404, statusMessage: 'Audit workspace was not found.' })
  const revokedAt = new Date()
  await database.update(auditWorkspaces).set({ trainingConsent: false, consentRevokedAt: revokedAt }).where(eq(auditWorkspaces.id, workspace.id))
  await database.update(auditTrainingExamples).set({ trainingConsent: false, consentRevokedAt: revokedAt, datasetStatus: 'revoked' }).where(eq(auditTrainingExamples.workspaceId, workspace.id))
  return { workspaceId: workspace.id, revokedAt }
}
