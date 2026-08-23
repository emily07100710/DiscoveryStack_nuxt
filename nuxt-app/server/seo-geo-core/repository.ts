import { createHash } from 'node:crypto'
import { createError } from 'h3'
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { requireAuditDatabase } from '../audit/repository'
import {
  publicIntelligenceArtifacts,
  publicIntelligenceSources,
  seoGeoContentBriefs,
  seoGeoContentDrafts,
  seoGeoContentJobs,
  seoGeoContentReviews,
  seoGeoContentRiskGates,
  seoGeoDeliveryAttempts,
  seoGeoDeliveryTargets,
  seoGeoDiagnoses,
  seoGeoEvidenceApprovals,
} from '../database/schema'
import type { ContentBriefInput, ContentJobStatus, ContentRiskGateResult, DiagnosisResult, EvidenceRef } from './contracts'
import { canTransitionContentJob } from './contracts'

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

type EvidencePurpose = 'diagnosis' | 'recommendation' | 'content_draft'

type EvidenceSnapshot = {
  refs: EvidenceRef[]
  context: string
  hash: string
}

function evidenceKey(sourceId?: number, artifactId?: number) {
  return `${sourceId || ''}:${artifactId || ''}`
}

function renderEvidenceValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  try { return JSON.stringify(value) } catch { return '' }
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
export async function resolveApprovedEvidenceSnapshot(ownerUserId: number, requestedRefs: EvidenceRef[], allowedFor: EvidencePurpose | readonly EvidencePurpose[], options: { requireArtifact: boolean }): Promise<EvidenceSnapshot> {
  const purposes = Array.isArray(allowedFor) ? allowedFor : [allowedFor]
  if (!requestedRefs.length) throw createError({ statusCode: 422, statusMessage: '至少需要一項已核准 evidence reference。' })
  const database = requireAuditDatabase()
  const rows = await database.select({
    approvalId: seoGeoEvidenceApprovals.id,
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
  const contextBlocks: string[] = []
  for (const requested of requestedRefs) {
    if (!requested.sourceId) throw createError({ statusCode: 422, statusMessage: 'Evidence reference 必須指定 sourceId。' })
    const matchingRows = rowsByKey.get(evidenceKey(requested.sourceId, requested.artifactId)) || []
    const missingPurpose = purposes.find(purpose => !matchingRows.some(row => row.approvalPurpose === purpose))
    const row = matchingRows[0]
    if (!row || missingPurpose) throw createError({ statusCode: 422, statusMessage: `Evidence source/artifact 尚未取得 ${missingPurpose || purposes.join('/')} 用途的有效核准，或已撤銷。` })
    if (options.requireArtifact && (!row.artifactId || !row.artifactHash || !row.artifactType)) throw createError({ statusCode: 422, statusMessage: 'Content generation 必須使用通過品質與 PII 檢查的 approved artifact snapshot。' })
    if (requested.artifactHash && requested.artifactHash !== row.artifactHash) throw createError({ statusCode: 409, statusMessage: 'Evidence artifact hash 與目前核准 snapshot 不一致，請重新建立 Content Brief。' })
    const locator = row.artifactLocator || row.sourceUrl || row.fallbackSourceUrl || undefined
    const canonical: EvidenceRef = {
      sourceId: row.sourceId,
      artifactId: row.artifactId ?? undefined,
      locator,
      artifactHash: row.artifactHash ?? undefined,
      reason: `Evidence approval #${row.approvalId} 已由 owner 明確核准用於 ${purposes.join('/')}`,
    }
    canonicalRefs.push(canonical)
    const artifactPayload = row.artifactText?.trim() || renderEvidenceValue(row.fieldData)
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
  const snapshotIdentity = refs.map(({ sourceId, artifactId, locator, artifactHash }) => ({ sourceId, artifactId: artifactId ?? null, locator: locator || null, artifactHash: artifactHash || null }))
  return { refs, context, hash: stableFingerprint(snapshotIdentity) }
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

export async function createContentBrief(input: { ownerUserId: number, diagnosisId?: number, brief: ContentBriefInput }) {
  const database = requireAuditDatabase()
  const evidenceSnapshot = await resolveApprovedEvidenceSnapshot(input.ownerUserId, input.brief.evidenceRefs, 'content_draft', { requireArtifact: true })
  if (input.diagnosisId) {
    const [diagnosis] = await database.select({ id: seoGeoDiagnoses.id }).from(seoGeoDiagnoses).where(and(eq(seoGeoDiagnoses.id, input.diagnosisId), eq(seoGeoDiagnoses.ownerUserId, input.ownerUserId))).limit(1)
    if (!diagnosis) throw createError({ statusCode: 422, statusMessage: 'Diagnosis ID 必須屬於目前 owner。' })
  }
  await database.insert(seoGeoContentBriefs).values({
    ownerUserId: input.ownerUserId,
    diagnosisId: input.diagnosisId ?? null,
    title: input.brief.title.trim(),
    audience: input.brief.audience.trim(),
    contentType: input.brief.contentType,
    language: input.brief.language,
    goals: input.brief.goals,
    constraints: input.brief.constraints,
    evidenceRefs: evidenceSnapshot.refs,
    evidenceSnapshotHash: evidenceSnapshot.hash,
    status: 'ready_for_generation',
  })
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.ownerUserId, input.ownerUserId), eq(seoGeoContentBriefs.evidenceSnapshotHash, evidenceSnapshot.hash), eq(seoGeoContentBriefs.title, input.brief.title.trim()))).orderBy(desc(seoGeoContentBriefs.id)).limit(1)
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

export async function createContentJob(input: { ownerUserId: number, briefId: number, operation: 'autogeo_recommendation' | 'content_draft' | 'risk_scan' | 'delivery_preview' | 'delivery_publish', providerMode: 'reference_rules' | 'autogeo_bailian_qwen' | 'autogeo_api' | 'manual', idempotencyKey: string }) {
  const database = requireAuditDatabase()
  const [brief] = await database.select().from(seoGeoContentBriefs).where(and(eq(seoGeoContentBriefs.id, input.briefId), eq(seoGeoContentBriefs.ownerUserId, input.ownerUserId), eq(seoGeoContentBriefs.status, 'ready_for_generation'))).limit(1)
  if (!brief) throw createError({ statusCode: 422, statusMessage: 'Content Brief 必須為 owner-owned 且 ready_for_generation 才可建立工作。' })
  const requestFingerprint = stableFingerprint({ briefId: input.briefId, operation: input.operation, providerMode: input.providerMode, idempotencyKey: input.idempotencyKey })
  const [existing] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.ownerUserId, input.ownerUserId), eq(seoGeoContentJobs.idempotencyKey, input.idempotencyKey))).limit(1)
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint || existing.briefId !== brief.id) throw createError({ statusCode: 409, statusMessage: 'Idempotency key is already associated with a different content job request.' })
    return existing
  }
  await database.insert(seoGeoContentJobs).values({ ownerUserId: input.ownerUserId, briefId: brief.id, requestFingerprint, operation: input.operation, providerMode: input.providerMode, status: 'queued', idempotencyKey: input.idempotencyKey, evidenceSnapshotHash: brief.evidenceSnapshotHash })
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
  await database.insert(seoGeoContentRiskGates).values({ draftId: input.draftId, gateVersion: input.result.gateVersion, status: input.result.status, findings: input.result.findings, evidenceSnapshotHash: input.evidenceSnapshotHash })
}

