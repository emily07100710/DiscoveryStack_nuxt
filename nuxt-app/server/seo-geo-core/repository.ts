import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { requireAuditDatabase } from '../audit/repository'
import {
  publicIntelligenceArtifacts,
  publicIntelligenceSources,
  seoGeoContentBriefs,
  seoGeoProductionDeliverables,
  seoGeoProductionPlanSelections,
  seoGeoProductionPlans,
  seoGeoStrategyRecommendations,
  seoGeoContentDrafts,
  seoGeoContentJobs,
  seoGeoContentReviews,
  seoGeoContentRiskGates,
  seoGeoDeliveryAttempts,
  seoGeoDeliveryTargets,
  seoGeoDiagnoses,
  seoGeoEvidenceApprovals,
  contentOperationCalendarEntries,
  contentOperationPublicationAttempts,
} from '../database/schema'
import type { AutoGeoStrategyRecommendation, ContentBriefInput, ContentJobStatus, ContentRiskGateResult, DiagnosisResult, EvidenceMaterial, EvidenceRef, ProductionDeliverableStatus, ProductionPlanStatus } from './contracts'
import { canTransitionContentJob } from './contracts'
import { resolveCanonicalGeoRules } from '../geo/rules'
import type { GeoRule } from '../geo/contracts'
import { buildAutoGeoStrategyRecommendations } from './strategy'
import { evaluateContentRisk, contentFingerprint } from './riskGate'
import { resolveProductionRuntimeProviders } from './productionProviders'
import { optimiseGeoDocument } from '../geo/optimise'

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

type EvidencePurpose = 'diagnosis' | 'recommendation' | 'content_draft'

export type EvidenceSnapshot = {
  refs: EvidenceRef[]
  context: string
  hash: string
  materials: EvidenceMaterial[]
  approvalTimestamps: string[]
  freshnessBasis: string
}

function evidenceKey(sourceId?: number, artifactId?: number) {
  return `${sourceId || ''}:${artifactId || ''}`
}

function renderEvidenceValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  try { return JSON.stringify(value) } catch { return '' }
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function sameEvidenceIdentity(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.sourceId === right.sourceId && left.artifactId === right.artifactId
}

async function getOwnerSource(ownerUserId: number, sourceId: number) {
  const database = requireAuditDatabase()
  const [source] = await database.select().from(publicIntelligenceSources).where(and(
    eq(publicIntelligenceSources.id, sourceId),
    eq(publicIntelligenceSources.ownerUserId, ownerUserId),
    eq(publicIntelligenceSources.reviewStatus, 'approved'),
    ne(publicIntelligenceSources.allowedUse, 'blocked'),
    isNull(publicIntelligenceSources.removedAt),
  )).limit(1)
  if (!source) throw createError({ statusCode: 422, statusMessage: '來源必須先通過既有 Public Intelligence policy review，且不得已移除或封鎖。' })
  return source
}

/** Resolve only active, owner-scoped approvals and return canonical immutable evidence metadata for downstream work. */
export async function resolveApprovedEvidenceSnapshot(ownerUserId: number, requestedRefs: EvidenceRef[], allowedFor: EvidencePurpose | readonly EvidencePurpose[], options: { requireArtifact: boolean; now?: Date }): Promise<EvidenceSnapshot> {
  const purposes = Array.isArray(allowedFor) ? allowedFor : [allowedFor]
  if (!requestedRefs.length) throw createError({ statusCode: 422, statusMessage: '至少需要一項已核准 evidence reference。' })
  const now = options.now || new Date()
  if (!Number.isFinite(now.getTime())) throw createError({ statusCode: 422, statusMessage: 'Evidence freshness clock is invalid.' })
  const database = requireAuditDatabase()
  const rows = await database.select({
    approvalId: seoGeoEvidenceApprovals.id,
    approvedAt: seoGeoEvidenceApprovals.approvedAt,
    approvalPurpose: seoGeoEvidenceApprovals.allowedFor,
    sourceId: seoGeoEvidenceApprovals.sourceId,
    artifactId: seoGeoEvidenceApprovals.artifactId,
    sourceName: publicIntelligenceSources.sourceName,
    sourceUrl: publicIntelligenceSources.canonicalUrl,
    fallbackSourceUrl: publicIntelligenceSources.sourceUrl,
    artifactType: publicIntelligenceArtifacts.artifactType,
    artifactText: publicIntelligenceArtifacts.artifactText,
    artifactLocator: publicIntelligenceArtifacts.sourceLocator,
    artifactHash: publicIntelligenceArtifacts.artifactHash,
    fieldData: publicIntelligenceArtifacts.fieldData,
  }).from(seoGeoEvidenceApprovals)
    .innerJoin(publicIntelligenceSources, eq(seoGeoEvidenceApprovals.sourceId, publicIntelligenceSources.id))
    .leftJoin(publicIntelligenceArtifacts, eq(seoGeoEvidenceApprovals.artifactId, publicIntelligenceArtifacts.id))
    .where(and(
      eq(seoGeoEvidenceApprovals.ownerUserId, ownerUserId),
      eq(publicIntelligenceSources.ownerUserId, ownerUserId),
      inArray(seoGeoEvidenceApprovals.allowedFor, purposes),
      eq(seoGeoEvidenceApprovals.status, 'approved'),
      isNull(seoGeoEvidenceApprovals.revokedAt),
      eq(publicIntelligenceSources.reviewStatus, 'approved'),
      ne(publicIntelligenceSources.allowedUse, 'blocked'),
      isNull(publicIntelligenceSources.removedAt),
      or(
        isNull(seoGeoEvidenceApprovals.artifactId),
        and(
          eq(publicIntelligenceArtifacts.qualityStatus, 'passed'),
          eq(publicIntelligenceArtifacts.piiStatus, 'none_detected'),
          isNull(publicIntelligenceArtifacts.removedAt),
        ),
      ),
    ))
  const rowsByKey = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = evidenceKey(row.sourceId, row.artifactId ?? undefined)
    rowsByKey.set(key, [...(rowsByKey.get(key) || []), row])
  }
  const canonicalRefs: EvidenceRef[] = []
  const materials: EvidenceMaterial[] = []
  const contextBlocks: string[] = []
  for (const requested of requestedRefs) {
    if (!requested.sourceId) throw createError({ statusCode: 422, statusMessage: 'Evidence reference 必須指定 sourceId。' })
    const matchingRows = rowsByKey.get(evidenceKey(requested.sourceId, requested.artifactId)) || []
    const missingPurpose = purposes.find(purpose => !matchingRows.some(row => row.approvalPurpose === purpose))
    const row = matchingRows[0]
    if (!row || missingPurpose) throw createError({ statusCode: 422, statusMessage: `Evidence source/artifact 尚未取得 ${missingPurpose || purposes.join('/')} 用途的有效核准，或已撤銷。` })
    if (options.requireArtifact && (!row.artifactId || !row.artifactHash || !row.artifactType)) throw createError({ statusCode: 422, statusMessage: 'Content generation 必須使用通過品質與 PII 檢查的 approved artifact snapshot。' })
    if (requested.artifactHash && requested.artifactHash !== row.artifactHash) throw createError({ statusCode: 409, statusMessage: 'Evidence artifact hash 與目前核准 snapshot 不一致，請重新建立 Content Brief。' })
    const approvedAt = row.approvedAt ? new Date(row.approvedAt) : null
    if (!approvedAt || !Number.isFinite(approvedAt.getTime()) || approvedAt.getTime() > now.getTime()) throw createError({ statusCode: 409, statusMessage: 'Evidence approval timestamp is missing, invalid, or in the future.' })
    const approvedAtIso = approvedAt.toISOString()
    const locator = row.artifactLocator || row.sourceUrl || row.fallbackSourceUrl || undefined
    const canonical: EvidenceRef = {
      sourceId: row.sourceId,
      artifactId: row.artifactId ?? undefined,
      locator,
      artifactHash: row.artifactHash ?? undefined,
      approvedAt: approvedAtIso,
      reason: `Evidence approval #${row.approvalId} 已由 owner 明確核准用於 ${purposes.join('/')}`,
    }
    canonicalRefs.push(canonical)
    const artifactPayload = row.artifactText?.trim() || renderEvidenceValue(row.fieldData)
    if (row.artifactId && row.artifactHash && row.artifactType) {
      materials.push({ sourceId: row.sourceId, artifactId: row.artifactId, sourceName: row.sourceName || undefined, locator, artifactType: row.artifactType, artifactHash: row.artifactHash, reviewedText: artifactPayload.slice(0, 5000), ...(row.fieldData && typeof row.fieldData === 'object' && !Array.isArray(row.fieldData) ? { reviewedFields: row.fieldData as Record<string, unknown> } : {}) })
    }
    contextBlocks.push([
      `Evidence approval #${row.approvalId}`,
      `Source: ${row.sourceName || row.sourceUrl || row.fallbackSourceUrl || `source-${row.sourceId}`}`,
      `Locator: ${locator || 'not specified'}`,
      `Artifact type: ${row.artifactType || 'source-level approval'}`,
      `Artifact hash: ${row.artifactHash || 'source-level approval'}`,
      artifactPayload ? `Reviewed representation:\n${artifactPayload.slice(0, 5000)}` : 'No artifact text is available; do not infer additional factual claims from this reference.',
    ].join('\n'))
  }
  const refs = canonicalRefs.slice(0, 40)
  const context = contextBlocks.join('\n\n').slice(0, 16000)
  const snapshotIdentity = refs.map(({ sourceId, artifactId, locator, artifactHash, approvedAt }) => ({ sourceId, artifactId: artifactId ?? null, locator: locator || null, artifactHash: artifactHash || null, approvedAt: approvedAt || null }))
  const approvalTimestamps = refs.map(ref => ref.approvedAt).filter((value): value is string => typeof value === 'string')
  if (approvalTimestamps.length !== refs.length) throw createError({ statusCode: 409, statusMessage: 'Approved evidence snapshot is missing an approval timestamp.' })
  if (options.requireArtifact && materials.length !== refs.filter(ref => Boolean(ref.artifactId)).length) throw createError({ statusCode: 422, statusMessage: 'Approved artifact material is incomplete; content generation is blocked.' })
  const freshnessBasis = [...approvalTimestamps].sort()[0]
  if (!freshnessBasis) throw createError({ statusCode: 409, statusMessage: 'Approved evidence snapshot has no freshness basis.' })
  return { refs, context, hash: stableFingerprint(snapshotIdentity), materials, approvalTimestamps, freshnessBasis }
}

export async function createEvidenceApproval(input: { ownerUserId: number, sourceId: number, artifactId?: number, allowedFor: EvidencePurpose, reviewNote: string }) {
  const database = requireAuditDatabase()
  const source = await getOwnerSource(input.ownerUserId, input.sourceId)
  let artifact: typeof publicIntelligenceArtifacts.$inferSelect | undefined
  if (input.artifactId) {
    const [found] = await database.select().from(publicIntelligenceArtifacts).where(and(
      eq(publicIntelligenceArtifacts.id, input.artifactId),
      eq(publicIntelligenceArtifacts.sourceId, source.id),
      eq(publicIntelligenceArtifacts.qualityStatus, 'passed'),
      eq(publicIntelligenceArtifacts.piiStatus, 'none_detected'),
      isNull(publicIntelligenceArtifacts.removedAt),
    )).limit(1)
    if (!found) throw createError({ statusCode: 422, statusMessage: '指定 artifact 必須屬於該 owner 的已核准來源，並通過品質與 PII 檢查。' })
    artifact = found
  }
  const policySnapshot = {
    sourceId: source.id,
    sourceUrl: source.canonicalUrl || source.sourceUrl,
    allowedUse: source.allowedUse,
    reviewStatus: source.reviewStatus,
    termsStatus: source.termsStatus,
    copyrightRisk: source.copyrightRisk,
    piiStatus: source.piiStatus,
    artifactId: artifact?.id ?? null,
    artifactHash: artifact?.artifactHash ?? null,
    artifactType: artifact?.artifactType ?? null,
    approvalPurpose: input.allowedFor,
  }
  await database.insert(seoGeoEvidenceApprovals).values({
    ownerUserId: input.ownerUserId,
    sourceId: input.sourceId,
    artifactId: input.artifactId ?? null,
    allowedFor: input.allowedFor,
    status: 'approved',
    policySnapshot,
    reviewerUserId: input.ownerUserId,
    reviewNote: input.reviewNote.trim(),
    approvedAt: new Date(),
  }).onDuplicateKeyUpdate({ set: { status: 'approved', policySnapshot, reviewerUserId: input.ownerUserId, reviewNote: input.reviewNote.trim(), approvedAt: new Date(), revokedAt: null } })
  const [approval] = await database.select().from(seoGeoEvidenceApprovals).where(and(
    eq(seoGeoEvidenceApprovals.ownerUserId, input.ownerUserId),
    eq(seoGeoEvidenceApprovals.sourceId, input.sourceId),
    input.artifactId ? eq(seoGeoEvidenceApprovals.artifactId, input.artifactId) : isNull(seoGeoEvidenceApprovals.artifactId),
    eq(seoGeoEvidenceApprovals.allowedFor, input.allowedFor),
  )).limit(1)
  if (!approval) throw createError({ statusCode: 500, statusMessage: 'Evidence approval could not be recorded.' })
  return approval
}