export async function createContentReview(input: { ownerUserId: number, jobId: number, draftId: number, decision: 'approved_for_preview' | 'approved_for_delivery' | 'changes_requested' | 'rejected', reviewNote?: string }) {
  const database = requireAuditDatabase()
  const [job] = await database.select({ id: seoGeoContentJobs.id, evidenceSnapshotHash: seoGeoContentJobs.evidenceSnapshotHash, status: seoGeoContentJobs.status }).from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, input.jobId), eq(seoGeoContentJobs.ownerUserId, input.ownerUserId))).limit(1)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Content job was not found.' })
  const [draft] = await database.select({ id: seoGeoContentDrafts.id, safetyStatus: seoGeoContentDrafts.safetyStatus }).from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, input.draftId), eq(seoGeoContentDrafts.jobId, job.id))).limit(1)
  if (!draft) throw createError({ statusCode: 404, statusMessage: 'Draft was not found for this job.' })
  if (draft.safetyStatus === 'blocked' && input.decision.startsWith('approved')) throw createError({ statusCode: 422, statusMessage: 'Blocked draft cannot be approved for preview or delivery.' })
  if (input.decision.startsWith('approved') && !['candidate_ready', 'needs_human_review'].includes(job.status)) throw createError({ statusCode: 409, statusMessage: 'Only a candidate awaiting human review can be approved.' })
  const next: ContentJobStatus = input.decision.startsWith('approved') ? 'approved' : input.decision === 'changes_requested' ? 'needs_human_review' : 'blocked'
  if (!canTransitionContentJob(job.status, next) && job.status !== next) throw createError({ statusCode: 409, statusMessage: `Invalid content job transition: ${job.status} -> ${next}` })
  const review = await database.transaction(async tx => {
    const [reviewId] = await tx.insert(seoGeoContentReviews).values({ jobId: job.id, draftId: draft.id, reviewerUserId: input.ownerUserId, decision: input.decision, reviewNote: input.reviewNote?.trim() || null, evidenceSnapshotHash: job.evidenceSnapshotHash }).$returningId()
    await tx.update(seoGeoContentJobs).set({ status: next, completedAt: ['candidate_ready', 'needs_human_review', 'approved', 'blocked', 'failed', 'delivered'].includes(next) ? new Date() : null }).where(eq(seoGeoContentJobs.id, job.id))
    return reviewId
  })
  return { jobId: job.id, reviewId: review?.id, nextStatus: next }
}