export async function listApprovedEvidence(ownerUserId: number, allowedFor: EvidencePurpose): Promise<EvidenceRef[]> {
  const database = requireAuditDatabase()
  const rows = await database.select({
    approvalId: seoGeoEvidenceApprovals.id,
    sourceId: seoGeoEvidenceApprovals.sourceId,
    artifactId: seoGeoEvidenceApprovals.artifactId,
    sourceUrl: publicIntelligenceSources.canonicalUrl,
    fallbackSourceUrl: publicIntelligenceSources.sourceUrl,
    artifactHash: publicIntelligenceArtifacts.artifactHash,
    artifactLocator: publicIntelligenceArtifacts.sourceLocator,
  }).from(seoGeoEvidenceApprovals)
    .innerJoin(publicIntelligenceSources, eq(seoGeoEvidenceApprovals.sourceId, publicIntelligenceSources.id))
    .leftJoin(publicIntelligenceArtifacts, eq(seoGeoEvidenceApprovals.artifactId, publicIntelligenceArtifacts.id))
    .where(and(
      eq(seoGeoEvidenceApprovals.ownerUserId, ownerUserId),
      eq(publicIntelligenceSources.ownerUserId, ownerUserId),
      eq(seoGeoEvidenceApprovals.allowedFor, allowedFor),
      eq(seoGeoEvidenceApprovals.status, 'approved'),
      isNull(seoGeoEvidenceApprovals.revokedAt),
      eq(publicIntelligenceSources.reviewStatus, 'approved'),
      ne(publicIntelligenceSources.allowedUse, 'blocked'),
      isNull(publicIntelligenceSources.removedAt),
    )).orderBy(desc(seoGeoEvidenceApprovals.updatedAt))
  return rows.map(row => ({ sourceId: row.sourceId, artifactId: row.artifactId ?? undefined, locator: row.artifactLocator || row.sourceUrl || row.fallbackSourceUrl, artifactHash: row.artifactHash ?? undefined, reason: `Evidence approval #${row.approvalId} 已由 owner 明確核准用於 ${allowedFor}` }))
}

export async function saveDiagnosis(input: { ownerUserId: number, sourceId?: number, auditRunId?: number, diagnosis: DiagnosisResult }) {
  const database = requireAuditDatabase()
  await database.insert(seoGeoDiagnoses).values({
    ownerUserId: input.ownerUserId,
    sourceId: input.sourceId ?? null,
    auditRunId: input.auditRunId ?? null,
    inputFingerprint: input.diagnosis.inputFingerprint,
    diagnosisKind: input.diagnosis.engine === 'deterministic-diagnosis-v1' ? 'deterministic_baseline' : 'approved_model',
    status: input.diagnosis.status,
    modelReference: input.diagnosis.engine === 'approved-model-not-ready' ? { engine: input.diagnosis.engine } : null,
    evidenceRefs: input.diagnosis.findings.flatMap(finding => finding.evidence),
    result: input.diagnosis,
    limitations: input.diagnosis.limitations,
    requiresHumanReview: true,
  })
  const [stored] = await database.select().from(seoGeoDiagnoses).where(and(eq(seoGeoDiagnoses.ownerUserId, input.ownerUserId), eq(seoGeoDiagnoses.inputFingerprint, input.diagnosis.inputFingerprint))).orderBy(desc(seoGeoDiagnoses.id)).limit(1)
  if (!stored) throw createError({ statusCode: 500, statusMessage: 'Diagnosis could not be recorded.' })
  return stored
}

export async function getOwnerDiagnosis(ownerUserId: number, diagnosisId: number) {
  const database = requireAuditDatabase()
  const [diagnosis] = await database.select().from(seoGeoDiagnoses).where(and(eq(seoGeoDiagnoses.id, diagnosisId), eq(seoGeoDiagnoses.ownerUserId, ownerUserId))).limit(1)
  if (!diagnosis) throw createError({ statusCode: 404, statusMessage: 'Diagnosis was not found.' })
  return diagnosis
}

export function preserveStrategyRerunStatus(status: AutoGeoStrategyRecommendation['status']): AutoGeoStrategyRecommendation['status'] {
  return status
}

export async function createStrategyRecommendations(input: { ownerUserId: number, diagnosisId: number }) {
  const database = requireAuditDatabase()
  const diagnosis = await getOwnerDiagnosis(input.ownerUserId, input.diagnosisId)
  const result = diagnosis.result as DiagnosisResult
  if (result.engine !== 'deterministic-diagnosis-v1' || !result.findings.length) throw createError({ statusCode: 422, statusMessage: '只有包含 deterministic findings 的 Diagnosis 才能建立 Strategy recommendation。' })
  const [recommendationRefs, contentDraftRefs] = await Promise.all([
    listApprovedEvidence(input.ownerUserId, 'recommendation'),
    listApprovedEvidence(input.ownerUserId, 'content_draft'),
  ])
  const eligibleRefs = contentDraftRefs.filter(contentRef => recommendationRefs.some(recommendationRef => sameEvidenceIdentity(recommendationRef, contentRef))).filter(ref => Boolean(diagnosis.sourceId) && ref.sourceId === diagnosis.sourceId)
  const enrichedFindings = result.findings.map(finding => ({ ...finding, evidence: [...finding.evidence, ...eligibleRefs.filter(ref => !finding.evidence.some(existing => sameEvidenceIdentity(existing, ref)))] }))
  const recommendations = buildAutoGeoStrategyRecommendations(diagnosis.id, enrichedFindings)
  const saved: typeof seoGeoStrategyRecommendations.$inferSelect[] = []
  for (const recommendation of recommendations) {
    const idempotencyKey = `strategy:${diagnosis.id}:${recommendation.issueCode}:v${recommendation.version}`.slice(0, 128)
    const row = {
      ownerUserId: input.ownerUserId,
      diagnosisId: diagnosis.id,
      issueCode: recommendation.issueCode,
      recommendationKey: recommendation.recommendationKey,
      ruleSetVersion: recommendation.ruleSetVersion,
      ruleIds: recommendation.ruleIds,
      rules: recommendation.rules,
      priority: recommendation.priority,
      rationale: recommendation.rationale,
      recommendedActions: recommendation.recommendedActions,
      deliverableTypes: recommendation.deliverableTypes,
      contentOpportunities: recommendation.contentOpportunities,
      evidenceRefs: recommendation.evidenceRefs,
      evidenceSnapshotHash: recommendation.evidenceSnapshotHash,
      status: 'proposed' as const,
      limitations: recommendation.limitations,
      version: recommendation.version,
      idempotencyKey,
      provenance: { ...recommendation.provenance, eligibleEvidenceCount: eligibleRefs.length },
    }
    const [existing] = await database.select().from(seoGeoStrategyRecommendations).where(and(eq(seoGeoStrategyRecommendations.ownerUserId, input.ownerUserId), eq(seoGeoStrategyRecommendations.idempotencyKey, idempotencyKey))).limit(1)
    if (existing) {
      if (existing.status !== 'proposed' && (existing.evidenceSnapshotHash !== recommendation.evidenceSnapshotHash || existing.recommendationKey !== recommendation.recommendationKey)) throw createError({ statusCode: 409, statusMessage: 'Strategy recommendation snapshot conflicts with the selected plan.' })
      await database.update(seoGeoStrategyRecommendations).set({ ...row, status: preserveStrategyRerunStatus(existing.status) }).where(eq(seoGeoStrategyRecommendations.id, existing.id))
    } else {
      await database.insert(seoGeoStrategyRecommendations).values(row)
    }
    const [stored] = await database.select().from(seoGeoStrategyRecommendations).where(and(eq(seoGeoStrategyRecommendations.ownerUserId, input.ownerUserId), eq(seoGeoStrategyRecommendations.idempotencyKey, idempotencyKey))).limit(1)
    if (!stored) throw createError({ statusCode: 500, statusMessage: 'Strategy recommendation could not be recorded.' })
    saved.push(stored)
  }
  return { diagnosis, recommendations: saved }
}

export async function listOwnerStrategyRecommendations(ownerUserId: number, diagnosisId?: number) {
  const database = requireAuditDatabase()
  return database.select().from(seoGeoStrategyRecommendations).where(and(eq(seoGeoStrategyRecommendations.ownerUserId, ownerUserId), diagnosisId ? eq(seoGeoStrategyRecommendations.diagnosisId, diagnosisId) : undefined)).orderBy(desc(seoGeoStrategyRecommendations.createdAt)).limit(100)
}

export async function getProductionPlanBundle(ownerUserId: number, planId: number) {
  const database = requireAuditDatabase()
  const [plan] = await database.select().from(seoGeoProductionPlans).where(and(eq(seoGeoProductionPlans.id, planId), eq(seoGeoProductionPlans.ownerUserId, ownerUserId))).limit(1)
  if (!plan) throw createError({ statusCode: 404, statusMessage: 'Production Plan was not found.' })
  const [selections, deliverables] = await Promise.all([
    database.select().from(seoGeoProductionPlanSelections).where(and(eq(seoGeoProductionPlanSelections.planId, plan.id), eq(seoGeoProductionPlanSelections.ownerUserId, ownerUserId))).orderBy(seoGeoProductionPlanSelections.createdAt),
    database.select().from(seoGeoProductionDeliverables).where(and(eq(seoGeoProductionDeliverables.planId, plan.id), eq(seoGeoProductionDeliverables.ownerUserId, ownerUserId))).orderBy(seoGeoProductionDeliverables.createdAt),
  ])
  const strategyIds = selections.map(selection => selection.strategyRecommendationId)
  const strategies = strategyIds.length
    ? await database.select().from(seoGeoStrategyRecommendations).where(and(eq(seoGeoStrategyRecommendations.ownerUserId, ownerUserId), inArray(seoGeoStrategyRecommendations.id, strategyIds))).orderBy(seoGeoStrategyRecommendations.createdAt)
    : []
  return { plan, selections, strategies, deliverables }
}

export type CanonicalProductionContext = {
  plan: Awaited<ReturnType<typeof getProductionPlanBundle>>['plan']
  deliverable: Awaited<ReturnType<typeof getProductionPlanBundle>>['deliverables'][number]
  selection: Awaited<ReturnType<typeof getProductionPlanBundle>>['selections'][number]
  strategy: Awaited<ReturnType<typeof getProductionPlanBundle>>['strategies'][number]
  diagnosis: Awaited<ReturnType<typeof getOwnerDiagnosis>>
  diagnosisResult: DiagnosisResult
  opportunity: { key: string, deliverableType: 'article' | 'faq' | 'service_page', title: string, audience: string, goals: string[], constraints: string[] }
  rules: GeoRule[]
  evidenceSnapshot: EvidenceSnapshot
  brief?: Awaited<ReturnType<typeof getOwnerContentBrief>>
  job?: Awaited<ReturnType<typeof getOwnerContentJob>>
}

export async function resolveProductionContext(input: { ownerUserId: number, planId: number, deliverableId: number, includeArtifacts?: boolean }): Promise<CanonicalProductionContext> {
  const bundle = await getProductionPlanBundle(input.ownerUserId, input.planId)
  const deliverable = bundle.deliverables.find(item => item.id === input.deliverableId)
  if (!deliverable) throw createError({ statusCode: 404, statusMessage: 'Production deliverable was not found in this plan.' })
  const selection = bundle.selections.find(item => item.id === deliverable.selectionId)
  if (!selection || selection.status !== 'selected') throw createError({ statusCode: 422, statusMessage: 'Production deliverable must have an active selected strategy.' })
  const strategy = bundle.strategies.find(item => item.id === selection.strategyRecommendationId)
  if (!strategy || ['rejected', 'superseded'].includes(strategy.status)) throw createError({ statusCode: 422, statusMessage: 'Production deliverable strategy is not active.' })
  const diagnosisId = bundle.plan.diagnosisId
  if (!diagnosisId || strategy.diagnosisId !== diagnosisId) throw createError({ statusCode: 409, statusMessage: 'Plan, selection, and strategy must resolve to the same Diagnosis.' })
  const diagnosis = await getOwnerDiagnosis(input.ownerUserId, diagnosisId)
  const diagnosisResult = diagnosis.result as DiagnosisResult
  if (diagnosisResult.status === 'blocked') throw createError({ statusCode: 422, statusMessage: 'Blocked Diagnosis cannot enter Production.' })
  if (selection.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash || strategy.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash || deliverable.evidenceSnapshotHash !== bundle.plan.evidenceSnapshotHash) throw createError({ statusCode: 409, statusMessage: 'Plan, selection, strategy, and deliverable evidence snapshots are inconsistent.' })
  const evidenceSnapshot = await resolveApprovedEvidenceSnapshot(input.ownerUserId, jsonArray<EvidenceRef>(strategy.evidenceRefs), ['recommendation', 'content_draft'], { requireArtifact: input.includeArtifacts !== false })
  if (evidenceSnapshot.hash !== bundle.plan.evidenceSnapshotHash) throw createError({ statusCode: 409, statusMessage: 'Approved evidence snapshot is stale; rebuild the Production Plan.' })
  const ruleIds = jsonArray<string>(strategy.ruleIds)
  const rules = resolveCanonicalGeoRules(ruleIds)
  if (strategy.ruleSetVersion !== 'autogeo-compatible-rules-v1' || rules.length !== ruleIds.length || jsonArray<{ id: string }>(strategy.rules).map(rule => rule.id).join('|') !== rules.map(rule => rule.id).join('|')) throw createError({ statusCode: 409, statusMessage: 'Strategy rules are not the current canonical compatible ruleset.' })
  const opportunityKey = deliverable.opportunityKey.startsWith(`${strategy.id}:`) ? deliverable.opportunityKey.slice(`${strategy.id}:`.length) : ''
  const opportunity = jsonArray<CanonicalProductionContext['opportunity']>(strategy.contentOpportunities).find(item => item.key === opportunityKey)
  if (!opportunity || opportunity.deliverableType !== deliverable.contentType || opportunity.title !== deliverable.title || opportunity.audience !== deliverable.audience) throw createError({ statusCode: 409, statusMessage: 'Production deliverable does not match its canonical strategy opportunity.' })
  let brief = deliverable.briefId ? await getOwnerContentBrief(input.ownerUserId, deliverable.briefId) : await findOwnerBriefForDeliverable(input.ownerUserId, deliverable.id)
  if (brief && (brief.productionPlanId !== bundle.plan.id || brief.productionDeliverableId !== deliverable.id || brief.strategyRecommendationId !== strategy.id || brief.diagnosisId !== diagnosisId || brief.evidenceSnapshotHash !== evidenceSnapshot.hash)) throw createError({ statusCode: 409, statusMessage: 'Content Brief linkage or evidence snapshot is not canonical.' })
  let job = deliverable.jobId ? await getOwnerContentJob(input.ownerUserId, deliverable.jobId) : undefined
  if (job && (job.productionPlanId !== bundle.plan.id || job.productionDeliverableId !== deliverable.id || job.strategyRecommendationId !== strategy.id || job.briefId !== brief?.id || job.operation !== 'content_draft' || job.evidenceSnapshotHash !== evidenceSnapshot.hash)) throw createError({ statusCode: 409, statusMessage: 'Content job linkage or operation is not canonical.' })
  return { plan: bundle.plan, deliverable, selection, strategy, diagnosis, diagnosisResult, opportunity, rules, evidenceSnapshot, brief, job }
}

export function assertProductionPlanEvidenceSnapshot(strategyHashes: readonly string[], approvedHash: string): string {
  const uniqueHashes = [...new Set(strategyHashes)]
  if (uniqueHashes.length !== 1 || uniqueHashes[0] !== approvedHash) throw createError({ statusCode: 409, statusMessage: 'Production Plan evidence approval snapshot is stale; regenerate Strategy recommendations.' })
  return approvedHash
}

export async function createProductionPlan(input: { ownerUserId: number, diagnosisId?: number, strategyRecommendationIds: number[], title: string, language: 'en' | 'zh-hant', idempotencyKey: string }) {
  const database = requireAuditDatabase()
  const ids = [...new Set(input.strategyRecommendationIds)]
  if (!ids.length || ids.length > 10) throw createError({ statusCode: 422, statusMessage: 'Production Plan 必須選擇 1 至 10 個 Strategy recommendations。' })
  const strategies = await database.select().from(seoGeoStrategyRecommendations).where(and(eq(seoGeoStrategyRecommendations.ownerUserId, input.ownerUserId), inArray(seoGeoStrategyRecommendations.id, ids))).orderBy(seoGeoStrategyRecommendations.id)
  if (strategies.length !== ids.length) throw createError({ statusCode: 422, statusMessage: '所有 Strategy recommendation 都必須屬於目前 owner。' })
  const strategyDiagnosisIds = [...new Set(strategies.map(strategy => strategy.diagnosisId))]
  if (strategyDiagnosisIds.length !== 1 || (input.diagnosisId && strategyDiagnosisIds[0] !== input.diagnosisId)) throw createError({ statusCode: 422, statusMessage: '選取的 Strategy recommendations 必須屬於同一個 Diagnosis。' })
  if (strategies.some(strategy => ['rejected', 'superseded'].includes(strategy.status))) throw createError({ statusCode: 422, statusMessage: 'Rejected 或 superseded strategy 不能加入 Production Plan。' })
  if (strategies.some(strategy => !jsonArray<EvidenceRef>(strategy.evidenceRefs).some(ref => Boolean(ref.artifactId)))) throw createError({ statusCode: 422, statusMessage: 'Production Plan 需要至少一項同一來源且同時通過 recommendation／content_draft approval 的 artifact。' })
  const diagnosisId = input.diagnosisId ?? strategies[0]?.diagnosisId
  const diagnosis = diagnosisId ? await getOwnerDiagnosis(input.ownerUserId, diagnosisId) : undefined
  const diagnosisResult = diagnosis?.result as DiagnosisResult | undefined
  if (!diagnosis || !diagnosisResult || diagnosisResult.status === 'blocked' || diagnosisResult.status === 'not_ready') throw createError({ statusCode: 422, statusMessage: 'Production Plan 需要可用且未 blocked 的 Diagnosis。' })
  const snapshotHashes = [...new Set(strategies.map(strategy => strategy.evidenceSnapshotHash))]
  if (snapshotHashes.length !== 1) throw createError({ statusCode: 409, statusMessage: '同一 Production Plan 的 Strategy evidence snapshot 必須一致。' })
  const requestedEvidenceRefs = [...new Map(strategies.flatMap(strategy => jsonArray<EvidenceRef>(strategy.evidenceRefs)).map(ref => [`${ref.sourceId || ''}:${ref.artifactId || ''}`, ref])).values()]
  const approvedEvidence = await resolveApprovedEvidenceSnapshot(input.ownerUserId, requestedEvidenceRefs, ['recommendation', 'content_draft'], { requireArtifact: true })
  assertProductionPlanEvidenceSnapshot(snapshotHashes, approvedEvidence.hash)
  const inputFingerprint = stableFingerprint({ diagnosisId: diagnosisId ?? null, strategyRecommendationIds: ids, title: input.title.trim(), language: input.language })
  const [existing] = await database.select().from(seoGeoProductionPlans).where(and(eq(seoGeoProductionPlans.ownerUserId, input.ownerUserId), eq(seoGeoProductionPlans.idempotencyKey, input.idempotencyKey))).limit(1)
  if (existing) {
    if (existing.inputFingerprint !== inputFingerprint) throw createError({ statusCode: 409, statusMessage: 'Production Plan idempotency key is already associated with a different selection.' })
    return getProductionPlanBundle(input.ownerUserId, existing.id)
  }
  const planId = await database.transaction(async tx => {
    const [created] = await tx.insert(seoGeoProductionPlans).values({ ownerUserId: input.ownerUserId, diagnosisId: diagnosisId ?? null, title: input.title.trim(), language: input.language, inputFingerprint, evidenceSnapshotHash: snapshotHashes[0]!, status: 'ready', idempotencyKey: input.idempotencyKey, provenance: { strategyRecommendationIds: ids, ruleSetVersions: strategies.map(strategy => strategy.ruleSetVersion), createdBy: 'owner-selection' } }).$returningId()
    if (!created?.id) throw createError({ statusCode: 500, statusMessage: 'Production Plan could not be recorded.' })
    for (const strategy of strategies) {
      await tx.insert(seoGeoProductionPlanSelections).values({ ownerUserId: input.ownerUserId, planId: created.id, strategyRecommendationId: strategy.id, status: 'selected', evidenceSnapshotHash: strategy.evidenceSnapshotHash, idempotencyKey: `plan:${created.id}:strategy:${strategy.id}`, provenance: { selection: 'owner-approved', strategyVersion: strategy.version } })
    }
    const usedKeys = new Set<string>()
    let deliverableCount = 0
    for (const strategy of strategies) {
      const [selection] = await tx.select({ id: seoGeoProductionPlanSelections.id }).from(seoGeoProductionPlanSelections).where(and(eq(seoGeoProductionPlanSelections.planId, created.id), eq(seoGeoProductionPlanSelections.strategyRecommendationId, strategy.id))).limit(1)
      if (!selection) throw createError({ statusCode: 500, statusMessage: 'Production Plan selection could not be recorded.' })
      for (const opportunity of jsonArray<{ key: string, deliverableType: 'article' | 'faq' | 'service_page', title: string, audience: string, goals: string[], constraints: string[] }>(strategy.contentOpportunities)) {
        if (deliverableCount >= 10) break
        const opportunityKey = `${strategy.id}:${opportunity.key}`.slice(0, 180)
        if (usedKeys.has(opportunityKey)) continue
        usedKeys.add(opportunityKey)
        await tx.insert(seoGeoProductionDeliverables).values({ ownerUserId: input.ownerUserId, planId: created.id, selectionId: selection.id, opportunityKey, contentType: opportunity.deliverableType, title: opportunity.title.slice(0, 300), audience: opportunity.audience.slice(0, 300), goals: opportunity.goals.slice(0, 20), constraints: opportunity.constraints.slice(0, 20), language: input.language, status: 'planned', evidenceSnapshotHash: strategy.evidenceSnapshotHash, idempotencyKey: `plan:${created.id}:deliverable:${opportunityKey}`.slice(0, 128), provenance: { strategyRecommendationId: strategy.id, issueCode: strategy.issueCode, recommendationKey: strategy.recommendationKey, ruleIds: jsonArray<string>(strategy.ruleIds), rules: jsonArray(strategy.rules) } })
        deliverableCount += 1
      }
    }
    await tx.update(seoGeoStrategyRecommendations).set({ status: 'selected' }).where(and(eq(seoGeoStrategyRecommendations.ownerUserId, input.ownerUserId), inArray(seoGeoStrategyRecommendations.id, ids)))
    return created.id
  })
  return getProductionPlanBundle(input.ownerUserId, planId)
}