export async function prepareDeliveryPreview(input: { ownerUserId: number, jobId: number, draftId: number, targetId: number, idempotencyKey: string }) {
  const database = requireAuditDatabase()
  const [target] = await database.select().from(seoGeoDeliveryTargets).where(and(eq(seoGeoDeliveryTargets.id, input.targetId), eq(seoGeoDeliveryTargets.ownerUserId, input.ownerUserId), eq(seoGeoDeliveryTargets.status, 'disabled'), eq(seoGeoDeliveryTargets.allowPublish, false))).limit(1)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Delivery target was not found or is not disabled.' })
  const [job] = await database.select().from(seoGeoContentJobs).where(and(eq(seoGeoContentJobs.id, input.jobId), eq(seoGeoContentJobs.ownerUserId, input.ownerUserId), eq(seoGeoContentJobs.status, 'approved'))).limit(1)
  if (!job) throw createError({ statusCode: 422, statusMessage: 'Preview requires an owner-approved content job.' })
  const [draft] = await database.select({ id: seoGeoContentDrafts.id, safetyStatus: seoGeoContentDrafts.safetyStatus, contentHash: seoGeoContentDrafts.contentHash }).from(seoGeoContentDrafts).where(and(eq(seoGeoContentDrafts.id, input.draftId), eq(seoGeoContentDrafts.jobId, job.id))).limit(1)
  if (!draft || draft.safetyStatus === 'blocked') throw createError({ statusCode: 422, statusMessage: 'A non-blocked draft is required for preview.' })
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
  return summary
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
  const [diagnoses, evidenceApprovals, briefs, jobs, targets] = await Promise.all([
    database.select({ id: seoGeoDiagnoses.id, status: seoGeoDiagnoses.status, diagnosisKind: seoGeoDiagnoses.diagnosisKind, createdAt: seoGeoDiagnoses.createdAt, inputFingerprint: seoGeoDiagnoses.inputFingerprint }).from(seoGeoDiagnoses).where(eq(seoGeoDiagnoses.ownerUserId, ownerUserId)).orderBy(desc(seoGeoDiagnoses.createdAt)).limit(20),
    database.select({ id: seoGeoEvidenceApprovals.id, sourceId: seoGeoEvidenceApprovals.sourceId, artifactId: seoGeoEvidenceApprovals.artifactId, allowedFor: seoGeoEvidenceApprovals.allowedFor, status: seoGeoEvidenceApprovals.status, approvedAt: seoGeoEvidenceApprovals.approvedAt }).from(seoGeoEvidenceApprovals).where(eq(seoGeoEvidenceApprovals.ownerUserId, ownerUserId)).orderBy(desc(seoGeoEvidenceApprovals.updatedAt)).limit(50),
    database.select({ id: seoGeoContentBriefs.id, title: seoGeoContentBriefs.title, contentType: seoGeoContentBriefs.contentType, language: seoGeoContentBriefs.language, status: seoGeoContentBriefs.status, createdAt: seoGeoContentBriefs.createdAt }).from(seoGeoContentBriefs).where(eq(seoGeoContentBriefs.ownerUserId, ownerUserId)).orderBy(desc(seoGeoContentBriefs.createdAt)).limit(20),
    database.select({ id: seoGeoContentJobs.id, briefId: seoGeoContentJobs.briefId, operation: seoGeoContentJobs.operation, status: seoGeoContentJobs.status, requestedAt: seoGeoContentJobs.requestedAt, completedAt: seoGeoContentJobs.completedAt }).from(seoGeoContentJobs).where(eq(seoGeoContentJobs.ownerUserId, ownerUserId)).orderBy(desc(seoGeoContentJobs.requestedAt)).limit(30),
    database.select({ id: seoGeoDeliveryTargets.id, displayName: seoGeoDeliveryTargets.displayName, adapter: seoGeoDeliveryTargets.adapter, targetOrigin: seoGeoDeliveryTargets.targetOrigin, status: seoGeoDeliveryTargets.status, allowPublish: seoGeoDeliveryTargets.allowPublish, createdAt: seoGeoDeliveryTargets.createdAt }).from(seoGeoDeliveryTargets).where(eq(seoGeoDeliveryTargets.ownerUserId, ownerUserId)).orderBy(desc(seoGeoDeliveryTargets.createdAt)).limit(20),
  ])
  return { diagnoses, evidenceApprovals, briefs, jobs, targets, deliveryNotice: 'No delivery is performed by this API. Preview requires an approved review and a configured server-side adapter in a future explicitly approved release.' }
}