export async function listOwnerProductionPlans(ownerUserId: number) {
  const database = requireAuditDatabase()
  return database.select().from(seoGeoProductionPlans).where(eq(seoGeoProductionPlans.ownerUserId, ownerUserId)).orderBy(desc(seoGeoProductionPlans.createdAt)).limit(50)
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function appendExportLedger(previous: unknown, entry: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(previous)) return [...previous.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[], entry]
  if (previous && typeof previous === 'object') return [previous as Record<string, unknown>, entry]
  return [entry]
}

export function deriveDraftReviewEligibility(input: { stage?: unknown, safetyStatus?: string, jobStatus?: string, gateStatus?: string, approvedForPreview: boolean, approvedForDelivery: boolean, pendingChangesRequested?: boolean }) {
  const optimized = input.stage === 'optimized'
  const knownDraftSafety = input.safetyStatus === 'passed' || input.safetyStatus === 'needs_review'
  const knownGateStatus = input.gateStatus === 'passed' || input.gateStatus === 'needs_human_review'
  const safe = knownDraftSafety && knownGateStatus
  const approvalSafe = input.safetyStatus === 'passed' && input.gateStatus === 'passed'
  const pendingChanges = Boolean(input.pendingChangesRequested)
  const awaitingReview = input.jobStatus === 'candidate_ready' || input.jobStatus === 'needs_human_review'
  const reviewWindow = awaitingReview || (input.jobStatus === 'approved' && input.approvedForPreview)
  const canApprovePreview = optimized && safe && approvalSafe && !pendingChanges && awaitingReview
  const canApproveDelivery = optimized && safe && approvalSafe && !pendingChanges && !input.approvedForDelivery && reviewWindow
  const canReview = optimized && safe && !pendingChanges && reviewWindow
  const canPreview = optimized && safe && approvalSafe && !pendingChanges && input.jobStatus === 'approved' && (input.approvedForPreview || input.approvedForDelivery)
  const canExport = optimized && safe && approvalSafe && !pendingChanges && input.jobStatus === 'approved' && input.approvedForDelivery
  return { canReview, canApprovePreview, canApproveDelivery, canPreview, canExport }
}

export function buildOwnerRevisionInputProvenance(input: { parentDraftId: number, parentDraftContentHash: string, changeRequestReviewId: number, selectedRuleIds: string[], evidenceSnapshotHash: string, revisionAuthor: number }) {
  return { stage: 'owner_revision_input' as const, generationMode: 'owner_revision_input' as const, provider: 'owner-submitted-revision', parentDraftId: input.parentDraftId, parentDraftContentHash: input.parentDraftContentHash, changeRequestReviewId: input.changeRequestReviewId, selectedRuleIds: input.selectedRuleIds, appliedRuleIds: [], evidenceSnapshotHash: input.evidenceSnapshotHash, revisionAuthor: input.revisionAuthor }
}

export function buildRevisionOptimizationProvenance(input: { ownerRevisionInputDraftId: number, originalParentDraftId: number, changeRequestReviewId: number, selectedRuleIds: string[], appliedRuleIds: string[], evidenceSnapshotHash: string, provider: string, providerVersion: string, runtimeProvider: object, actualProviderMode: string, fallbackReason?: string | null }) {
  return { stage: 'optimized' as const, generationMode: 'revision_selected_rule_optimization' as const, provider: input.provider, providerVersion: input.providerVersion, ownerRevisionInputDraftId: input.ownerRevisionInputDraftId, parentDraftId: input.ownerRevisionInputDraftId, originalParentDraftId: input.originalParentDraftId, changeRequestReviewId: input.changeRequestReviewId, selectedRuleIds: input.selectedRuleIds, appliedRuleIds: input.appliedRuleIds, evidenceSnapshotHash: input.evidenceSnapshotHash, runtimeProvider: input.runtimeProvider, actualProviderMode: input.actualProviderMode, fallbackReason: input.fallbackReason ?? null }
}

export async function getProductionPlanDetail(ownerUserId: number, planId: number) {
  await recalculateProductionPlanStatus(ownerUserId, planId)
  const database = requireAuditDatabase()
  const bundle = await getProductionPlanBundle(ownerUserId, planId)
  const deliverableIds = bundle.deliverables.map(item => item.id)
  const [diagnosis, briefs, jobs, targets] = await Promise.all([
    bundle.plan.diagnosisId ? getOwnerDiagnosis(ownerUserId, bundle.plan.diagnosisId) : undefined,
    deliverableIds.length ? database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.ownerUserId, ownerUserId), inArray(seoGeoContentBriefs.productionDeliverableId, deliverableIds))).orderBy(desc(seoGeoContentBriefs.createdAt)) : [],
    deliverableIds.length ? database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.ownerUserId, ownerUserId), inArray(seoGeoContentJobs.productionDeliverableId, deliverableIds))).orderBy(desc(seoGeoContentJobs.requestedAt)) : [],
    database.select({ id: seoGeoDeliveryTargets.id, displayName: seoGeoDeliveryTargets.displayName, adapter: seoGeoDeliveryTargets.adapter, targetOrigin: seoGeoDeliveryTargets.targetOrigin, status: seoGeoDeliveryTargets.status, allowPublish: seoGeoDeliveryTargets.allowPublish }).from(seoGeoDeliveryTargets).where(and(eq(seoGeoDeliveryTargets.ownerUserId, ownerUserId), eq(seoGeoDeliveryTargets.status, 'disabled'), eq(seoGeoDeliveryTargets.allowPublish, false))),
  ])
  const jobIds = jobs.map(job => job.id)
  const drafts = jobIds.length ? await database.select().from(seoGeoContentDrafts).where(inArray(seoGeoContentDrafts.jobId, jobIds)).orderBy(desc(seoGeoContentDrafts.createdAt)) : []
  const draftIds = drafts.map(draft => draft.id)
  const [riskGates, reviews, previews] = await Promise.all([
    draftIds.length ? database.select().from(seoGeoContentRiskGates).where(inArray(seoGeoContentRiskGates.draftId, draftIds)).orderBy(desc(seoGeoContentRiskGates.createdAt)) : [],
    jobIds.length ? database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.reviewerUserId, ownerUserId), inArray(seoGeoContentReviews.jobId, jobIds))).orderBy(desc(seoGeoContentReviews.createdAt)) : [],
    jobIds.length ? database.select({ id: seoGeoDeliveryAttempts.id, jobId: seoGeoDeliveryAttempts.jobId, draftId: seoGeoDeliveryAttempts.draftId, targetId: seoGeoDeliveryAttempts.targetId, mode: seoGeoDeliveryAttempts.mode, status: seoGeoDeliveryAttempts.status, deliverySummary: seoGeoDeliveryAttempts.deliverySummary, createdAt: seoGeoDeliveryAttempts.createdAt }).from(seoGeoDeliveryAttempts).where(and(inArray(seoGeoDeliveryAttempts.jobId, jobIds), eq(seoGeoDeliveryAttempts.mode, 'preview'))).orderBy(desc(seoGeoDeliveryAttempts.createdAt)) : [],
  ])
  const diagnosisResult = diagnosis ? diagnosis.result as DiagnosisResult : undefined
  const briefsByDeliverable = new Map<number, typeof briefs[number]>()
  for (const brief of briefs) if (brief.productionDeliverableId && !briefsByDeliverable.has(brief.productionDeliverableId)) briefsByDeliverable.set(brief.productionDeliverableId, brief)
  const jobsByDeliverable = new Map<number, typeof jobs[number]>()
  for (const job of jobs) if (job.productionDeliverableId && !jobsByDeliverable.has(job.productionDeliverableId)) jobsByDeliverable.set(job.productionDeliverableId, job)
  const draftsByJob = new Map<number, typeof drafts>()
  for (const draft of drafts) draftsByJob.set(draft.jobId, [...(draftsByJob.get(draft.jobId) || []), draft])
  const reviewsByDraft = new Map<number, typeof reviews>()
  for (const review of reviews) reviewsByDraft.set(review.draftId, [...(reviewsByDraft.get(review.draftId) || []), review])
  const gatesByDraft = new Map<number, typeof riskGates>()
  for (const gate of riskGates) gatesByDraft.set(gate.draftId, [...(gatesByDraft.get(gate.draftId) || []), gate])
  const deliverables = bundle.deliverables.map(deliverable => {
    const job = jobsByDeliverable.get(deliverable.id)
    const allDrafts = (job ? draftsByJob.get(job.id) || [] : []).sort((left, right) => right.version - left.version)
    const baseDraft = allDrafts.find(draft => jsonRecord(draft.provenance).stage === 'base_draft')
      const optimizedDraft = allDrafts.find(draft => jsonRecord(draft.provenance).stage === 'optimized') || null
    const draftReviews = optimizedDraft ? reviewsByDraft.get(optimizedDraft.id) || [] : []
    const latestGate = optimizedDraft ? (gatesByDraft.get(optimizedDraft.id) || [])[0] : undefined
    const approvedForPreview = draftReviews.some(review => review.decision === 'approved_for_preview' && review.evidenceSnapshotHash === bundle.plan.evidenceSnapshotHash)
    const approvedForDelivery = draftReviews.some(review => review.decision === 'approved_for_delivery' && review.evidenceSnapshotHash === bundle.plan.evidenceSnapshotHash)
    const pendingChangesRequested = draftReviews.some(review => review.decision === 'changes_requested' && review.evidenceSnapshotHash === bundle.plan.evidenceSnapshotHash)
    const eligibility = deriveDraftReviewEligibility({ stage: jsonRecord(optimizedDraft?.provenance).stage, safetyStatus: optimizedDraft?.safetyStatus, jobStatus: job?.status, gateStatus: latestGate?.status, approvedForPreview, approvedForDelivery, pendingChangesRequested })
    return { ...deliverable, brief: briefsByDeliverable.get(deliverable.id) || null, job: job || null, baseDraft: baseDraft || null, optimizedDraft, riskGate: latestGate || null, reviews: draftReviews, previews: previews.filter(preview => preview.jobId === job?.id && preview.draftId === optimizedDraft?.id), eligibility }
  })
  return {
    plan: bundle.plan,
    diagnosis: diagnosis ? { id: diagnosis.id, sourceId: diagnosis.sourceId, status: diagnosis.status, result: diagnosisResult, limitations: diagnosis.limitations, createdAt: diagnosis.createdAt } : null,
    selections: bundle.selections,
    strategies: bundle.strategies,
    deliverables,
    briefs,
    jobs,
    drafts,
    riskGates,
    reviews,
    previews,
    previewTargets: targets,
    eligibility: { canExport: deliverables.some(deliverable => deliverable.eligibility.canExport), allApproved: deliverables.length > 0 && deliverables.every(deliverable => ['approved', 'exported'].includes(deliverable.status)) },
    deliveryNotice: 'Preview and export are local owner-only records. No CMS, WordPress, generic HTTP, or external delivery write is performed.',
  }
}

export async function findOwnerBriefForDeliverable(ownerUserId: number, deliverableId: number) {
  const database = requireAuditDatabase()
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(
    eq(seoGeoContentBriefs.ownerUserId, ownerUserId),
    eq(seoGeoContentBriefs.productionDeliverableId, deliverableId),
    or(eq(seoGeoContentBriefs.status, 'draft'), eq(seoGeoContentBriefs.status, 'ready_for_generation'), eq(seoGeoContentBriefs.status, 'approved')),
  )).orderBy(desc(seoGeoContentBriefs.id)).limit(1)
  return brief
}

export async function updateProductionDeliverable(ownerUserId: number, deliverableId: number, patch: { status?: ProductionDeliverableStatus, briefId?: number, jobId?: number }) {
  const database = requireAuditDatabase()
  const [deliverable] = await database.select().from(seoGeoProductionDeliverables).where(and(eq(seoGeoProductionDeliverables.id, deliverableId), eq(seoGeoProductionDeliverables.ownerUserId, ownerUserId))).limit(1)
  if (!deliverable) throw createError({ statusCode: 404, statusMessage: 'Production deliverable was not found.' })
  await database.update(seoGeoProductionDeliverables).set({ status: patch.status ?? deliverable.status, briefId: patch.briefId ?? deliverable.briefId, jobId: patch.jobId ?? deliverable.jobId }).where(eq(seoGeoProductionDeliverables.id, deliverable.id))
  return { ...deliverable, ...patch }
}

export function deriveProductionPlanStatus(statuses: readonly ProductionDeliverableStatus[], currentStatus?: ProductionPlanStatus): ProductionPlanStatus {
  if (currentStatus === 'archived') return currentStatus
  if (currentStatus === 'generating') return currentStatus
  if (!statuses.length) return 'ready'
  if (statuses.every(status => status === 'approved' || status === 'exported')) return 'completed'
  if (statuses.every(status => status === 'blocked')) return 'blocked'
  return 'in_progress'
}

export async function recalculateProductionPlanStatus(ownerUserId: number, planId: number): Promise<ProductionPlanStatus> {
  const database = requireAuditDatabase()
  const [plan] = await database.select().from(seoGeoProductionPlans).where(and(eq(seoGeoProductionPlans.id, planId), eq(seoGeoProductionPlans.ownerUserId, ownerUserId))).limit(1)
  if (!plan) throw createError({ statusCode: 404, statusMessage: 'Production Plan was not found.' })
  const deliverables = await database.select({ status: seoGeoProductionDeliverables.status }).from(seoGeoProductionDeliverables).where(and(eq(seoGeoProductionDeliverables.planId, plan.id), eq(seoGeoProductionDeliverables.ownerUserId, ownerUserId)))
  const nextStatus = deriveProductionPlanStatus(deliverables.map(item => item.status), plan.status)
  if (plan.status !== nextStatus) await database.update(seoGeoProductionPlans).set({ status: nextStatus }).where(and(eq(seoGeoProductionPlans.id, plan.id), eq(seoGeoProductionPlans.ownerUserId, ownerUserId)))
  return nextStatus
}

export async function createCanonicalProductionBrief(ownerUserId: number, context: CanonicalProductionContext) {
  if (context.brief) return context.brief
  const database = requireAuditDatabase()
  const existing = await findOwnerBriefForDeliverable(ownerUserId, context.deliverable.id)
  if (existing) return existing
  const canonicalProvenance = {
    stage: 'canonical-production-context',
    source: 'server-resolved',
    diagnosisId: context.diagnosis.id,
    strategyRecommendationId: context.strategy.id,
    planId: context.plan.id,
    deliverableId: context.deliverable.id,
    selectedRuleIds: context.rules.map(rule => rule.id),
    ruleSetVersion: context.strategy.ruleSetVersion,
    ruleSource: 'discoverystack-autogeo-compatible',
    evidenceSnapshotHash: context.evidenceSnapshot.hash,
    limitations: ['Strategy rules are deterministic AutoGEO-compatible rules, not official upstream extracted rules.', 'Brief fields and provenance are server-owned; browser-supplied rule IDs and provenance are not used.'],
  }
  await database.insert(seoGeoContentBriefs).values({
    ownerUserId,
    diagnosisId: context.diagnosis.id,
    strategyRecommendationId: context.strategy.id,
    productionPlanId: context.plan.id,
    productionDeliverableId: context.deliverable.id,
    ruleIds: context.rules.map(rule => rule.id),
    provenance: canonicalProvenance,
    title: context.opportunity.title,
    audience: context.opportunity.audience,
    contentType: context.opportunity.deliverableType,
    language: context.plan.language,
    goals: context.opportunity.goals,
    constraints: context.opportunity.constraints,
    evidenceRefs: context.evidenceSnapshot.refs,
    evidenceSnapshotHash: context.evidenceSnapshot.hash,
    status: 'ready_for_generation',
  })
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.ownerUserId, ownerUserId), eq(seoGeoContentBriefs.productionDeliverableId, context.deliverable.id), eq(seoGeoContentBriefs.evidenceSnapshotHash, context.evidenceSnapshot.hash))).orderBy(desc(seoGeoContentBriefs.id)).limit(1)
  if (!brief) throw createError({ statusCode: 500, statusMessage: 'Canonical Content Brief could not be recorded.' })
  return brief
}

export async function prepareProductionPlanGeneration(ownerUserId: number, planId: number) {
  const bundle = await getProductionPlanBundle(ownerUserId, planId)
  if (!['ready', 'generating', 'in_progress'].includes(bundle.plan.status)) throw createError({ statusCode: 422, statusMessage: `Production Plan cannot generate from status ${bundle.plan.status}.` })
  const prepared: Array<{ deliverableId: number, briefId: number, jobId: number, idempotencyKey: string }> = []
  await databaseForPlan(ownerUserId).update(seoGeoProductionPlans).set({ status: 'generating' }).where(and(eq(seoGeoProductionPlans.id, planId), eq(seoGeoProductionPlans.ownerUserId, ownerUserId)))
  try {
    for (const deliverable of bundle.deliverables) {
      const context = await resolveProductionContext({ ownerUserId, planId, deliverableId: deliverable.id, includeArtifacts: true })
      const brief = await createCanonicalProductionBrief(ownerUserId, context)
      if (deliverable.briefId !== brief.id || deliverable.status === 'planned') await updateProductionDeliverable(ownerUserId, deliverable.id, { status: 'brief_ready', briefId: brief.id })
      const currentJob = context.job
      const runtimeProviders = resolveProductionRuntimeProviders()
      const job = currentJob || await createContentJob({ ownerUserId, briefId: brief.id, operation: 'content_draft', providerMode: runtimeProviders.mode, idempotencyKey: `plan:${bundle.plan.id}:job:${deliverable.id}`.slice(0, 128), productionPlanId: bundle.plan.id, strategyRecommendationId: context.strategy.id, productionDeliverableId: deliverable.id })
      if (!currentJob) await updateProductionDeliverable(ownerUserId, deliverable.id, { status: 'job_queued', jobId: job.id, briefId: brief.id })
      prepared.push({ deliverableId: deliverable.id, briefId: brief.id, jobId: job.id, idempotencyKey: job.idempotencyKey })
    }
    await databaseForPlan(ownerUserId).update(seoGeoProductionPlans).set({ status: 'in_progress' }).where(and(eq(seoGeoProductionPlans.id, planId), eq(seoGeoProductionPlans.ownerUserId, ownerUserId)))
  } catch (error) {
    await databaseForPlan(ownerUserId).update(seoGeoProductionPlans).set({ status: 'blocked' }).where(and(eq(seoGeoProductionPlans.id, planId), eq(seoGeoProductionPlans.ownerUserId, ownerUserId)))
    throw error
  }
  return { ...await getProductionPlanBundle(ownerUserId, planId), prepared }
}

function databaseForPlan(_ownerUserId: number) {
  return requireAuditDatabase()
}

export async function createContentBrief(input: { ownerUserId: number, brief: ContentBriefInput }) {
  const database = requireAuditDatabase()
  const evidenceSnapshot = await resolveApprovedEvidenceSnapshot(input.ownerUserId, input.brief.evidenceRefs, 'content_draft', { requireArtifact: true })
  const title = input.brief.title.trim()
  const audience = input.brief.audience.trim()
  await database.insert(seoGeoContentBriefs).values({
    ownerUserId: input.ownerUserId,
    diagnosisId: null,
    strategyRecommendationId: null,
    productionPlanId: null,
    productionDeliverableId: null,
    ruleIds: null,
    provenance: { source: 'standalone-owner-brief', evidenceSnapshotHash: evidenceSnapshot.hash, ruleSource: 'not-applicable' },
    title,
    audience,
    contentType: input.brief.contentType,
    language: input.brief.language,
    goals: input.brief.goals,
    constraints: input.brief.constraints,
    evidenceRefs: evidenceSnapshot.refs,
    evidenceSnapshotHash: evidenceSnapshot.hash,
    status: 'ready_for_generation',
  })
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.ownerUserId, input.ownerUserId), eq(seoGeoContentBriefs.evidenceSnapshotHash, evidenceSnapshot.hash), eq(seoGeoContentBriefs.title, title), isNull(seoGeoContentBriefs.productionDeliverableId))).orderBy(desc(seoGeoContentBriefs.id)).limit(1)
  if (!brief) throw createError({ statusCode: 500, statusMessage: 'Content Brief could not be recorded.' })
  return brief
}

export async function getOwnerContentBrief(ownerUserId: number, briefId: number) {
  const database = requireAuditDatabase()
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.id, briefId), eq(seoGeoContentBriefs.ownerUserId, ownerUserId))).limit(1)
  if (!brief) throw createError({ statusCode: 404, statusMessage: 'Content Brief was not found.' })
  return brief
}

export async function getOwnerContentJob(ownerUserId: number, jobId: number) {
  const database = requireAuditDatabase()
  const [job] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, jobId), eq(seoGeoContentJobs.ownerUserId, ownerUserId))).limit(1)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Content job was not found.' })
  return job
}

export async function createContentJob(input: { ownerUserId: number, briefId: number, operation: 'autogeo_recommendation' | 'content_draft' | 'risk_scan' | 'delivery_preview' | 'delivery_publish', providerMode: 'reference_rules' | 'autogeo_bailian_qwen' | 'autogeo_api' | 'manual', idempotencyKey: string, productionPlanId?: number, strategyRecommendationId?: number, productionDeliverableId?: number }) {
  const database = requireAuditDatabase()
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.id, input.briefId), eq(seoGeoContentBriefs.ownerUserId, input.ownerUserId), eq(seoGeoContentBriefs.status, 'ready_for_generation'))).limit(1)
  if (!brief) throw createError({ statusCode: 422, statusMessage: 'Content Brief 必須為 owner-owned 且 ready_for_generation 才可建立工作。' })
  if (input.productionPlanId && brief.productionPlanId !== input.productionPlanId) throw createError({ statusCode: 422, statusMessage: 'Job 的 Production Plan 必須與 Brief 一致。' })
  if (brief.productionPlanId && input.operation !== 'content_draft') throw createError({ statusCode: 422, statusMessage: 'Production Plan jobs must use the content_draft operation.' })
  if (input.strategyRecommendationId && brief.strategyRecommendationId !== input.strategyRecommendationId) throw createError({ statusCode: 422, statusMessage: 'Job 的 Strategy recommendation 必須與 Brief 一致。' })
  if (input.productionDeliverableId && brief.productionDeliverableId !== input.productionDeliverableId) throw createError({ statusCode: 422, statusMessage: 'Job 的 deliverable 必須與 Brief 一致。' })
  const requestFingerprint = stableFingerprint({ briefId: input.briefId, operation: input.operation, providerMode: input.providerMode, productionPlanId: input.productionPlanId ?? null, strategyRecommendationId: input.strategyRecommendationId ?? null, productionDeliverableId: input.productionDeliverableId ?? null, idempotencyKey: input.idempotencyKey })
  const [existing] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.ownerUserId, input.ownerUserId), eq(seoGeoContentJobs.idempotencyKey, input.idempotencyKey))).limit(1)
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint || existing.briefId !== brief.id || existing.productionPlanId !== (input.productionPlanId ?? null) || existing.strategyRecommendationId !== (input.strategyRecommendationId ?? null) || existing.productionDeliverableId !== (input.productionDeliverableId ?? null)) throw createError({ statusCode: 409, statusMessage: 'Idempotency key is already associated with a different content job request.' })
    return existing
  }
  await database.insert(seoGeoContentJobs).values({ ownerUserId: input.ownerUserId, briefId: brief.id, productionPlanId: input.productionPlanId ?? null, strategyRecommendationId: input.strategyRecommendationId ?? null, productionDeliverableId: input.productionDeliverableId ?? null, requestFingerprint, operation: input.operation, providerMode: input.providerMode, status: 'queued', idempotencyKey: input.idempotencyKey, evidenceSnapshotHash: brief.evidenceSnapshotHash })
  const [job] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.ownerUserId, input.ownerUserId), eq(seoGeoContentJobs.idempotencyKey, input.idempotencyKey))).limit(1)
  if (!job) throw createError({ statusCode: 500, statusMessage: 'Content job could not be recorded.' })
  return job
}

export async function transitionContentJob(input: { ownerUserId: number, jobId: number, to: ContentJobStatus, errorCode?: string, errorSummary?: string, providerProvenance?: object }) {
  const database = requireAuditDatabase()
  const [job] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, input.jobId), eq(seoGeoContentJobs.ownerUserId, input.ownerUserId))).limit(1)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Content job was not found.' })
  if (!canTransitionContentJob(job.status, input.to) && job.status !== input.to) throw createError({ statusCode: 409, statusMessage: `Invalid content job transition: ${job.status} -> ${input.to}` })
  await database.update(seoGeoContentJobs).set({ status: input.to, errorCode: input.errorCode ?? null, errorSummary: input.errorSummary ?? null, providerProvenance: input.providerProvenance ?? job.providerProvenance, startedAt: input.to === 'processing' ? new Date() : job.startedAt, completedAt: ['candidate_ready', 'needs_human_review', 'approved', 'blocked', 'failed', 'delivered'].includes(input.to) ? new Date() : null }).where(eq(seoGeoContentJobs.id, job.id))
  return { ...job, status: input.to }
}

export async function saveContentCandidate(input: { jobId: number, title: string, body: string, contentHash: string, sourceMode: 'provider_candidate' | 'reference_fallback' | 'manual', provenance: object, evidenceRefs: EvidenceRef[], safetyStatus: 'passed' | 'needs_review' | 'blocked', safetyNotes: unknown }) {
  const database = requireAuditDatabase()
  const current = await database.select({ version: seoGeoContentDrafts.version }).from(seoGeoContentDrafts).where(eq(seoGeoContentDrafts.jobId, input.jobId)).orderBy(desc(seoGeoContentDrafts.version)).limit(1)
  const version = (current[0]?.version || 0) + 1
  await database.insert(seoGeoContentDrafts).values({ ...input, version })
  const [draft] = await database.select().from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.jobId, input.jobId), eq(seoGeoContentDrafts.version, version))).limit(1)
  if (!draft) throw createError({ statusCode: 500, statusMessage: 'Candidate draft could not be recorded.' })
  return draft
}

export async function saveRiskGate(input: { draftId: number, result: ContentRiskGateResult, evidenceSnapshotHash: string }) {
  const database = requireAuditDatabase()
  return database.transaction(async tx => {
    const [draft] = await tx.select({ id: seoGeoContentDrafts.id, jobId: seoGeoContentDrafts.jobId }).from(seoGeoContentDrafts).where(eq(seoGeoContentDrafts.id, input.draftId)).limit(1)
    if (!draft) throw createError({ statusCode: 404, statusMessage: 'Risk gate draft was not found.' })
    const [lockedJob] = await tx.select({ id: seoGeoContentJobs.id }).from(seoGeoContentJobs).where(eq(seoGeoContentJobs.id, draft.jobId)).for('update').limit(1)
    if (!lockedJob) throw createError({ statusCode: 409, statusMessage: 'Risk gate job is no longer available.' })
    const [publicationAttempt] = await tx.select({ id: contentOperationPublicationAttempts.id }).from(contentOperationPublicationAttempts).innerJoin(contentOperationCalendarEntries, eq(contentOperationPublicationAttempts.entryId, contentOperationCalendarEntries.id)).where(and(
      eq(contentOperationPublicationAttempts.mode, 'execute'),
      eq(contentOperationCalendarEntries.jobId, draft.jobId),
      eq(contentOperationCalendarEntries.draftId, draft.id),
      eq(contentOperationCalendarEntries.evidenceSnapshotHash, input.evidenceSnapshotHash),
    )).limit(1)
    if (publicationAttempt) throw createError({ statusCode: 409, statusMessage: 'A new risk gate cannot replace the gate bound to an existing publication attempt.' })
    const inserted = await tx.insert(seoGeoContentRiskGates).values({ draftId: input.draftId, gateVersion: input.result.gateVersion, status: input.result.status, findings: input.result.findings, evidenceSnapshotHash: input.evidenceSnapshotHash })
    const insertedId = Number(inserted?.[0]?.insertId)
    if (!Number.isSafeInteger(insertedId) || insertedId < 1) throw createError({ statusCode: 500, statusMessage: 'Risk gate could not be recorded.' })
    const [row] = await tx.select().from(seoGeoContentRiskGates).where(eq(seoGeoContentRiskGates.id, insertedId)).limit(1)
    if (!row) throw createError({ statusCode: 500, statusMessage: 'Risk gate could not be loaded.' })
    return row
  })
}

export async function createContentReview(input: { ownerUserId: number, jobId: number, draftId: number, decision: 'approved_for_preview' | 'approved_for_delivery' | 'changes_requested' | 'rejected', reviewNote?: string }) {
  const database = requireAuditDatabase()
  const [job] = await database.select({ id: seoGeoContentJobs.id, evidenceSnapshotHash: seoGeoContentJobs.evidenceSnapshotHash, status: seoGeoContentJobs.status, productionDeliverableId: seoGeoContentJobs.productionDeliverableId, productionPlanId: seoGeoContentJobs.productionPlanId }).from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, input.jobId), eq(seoGeoContentJobs.ownerUserId, input.ownerUserId))).limit(1)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Content job was not found.' })
  const [draft] = await database.select({ id: seoGeoContentDrafts.id, safetyStatus: seoGeoContentDrafts.safetyStatus, provenance: seoGeoContentDrafts.provenance }).from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, input.draftId), eq(seoGeoContentDrafts.jobId, job.id))).limit(1)
  if (!draft) throw createError({ statusCode: 404, statusMessage: 'Draft was not found for this job.' })
  if (jsonRecord(draft.provenance).stage !== 'optimized') throw createError({ statusCode: 422, statusMessage: 'Only an optimized production draft can enter owner review.' })
  const [riskGate] = await database.select().from(seoGeoContentRiskGates).where(and(
    eq(seoGeoContentRiskGates.draftId, draft.id),
    eq(seoGeoContentRiskGates.evidenceSnapshotHash, job.evidenceSnapshotHash),
  )).orderBy(desc(seoGeoContentRiskGates.id)).limit(1)
  if (!riskGate) throw createError({ statusCode: 422, statusMessage: 'Owner review requires a matching risk gate for this draft and evidence snapshot.' })
  if (riskGate.status === 'blocked') throw createError({ statusCode: 422, statusMessage: 'A blocked risk gate cannot enter owner review.' })
  if (input.decision.startsWith('approved') && (riskGate.status !== 'passed' || draft.safetyStatus !== 'passed')) throw createError({ statusCode: 422, statusMessage: 'Preview or delivery approval requires a passed risk gate and passed draft safety status.' })
  if (input.decision.startsWith('approved')) {
    const [pendingChange] = await database.select({ id: seoGeoContentReviews.id }).from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, draft.id), eq(seoGeoContentReviews.reviewerUserId, input.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, job.evidenceSnapshotHash), eq(seoGeoContentReviews.decision, 'changes_requested'))).orderBy(desc(seoGeoContentReviews.id)).limit(1)
    if (pendingChange) throw createError({ statusCode: 409, statusMessage: 'This draft has changes_requested; submit a new revision before approval.' })
  }
  if (draft.safetyStatus === 'blocked' && input.decision.startsWith('approved')) throw createError({ statusCode: 422, statusMessage: 'Blocked draft cannot be approved for preview or delivery.' })
  const [priorPreview] = input.decision === 'approved_for_delivery' ? await database.select({ id: seoGeoContentReviews.id }).from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, draft.id), eq(seoGeoContentReviews.reviewerUserId, input.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, job.evidenceSnapshotHash), eq(seoGeoContentReviews.decision, 'approved_for_preview'))).orderBy(desc(seoGeoContentReviews.id)).limit(1) : []
  const [priorDelivery] = input.decision === 'approved_for_delivery' ? await database.select({ id: seoGeoContentReviews.id }).from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, draft.id), eq(seoGeoContentReviews.reviewerUserId, input.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, job.evidenceSnapshotHash), eq(seoGeoContentReviews.decision, 'approved_for_delivery'))).orderBy(desc(seoGeoContentReviews.id)).limit(1) : []
  if (priorDelivery) throw createError({ statusCode: 409, statusMessage: 'This optimized draft already has approved_for_delivery; create a new revision before delivery approval.' })
  const approvalUpgrade = input.decision === 'approved_for_delivery' && job.status === 'approved' && Boolean(priorPreview)
  if (input.decision === 'approved_for_delivery' && !approvalUpgrade && !['candidate_ready', 'needs_human_review'].includes(job.status)) throw createError({ statusCode: 409, statusMessage: 'Delivery approval must follow preview approval for an already approved draft, or start from a candidate awaiting review.' })
  if (input.decision === 'approved_for_preview' && !['candidate_ready', 'needs_human_review'].includes(job.status)) throw createError({ statusCode: 409, statusMessage: 'Only a candidate awaiting human review can receive preview approval.' })
  if (input.decision === 'changes_requested' && !['candidate_ready', 'needs_human_review', 'approved'].includes(job.status)) throw createError({ statusCode: 409, statusMessage: 'Changes can only be requested for a candidate under owner review.' })
  const next: ContentJobStatus = input.decision.startsWith('approved') ? 'approved' : input.decision === 'changes_requested' ? 'needs_human_review' : 'blocked'
  if (!approvalUpgrade && !canTransitionContentJob(job.status, next) && job.status !== next) throw createError({ statusCode: 409, statusMessage: `Invalid content job transition: ${job.status} -> ${next}` })
  const review = await database.transaction(async tx => {
    const [lockedJob] = await tx.select({ id: seoGeoContentJobs.id, status: seoGeoContentJobs.status }).from(seoGeoContentJobs).where(and(
      eq(seoGeoContentJobs.id, job.id),
      eq(seoGeoContentJobs.ownerUserId, input.ownerUserId),
    )).for('update').limit(1)
    if (!lockedJob || lockedJob.status !== job.status) throw createError({ statusCode: 409, statusMessage: 'Content job changed while this review was being recorded.' })
    if (input.decision === 'changes_requested' || input.decision === 'rejected') {
      const [publishingAttempt] = await tx.select({ id: contentOperationPublicationAttempts.id }).from(contentOperationPublicationAttempts).innerJoin(contentOperationCalendarEntries, eq(contentOperationPublicationAttempts.entryId, contentOperationCalendarEntries.id)).where(and(
        eq(contentOperationPublicationAttempts.ownerUserId, input.ownerUserId),
        eq(contentOperationPublicationAttempts.status, 'planned'),
        eq(contentOperationCalendarEntries.ownerUserId, input.ownerUserId),
        eq(contentOperationCalendarEntries.jobId, job.id),
        eq(contentOperationCalendarEntries.draftId, draft.id),
        eq(contentOperationCalendarEntries.evidenceSnapshotHash, job.evidenceSnapshotHash),
      )).limit(1)
      if (publishingAttempt) throw createError({ statusCode: 409, statusMessage: 'Publication has already started for this draft; wait for the attempt to finish before changing the review.' })
    }
    const [reviewId] = await tx.insert(seoGeoContentReviews).values({ jobId: job.id, draftId: draft.id, reviewerUserId: input.ownerUserId, decision: input.decision, reviewNote: input.reviewNote?.trim() || null, evidenceSnapshotHash: job.evidenceSnapshotHash }).$returningId()
    await tx.update(seoGeoContentJobs).set({ status: next, completedAt: ['candidate_ready', 'needs_human_review', 'approved', 'blocked', 'failed', 'delivered'].includes(next) ? new Date() : null }).where(eq(seoGeoContentJobs.id, job.id))
    if (job.productionDeliverableId) {
      const deliverableStatus = input.decision.startsWith('approved') ? 'approved' : input.decision === 'changes_requested' ? 'needs_human_review' : 'blocked'
      await tx.update(seoGeoProductionDeliverables).set({ status: deliverableStatus }).where(and(eq(seoGeoProductionDeliverables.id, job.productionDeliverableId), eq(seoGeoProductionDeliverables.ownerUserId, input.ownerUserId)))
    }
    return reviewId
  })
  const planStatus = job.productionPlanId ? await recalculateProductionPlanStatus(input.ownerUserId, job.productionPlanId) : undefined
  return { jobId: job.id, reviewId: review?.id, nextStatus: next, planId: job.productionPlanId ?? undefined, planStatus }
}

export async function submitProductionDraftRevision(input: { ownerUserId: number, planId: number, deliverableId: number, title: string, body: string }) {
  const context = await resolveProductionContext({ ownerUserId: input.ownerUserId, planId: input.planId, deliverableId: input.deliverableId, includeArtifacts: true })
  const job = context.job
  if (!job || job.status !== 'needs_human_review') throw createError({ statusCode: 409, statusMessage: 'A production job must be in needs_human_review before submitting a revision.' })
  const database = requireAuditDatabase()
  const drafts = await database.select().from(seoGeoContentDrafts).where(eq(seoGeoContentDrafts.jobId, job.id)).orderBy(desc(seoGeoContentDrafts.version))
  const parentDraft = drafts.find(item => jsonRecord(item.provenance).stage === 'optimized')
  if (!parentDraft) throw createError({ statusCode: 422, statusMessage: 'A revision requires an existing optimized draft.' })
  const [changeRequest] = await database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, parentDraft.id), eq(seoGeoContentReviews.reviewerUserId, input.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, context.evidenceSnapshot.hash), eq(seoGeoContentReviews.decision, 'changes_requested'))).orderBy(desc(seoGeoContentReviews.id)).limit(1)
  if (!changeRequest) throw createError({ statusCode: 422, statusMessage: 'An owner changes_requested review is required before submitting a revision.' })
  const title = input.title.trim()
  const body = input.body.trim()
  const revisionHash = contentFingerprint(title, body)
  if (revisionHash === parentDraft.contentHash) throw createError({ statusCode: 409, statusMessage: 'Revision must change the title or body and produce a new content hash.' })
  const selectedRules = resolveCanonicalGeoRules(context.rules.map(rule => rule.id))
  const ownerRevisionInput = await saveContentCandidate({
    jobId: job.id,
    title,
    body,
    contentHash: revisionHash,
    sourceMode: 'manual',
    provenance: buildOwnerRevisionInputProvenance({ parentDraftId: parentDraft.id, parentDraftContentHash: parentDraft.contentHash, changeRequestReviewId: changeRequest.id, selectedRuleIds: selectedRules.map(rule => rule.id), evidenceSnapshotHash: context.evidenceSnapshot.hash, revisionAuthor: input.ownerUserId }),
    evidenceRefs: context.evidenceSnapshot.refs,
    safetyStatus: 'needs_review',
    safetyNotes: ['Owner submission is stored as input only.', 'This record is not eligible for owner review, preview, or export until a new optimized child passes the risk gate.'],
  })
  const runtimeProviders = resolveProductionRuntimeProviders(job.providerMode)
  const optimizationSource = {
    title,
    content: body,
    language: context.plan.language,
    approvedEvidenceContext: context.evidenceSnapshot.context,
    approvedDiagnosisContext: JSON.stringify(context.diagnosisResult),
    approvedStrategyContext: JSON.stringify(selectedRules),
    approvedBriefGoals: context.opportunity.goals,
    approvedBriefConstraints: context.opportunity.constraints,
  }
  const optimizationResult = await optimiseGeoDocument(optimizationSource, runtimeProviders.optimizationAdapter, selectedRules)
  const candidate = optimizationResult.candidate
  const riskGate = evaluateContentRisk({ source: optimizationSource, candidateTitle: candidate.optimizedTitle, candidateBody: candidate.optimizedContent, evidenceCount: context.evidenceSnapshot.refs.length })
  const selectedRuleIds = selectedRules.map(rule => rule.id)
  const finalOptimizationProvenance = buildRevisionOptimizationProvenance({ ownerRevisionInputDraftId: ownerRevisionInput.id, originalParentDraftId: parentDraft.id, changeRequestReviewId: changeRequest.id, selectedRuleIds, appliedRuleIds: candidate.appliedRuleIds, evidenceSnapshotHash: context.evidenceSnapshot.hash, provider: candidate.provider, providerVersion: candidate.providerVersion, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? candidate.provenance.fallbackReason ?? null })
  const pendingOptimizationProvenance = { ...finalOptimizationProvenance, stage: 'optimized_pending_gate' as const, generationMode: 'revision_selected_rule_optimization_pending_gate' as const }
  const finalSafetyStatus: 'passed' | 'needs_review' | 'blocked' = riskGate.status === 'blocked' ? 'blocked' : riskGate.status === 'needs_human_review' ? 'needs_review' : 'passed'
  const finalSafetyNotes = [...candidate.safetyNotes, optimizationResult.interpretationLimit, 'A new optimized child must receive explicit owner review before preview or export.']
  const nextStatus: ContentJobStatus = riskGate.status === 'blocked' ? 'blocked' : 'needs_human_review'
  const finalJobProvenance = { stage: 'revision_optimized', ownerRevisionInputDraftId: ownerRevisionInput.id, parentDraftId: parentDraft.id, changeRequestReviewId: changeRequest.id, optimizedDraftId: 0, selectedRuleIds, appliedRuleIds: candidate.appliedRuleIds, runtimeProvider: runtimeProviders.provenance, actualProviderMode: runtimeProviders.mode, fallbackReason: runtimeProviders.fallbackReason ?? candidate.provenance.fallbackReason ?? null }
  const pendingDraft = await saveContentCandidate({
    jobId: job.id,
    title: candidate.optimizedTitle,
    body: candidate.optimizedContent,
    contentHash: contentFingerprint(candidate.optimizedTitle, candidate.optimizedContent),
    sourceMode: candidate.provider === 'reference-rules-v1' ? 'reference_fallback' : 'provider_candidate',
    provenance: pendingOptimizationProvenance,
    evidenceRefs: context.evidenceSnapshot.refs,
    safetyStatus: finalSafetyStatus,
    safetyNotes: finalSafetyNotes,
  })
  finalJobProvenance.optimizedDraftId = pendingDraft.id
  await database.transaction(async tx => {
    await tx.insert(seoGeoContentRiskGates).values({ draftId: pendingDraft.id, gateVersion: riskGate.gateVersion, status: riskGate.status, findings: riskGate.findings, evidenceSnapshotHash: context.evidenceSnapshot.hash })
    await tx.update(seoGeoContentDrafts).set({ provenance: finalOptimizationProvenance, safetyStatus: finalSafetyStatus, safetyNotes: finalSafetyNotes }).where(eq(seoGeoContentDrafts.id, pendingDraft.id))
    await tx.update(seoGeoContentJobs).set({ status: nextStatus, providerProvenance: finalJobProvenance, completedAt: ['candidate_ready', 'needs_human_review', 'approved', 'blocked', 'failed', 'delivered'].includes(nextStatus) ? new Date() : null }).where(eq(seoGeoContentJobs.id, job.id))
    await tx.update(seoGeoProductionDeliverables).set({ status: nextStatus === 'blocked' ? 'blocked' : 'needs_human_review', briefId: context.brief?.id ?? context.deliverable.briefId, jobId: job.id }).where(and(eq(seoGeoProductionDeliverables.id, context.deliverable.id), eq(seoGeoProductionDeliverables.ownerUserId, input.ownerUserId)))
  })
  if (context.plan.id) await recalculateProductionPlanStatus(input.ownerUserId, context.plan.id)
  const optimizedDraft = { ...pendingDraft, provenance: finalOptimizationProvenance, safetyStatus: finalSafetyStatus, safetyNotes: finalSafetyNotes }
  return { draft: optimizedDraft, ownerRevisionInput, riskGate, optimizationResult, job: { ...job, status: nextStatus, providerProvenance: finalJobProvenance }, parentDraftId: parentDraft.id, changeRequestReviewId: changeRequest.id }
}

export async function exportProductionDraft(input: { ownerUserId: number, planId: number, deliverableId: number, format: 'markdown' | 'json' }) {
  const context = await resolveProductionContext({ ownerUserId: input.ownerUserId, planId: input.planId, deliverableId: input.deliverableId, includeArtifacts: true })
  const job = context.job
  if (!job || job.status !== 'approved') throw createError({ statusCode: 422, statusMessage: 'Export requires an owner-approved production job.' })
  const database = requireAuditDatabase()
  const drafts = await database.select().from(seoGeoContentDrafts).where(eq(seoGeoContentDrafts.jobId, job.id)).orderBy(desc(seoGeoContentDrafts.version))
  const draft = drafts.find(item => jsonRecord(item.provenance).stage === 'optimized')
  if (!draft || draft.safetyStatus === 'blocked') throw createError({ statusCode: 422, statusMessage: 'Export requires a non-blocked optimized draft.' })
  const [review] = await database.select().from(seoGeoContentReviews).where(and(eq(seoGeoContentReviews.jobId, job.id), eq(seoGeoContentReviews.draftId, draft.id), eq(seoGeoContentReviews.reviewerUserId, input.ownerUserId), eq(seoGeoContentReviews.evidenceSnapshotHash, context.evidenceSnapshot.hash), eq(seoGeoContentReviews.decision, 'approved_for_delivery'))).orderBy(desc(seoGeoContentReviews.id)).limit(1)
  if (!review) throw createError({ statusCode: 422, statusMessage: 'Export requires explicit approved_for_delivery owner review.' })
  const [gate] = await database.select().from(seoGeoContentRiskGates).where(and(eq(seoGeoContentRiskGates.draftId, draft.id), eq(seoGeoContentRiskGates.evidenceSnapshotHash, context.evidenceSnapshot.hash))).orderBy(desc(seoGeoContentRiskGates.id)).limit(1)
  if (!gate || gate.status !== 'passed') throw createError({ statusCode: 422, statusMessage: 'Export requires a passed risk gate for the selected draft.' })
  const safeStem = context.opportunity.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || `production-${input.deliverableId}`
  const exportedAt = new Date().toISOString()
  const exportLedgerEntry = { exportId: stableFingerprint({ planId: input.planId, deliverableId: input.deliverableId, draftId: draft.id, format: input.format, contentHash: draft.contentHash, exportedAt }), format: input.format, draftId: draft.id, reviewId: review.id, contentHash: draft.contentHash, evidenceSnapshotHash: context.evidenceSnapshot.hash, exportedAt, mode: 'owner_local_export' as const }
  const exportLedger = appendExportLedger(jsonRecord(context.deliverable.provenance).exportLedger, exportLedgerEntry)
  const markdown = `# ${draft.title}\n\n${draft.body}\n\n---\n\nEvidence snapshot: ${context.evidenceSnapshot.hash}\nDraft content hash: ${draft.contentHash}\nGeneration provenance: ${JSON.stringify(jsonRecord(draft.provenance))}`
  const body = input.format === 'markdown' ? markdown : JSON.stringify({ title: draft.title, body: draft.body, contentHash: draft.contentHash, evidenceSnapshotHash: context.evidenceSnapshot.hash, provenance: jsonRecord(draft.provenance), riskGate: gate, review: { id: review.id, decision: review.decision, evidenceSnapshotHash: review.evidenceSnapshotHash }, exportLedger }, null, 2)
  await database.update(seoGeoProductionDeliverables).set({ status: 'exported', provenance: { ...jsonRecord(context.deliverable.provenance), exportLedger } }).where(and(eq(seoGeoProductionDeliverables.id, context.deliverable.id), eq(seoGeoProductionDeliverables.ownerUserId, input.ownerUserId), eq(seoGeoProductionDeliverables.planId, input.planId)))
  const planStatus = await recalculateProductionPlanStatus(input.ownerUserId, input.planId)
  return { format: input.format, filename: `${safeStem}.${input.format === 'markdown' ? 'md' : 'json'}`, contentType: input.format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', body, contentHash: draft.contentHash, exportLedger, planId: input.planId, deliverableId: input.deliverableId, planStatus }
}

export async function prepareDeliveryPreview(input: { ownerUserId: number, jobId: number, draftId: number, targetId: number, idempotencyKey: string }) {
  const database = requireAuditDatabase()
  const [target] = await database.select().from(seoGeoDeliveryTargets).where(and(eq(seoGeoDeliveryTargets.id, input.targetId), eq(seoGeoDeliveryTargets.ownerUserId, input.ownerUserId), eq(seoGeoDeliveryTargets.status, 'disabled'), eq(seoGeoDeliveryTargets.allowPublish, false))).limit(1)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Delivery target was not found or is not disabled.' })
  const [job] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, input.jobId), eq(seoGeoContentJobs.ownerUserId, input.ownerUserId), eq(seoGeoContentJobs.status, 'approved'))).limit(1)
  if (!job) throw createError({ statusCode: 422, statusMessage: 'Preview requires an owner-approved content job.' })
  const [draft] = await database.select({ id: seoGeoContentDrafts.id, safetyStatus: seoGeoContentDrafts.safetyStatus, contentHash: seoGeoContentDrafts.contentHash, provenance: seoGeoContentDrafts.provenance }).from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, input.draftId), eq(seoGeoContentDrafts.jobId, job.id))).limit(1)
  if (!draft || jsonRecord(draft.provenance).stage !== 'optimized' || draft.safetyStatus === 'blocked') throw createError({ statusCode: 422, statusMessage: 'Preview requires a non-blocked optimized draft.' })
  const [gate] = await database.select().from(seoGeoContentRiskGates).where(and(
    eq(seoGeoContentRiskGates.draftId, draft.id),
    eq(seoGeoContentRiskGates.evidenceSnapshotHash, job.evidenceSnapshotHash),
  )).orderBy(desc(seoGeoContentRiskGates.id)).limit(1)
  if (!gate || gate.status !== 'passed') throw createError({ statusCode: 422, statusMessage: 'Preview requires a passed risk gate for the selected draft and evidence snapshot.' })
  const [review] = await database.select({ id: seoGeoContentReviews.id, decision: seoGeoContentReviews.decision, evidenceSnapshotHash: seoGeoContentReviews.evidenceSnapshotHash }).from(seoGeoContentReviews).where(and(
    eq(seoGeoContentReviews.jobId, job.id),
    eq(seoGeoContentReviews.draftId, draft.id),
    eq(seoGeoContentReviews.reviewerUserId, input.ownerUserId),
    eq(seoGeoContentReviews.evidenceSnapshotHash, job.evidenceSnapshotHash),
    or(eq(seoGeoContentReviews.decision, 'approved_for_preview'), eq(seoGeoContentReviews.decision, 'approved_for_delivery')),
  )).orderBy(desc(seoGeoContentReviews.id)).limit(1)
  if (!review) throw createError({ statusCode: 422, statusMessage: 'Preview requires an explicit approved owner review for this draft.' })
  const summary = { adapter: target.adapter, targetOrigin: target.targetOrigin, canPublish: false, requiredNextStep: 'explicit_owner_approval_and_server_side_adapter_configuration', contentHash: draft.contentHash }
  const [existingAttempt] = await database.select({ id: seoGeoDeliveryAttempts.id, jobId: seoGeoDeliveryAttempts.jobId, draftId: seoGeoDeliveryAttempts.draftId, mode: seoGeoDeliveryAttempts.mode }).from(seoGeoDeliveryAttempts).where(and(eq(seoGeoDeliveryAttempts.targetId, target.id), eq(seoGeoDeliveryAttempts.idempotencyKey, input.idempotencyKey))).limit(1)
  if (existingAttempt && (existingAttempt.jobId !== input.jobId || existingAttempt.draftId !== draft.id || existingAttempt.mode !== 'preview')) throw createError({ statusCode: 409, statusMessage: 'Delivery preview idempotency key is already associated with a different preview.' })
  if (existingAttempt) {
    await database.update(seoGeoDeliveryAttempts).set({ approvalReviewId: review.id, deliverySummary: summary, status: 'prepared' }).where(eq(seoGeoDeliveryAttempts.id, existingAttempt.id))
  } else {
    await database.insert(seoGeoDeliveryAttempts).values({ jobId: input.jobId, draftId: draft.id, targetId: target.id, approvalReviewId: review.id, idempotencyKey: input.idempotencyKey, mode: 'preview', status: 'prepared', deliverySummary: summary })
  }
  const planStatus = job.productionPlanId ? await recalculateProductionPlanStatus(input.ownerUserId, job.productionPlanId) : undefined
  return { ...summary, planId: job.productionPlanId ?? undefined, planStatus }
}

export async function createDeliveryTarget(input: { ownerUserId: number, displayName: string, adapter: 'manual_export' | 'wordpress_rest' | 'generic_http', targetOrigin: string }) {
  const database = requireAuditDatabase()
  await database.insert(seoGeoDeliveryTargets).values({ ...input, status: 'disabled', allowPublish: false })
  const [target] = await database.select().from(seoGeoDeliveryTargets).where(and(eq(seoGeoDeliveryTargets.ownerUserId, input.ownerUserId), eq(seoGeoDeliveryTargets.displayName, input.displayName))).orderBy(desc(seoGeoDeliveryTargets.id)).limit(1)
  if (!target) throw createError({ statusCode: 500, statusMessage: 'Delivery target could not be recorded.' })
  return target
}

export async function listOwnerSeoGeoWorkspace(ownerUserId: number) {
  const database = requireAuditDatabase()
  const [diagnoses, evidenceApprovals, strategies, plans, deliverables, briefs, jobs, targets] = await Promise.all([
    database.select({ id: seoGeoDiagnoses.id, status: seoGeoDiagnoses.status, diagnosisKind: seoGeoDiagnoses.diagnosisKind, createdAt: seoGeoDiagnoses.createdAt, inputFingerprint: seoGeoDiagnoses.inputFingerprint }).from(seoGeoDiagnoses).where(eq(seoGeoDiagnoses.ownerUserId, ownerUserId)).orderBy(desc(seoGeoDiagnoses.createdAt)).limit(20),
    database.select({ id: seoGeoEvidenceApprovals.id, sourceId: seoGeoEvidenceApprovals.sourceId, artifactId: seoGeoEvidenceApprovals.artifactId, sourceName: publicIntelligenceSources.sourceName, sourceUrl: publicIntelligenceSources.canonicalUrl, fallbackSourceUrl: publicIntelligenceSources.sourceUrl, artifactType: publicIntelligenceArtifacts.artifactType, artifactHash: publicIntelligenceArtifacts.artifactHash, allowedFor: seoGeoEvidenceApprovals.allowedFor, status: seoGeoEvidenceApprovals.status, approvedAt: seoGeoEvidenceApprovals.approvedAt }).from(seoGeoEvidenceApprovals).innerJoin(publicIntelligenceSources, eq(seoGeoEvidenceApprovals.sourceId, publicIntelligenceSources.id)).leftJoin(publicIntelligenceArtifacts, eq(seoGeoEvidenceApprovals.artifactId, publicIntelligenceArtifacts.id)).where(and(eq(seoGeoEvidenceApprovals.ownerUserId, ownerUserId), eq(publicIntelligenceSources.ownerUserId, ownerUserId))).orderBy(desc(seoGeoEvidenceApprovals.updatedAt)).limit(50),
    database.select({ id: seoGeoStrategyRecommendations.id, diagnosisId: seoGeoStrategyRecommendations.diagnosisId, issueCode: seoGeoStrategyRecommendations.issueCode, recommendationKey: seoGeoStrategyRecommendations.recommendationKey, priority: seoGeoStrategyRecommendations.priority, status: seoGeoStrategyRecommendations.status, ruleIds: seoGeoStrategyRecommendations.ruleIds, contentOpportunities: seoGeoStrategyRecommendations.contentOpportunities, createdAt: seoGeoStrategyRecommendations.createdAt }).from(seoGeoStrategyRecommendations).where(eq(seoGeoStrategyRecommendations.ownerUserId, ownerUserId)).orderBy(desc(seoGeoStrategyRecommendations.createdAt)).limit(50),
    database.select({ id: seoGeoProductionPlans.id, diagnosisId: seoGeoProductionPlans.diagnosisId, title: seoGeoProductionPlans.title, language: seoGeoProductionPlans.language, status: seoGeoProductionPlans.status, evidenceSnapshotHash: seoGeoProductionPlans.evidenceSnapshotHash, createdAt: seoGeoProductionPlans.createdAt }).from(seoGeoProductionPlans).where(eq(seoGeoProductionPlans.ownerUserId, ownerUserId)).orderBy(desc(seoGeoProductionPlans.createdAt)).limit(20),
    database.select({ id: seoGeoProductionDeliverables.id, planId: seoGeoProductionDeliverables.planId, title: seoGeoProductionDeliverables.title, contentType: seoGeoProductionDeliverables.contentType, status: seoGeoProductionDeliverables.status, briefId: seoGeoProductionDeliverables.briefId, jobId: seoGeoProductionDeliverables.jobId, createdAt: seoGeoProductionDeliverables.createdAt }).from(seoGeoProductionDeliverables).where(eq(seoGeoProductionDeliverables.ownerUserId, ownerUserId)).orderBy(desc(seoGeoProductionDeliverables.createdAt)).limit(50),
    database.select({ id: seoGeoContentBriefs.id, title: seoGeoContentBriefs.title, contentType: seoGeoContentBriefs.contentType, language: seoGeoContentBriefs.language, status: seoGeoContentBriefs.status, productionPlanId: seoGeoContentBriefs.productionPlanId, productionDeliverableId: seoGeoContentBriefs.productionDeliverableId, createdAt: seoGeoContentBriefs.createdAt }).from(seoGeoContentBriefs).where(eq(seoGeoContentBriefs.ownerUserId, ownerUserId)).orderBy(desc(seoGeoContentBriefs.createdAt)).limit(20),
    database.select({ id: seoGeoContentJobs.id, briefId: seoGeoContentJobs.briefId, productionPlanId: seoGeoContentJobs.productionPlanId, productionDeliverableId: seoGeoContentJobs.productionDeliverableId, operation: seoGeoContentJobs.operation, status: seoGeoContentJobs.status, requestedAt: seoGeoContentJobs.requestedAt, completedAt: seoGeoContentJobs.completedAt }).from(seoGeoContentJobs).where(eq(seoGeoContentJobs.ownerUserId, ownerUserId)).orderBy(desc(seoGeoContentJobs.requestedAt)).limit(30),
    database.select({ id: seoGeoDeliveryTargets.id, displayName: seoGeoDeliveryTargets.displayName, adapter: seoGeoDeliveryTargets.adapter, targetOrigin: seoGeoDeliveryTargets.targetOrigin, status: seoGeoDeliveryTargets.status, allowPublish: seoGeoDeliveryTargets.allowPublish, createdAt: seoGeoDeliveryTargets.createdAt }).from(seoGeoDeliveryTargets).where(eq(seoGeoDeliveryTargets.ownerUserId, ownerUserId)).orderBy(desc(seoGeoDeliveryTargets.createdAt)).limit(20),
  ])
  return { diagnoses, evidenceApprovals, strategies, plans, deliverables, briefs, jobs, targets, deliveryNotice: 'No delivery is performed by this API. Preview requires an approved review and a configured server-side adapter in a future explicitly approved release.' }
}
